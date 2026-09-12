// ═══════════════════════════════════════════════════════════════
//  Adaptateur Fluxer
//
//  Assemble les six pièces — client, commandes, contexte, événements, rendu,
//  panneaux — derrière le contrat de la DA §4, et n'ajoute aucune logique
//  métier. Aucun `require('discord.js')` n'apparaît dans ce dossier : c'est la
//  contrepartie de la règle qui réserve discord.js à `bot/platform/discord/`.
//
//  La fabrique est appelée par `resolvePlatform()`. Elle accepte un `client`
//  déjà construit : c'est ce qui permet aux tests de travailler sans jeton et
//  sans réseau, et ce qui laisse `bot/index.js` maître du cycle de vie.
//
//  ⚠️ Rien n'est instancié au `require` de ce module : ni socket, ni lecture de
//  jeton, ni appel réseau. `bot/platform/index.js` doit pouvoir résoudre
//  l'adaptateur sans effet de bord, et le garde de configuration d'`index.js`
//  doit pouvoir refuser un démarrage AVANT que quoi que ce soit ne s'ouvre.
//
//  ─── Un seul écouteur de passerelle ─────────────────────────────────────────
//
//  Contrairement à l'adaptateur Discord, qui pose un `client.on()` par
//  abonnement, celui-ci n'écoute la passerelle QU'UNE FOIS et redistribue. Ce
//  n'est pas une préférence de style : trois événements Fluxer ne livrent que le
//  nouvel état, et leur « avant » est lu dans l'état local juste avant d'y
//  écrire (cf. `events.js`). Normaliser une deuxième fois pour un deuxième
//  abonné rendrait donc un « avant » déjà égal à l'« après », et la comparaison
//  de `guildMemberUpdate` — celle qui détecte un changement de rôle — ne
//  verrait plus jamais rien changer.
// ═══════════════════════════════════════════════════════════════

const { creerClient } = require('./client');
const { creerCapacites } = require('../capabilities');
const { creerApi } = require('./api');
const {
    chargerCommandes, construireSlashCommand, construireIndex, analyser, remplirOptions,
    construireAide, verifierAcces, verifierAccesCommandePersonnalisee, rendreCommandePersonnalisee,
    PREFIXE_PAR_DEFAUT,
} = require('./commands');
const { surEvenement, chargerEvenements, creerContexteEvenement, EVENEMENTS, NOMS_EVENEMENTS } = require('./events');
const { chargerPanneaux } = require('../panneaux');
const { mentionsAutoriseesPour, restreindreMentionsAuDeclencheur } = require('../accesCommandePersonnalisee');
const {
    creerContextePanneau, poserPanneau,
    normaliserUtilisateur, normaliserMembre, normaliserCanal, normaliserRole,
} = require('./context');
const { BITS } = require('./permissions');
const { cleEmoji, resoudreEmoji } = require('./events');

// Index inverse, calculé une fois : la boucle de distribution traverse cette
// table pour CHAQUE message de CHAQUE serveur, et une recherche linéaire sur
// dix-sept entrées n'a pas sa place sur ce chemin.
const NEUTRE_PAR_NATIF = new Map(
    Object.entries(EVENEMENTS)
        .filter(([, [natif]]) => natif !== null)
        .map(([neutre, [natif]]) => [natif, neutre]),
);

// Séparateur entre le nom d'un panneau et la clé du choix. Sans objet côté
// Fluxer — une réaction n'a pas d'identifiant composé — mais le nom de panneau
// reste soumis à la même contrainte, pour qu'un descripteur valide d'un côté le
// soit de l'autre.
const SEPARATEUR_PANNEAU = ':';

// ─── Capacités déclarées (DA §4.2) ───────────────────────────────────────────
//
// Chaque ligne porte sa source. Une capacité qu'on ne sait pas justifier reste
// fausse : c'est le défaut de `creerCapacites`, et c'est le bon — un adaptateur
// qui surestime ce qu'il sait faire produit des parcours qui échouent à
// l'usage, là où un adaptateur qui sous-estime produit des parcours dégradés
// mais fonctionnels.
const CAPACITES_FLUXER = creerCapacites({
    // `fluxer_gateway/src/utils/event_atoms.erl` énumère TOUS les événements
    // dispatchés : il n'y a aucun INTERACTION_CREATE. Aucune route de composant
    // ni de commande d'application n'existe dans l'API HTTP.
    interactions: false,

    // Dépend des interactions : sans réponse d'interaction, il n'existe aucun
    // message visible du seul destinataire. Déclaré explicitement et non déduit
    // — le contrat exige qu'une capacité soit affirmée, pas devinée.
    ephemere: false,

    // Aucune modération automatique native : ni route, ni événement, ni fichier
    // dans `fluxerapp/fluxer`. `grep -i automod` sur la documentation HTTP et
    // passerelle ne rend rien.
    automod: false,

    // La voix passe par LiveKit et Fluxer ne publie aucun protocole de
    // signalisation propre : `@discordjs/voice` est inutilisable. Le module
    // musique déclare `plateformes: ['discord']` et n'est donc pas chargé.
    audioBot: false,

    // `communication_disabled_until` et `timeout_reason` sur le membre, plafond
    // 365,25 jours, permission MODERATE_MEMBERS (1<<40).
    // Source : http-api/guild-members.mdx, « Guild member update object ».
    timeout: true,

    // `POST /v1/channels/{id}/messages/bulk-delete`, 1 à 100 messages, et
    // `MESSAGE_DELETE_BULK` est dispatché par la passerelle.
    // Source : http-api/messages.mdx, § « Bulk delete messages ».
    bulkDelete: true,

    // ⚠️ ÉCART ASSUMÉ AVEC LA DA §4.2, QUI DÉCLARE `true`.
    //
    // Fluxer n'a AUCUN fil, et deux sources indépendantes le disent :
    //   • `http-api/channels.mdx`, table « Channel types », énumère 0 GUILD_TEXT,
    //     1 DM, 2 GUILD_VOICE, 3 GROUP_DM, 4 GUILD_CATEGORY, 998 GUILD_LINK,
    //     999 DM_PERSONAL_NOTES — et rien d'autre ;
    //   • `event_atoms.erl` ne dispatche aucun THREAD_*.
    // Le mot « thread » n'apparaît nulle part dans la documentation HTTP ni
    // passerelle. La DA annonçait « threads livrés en juillet 2026 » ; la
    // documentation de septembre 2026 ne les porte pas.
    //
    // Déclarer `true` ferait tenter un parcours qui n'a pas d'objet, et
    // `normaliserMessage` rend d'ailleurs `estFil: false` sans condition.
    // À VÉRIFIER EN RECETTE : confirmer auprès de l'instance qu'aucun fil
    // n'existe. Si la DA a raison, un seul booléen bascule ici.
    fils: false,

    // Pas de suspension d'invitations À ÉCHÉANCE. Le drapeau `INVITES_DISABLED`
    // de `PATCH /v1/guilds/{id}` ferme le serveur, mais DÉFINITIVEMENT : rien ne
    // le rouvre tout seul, et le balayage du mode panique s'appuie justement sur
    // une échéance. Déclarer `true` laisserait des serveurs fermés indéfiniment.
    // Source : http-api/guilds.mdx, note 14 sur `features`.
    pauseInvitations: false,
});

/**
 * @param {object} [options]
 * @param {object} [options.client] client Fluxer déjà instancié
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {object} adaptateur conforme au contrat de la DA §4
 */
function creerAdaptateurFluxer({ client = null, env = process.env } = {}) {
    const clientFluxer = client || creerClient({ env });
    const prefixe = env.COMMAND_PREFIX || PREFIXE_PAR_DEFAUT;

    // Nom de panneau -> handler, et nom -> d'où vient la déclaration. Comme côté
    // Discord : « déjà enregistré » ne dit pas PAR QUI, et deux déclarations
    // peuvent venir de deux lots qui ne se relisent pas.
    const panneaux = new Map();
    const sourcesPanneaux = new Map();

    // Événement neutre -> abonnés. Un seul écouteur de passerelle redistribue
    // (voir l'en-tête de fichier).
    const abonnes = new Map();

    // Collecteurs en attente : `prompt`, `choose` et `choisirMembre` déposent
    // ici une promesse que le prochain événement correspondant résout.
    const collecteurs = new Set();

    // Index du parseur, rempli par `enregistrerCommandes`.
    let index = new Map();

    const adaptateur = {
        nom: 'fluxer',
        capacites: CAPACITES_FLUXER,
        permissions: BITS,

        // Identité du bot. Renseignée à la connexion : avant, elle est nulle, et
        // le code qui en dépend — le filtrage de ses propres réactions, au
        // premier chef — doit s'abonner à `pret` plutôt que de la lire au
        // chargement.
        moi: { id: null, nom: null },

        // ⚠️ Échappatoire de transition, comme côté Discord : `api/` et le
        // dashboard consomment encore le client natif (lot 7). Rien dans bot/ ne
        // doit s'en servir.
        client: clientFluxer,

        api: creerApi(clientFluxer),

        // ─── Cycle de vie ────────────────────────────────────────────────────

        async connecter(jeton = env.FLUXER_TOKEN) {
            if (!jeton) {
                throw new Error(
                    'FLUXER_TOKEN est absent : impossible de se connecter à Fluxer. '
                    + 'Renseignez la variable, ou démarrez avec QUASAR_PLATFORM=discord.'
                );
            }
            await clientFluxer.connecter();
            return adaptateur;
        },

        async deconnecter() {
            return clientFluxer.deconnecter();
        },

        // ─── Enregistrement ──────────────────────────────────────────────────

        /**
         * « Déploie » les commandes.
         *
         * Il n'y a rien à déployer : une commande préfixée n'est déclarée nulle
         * part, elle est reconnue à la lecture. Cette méthode construit donc
         * l'INDEX du parseur — c'est le strict équivalent fonctionnel du
         * déploiement Discord, et le même appel de `bot/index.js` le déclenche.
         *
         * @param {Array} entrees  produites par `chargerCommandes`
         * @returns {Promise<{indexees: number}>}
         */
        async enregistrerCommandes(entrees) {
            index = construireIndex(entrees || []);
            console.log(
                `[Quasar] ${index.size} commande(s) indexée(s) pour le préfixe « ${prefixe} ». `
                + 'Aucun déploiement : Fluxer n\'a pas de commandes d\'application.'
            );
            return { indexees: index.size };
        },

        // ─── Commandes personnalisées, serveur par serveur ───────────────────
        //
        // INERTES, et c'est la conséquence directe de `capacites.interactions`
        // qui vaut false : sur Fluxer une commande personnalisée est une ligne de
        // `custom_commands` que le parseur consulte quand aucune commande
        // déclarée ne correspond. Il n'y a rien à enregistrer auprès de la
        // plateforme, et rien à retirer.
        //
        // Les deux rendent `true` : « il n'y a rien à faire » est un succès, pas
        // un échec, et `/cmd` n'a pas à tester la plateforme.

        async deployerCommandeServeur(guildeId, { nom, description } = {}) {
            if (!adaptateur.capacites.interactions) return true;
            return true;
        },

        async retirerCommandeServeur(guildeId, nom) {
            if (!adaptateur.capacites.interactions) return true;
            return true;
        },

        /**
         * Contexte neutre d'une commande PERSONNALISÉE.
         *
         * Sur Discord, cette méthode est appelée depuis le dispatch natif
         * (`interactionCreate` de `bot/index.js`) parce qu'une commande
         * personnalisée y est une vraie commande d'application, résolue par la
         * plateforme et non par le registre.
         *
         * Ici elle n'est appelée par personne : Fluxer n'a pas d'interactions,
         * et le parseur de ce même adaptateur résout les commandes
         * personnalisées lui-même, en base, quand aucune commande déclarée ne
         * correspond (cf. `traiterCommandePersonnalisee`). La méthode existe
         * pour que la surface des deux adaptateurs reste identique — et parce
         * qu'un appel accidentel doit produire un contexte utilisable plutôt
         * qu'un `is not a function` au milieu d'un dispatch.
         *
         * @param {object} source  source de commande produite par le parseur
         * @param {string} nom     nom de la commande, tel qu'il est en base
         */
        contexteCommandePersonnalisee(source, nom) {
            const { creerContexteCommande } = require('./context');
            return creerContexteCommande(source, {
                adaptateur,
                // Descripteur minimal : une commande personnalisée ne porte
                // aucune option, et n'a donc rien à lire dans le message.
                descripteur: { nom, description: nom, options: [] },
            });
        },

        /**
         * Contrôle d'accès d'une commande PERSONNALISÉE.
         *
         * La règle vit dans `bot/platform/accesCommandePersonnalisee.js`,
         * partagée par les deux adaptateurs : trois modes en base, un membre,
         * ses rôles. Rien n'y connaît de plateforme.
         *
         * Elle est exposée ICI parce que son appelant est le dispatch NATIF —
         * `bot/index.js` côté Discord, le parseur de cet adaptateur côté
         * Fluxer — et qu'un appelant natif n'a pas de contexte neutre sous la
         * main. Il a en revanche l'adaptateur.
         *
         * @param {object} ligne   ligne `custom_commands`
         * @param {object|null} membre  membre NORMALISÉ par cet adaptateur
         * @param {{roles?: Map|Set|object}} [options] rôles du serveur
         * @returns {null|{titre, cause, action}} `null` = accès accordé
         */
        verifierAccesCommandePersonnalisee(ligne, membre, options) {
            return verifierAccesCommandePersonnalisee(ligne, membre, options);
        },

        /**
         * Pose un panneau persistant, depuis un appelant qui n'a QUE
         * l'adaptateur sous la main — une route du dashboard, typiquement.
         *
         * Sur l'adaptateur et non sur `api`, pour la même raison que
         * `enregistrerCommandes` : ce n'est pas un appel REST générique, c'est
         * la pose d'un objet dont le ROUTAGE appartient à la plateforme.
         *
         * ⚠️ Délègue à la fonction interne que `ctx.poserPanneau` appelle déjà —
         * elle n'est pas réécrite. Un panneau posé par le dashboard doit être
         * STRICTEMENT le même que celui d'une commande : même corps, même
         * identifiant de composant, même persistance. Deux constructions
         * séparées produiraient un panneau qui s'affiche parfaitement et ne
         * répond jamais.
         *
         * @param {string} canalId
         * @param {string|object} contenuOuEmbed  chaîne, embed neutre, ou corps
         *   composé `{ contenu, embeds, fichiers }`
         * @param {Array} choix
         * @param {{panneau: string, guildeId?: string}} options
         * @returns {Promise<{canalId: string, messageId: string|null}>}
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, options);
        },

        /**
         * Verrou de mentions d'une commande PERSONNALISÉE.
         *
         * Même raison d'être que `verifierAccesCommandePersonnalisee` juste
         * au-dessus : la règle est neutre — elle ne lit qu'un membre normalisé
         * et les rôles du serveur — mais son appelant est le dispatch NATIF, qui
         * n'a pas de contexte neutre sous la main. Il a en revanche
         * l'adaptateur.
         *
         * @see bot/platform/accesCommandePersonnalisee.js
         */
        mentionsAutoriseesPour(membre, contexte) {
            return mentionsAutoriseesPour(membre, contexte);
        },

        /** @see bot/platform/accesCommandePersonnalisee.js */
        restreindreMentionsAuDeclencheur(mentions, membre, contexte) {
            return restreindreMentionsAuDeclencheur(mentions, membre, contexte);
        },

        /** @see bot/platform/fluxer/events.js pour la table et les payloads. */
        surEvenement(nomNeutre, handler, options) {
            return surEvenement(clientFluxer, adaptateur, nomNeutre, handler, options);
        },

        /** Charge bot/commands/ — descripteurs neutres uniquement. */
        chargerCommandes(options) {
            return chargerCommandes({ ...options, adaptateur });
        },

        /** Charge bot/events/ et branche les handlers migrés. */
        chargerEvenements(options) {
            return chargerEvenements({ ...options, adaptateur });
        },

        /** Charge bot/panneaux/ — les panneaux qui n'ont pas de commande. */
        chargerPanneaux(options) {
            return chargerPanneaux({ ...options, adaptateur });
        },

        // ─── Panneaux persistants ────────────────────────────────────────────

        /**
         * Enregistre le handler des réactions d'un panneau persistant.
         *
         * @param {string} panneau  le même nom que `ctx.choose({ panneau })`
         * @param {(ctx, cle) => Promise<void>} handler  `ctx` est un contexte
         *   COMPLET. Contrairement à Discord, il n'y a aucune fenêtre de trois
         *   secondes à respecter : une réaction n'attend pas d'accusé.
         * @param {string} [source]  d'où vient la déclaration
         */
        surPanneau(panneau, handler, source = null) {
            if (typeof panneau !== 'string' || !panneau || panneau.includes(SEPARATEUR_PANNEAU)) {
                throw new Error(
                    `surPanneau : nom de panneau invalide « ${panneau} ». Attendu une chaîne non vide `
                    + `et sans « ${SEPARATEUR_PANNEAU} », qui sépare le panneau de la clé du choix.`
                );
            }
            if (panneaux.has(panneau)) {
                const dejaPris = sourcesPanneaux.get(panneau);
                throw new Error(
                    `Panneau « ${panneau} » déclaré deux fois`
                    + `${dejaPris && source ? ` : par ${dejaPris} et par ${source}` : ''}`
                    + '. Un panneau n\'appartient qu\'à une déclaration — ses clics ne peuvent pas '
                    + 'être routés deux fois.'
                );
            }
            panneaux.set(panneau, handler);
            if (source) sourcesPanneaux.set(panneau, source);
            return () => { panneaux.delete(panneau); sourcesPanneaux.delete(panneau); };
        },

        /**
         * Route une réaction vers son panneau, s'il en a un.
         *
         * ⚠️ C'est ici que le contrat diverge le plus de Discord. Un bouton porte
         * son panneau et sa clé DANS son `customId` : le routage est une lecture
         * de chaîne. Une réaction ne porte rien — ni panneau, ni clé — et le lien
         * entre le message et son panneau ne vit qu'en base, dans
         * `interaction_panels`. Sans cette table, un panneau cesserait d'exister
         * au premier redémarrage.
         *
         * ⚠️ Le bot IGNORE SES PROPRES RÉACTIONS. Il pose lui-même les emojis
         * d'un panneau : sans ce filtre, chaque panneau se déclencherait tout
         * seul à sa création, autant de fois qu'il a de choix.
         *
         * @returns {Promise<void>|null} `null` si aucun panneau ne revendique ce
         *   message — l'immense majorité des réactions.
         */
        routerPanneau(evenement) {
            const d = evenement?.donnees ?? evenement;
            if (!d?.message_id || !d?.channel_id) return null;
            if (adaptateur.moi.id && String(d.user_id) === String(adaptateur.moi.id)) return null;

            let ligne;
            try {
                const db = require('../../../api/services/database').getDb();
                ligne = db.prepare(
                    'SELECT * FROM interaction_panels WHERE channel_id = ? AND message_id = ?'
                ).get(String(d.channel_id), String(d.message_id));
            } catch (err) {
                // Base indisponible : on ne route pas, mais on le DIT. Avaler
                // l'erreur ferait passer un panneau muet pour un panneau non
                // enregistré, deux causes qui ne se corrigent pas pareil.
                console.error('[Quasar] Routage de panneau impossible (base) :', err?.message || err);
                return null;
            }
            if (!ligne) return null;

            let choix;
            try { choix = JSON.parse(ligne.payload); } catch { choix = []; }
            const emoji = cleEmoji(resoudreEmoji(d, clientFluxer.etat));
            const retenu = (choix || []).find(c => c.emoji === emoji);
            if (!retenu) return null;

            const handler = panneaux.get(ligne.kind);
            if (!handler) return null;

            const ctx = creerContextePanneau({
                guildeId: ligne.guild_id || d.guild_id || null,
                canalId: String(d.channel_id),
                messageId: String(d.message_id),
                auteur: d.member?.user ?? { id: d.user_id },
                membre: d.member ?? null,
                creeLe: Date.now(),
            }, { adaptateur, panneau: ligne.kind, cle: retenu.cle });

            return handler(ctx, retenu.cle);
        },

        /** Exposé pour les tests : descripteur -> forme dérivée de la plateforme. */
        construireSlashCommand,

        EVENEMENTS,
        NOMS_EVENEMENTS,
        SEPARATEUR_PANNEAU,
    };

    // ─── Plomberie interne, volontairement NON ÉNUMÉRABLE ────────────────────
    //
    // Ces méthodes n'ont pas d'équivalent côté Discord — elles remplacent ce que
    // discord.js fournit (collecteurs, cache, routage de composants). Les
    // exposer en clair ferait diverger la surface des deux adaptateurs, que le
    // test de miroir compare clé pour clé. Or c'est cette comparaison, et elle
    // seule, qui garantit qu'une commande migrée trouve bien la même chose des
    // deux côtés.
    //
    // Elles sont donc posées en non énumérable — la convention déjà employée
    // pour `err.codeNeutre` : accessibles à qui les nomme, invisibles à qui
    // énumère.
    const interne = {
        /** Préfixe actif, lu par la dérivation des lignes d'usage. */
        prefixe,

        /** Abonnement d'un handler neutre, appelé par `surEvenement`. */
        abonner(nomNeutre, handler, { une = false, surErreur } = {}) {
            if (!abonnes.has(nomNeutre)) abonnes.set(nomNeutre, new Set());
            const entree = { handler, une, surErreur };
            abonnes.get(nomNeutre).add(entree);
            return () => abonnes.get(nomNeutre)?.delete(entree);
        },

        /**
         * Attend un message, pour `ctx.prompt` et `ctx.choisirMembre`.
         *
         * @param {{canalId, auteurId?, accepte?, delai}} filtre
         * @returns {Promise<object|null>} le message BRUT, ou `null` à expiration
         */
        attendreMessage({ canalId, auteurId = null, accepte = null, delai = 60000 }) {
            return attendre(collecteurs, {
                type: 'MESSAGE_CREATE',
                delai,
                teste: (d, contexte) => {
                    if (String(d.channel_id) !== String(canalId)) return false;
                    // Le bot ne se répond pas à lui-même : il pose les questions.
                    if (adaptateur.moi.id && String(d.author?.id) === String(adaptateur.moi.id)) return false;
                    if (auteurId && String(d.author?.id) !== String(auteurId)) return false;
                    return accepte ? accepte(contexte(d)) : true;
                },
                contexte: (d) => contexteActeur(d, d.author?.id, adaptateur, clientFluxer),
            });
        },

        /**
         * Attend une réaction sur un message donné, pour `ctx.choose`.
         *
         * @param {{canalId, messageId, accepte?, delai}} filtre
         * @returns {Promise<{emojiCle, utilisateurId, membre}|null>}
         */
        attendreReaction({ canalId, messageId, accepte = null, delai = 60000 }) {
            return attendre(collecteurs, {
                type: 'MESSAGE_REACTION_ADD',
                delai,
                teste: (d, contexte) => {
                    if (String(d.message_id) !== String(messageId)) return false;
                    if (String(d.channel_id) !== String(canalId)) return false;
                    // ⚠️ Le piège n°1 des panneaux : le bot appose lui-même les
                    // réactions du panneau. Sans ce filtre, `choose` se résout
                    // tout seul, sur le premier emoji qu'il vient de poser.
                    if (adaptateur.moi.id && String(d.user_id) === String(adaptateur.moi.id)) return false;
                    return accepte ? accepte(contexte(d)) : true;
                },
                contexte: (d) => ({
                    ...contexteActeur(d, d.user_id, adaptateur, clientFluxer),
                    emojiCle: cleEmoji(resoudreEmoji(d, clientFluxer.etat)),
                }),
            });
        },

        /**
         * Enregistre — ou remet à jour — la ligne `interaction_panels` d'un
         * panneau persistant.
         *
         * `ON CONFLICT` plutôt qu'un INSERT nu : la table porte
         * `UNIQUE (channel_id, message_id)`, et reposer un panneau sur le même
         * message (réouverture d'un ticket, mise à jour d'une configuration)
         * doit REMPLACER ses choix, pas échouer.
         */
        enregistrerPanneauPersistant({ guildeId, canalId, messageId, panneau, choix }) {
            if (!messageId) return;
            try {
                const db = require('../../../api/services/database').getDb();
                db.prepare(`
                    INSERT INTO interaction_panels (guild_id, channel_id, message_id, kind, payload)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (channel_id, message_id)
                    DO UPDATE SET kind = excluded.kind, payload = excluded.payload
                `).run(
                    String(guildeId ?? ''), String(canalId), String(messageId), panneau,
                    JSON.stringify(choix || []),
                );
            } catch (err) {
                // Le panneau est posté, ses réactions aussi : il fonctionnera
                // jusqu'au prochain redémarrage. Lever ici annulerait un panneau
                // parfaitement visible. On le dit fort, on ne casse pas.
                console.error(
                    `[Quasar] Panneau ${panneau} NON persisté (${err?.message || err}) : `
                    + 'il cessera de répondre au prochain redémarrage.'
                );
            }
        },

        /**
         * Retire la ligne `interaction_panels` d'un panneau qui n'existe plus.
         *
         * C'est l'adaptateur qui ÉCRIT cette table, c'est donc lui qui la
         * nettoie. Sans ce nettoyage, la table n'était purgée par rien : chaque
         * salon vocal temporaire pose un panneau, donc une ligne, et le salon
         * meurt sans que la ligne parte. La purge de rétention rattrape le
         * départ d'un serveur ; elle ne rattrape pas la vie courante d'un
         * serveur actif.
         *
         * Deux portées, selon ce qui a disparu :
         *   { canalId, messageId } — un message précis ;
         *   { canalId }            — tout le salon.
         *
         * Ne lève jamais : une ligne orpheline est un défaut d'hygiène, pas une
         * panne, et faire échouer le traitement d'un CHANNEL_DELETE pour ça
         * emporterait tout ce qui en dépend.
         */
        retirerPanneauPersistant({ canalId, messageId = null }) {
            if (!canalId) return 0;
            try {
                const db = require('../../../api/services/database').getDb();
                const resultat = messageId
                    ? db.prepare('DELETE FROM interaction_panels WHERE channel_id = ? AND message_id = ?')
                        .run(String(canalId), String(messageId))
                    : db.prepare('DELETE FROM interaction_panels WHERE channel_id = ?').run(String(canalId));
                return resultat.changes || 0;
            } catch (err) {
                console.error(
                    `[Quasar] Panneau non retiré de interaction_panels (${err?.message || err}) : `
                    + 'la ligne restera orpheline jusqu\'à la purge du serveur.'
                );
                return 0;
            }
        },

        /** Redistribution d'un événement de passerelle. Exposée pour les tests. */
        traiterDispatch,
    };

    for (const [nom, valeur] of Object.entries(interne)) {
        Object.defineProperty(adaptateur, nom, { value: valeur, enumerable: false, writable: true });
    }

    // ─── Boucle de distribution ──────────────────────────────────────────────

    /**
     * Traite un événement de passerelle, DANS CET ORDRE :
     *   1. normalisation UNE SEULE FOIS (elle lit l'« avant » dans l'état) ;
     *   2. collecteurs en attente — un dialogue en cours passe avant tout ;
     *   3. routage de panneau, puis parseur de commandes ;
     *   4. handlers métier abonnés.
     *
     * L'ordre 2 avant 3 n'est pas anodin : quelqu'un qui répond « annuler » à un
     * formulaire ne doit pas voir sa réponse relue comme une commande.
     */
    function traiterDispatch(type, d) {
        const neutre = NEUTRE_PAR_NATIF.get(type);
        let args = null;
        if (neutre) {
            try {
                args = { nom: neutre, donnees: EVENEMENTS[neutre][1](d, { etat: clientFluxer.etat }) };
            } catch (err) {
                console.error(`[Quasar] Normalisation de ${type} impossible :`, err?.message || err);
            }
        }

        // Un collecteur en attente CONSOMME l'événement pour la plomberie —
        // parseur de commandes et routage de panneau — mais PAS pour les
        // handlers métier.
        //
        // Les deux moitiés de cette phrase comptent. Sans la première,
        // quelqu'un qui répond « !help » à un formulaire verrait sa réponse
        // relue comme une commande. Sans la seconde, une réponse de dialogue
        // deviendrait invisible à la modération : le salon piège et l'anti-raid
        // cesseraient de voir les messages d'une personne en train de remplir
        // un ticket, ce qui est exactement le trou qu'ils existent pour fermer.
        let consomme = false;
        for (const collecteur of [...collecteurs]) {
            if (collecteur.type !== type) continue;
            try {
                if (collecteur.teste(d, collecteur.contexte)) {
                    collecteurs.delete(collecteur);
                    collecteur.resoudre(collecteur.contexte(d));
                    consomme = true;
                    break;
                }
            } catch (err) {
                console.error('[Quasar] Filtre de collecteur en erreur :', err?.message || err);
            }
        }

        // Hygiène de `interaction_panels` : un panneau dont le message ou le
        // salon disparaît laisse une ligne qui ne pointe plus sur rien, et que
        // `routerPanneau` relira à chaque réaction du salon. Fait AVANT les
        // handlers métier et hors de toute condition de consommation : ce n'est
        // pas un comportement, c'est de la tenue de registre.
        if (type === 'CHANNEL_DELETE' && d?.id) {
            adaptateur.retirerPanneauPersistant({ canalId: d.id });
        }
        if (type === 'MESSAGE_DELETE' && d?.channel_id && d?.id) {
            adaptateur.retirerPanneauPersistant({ canalId: d.channel_id, messageId: d.id });
        }
        if (type === 'MESSAGE_DELETE_BULK' && d?.channel_id && Array.isArray(d.ids)) {
            // Pas un événement neutre — le contrat n'en a pas — mais il efface
            // bel et bien des messages, panneaux compris.
            for (const id of d.ids) {
                adaptateur.retirerPanneauPersistant({ canalId: d.channel_id, messageId: id });
            }
        }

        if (!consomme && type === 'MESSAGE_REACTION_ADD') {
            const routage = adaptateur.routerPanneau({ donnees: d });
            if (routage) Promise.resolve(routage).catch((err) => {
                console.error('[Quasar] ⚠️  Panneau |', err?.message || err);
            });
        }

        if (!consomme && type === 'MESSAGE_CREATE') {
            Promise.resolve().then(() => traiterCommande(d)).catch((err) => {
                console.error('[Quasar] ⚠️  Commande |', err?.message || err);
            });
        }

        if (!args) return;
        const inscrits = abonnes.get(args.nom);
        if (!inscrits) return;
        for (const entree of [...inscrits]) {
            if (entree.une) inscrits.delete(entree);
            // `Promise.resolve().then()` plutôt qu'un try/catch : il attrape
            // aussi bien le throw synchrone que le rejet asynchrone, et la
            // promesse n'est SURTOUT pas laissée flottante.
            Promise.resolve()
                .then(() => entree.handler(creerContexteEvenement(adaptateur), ...args.donnees))
                .catch(err => entree.surErreur?.(err, { evenement: args.nom }));
        }
    }

    /**
     * Parseur : un message ordinaire devient une commande, ou reste un message.
     *
     * Le chemin rapide compte : cette fonction s'exécute pour CHAQUE message de
     * CHAQUE serveur. Les trois premiers tests — bot, contenu, préfixe — ne
     * coûtent rien et écartent l'immense majorité des messages avant toute
     * lecture de base.
     */
    async function traiterCommande(d) {
        if (d?.author?.bot) return;
        if (typeof d?.content !== 'string' || !d.content) return;

        const analyse = analyser(d.content, { prefixe, index });
        if (!analyse) return;

        const source = {
            guildeId: d.guild_id ?? null,
            canalId: d.channel_id,
            auteur: d.author,
            membre: d.member ? { ...d.member, user: d.author, guild_id: d.guild_id } : null,
            messageId: d.id,
            creeLe: d.timestamp ? Date.parse(d.timestamp) : Date.now(),
        };
        const membre = source.membre
            ? normaliserMembre(source.membre, { etat: clientFluxer.etat, guildeId: d.guild_id })
            : null;

        // ── Commande inconnue : c'est peut-être une commande personnalisée ────
        if (analyse.inconnue) return traiterCommandePersonnalisee(analyse, source, membre, d);

        const { descripteur, sousCommande, entree } = analyse;

        // ── Contrôle d'accès, refait ICI parce que Fluxer n'en fait aucun ─────
        const refus = verifierAcces(descripteur, membre, { enPrive: !d.guild_id });
        if (refus) return repondreErreur(source, refus);

        // ── Sous-commande obligatoire mais absente ───────────────────────────
        if (Array.isArray(descripteur.sousCommandes) && !sousCommande) {
            return adaptateur.api.envoyerMessage(
                source.canalId, construireAide(descripteur, null, prefixe),
            );
        }

        // ── Remplissage des options (règles 3 à 6) ───────────────────────────
        const resolveur = creerResolveur(clientFluxer, d);
        const remplissage = remplirOptions(
            sousCommande?.options || descripteur.options,
            analyse.jetons,
            // La ligne BRUTE — préfixe retiré, rien d'autre : `reste: true` la
            // reprend à la position d'un jeton, et toute retouche décalerait
            // l'index et couperait la valeur au mauvais endroit.
            analyse.ligne,
            resolveur,
        );
        if (remplissage.erreur) {
            return adaptateur.api.envoyerMessage(source.canalId, [
                `❌ ${remplissage.erreur}`,
                '',
                construireAide(descripteur, sousCommande, prefixe),
            ].join('\n'));
        }

        source.sousCommande = sousCommande?.nom ?? null;
        source.valeurs = remplissage.valeurs;
        return entree.execute(source);
    }

    /**
     * Commande personnalisée : aucune commande déclarée ne correspond, on
     * consulte `custom_commands`.
     *
     * Même contrôle d'accès et même rendu que côté Discord (cf.
     * `bot/index.js`) : c'est ce contrôle, et lui seul, qui empêche que `/faq`
     * devienne un bouton « pinger tout le serveur » à disposition de tous.
     */
    async function traiterCommandePersonnalisee(analyse, source, membre, d) {
        if (!source.guildeId) return;

        let ligne;
        let db;
        try {
            db = require('../../../api/services/database').getDb();
            ligne = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?')
                .get(source.guildeId, analyse.commande);
        } catch (err) {
            console.error('[Quasar] Commande personnalisée : base inaccessible :', err?.message || err);
            return;
        }
        // Aucune commande de ce nom : on ne répond RIEN. Un « commande
        // inconnue » automatique sur chaque message commençant par « ! » rendrait
        // le bot insupportable dans un salon où l'on ponctue par des points
        // d'exclamation.
        if (!ligne) return;

        const refus = verifierAccesCommandePersonnalisee(ligne, membre, {
            roles: source.guildeId ? clientFluxer.etat.roles(source.guildeId) : null,
        });
        if (refus) return repondreErreur(source, refus);

        // Le membre normalisé porte les permissions calculées : c'est lui qui
        // décide de ce que la commande a le droit de notifier.
        const corps = rendreCommandePersonnalisee(ligne, db, {
            membre,
            roles: source.guildeId ? clientFluxer.etat.roles(source.guildeId) : null,
        });
        if (!corps) return;
        return adaptateur.api.envoyerMessage(source.canalId, corps);
    }

    /** Erreur d'usage, dans le salon, auto-supprimée : ce n'est pas un incident. */
    function repondreErreur(source, { titre, cause, action }) {
        const { construireEmbedErreur } = require('../../utils/errors');
        return adaptateur.api
            .envoyerMessage(source.canalId, construireEmbedErreur({ title: titre, cause, action }))
            .then((message) => {
                const minuteur = setTimeout(() => {
                    adaptateur.api.supprimerMessage(source.canalId, message.id).catch(() => {});
                }, 15000);
                minuteur.unref?.();
                return message;
            })
            .catch(() => null);
    }

    // ─── Branchements ────────────────────────────────────────────────────────

    clientFluxer.on('dispatch', traiterDispatch);
    clientFluxer.on('clientReady', () => {
        adaptateur.moi.id = clientFluxer.user?.id ?? null;
        adaptateur.moi.nom = clientFluxer.user?.username ?? null;
    });

    return adaptateur;
}

/**
 * Dépose un collecteur et rend une promesse qu'un événement résout.
 *
 * Le minuteur d'expiration est `unref()` : sans lui, un `prompt` de cinq minutes
 * retiendrait le processus à l'arrêt, et un redéploiement attendrait.
 */
function attendre(collecteurs, { type, delai, teste, contexte }) {
    return new Promise((resolve) => {
        const collecteur = { type, teste, contexte, resoudre: resolve };
        collecteurs.add(collecteur);
        const minuteur = setTimeout(() => {
            collecteurs.delete(collecteur);
            resolve(null);
        }, delai);
        minuteur.unref?.();
    });
}

/**
 * Contexte d'un acteur (auteur d'un message, auteur d'une réaction), avec son
 * membre normalisé — donc ses permissions calculées. C'est ce que consomme
 * `autoriseClic` pour appliquer `autorise: 'staff'`.
 */
function contexteActeur(d, utilisateurId, adaptateur, client) {
    const guildeId = d.guild_id ?? null;
    const brut = d.member
        ?? (guildeId ? client.etat.membre(guildeId, utilisateurId) : null);
    return {
        ...d,
        utilisateurId: utilisateurId ? String(utilisateurId) : null,
        membre: brut
            ? normaliserMembre(brut, {
                etat: client.etat,
                guildeId,
                utilisateur: d.author ?? brut.user ?? { id: utilisateurId },
            })
            : null,
    };
}

/**
 * Résout les entités d'une commande, pour que `ctx.options.get('membre')` rende
 * un nom et pas seulement un identifiant.
 *
 * Trois sources, dans l'ordre de fiabilité : les `mentions` du message — que
 * Fluxer livre en entier, ce qui évite tout appel — puis l'état local, puis
 * rien. « Rien » n'est pas un échec : `{ id, mention }` suffit à agir, toutes
 * les méthodes d'`api` prenant des identifiants.
 */
function creerResolveur(client, d) {
    const guildeId = d.guild_id ?? null;
    const mentionnes = new Map((d.mentions || []).map(u => [String(u.id), u]));

    return {
        utilisateur(id) {
            const user = mentionnes.get(String(id))
                ?? (guildeId ? client.etat.membre(guildeId, id)?.user : null);
            return user ? normaliserUtilisateur(user) : null;
        },
        canal(id) {
            const canal = client.etat.canal(id);
            return canal ? normaliserCanal(canal) : null;
        },
        role(id) {
            const role = guildeId ? client.etat.role(guildeId, id) : null;
            return role ? normaliserRole(role, { guildeId }) : null;
        },
    };
}

module.exports = creerAdaptateurFluxer;
module.exports.CAPACITES_FLUXER = CAPACITES_FLUXER;
module.exports.SEPARATEUR_PANNEAU = SEPARATEUR_PANNEAU;
module.exports.creerResolveur = creerResolveur;
module.exports.contexteActeur = contexteActeur;
