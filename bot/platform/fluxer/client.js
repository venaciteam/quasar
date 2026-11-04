// ═══════════════════════════════════════════════════════════════
//  Client Fluxer : REST, passerelle, et état local
//
//  ─── Pourquoi aucune dépendance nouvelle ────────────────────────────────────
//
//  `@discordjs/rest` et `@discordjs/ws` sont déjà présents (dépendances
//  transitives de discord.js), et `@discordjs/core` ne l'est pas. Aucun des
//  trois n'est retenu, et le choix n'est pas une préférence :
//
//   • `@discordjs/ws` implémente la passerelle de DISCORD. Fluxer n'a pas
//     d'intents (l'Identify n'accepte que `token` et `properties`), son Opcode 9
//     n'est jamais une invitation à reprendre (« Fluxer never sends Opcode 9
//     with d: true »), ses codes de fermeture ont d'autres significations, et sa
//     boucle de reconnexion avalerait le `4004 Invalid token` que l'on doit
//     justement rapporter clairement. On écrit donc la passerelle : Hello,
//     Identify, Heartbeat, Resume, Dispatch — deux cents lignes entièrement
//     spécifiées par `gateway/overview.md` et `opcodes-and-close-codes.md`.
//
//   • `@discordjs/rest` gère des seaux de débit propres à Discord et n'est pas
//     déclaré dans `package.json` : l'y appeler en direct reposerait sur la
//     remontée d'une dépendance transitive, qu'un `npm ci` peut cesser de
//     remonter sans prévenir. Le client REST ci-dessous tient en une centaine de
//     lignes sur le `fetch` global de Node 22 et n'a besoin de rien.
//
//  Conséquence : `package.json` et `package-lock.json` ne sont PAS touchés.
//
//  ─── Pourquoi un état local ─────────────────────────────────────────────────
//
//  Trois choses que discord.js faisait gratuitement n'existent pas ici :
//
//   1. Un membre Fluxer ne porte AUCUN champ `permissions` (guild-members.mdx).
//      Sans les rôles du serveur, `estAdmin` serait toujours faux — et
//      `accesParDefaut: false` n'ouvrirait la commande à personne.
//   2. `VOICE_STATE_UPDATE`, `MESSAGE_UPDATE` et `GUILD_MEMBER_UPDATE` ne
//      livrent QUE le nouvel état. Le contrat neutre, lui, passe (avant, après).
//      L'« avant » ne peut venir que d'ici.
//   3. `GUILD_MEMBER_REMOVE` ne porte que `{guild_id, user: {id}}` — pas même le
//      pseudonyme. Un message d'au revoir sans nom est un message cassé.
//
//  L'état est alimenté par la rafale de `GUILD_CREATE` qui suit READY, puis par
//  les événements. Il est BORNÉ : voir `MEMBRES_PAR_GUILDE` et `MESSAGES_CACHE`.
// ═══════════════════════════════════════════════════════════════

const { EventEmitter } = require('events');

// Valeurs par défaut de la DA §9.3.
const BASE_REST_DEFAUT = 'https://api.fluxer.app/v1';
const URL_PASSERELLE_DEFAUT = 'wss://gateway.fluxer.app/?v=1';

// Base du proxy média — avatars et emojis. Voir la note « À VÉRIFIER EN
// RECETTE » de `context.js` : la valeur canonique se lit dans `endpoints.media`
// du document de découverte d'instance, et n'est pas publiée en dur.
const BASE_MEDIA_DEFAUT = 'https://media.fluxer.app';

// Opcodes de `gateway/opcodes-and-close-codes.md`, § Opcodes.
const OP = Object.freeze({
    DISPATCH: 0,
    HEARTBEAT: 1,
    IDENTIFY: 2,
    RESUME: 6,
    RECONNECT: 7,
    INVALID_SESSION: 9,
    HELLO: 10,
    HEARTBEAT_ACK: 11,
});

// Fermetures dont il est INUTILE de se relever : recommencer à l'identique
// reproduit l'échec. « A client changes the token, the shard pair, or the
// version before it reconnects. » (opcodes-and-close-codes.md)
const FERMETURES_FATALES = Object.freeze({
    4004: 'jeton refusé',
    4010: 'shard invalide',
    4011: 'partitionnement obligatoire',
    4012: 'version de passerelle invalide',
});

// Message d'exploitation par code de fermeture. Le but est qu'une personne qui
// lit le journal sache quoi corriger sans ouvrir la documentation.
const EXPLICATIONS_FERMETURE = Object.freeze({
    4004: 'FLUXER_TOKEN est invalide ou a été révoqué. Le jeton d\'un bot Fluxer a la forme '
        + '« <identifiant_application>.<secret> » et se régénère depuis l\'application ; '
        + 'une rotation met fin à toutes les sessions en cours.',
    4008: 'Trop de connexions ou de messages depuis cette adresse ou ce compte.',
    4010: 'La paire [shard_id, shard_count] envoyée à l\'Identify est invalide.',
    4011: 'Plus de 2 500 serveurs pour une seule session : il faut partitionner.',
    4012: 'Le paramètre « v » de l\'URL de passerelle doit valoir 1. '
        + 'Vérifiez FLUXER_GATEWAY_URL.',
});

// Bornes de l'état local. Un serveur de 40 000 membres ne doit pas tenir en
// mémoire : on garde les derniers vus, qui sont exactement ceux dont les
// événements « avant / après » ont besoin.
const MEMBRES_PAR_GUILDE = 2000;
const MESSAGES_CACHE = 1000;

// ─── Erreur d'API ────────────────────────────────────────────────────────────

/**
 * Erreur d'une requête HTTP Fluxer.
 *
 * `code` porte la CHAÎNE du registre (« MISSING_PERMISSIONS »), pas un numéro :
 * c'est ce que `fluxer/erreurs.js` traduit en code neutre. « Match on `code`
 * alone » (errors.md) — le statut ne suffit pas, plusieurs codes le partagent.
 */
class ErreurApiFluxer extends Error {
    constructor(message, { code, status, methode, url, donnees } = {}) {
        super(message);
        this.name = 'ErreurApiFluxer';
        this.code = code;
        this.status = status;
        this.methode = methode;
        this.url = url;
        this.donnees = donnees;
    }
}

// ─── Client REST ─────────────────────────────────────────────────────────────

/**
 * Client HTTP minimal pour l'API Fluxer.
 *
 * @param {object} options
 * @param {string}   options.base     racine versionnée, ex. https://api.fluxer.app/v1
 * @param {string}   options.jeton    jeton de bot, SANS le préfixe « Bot »
 * @param {Function} [options.fetch]  injecté par les tests
 * @param {number}   [options.reessaisDebit]  tentatives sur un 429
 */
function creerRest({ base = BASE_REST_DEFAUT, jeton, fetch: fetchImpl = globalThis.fetch, reessaisDebit = 2 } = {}) {
    const racine = String(base).replace(/\/+$/, '');

    async function requete(methode, chemin, { body, query, files, raison, brut = false } = {}) {
        let url = `${racine}${chemin}`;
        if (query) {
            const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
            const chaine = params.toString();
            if (chaine) url += `?${chaine}`;
        }

        const headers = {
            // « The value after `Bot ` is the application's snowflake, a full
            // stop, and the secret. » (authentication.md) Le préfixe est exact,
            // sensible à la casse, sans espace superflu : « a padded value never
            // authenticates ».
            Authorization: `Bot ${jeton}`,
            Accept: 'application/json',
        };
        // « X-Audit-Log-Reason | Free-text reason recorded on the resulting audit
        // log entry ». Normalisée à 512 caractères côté serveur ; on tronque
        // pour que le motif reste lisible plutôt que rejeté en silence.
        if (raison) headers['X-Audit-Log-Reason'] = String(raison).slice(0, 512);

        let corps;
        if (files && files.length > 0) {
            // Multipart DIRECT : `payload_json` + `files[N]`, avec N à partir de
            // zéro (messages.mdx, § Multipart body). Voir `api.requeteMessage`
            // pour la métadonnée `attachments` qui va avec — sans elle, un
            // fichier ne se rattache à rien.
            const form = new FormData();
            if (body !== undefined) form.append('payload_json', JSON.stringify(body));
            files.forEach((fichier, index) => {
                const donnees = fichier.data instanceof Blob
                    ? fichier.data
                    : new Blob([fichier.data], { type: fichier.contentType || 'application/octet-stream' });
                form.append(`files[${index}]`, donnees, fichier.name);
            });
            corps = form;
            // Surtout PAS de Content-Type posé à la main : la frontière multipart
            // est choisie par FormData, et l'écraser rend le corps illisible.
        } else if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            corps = JSON.stringify(body);
        }

        let reponse;
        for (let tentative = 0; ; tentative++) {
            reponse = await fetchImpl(url, { method: methode, headers, body: corps });
            // « Fluxer denies an over-allowance request with 429, code set to
            // RATE_LIMITED […] retry_after in the response body reports the
            // shorter delay after which one further request is admitted. »
            if (reponse.status !== 429 || tentative >= reessaisDebit) break;
            const attente = await lireRetryAfter(reponse);
            await new Promise(r => setTimeout(r, attente).unref?.());
        }

        if (reponse.status === 204) return null;

        const texte = await reponse.text().catch(() => '');
        let donnees = null;
        if (texte) { try { donnees = JSON.parse(texte); } catch { donnees = texte; } }

        if (!reponse.ok) {
            const code = (donnees && typeof donnees === 'object' && typeof donnees.code === 'string')
                ? donnees.code
                : null;
            const message = (donnees && typeof donnees === 'object' && donnees.message)
                ? donnees.message
                : `${methode} ${chemin} a répondu ${reponse.status}`;
            throw new ErreurApiFluxer(message, { code, status: reponse.status, methode, url, donnees });
        }

        return brut ? { donnees, reponse } : donnees;
    }

    return {
        get: (chemin, options) => requete('GET', chemin, options),
        post: (chemin, options) => requete('POST', chemin, options),
        patch: (chemin, options) => requete('PATCH', chemin, options),
        put: (chemin, options) => requete('PUT', chemin, options),
        delete: (chemin, options) => requete('DELETE', chemin, options),
        requete,
        racine,
    };
}

/** Délai d'attente d'un 429, en millisecondes. Corps d'abord, en-tête ensuite. */
async function lireRetryAfter(reponse) {
    try {
        const corps = await reponse.clone().json();
        if (Number.isFinite(corps?.retry_after)) return Math.ceil(corps.retry_after * 1000);
    } catch { /* corps illisible : on retombe sur l'en-tête */ }
    const entete = Number(reponse.headers?.get?.('Retry-After'));
    return Number.isFinite(entete) && entete > 0 ? entete * 1000 : 1000;
}

// ─── État local ──────────────────────────────────────────────────────────────

/** Conserve les N dernières entrées d'une Map, dans l'ordre d'insertion. */
function borner(map, taille) {
    while (map.size > taille) {
        const plusAncien = map.keys().next();
        if (plusAncien.done) return;
        map.delete(plusAncien.value);
    }
}

/**
 * État des serveurs vus par la session.
 *
 * Alimenté par la rafale de `GUILD_CREATE` qui suit READY — « A bot session
 * receives one Guild Create per available guild immediately after Ready » — puis
 * par les événements. Chaque collection d'un `GUILD_CREATE` REMPLACE la copie
 * locale : « Every collection in the event replaces the client's copy for that
 * guild. »
 */
function creerEtat() {
    /** @type {Map<string, object>} */
    const guildes = new Map();
    /** @type {Map<string, object>} */
    const messages = new Map();

    function guilde(guildeId) {
        return guildes.get(String(guildeId)) || null;
    }

    function assurerGuilde(guildeId) {
        const cle = String(guildeId);
        let g = guildes.get(cle);
        if (!g) {
            g = {
                id: cle,
                proprietes: {},
                roles: new Map(),
                canaux: new Map(),
                membres: new Map(),
                etatsVocaux: new Map(),
                disponible: true,
            };
            guildes.set(cle, g);
        }
        return g;
    }

    return {
        guildes,
        guilde,

        /** Remplace l'instantané d'un serveur (GUILD_CREATE, GUILD_SYNC). */
        poserGuilde(pret) {
            if (!pret?.id) return null;
            const g = assurerGuilde(pret.id);
            // Un serveur indisponible est réduit à `{id, unavailable: true}` :
            // il n'a AUCUN autre champ, et écraser les collections avec du vide
            // effacerait un état parfaitement valide pendant une panne.
            if (pret.unavailable === true) {
                g.disponible = false;
                return g;
            }
            g.disponible = true;
            if (pret.properties) g.proprietes = { ...pret.properties, id: pret.id };
            if (Array.isArray(pret.roles)) {
                g.roles = new Map(pret.roles.map(r => [String(r.id), r]));
            }
            if (Array.isArray(pret.channels)) {
                g.canaux = new Map(pret.channels.map(c => [String(c.id), c]));
            }
            if (Number.isFinite(pret.member_count)) g.proprietes.member_count = pret.member_count;
            if (Array.isArray(pret.voice_states)) {
                g.etatsVocaux = new Map(
                    pret.voice_states.filter(v => v?.user_id).map(v => [String(v.user_id), v])
                );
            }
            // Les membres d'un GUILD_CREATE de rafale ont leur `user` réduit à
            // `{id}` : on les enregistre quand même, ils portent `roles` et
            // `communication_disabled_until`, qui sont ce dont on a besoin.
            if (Array.isArray(pret.members)) {
                for (const membre of pret.members) {
                    const id = membre?.user?.id ?? membre?.id;
                    if (id) g.membres.set(String(id), { ...membre, guild_id: pret.id });
                }
                borner(g.membres, MEMBRES_PAR_GUILDE);
            }
            return g;
        },

        retirerGuilde(guildeId, { indisponible = false } = {}) {
            const cle = String(guildeId);
            // Indisponible ≠ parti. « With unavailable: true, the guild is
            // retained in a placeholder state and a later Guild Create restores
            // it. » Le supprimer ferait perdre ses rôles pour rien.
            if (indisponible) {
                const g = guildes.get(cle);
                if (g) g.disponible = false;
                return;
            }
            guildes.delete(cle);
        },

        majProprietes(guildeBrute) {
            if (!guildeBrute?.id) return;
            const g = assurerGuilde(guildeBrute.id);
            g.proprietes = { ...g.proprietes, ...guildeBrute };
            if (guildeBrute.unavailable !== undefined) g.disponible = guildeBrute.unavailable !== true;
        },

        // ─── Rôles ───────────────────────────────────────────────────────────
        poserRole(guildeId, role) {
            if (!role?.id) return;
            assurerGuilde(guildeId).roles.set(String(role.id), role);
        },
        retirerRole(guildeId, roleId) {
            guilde(guildeId)?.roles.delete(String(roleId));
        },
        role(guildeId, roleId) {
            return guilde(guildeId)?.roles.get(String(roleId)) || null;
        },
        roles(guildeId) {
            return guilde(guildeId)?.roles || new Map();
        },

        // ─── Salons ──────────────────────────────────────────────────────────
        poserCanal(canal) {
            if (!canal?.id || !canal.guild_id) return;
            assurerGuilde(canal.guild_id).canaux.set(String(canal.id), canal);
        },
        retirerCanal(canal) {
            if (!canal?.id || !canal.guild_id) return;
            guilde(canal.guild_id)?.canaux.delete(String(canal.id));
        },
        canal(canalId) {
            for (const g of guildes.values()) {
                const trouve = g.canaux.get(String(canalId));
                if (trouve) return trouve;
            }
            return null;
        },

        // ─── Membres ─────────────────────────────────────────────────────────
        poserMembre(guildeId, membre) {
            const id = membre?.user?.id ?? membre?.id;
            if (!id) return null;
            const g = assurerGuilde(guildeId);
            const cle = String(id);
            const ancien = g.membres.get(cle) || null;
            // Fusion et non remplacement : un membre issu d'un MESSAGE_CREATE a
            // son `user` retiré (il est dans `author`), et l'écraser perdrait
            // l'identité déjà connue.
            const fusionne = { ...(ancien || {}), ...membre, guild_id: String(guildeId) };
            if (!membre.user && ancien?.user) fusionne.user = ancien.user;
            g.membres.delete(cle);
            g.membres.set(cle, fusionne);
            borner(g.membres, MEMBRES_PAR_GUILDE);
            return ancien;
        },
        retirerMembre(guildeId, membreId) {
            const g = guilde(guildeId);
            if (!g) return null;
            const cle = String(membreId);
            const ancien = g.membres.get(cle) || null;
            g.membres.delete(cle);
            return ancien;
        },
        membre(guildeId, membreId) {
            return guilde(guildeId)?.membres.get(String(membreId)) || null;
        },

        // ─── États vocaux ────────────────────────────────────────────────────
        /** @returns {object|null} l'état PRÉCÉDENT, que l'événement ne porte pas */
        poserEtatVocal(etat) {
            if (!etat?.guild_id || !etat.user_id) return null;
            const g = assurerGuilde(etat.guild_id);
            const cle = String(etat.user_id);
            const ancien = g.etatsVocaux.get(cle) || null;
            // `channel_id: null` = la personne a quitté : on retire l'entrée,
            // sinon le salon resterait « occupé » par un fantôme.
            if (etat.channel_id === null || etat.channel_id === undefined) g.etatsVocaux.delete(cle);
            else g.etatsVocaux.set(cle, etat);
            return ancien;
        },
        etatVocal(guildeId, membreId) {
            return guilde(guildeId)?.etatsVocaux.get(String(membreId)) || null;
        },
        /** Occupants d'un salon vocal, tous serveurs confondus. */
        membresDuVocal(canalId) {
            const cible = String(canalId);
            for (const g of guildes.values()) {
                const dedans = [...g.etatsVocaux.values()].filter(v => String(v.channel_id) === cible);
                if (dedans.length > 0 || g.canaux.has(cible)) {
                    return dedans.map(v => v.member
                        ? { ...v.member, guild_id: g.id, user: v.member.user || { id: v.user_id } }
                        : g.membres.get(String(v.user_id)) || { user: { id: v.user_id }, guild_id: g.id });
                }
            }
            return null;
        },

        // ─── Messages ────────────────────────────────────────────────────────
        /** @returns {object|null} la version PRÉCÉDENTE, pour `messageModifie` */
        poserMessage(message) {
            if (!message?.id) return null;
            const cle = String(message.id);
            const ancien = messages.get(cle) || null;
            messages.delete(cle);
            messages.set(cle, message);
            borner(messages, MESSAGES_CACHE);
            return ancien;
        },
        message(messageId) {
            return messages.get(String(messageId)) || null;
        },
        retirerMessage(messageId) {
            const cle = String(messageId);
            const ancien = messages.get(cle) || null;
            messages.delete(cle);
            return ancien;
        },
    };
}

// ─── Passerelle ──────────────────────────────────────────────────────────────

/**
 * Connexion à la passerelle Fluxer.
 *
 * Séquence de `gateway/overview.md` § Connecting, à la lettre :
 *   1. ouvrir la WebSocket sur `?v=1&encoding=json` ;
 *   2. lire l'Opcode 10 Hello et son `heartbeat_interval` ;
 *   3. envoyer l'Opcode 2 Identify avec `token` et `properties` ;
 *   4. lire READY et conserver son `session_id` ;
 *   5. battre l'Opcode 1 avec la dernière séquence reçue.
 *
 * ⚠️ Pas d'intents. L'Identify de Fluxer n'accepte que `token` et `properties` :
 * il n'y a rien à demander, la session reçoit ce que les permissions du bot lui
 * donnent. C'est la différence la plus visible avec Discord, et elle simplifie —
 * aucun intent privilégié à faire approuver dans un portail.
 *
 * ⚠️ Le jeton part SANS le préfixe « Bot » : « The token is the raw account or
 * bot token, with no HTTP authentication prefix, so a bot sends it without the
 * `Bot ` prefix the HTTP API requires. »
 */
function creerPasserelle({ url = URL_PASSERELLE_DEFAUT, jeton, WebSocketImpl = globalThis.WebSocket, journal = console } = {}) {
    const emetteur = new EventEmitter();
    // Plusieurs consommateurs s'abonnent (adaptateur, tests) : une limite à dix
    // produirait un avertissement trompeur sur un bot qui écoute seize
    // événements.
    emetteur.setMaxListeners(0);

    let socket = null;
    let sessionId = null;
    let sequence = null;
    let battement = null;
    let dernierAck = 0;
    let latence = null;
    let arretDemande = false;
    let reconnexions = 0;
    let premiereConnexion = null; // { resoudre, rejeter }

    function envoyer(op, d) {
        if (socket?.readyState !== 1) return false;
        socket.send(JSON.stringify({ op, d }));
        return true;
    }

    function battre() {
        dernierAck = Date.now();
        envoyer(OP.HEARTBEAT, sequence);
    }

    function arreterBattement() {
        if (battement) { clearInterval(battement); battement = null; }
    }

    function demarrerBattement(intervalle) {
        arreterBattement();
        battement = setInterval(battre, intervalle);
        // Sans `unref`, le minuteur maintient le processus en vie et un arrêt
        // propre attend indéfiniment.
        battement.unref?.();
    }

    function identifier() {
        if (sessionId && sequence !== null) {
            // « Opcode 6 supplies the original token, the Ready session_id, and
            // the last processed Dispatch sequence. »
            envoyer(OP.RESUME, { token: jeton, session_id: sessionId, seq: sequence });
            return;
        }
        envoyer(OP.IDENTIFY, {
            token: jeton,
            // « `token` and `properties` are the only required fields. »
            properties: { os: process.platform, browser: 'Quasar', device: 'Quasar' },
        });
    }

    function traiter(donnees) {
        let charge;
        try { charge = JSON.parse(donnees); } catch { return; }
        const { op, t, s, d } = charge || {};

        if (Number.isFinite(s)) sequence = s;

        switch (op) {
            case OP.HELLO:
                demarrerBattement(d?.heartbeat_interval || 41250);
                battre();
                identifier();
                return;
            case OP.HEARTBEAT:
                // « A client MUST answer the server's Opcode 1 with its own
                // Opcode 1. » Ne pas le faire mène à la fermeture 4009.
                battre();
                return;
            case OP.HEARTBEAT_ACK:
                if (dernierAck) latence = Date.now() - dernierAck;
                return;
            case OP.RECONNECT:
                // La fermeture 4000 suit immédiatement ; on la laisse arriver et
                // c'est le gestionnaire de fermeture qui relance.
                return;
            case OP.INVALID_SESSION:
                // « Fluxer never sends Opcode 9 with d: true, so an Invalid
                // Session is never an instruction to resume. » On repart donc
                // d'une session neuve, sans exception à traiter.
                sessionId = null;
                sequence = null;
                return;
            case OP.DISPATCH:
                break;
            default:
                // « A client SHOULD log an unknown opcode and ignore the frame,
                // and MUST NOT close or reconnect solely because the server used
                // an opcode newer than this registry. »
                return;
        }

        if (t === 'READY') {
            sessionId = d?.session_id ?? null;
            reconnexions = 0;
            emetteur.emit('pret', d);
            if (premiereConnexion) { premiereConnexion.resoudre(d); premiereConnexion = null; }
            return;
        }
        if (t === 'RESUMED') {
            reconnexions = 0;
            emetteur.emit('repris', d);
            return;
        }
        emetteur.emit('dispatch', t, d);
    }

    function surFermeture(code, raison) {
        arreterBattement();
        socket = null;

        const fatale = FERMETURES_FATALES[code];
        const explication = EXPLICATIONS_FERMETURE[code];

        if (fatale) {
            const err = new Error(
                `Passerelle Fluxer : connexion refusée (${code} ${fatale}${raison ? ` — « ${raison} »` : ''}). `
                + (explication || '')
            );
            err.code = code;
            err.fatale = true;
            // ⚠️ Pile volontairement réduite au message.
            //
            // `index.js` termine sur `console.error('Erreur fatale:', err)`, qui
            // imprime la pile d'un objet Error. Or celle-ci désigne l'écouteur
            // de fermeture de la WebSocket : une dizaine de lignes d'internes
            // Node qui ne disent RIEN de la cause, et qui enterrent le seul
            // renseignement utile — « le jeton est refusé, voici quoi faire ».
            //
            // Ce n'est pas un défaut masqué : cette erreur n'a qu'une cause, la
            // passerelle a refusé la session, et son message la nomme
            // entièrement. Le code de fermeture reste lisible dans `err.code`.
            err.stack = err.message;
            if (premiereConnexion) { premiereConnexion.rejeter(err); premiereConnexion = null; }
            else emetteur.emit('fatale', err);
            return;
        }

        if (arretDemande) { emetteur.emit('ferme', code, raison); return; }

        // Reprise. Le repli est plafonné : au-delà, on continue d'essayer à
        // intervalle constant plutôt que d'abandonner — une panne de passerelle
        // ne doit pas laisser le bot muet pour toujours.
        reconnexions += 1;
        const attente = Math.min(1000 * 2 ** Math.min(reconnexions, 5), 30000);
        emetteur.emit('deconnecte', { code, raison, reconnexionDans: attente });
        journal.warn?.(
            `[Quasar] Passerelle Fluxer fermée (${code}${raison ? ` ${raison}` : ''}), `
            + `nouvelle tentative dans ${Math.round(attente / 1000)} s.`
        );
        setTimeout(() => { if (!arretDemande) ouvrir(); }, attente).unref?.();
    }

    function ouvrir() {
        if (typeof WebSocketImpl !== 'function') {
            throw new Error(
                'Aucune implémentation WebSocket disponible. Node 22 en fournit une globalement : '
                + 'vérifiez la version du runtime, ou injectez-en une par l\'option WebSocketImpl.'
            );
        }
        socket = new WebSocketImpl(url);
        socket.addEventListener('message', (evt) => traiter(
            typeof evt.data === 'string' ? evt.data : Buffer.from(evt.data).toString('utf8')
        ));
        socket.addEventListener('close', (evt) => surFermeture(evt.code, evt.reason));
        socket.addEventListener('error', (evt) => {
            // Une erreur de transport est TOUJOURS suivie d'une fermeture : on
            // ne relance pas ici, sous peine d'ouvrir deux sockets.
            emetteur.emit('erreur', evt?.error || new Error('Erreur de transport de la passerelle Fluxer.'));
        });
    }

    return {
        emetteur,
        get latence() { return latence; },
        get sessionId() { return sessionId; },
        get sequence() { return sequence; },

        /**
         * Ouvre la connexion et rend quand READY est reçu.
         *
         * Rejette si la passerelle refuse la session AVANT tout READY — c'est le
         * cas du jeton invalide, et c'est la seule façon pour `index.js` d'en
         * faire un message d'exploitation plutôt qu'une trace d'exception.
         */
        connecter({ delai = 30000 } = {}) {
            arretDemande = false;
            return new Promise((resolve, reject) => {
                const minuteur = setTimeout(() => {
                    premiereConnexion = null;
                    reject(new Error(
                        `Passerelle Fluxer : aucun READY reçu en ${Math.round(delai / 1000)} s sur ${url}. `
                        + 'Vérifiez FLUXER_GATEWAY_URL et la joignabilité de l\'instance.'
                    ));
                }, delai);
                minuteur.unref?.();

                premiereConnexion = {
                    resoudre: (d) => { clearTimeout(minuteur); resolve(d); },
                    rejeter: (err) => { clearTimeout(minuteur); reject(err); },
                };
                try { ouvrir(); } catch (err) { premiereConnexion = null; clearTimeout(minuteur); reject(err); }
            });
        },

        fermer() {
            arretDemande = true;
            arreterBattement();
            try { socket?.close(1000, 'Arrêt de Quasar'); } catch { /* déjà fermée */ }
            socket = null;
        },
    };
}

// ─── Client complet ──────────────────────────────────────────────────────────

/**
 * Assemble REST, passerelle et état derrière un objet unique.
 *
 * L'objet est un `EventEmitter` et expose `user` et `guilds.cache`. Ce n'est pas
 * une imitation de discord.js par goût : `bot/index.js` — que le lot 6 n'a pas
 * le droit de modifier — pose `client.commands`, s'abonne à `clientReady` et lit
 * `client.guilds.cache` au démarrage des services. Ce strict minimum lui permet
 * de démarrer sur Fluxer sans être touché ; le reste est l'affaire du lot 7.
 *
 * ⚠️ Rien n'est construit tant que la fabrique n'est pas appelée : `require` de
 * ce module n'ouvre aucun socket et ne lit aucun jeton. C'est la condition pour
 * que `bot/platform/index.js` puisse résoudre l'adaptateur sans effet de bord.
 */
function creerClient({ env = process.env, fetch: fetchImpl, WebSocketImpl, journal = console } = {}) {
    const jeton = env.FLUXER_TOKEN || '';
    const rest = creerRest({ base: env.FLUXER_API_BASE || BASE_REST_DEFAUT, jeton, fetch: fetchImpl });
    const etat = creerEtat();
    const passerelle = creerPasserelle({
        url: env.FLUXER_GATEWAY_URL || URL_PASSERELLE_DEFAUT,
        jeton,
        WebSocketImpl,
        journal,
    });

    const client = new EventEmitter();
    client.setMaxListeners(0);

    client.rest = rest;
    client.etat = etat;
    client.passerelle = passerelle;
    client.user = null;
    // Résolue UNE FOIS, depuis l'env injecté et non `process.env` : c'est ce qui
    // rend `FLUXER_MEDIA_BASE` honorée par une instance auto-hébergée comme par
    // un test, et ce qui évite une lecture d'environnement par emoji rendu.
    client.baseMedia = env.FLUXER_MEDIA_BASE || BASE_MEDIA_DEFAUT;
    // Pont de transition pour `bot/index.js` uniquement. Les serveurs vivent
    // dans `etat.guildes` ; `guilds.cache` en est une vue, pas une seconde
    // source. À retirer au lot 7.
    client.guilds = { get cache() { return etat.guildes; } };
    client.isReady = () => Boolean(client.user);
    client.ws = { get ping() { return passerelle.latence; } };

    passerelle.emetteur.on('pret', (d) => {
        client.user = d?.user || null;
        // `clientReady` est le nom que `bot/index.js` attend. Il est émis APRÈS
        // la rafale de GUILD_CREATE côté Discord ; ici READY précède la rafale
        // (« a bot session receives one Guild Create per available guild
        // immediately after Ready »), donc `guilds.cache` peut être vide au
        // moment où les services démarrent.
        // À VÉRIFIER EN RECETTE : le décompte de serveurs affiché au démarrage
        // est-il nul ? Si oui, il faudra temporiser sur la fin de la rafale.
        client.emit('clientReady', client);
        client.emit('ready', client);
    });
    passerelle.emetteur.on('dispatch', (t, d) => {
        appliquerAEtat(etat, t, d);
        client.emit('dispatch', t, d);
    });
    passerelle.emetteur.on('fatale', (err) => client.emit('fatale', err));
    passerelle.emetteur.on('erreur', (err) => client.emit('erreurPasserelle', err));

    client.connecter = (options) => passerelle.connecter(options);
    client.deconnecter = () => { passerelle.fermer(); client.user = null; };

    return client;
}

/**
 * Tient l'état local à jour, AVANT que l'événement ne parte vers le métier.
 *
 * ⚠️ L'ORDRE EST LE SUJET de cette fonction, et ce qui n'y figure PAS compte
 * autant que ce qui y figure.
 *
 * Cinq familles d'événements ne livrent pas l'état précédent — un message
 * modifié, un membre modifié, un état vocal, un rôle supprimé, un serveur quitté
 * — et le contrat neutre, lui, doit le fournir. `events.js` le lit dans l'état
 * local pendant la normalisation, PUIS écrit le nouveau. Leur mise à jour est
 * donc faite là-bas et surtout pas ici : la faire ici d'abord détruirait
 * exactement l'information qu'on vient chercher.
 *
 * Concrètement, si `GUILD_ROLE_DELETE` retirait le rôle ici, le journal de
 * suppression n'aurait plus qu'un identifiant à afficher — et rien ne le
 * signalerait.
 */
function appliquerAEtat(etat, type, d) {
    switch (type) {
        case 'GUILD_CREATE':
        case 'GUILD_SYNC':
            etat.poserGuilde(d);
            return;
        case 'GUILD_UPDATE':
            etat.majProprietes(d);
            return;
        case 'GUILD_ROLE_CREATE':
        case 'GUILD_ROLE_UPDATE':
            etat.poserRole(d?.guild_id, d?.role);
            return;
        case 'GUILD_ROLE_UPDATE_BULK':
            for (const role of d?.roles || []) etat.poserRole(d?.guild_id, role);
            return;
        case 'CHANNEL_CREATE':
        case 'CHANNEL_UPDATE':
            etat.poserCanal(d);
            return;
        case 'CHANNEL_UPDATE_BULK':
            for (const canal of d?.channels || []) etat.poserCanal({ guild_id: d?.guild_id, ...canal });
            return;
        case 'CHANNEL_DELETE':
            etat.retirerCanal(d);
            return;
        default:
    }
}

module.exports = {
    creerClient,
    creerRest,
    creerEtat,
    creerPasserelle,
    appliquerAEtat,
    ErreurApiFluxer,
    OP,
    FERMETURES_FATALES,
    EXPLICATIONS_FERMETURE,
    BASE_REST_DEFAUT,
    URL_PASSERELLE_DEFAUT,
    BASE_MEDIA_DEFAUT,
    MEMBRES_PAR_GUILDE,
    MESSAGES_CACHE,
};
