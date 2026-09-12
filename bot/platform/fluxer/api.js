// ═══════════════════════════════════════════════════════════════
//  Client REST normalisé — Fluxer
//
//  Implémente le vocabulaire unique de la DA §4.3, méthode pour méthode et
//  signature pour signature avec `discord/api.js`. Le code métier n'appelle que
//  ces méthodes ; il n'a jamais à savoir d'où vient l'information.
//
//  Deux principes d'implémentation, et ils DIFFÈRENT de ceux de Discord :
//
//   • Les ÉCRITURES passent par REST, comme là-bas.
//   • Les LECTURES passent par REST **ou** par l'état local selon ce qui est
//     exact, pas selon ce qui est rapide. Il n'y a pas d'objet discord.js qui
//     porte les permissions calculées et la hiérarchie : c'est l'état local qui
//     les porte, alimenté par la rafale de GUILD_CREATE et par les événements.
//     Deux lectures n'ont même AUCUNE route REST — les occupants d'un salon
//     vocal et l'état vocal d'un membre ne se lisent que par la passerelle.
//
//  ⚠️ Bitfields : `allow` et `deny` sont des « decimal string because a
//  permission mask exceeds the range a JSON number preserves » (channels.mdx).
//  Tout ce qui sort d'ici passe par `serialiserBitfield`, et rien n'est calculé
//  en `number` — MODERATE_MEMBERS vaut 1<<40.
// ═══════════════════════════════════════════════════════════════

const { serialiserBitfield, estPermissionCanonique, exigerPermissionCanonique } = require('../permissions');
const { bitfield, BITS, aPermission, masqueMembre, masqueSurCanal } = require('./permissions');
const { CODES_NEUTRES, codeNeutre } = require('../erreurs');
const { marquerErreur, marquerErreursApi } = require('./erreurs');
const { exigerTypeCanalCanonique } = require('../channels');
const { versTypesFluxer } = require('./channels');
const { rendreContenu, rendreChoix, corpsPanneau } = require('./render');
const {
    normaliserMembre, normaliserUtilisateur, normaliserRole, normaliserCanal, normaliserGuilde,
    baseMedia,
} = require('./context');
const { normaliserMessage } = require('./events');
const { dateDuSnowflake } = require('./snowflake');

// ⚠️ DIVERGENCE ASSUMÉE AVEC DISCORD ET AVEC LE BRIEF DU LOT.
//
// Discord rejette le LOT ENTIER si un seul message dépasse quatorze jours
// (erreur 50034), d'où le filtrage en amont de `discord/api.js`. Fluxer, lui,
// déclare l'inverse noir sur blanc : « The operation applies no age boundary, so
// a message of any age can be selected. » (messages.mdx, § Bulk delete messages,
// Limitations). Le handoff d'avril 2026 mentionnait une limite à quatorze jours,
// mais il décrivait un code qui filtrait DE LUI-MÊME, par recopie du réflexe
// Discord — pas un refus observé de l'API.
//
// Filtrer quand même écarterait des messages que la plateforme sait supprimer :
// `/clear 100` annoncerait « 60 supprimés, 40 ignorés » sur un salon où les cent
// étaient effaçables. On ne filtre donc PAS, et `ignores` vaut 0.
//
// À VÉRIFIER EN RECETTE : supprimer en lot un message de plus de quatorze jours.
// Si l'API refuse, il suffit de redonner une valeur à la constante ci-dessous —
// le filtre est écrit, il est seulement désactivé.
const AGE_MAX_SUPPRESSION_LOT_MS = null;

// « Deletes from 1 through 100 messages in one guild channel. » Fluxer accepte
// un lot d'UN SEUL message, là où Discord en exige deux : il n'y a donc pas de
// repli en suppression unitaire à écrire.
const TAILLE_LOT_SUPPRESSION = 100;

// Permission exigée du BOT pour chaque action de sanction, lue dans
// permissions.mdx. C'est la moitié « permission » de
// `verifierMembreSanctionnable` ; l'autre moitié est la hiérarchie des rôles.
// Taille des vignettes d'emoji servies au sélecteur du dashboard. Le proxy média
// « snaps to the ladder » et 32 en fait partie (media-proxy/transformations.md).
const TAILLE_EMOJI = 32;

// Pagination des membres. « limit? | integer | (1-1000, default 1) » : le
// maximum documenté, pour faire le moins d'appels possible sur une route
// limitée à 40 requêtes / 10 s.
const TAILLE_PAGE_MEMBRES = 1000;

// Plafond du balayage. 50 000 membres sur une requête de dashboard, c'est déjà
// bien au-delà de l'usage réel ; au-delà, on rend une liste PARTIELLE en le
// disant plutôt que de tenir une requête HTTP ouverte indéfiniment.
const PAGES_MAX_MEMBRES = 50;

const PERMISSION_PAR_SANCTION = Object.freeze({
    timeout: 'MODERATE_MEMBERS',
    kick: 'KICK_MEMBERS',
    ban: 'BAN_MEMBERS',
});

const SANCTIONS = Object.freeze(Object.keys(PERMISSION_PAR_SANCTION));

// Codes neutres qui valent « la ressource n'existe pas », et pour lesquels un
// lecteur rend `null` plutôt que de lever. TOUT le reste remonte : rendre `null`
// sur une coupure ferait croire que la ressource a disparu, et le balayeur de
// bannissements temporaires en déduirait qu'il peut OUBLIER une échéance.
const ABSENCES = Object.freeze([CODES_NEUTRES.introuvable, CODES_NEUTRES.guilde_inconnue]);

/**
 * Rend `null` si l'erreur signifie « ça n'existe pas », relance sinon.
 * @param {string[]} [absences] codes neutres à traiter comme une absence
 */
function absenceOuLeve(err, absences = ABSENCES) {
    if (absences.includes(codeNeutre(marquerErreur(err)))) return null;
    throw err;
}

// ─── Corps d'un message : rendu -> REST ─────────────────────────────────────
//
// ⚠️ Même piège que côté Discord, et il s'aggrave ici : Fluxer « discards a key
// outside the table above and accepts the rest of the entry » pour les pièces
// jointes, et son schéma de message rejette au contraire un corps invalide en
// bloc avec un `INVALID_MESSAGE_DATA` qui « has no per-field detail ». Une clé
// mal nommée donne donc soit un silence, soit une erreur qui ne dit pas laquelle.
//
// La table ci-dessous couvre TOUT ce que `rendreContenu` peut émettre, et
// `corpsMessage` lève sur une clé absente.

/** Clé produite par `rendreContenu` -> clé du corps REST Fluxer. */
const CLES_CORPS_REST = Object.freeze({
    content: 'content',
    embeds: 'embeds',
    allowedMentions: 'allowed_mentions',
    // Fluxer n'a pas de composants. `rendreContenu` ne les émet pas ; l'entrée
    // existe pour que la table reste exhaustive si le rendu se met à en émettre.
    components: null,
    // `files` ne fait PAS partie du corps JSON : voir `requeteMessage`.
    files: null,
});

/** Verrou de mentions : vocabulaire neutre -> REST Fluxer. */
const CLES_MENTIONS_REST = Object.freeze({
    parse: 'parse',
    roles: 'roles',
    users: 'users',
    repliedUser: 'replied_user',
});

function mentionsRest(mentions) {
    if (!mentions || typeof mentions !== 'object') return mentions;
    const converti = {};
    for (const [cle, valeur] of Object.entries(mentions)) {
        const cleRest = CLES_MENTIONS_REST[cle];
        if (!cleRest) {
            throw new Error(
                `Verrou de mentions : clé « ${cle} » inconnue du corps REST. `
                + `Clés acceptées : ${Object.keys(CLES_MENTIONS_REST).join(', ')}.`
            );
        }
        converti[cleRest] = valeur;
    }
    return converti;
}

/**
 * Corps REST d'un message, à partir d'un contenu ou d'un embed neutre.
 *
 * Les pièces jointes n'y figurent pas : voir `requeteMessage`.
 */
function corpsMessage(contenu) {
    const rendu = rendreContenu(contenu);
    const corps = {};

    for (const [cle, valeur] of Object.entries(rendu)) {
        if (!(cle in CLES_CORPS_REST)) {
            throw new Error(
                `Corps de message : clé « ${cle} » sans correspondance REST. `
                + 'Ajoutez-la à CLES_CORPS_REST — une clé non convertie est perdue en silence.'
            );
        }
        const cleRest = CLES_CORPS_REST[cle];
        if (cleRest === null) continue; // porté hors du corps, ou sans objet ici

        if (cle === 'allowedMentions') corps.allowed_mentions = mentionsRest(valeur);
        else corps[cleRest] = valeur;
    }

    return corps;
}

/**
 * Requête REST complète d'un message : le corps ET les pièces jointes.
 *
 * ⚠️ CE N'EST PAS LE MULTIPART DE DISCORD, et c'est le piège le plus coûteux de
 * l'adaptateur. Les deux plateformes acceptent bien `payload_json` et
 * `files[N]` — mais chez Fluxer un fichier ne se rattache à rien tant que le
 * corps ne le DÉCLARE pas :
 *
 *   « Attachment IDs in a direct multipart request identify the matching
 *     zero-based files[N] field. » (messages.mdx, § Message attachment input)
 *   « An entry whose id matches no supplied file index and that has a filename
 *     fails with the field code NO_FILE_FOR_ATTACHMENT_METADATA. »
 *
 * On construit donc `attachments: [{ id, filename, content_type }]` en regard
 * des fichiers envoyés. Côté Discord, @discordjs/rest ne le fait pas et l'API
 * s'en passe ; s'en passer ici a toutes les chances de poster un message sans sa
 * pièce jointe — le transcript d'un ticket partirait dans le vide.
 *
 * À VÉRIFIER EN RECETTE : poster un transcript de ticket, vérifier que la pièce
 * jointe arrive et qu'elle porte son nom de fichier.
 */
function requeteMessage(contenu) {
    const rendu = rendreContenu(contenu);
    const corps = corpsMessage(contenu);

    if (!rendu.files || rendu.files.length === 0) return { body: corps };

    const files = rendu.files.map(f => ({
        name: f.name,
        data: f.attachment,
        contentType: f.contentType || f.content_type,
    }));

    corps.attachments = files.map((f, index) => {
        const entree = { id: index, filename: f.name };
        if (f.contentType) entree.content_type = f.contentType;
        const description = rendu.files[index]?.description;
        if (description) entree.description = description;
        return entree;
    });

    return { body: corps, files };
}

/**
 * Résout une valeur de permission vers un BigInt.
 * Accepte un nom canonique, un tableau de noms, un BigInt, un entier ou une
 * chaîne de bitfield déjà sérialisée.
 */
function resoudreBits(valeur) {
    if (valeur === null || valeur === undefined) return 0n;
    if (Array.isArray(valeur)) return bitfield(valeur);
    if (typeof valeur === 'string') return estPermissionCanonique(valeur) ? bitfield(valeur) : BigInt(valeur);
    return BigInt(valeur);
}

/**
 * Overwrites neutres -> forme REST.
 * `{ id, type: 'role'|'membre', autorise: [...], refuse: [...] }`
 *
 * Les types sont ceux de `channels.mdx` § « Permission overwrite types » :
 * 0 = ROLE, 1 = MEMBER — les mêmes valeurs que chez Discord.
 */
function normaliserOverwrites(liste) {
    if (!Array.isArray(liste)) return undefined;
    return liste.map(o => ({
        id: o.id,
        type: o.type === 'role' ? 0 : o.type === 'membre' ? 1 : o.type,
        allow: serialiserBitfield(resoudreBits(o.autorise ?? o.allow)),
        deny: serialiserBitfield(resoudreBits(o.refuse ?? o.deny)),
    }));
}

/**
 * Emoji neutre -> segment d'URL attendu par les routes de réaction.
 *
 * « A custom emoji uses `name:id`, where `id` is the trailing decimal custom
 * emoji snowflake and `name` is everything before the final colon. Any other
 * decoded value is read as a Unicode emoji. » (messages.mdx, § Reaction emoji
 * path value) — règle identique à celle de Discord.
 */
function encoderEmoji(emoji) {
    const personnalise = /^<a?:([^:]+):(\d+)>$/.exec(String(emoji));
    const brut = personnalise ? `${personnalise[1]}:${personnalise[2]}` : String(emoji);
    return encodeURIComponent(brut);
}

/**
 * Deltas de permission d'un overwrite unitaire.
 * `{ CONNECT: false, VIEW_CHANNEL: true, SEND_MESSAGES: null }`
 *   true  -> autorisée | false -> refusée | null -> héritée
 * @returns {{allow: bigint, deny: bigint}}
 */
function appliquerDeltas(allow, deny, deltas) {
    for (const [nom, valeur] of Object.entries(deltas || {})) {
        exigerPermissionCanonique(nom);
        const bit = BITS[nom];
        // Le bit est d'abord retiré des DEUX masques : sans ça, passer une
        // permission de « refusée » à « autorisée » la laisserait dans `deny`,
        // et le refus l'emporte (« denied bits first and allowed bits second »).
        allow &= ~bit;
        deny &= ~bit;
        if (valeur === true) allow |= bit;
        else if (valeur === false) deny |= bit;
    }
    return { allow, deny };
}

/**
 * Rang d'un membre dans la hiérarchie, au sens de Fluxer.
 *
 * « Roles are ranked by position, and the highest position ranks first. Two roles
 * sharing a position are ranked by snowflake, and the lower snowflake ranks
 * first. A member's rank is the rank of their highest assigned role, and a
 * member with no assigned role ranks below every role. » (permissions.mdx)
 *
 * @returns {{position: number, id: bigint}|null} `null` = aucun rôle assigné,
 *   donc en dessous de tout le monde.
 */
function rangMembre(rolesMembre, rolesGuilde) {
    let meilleur = null;
    for (const roleId of rolesMembre || []) {
        const role = rolesGuilde instanceof Map ? rolesGuilde.get(String(roleId)) : rolesGuilde?.[roleId];
        if (!role) continue;
        const candidat = { position: Number(role.position) || 0, id: BigInt(role.id) };
        if (!meilleur || comparerRangs(candidat, meilleur) > 0) meilleur = candidat;
    }
    return meilleur;
}

/** > 0 si `a` est au-dessus de `b`. */
function comparerRangs(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.position !== b.position) return a.position - b.position;
    // Position égale : le plus PETIT snowflake l'emporte.
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
}

/**
 * @param {object} client  client Fluxer (cf. ./client.js)
 * @returns {object} client REST normalisé (DA §4.3)
 */
function creerApi(client) {
    const rest = () => client.rest;
    const etat = () => client.etat;
    const moiId = () => client.user?.id ?? null;
    // Base du proxy média, résolue par le client depuis l'env INJECTÉ. Le repli
    // sur `baseMedia()` ne sert qu'aux doublures qui n'en fabriquent pas.
    const media = () => client.baseMedia || baseMedia();

    /** Membre brut, du cache si possible, de l'API sinon. */
    async function membreBrut(guildeId, membreId) {
        const cache = etat().membre(guildeId, membreId);
        // Le cache sert de repli, jamais de source unique : il ne porte pas
        // toujours `user`, et un contrôle de droits sur un membre périmé serait
        // faux. On relit, et on retombe sur le cache si la lecture échoue.
        try {
            const frais = await rest().get(`/guilds/${guildeId}/members/${membreId}`);
            etat().poserMembre(guildeId, frais);
            return frais;
        } catch (err) {
            if (cache) return cache;
            throw err;
        }
    }

    /** Normalise un membre AVEC l'état local, pour que ses permissions existent. */
    const normMembre = (membre, guildeId) => normaliserMembre(membre, {
        etat: etat(), guildeId, baseMedia: media(),
    });

    /**
     * Overwrite courant d'une cible, en BigInt.
     *
     * Rendre `null` pour « pas d'overwrite » se distingue de `{allow: 0n, deny:
     * 0n}`, « overwrite présent mais vide » : seul le premier oblige à connaître
     * le type de la cible, que l'API ne devine pas.
     */
    async function lireOverwrite(canalId, cibleId) {
        const cache = etat().canal(canalId);
        const source = cache || await rest().get(`/channels/${canalId}`).catch(() => null);
        const trouve = (source?.permission_overwrites || []).find(o => String(o.id) === String(cibleId));
        if (!trouve) return null;
        return { type: trouve.type, allow: BigInt(trouve.allow || 0), deny: BigInt(trouve.deny || 0) };
    }

    // `marquerErreursApi` enveloppe TOUTES les méthodes : chaque rejet ressort
    // avec `err.codeNeutre`, sans que `err.code` natif soit touché.
    const api = marquerErreursApi({
        // ─── Messages ────────────────────────────────────────────────────────

        /** @returns {Promise<object>} le message posté, NORMALISÉ (cf. events.js) */
        async envoyerMessage(canalId, contenu) {
            const { body, files } = requeteMessage(contenu);
            return normaliserMessage(await rest().post(`/channels/${canalId}/messages`, { body, files }));
        },

        async modifierMessage(canalId, messageId, contenu) {
            const { body, files } = requeteMessage(contenu);
            // « The body is read exactly as it is for Create message » — même
            // corps, même multipart, sur PATCH.
            return normaliserMessage(
                await rest().patch(`/channels/${canalId}/messages/${messageId}`, { body, files })
            );
        },

        /**
         * @returns {Promise<object|null>} `null` si le message ou son salon
         *   n'existe plus. Une panne LÈVE.
         *
         * Le message rendu porte ses `reactions` (avec `parMoi`), ce qui permet
         * de ne reposer que les emojis manquants d'un panneau au lieu de tous.
         * ⚠️ « me? […] Present and true only when the authenticated user has this
         * reaction, and omitted entirely otherwise, so an absent key must be read
         * as false » : la normalisation s'en charge.
         */
        async obtenirMessage(canalId, messageId) {
            try {
                return normaliserMessage(await rest().get(`/channels/${canalId}/messages/${messageId}`));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /**
         * Historique d'un salon, du plus récent au plus ancien.
         * @param {object} [options] { limite = 50, avant, apres } — identifiants
         *   de message, jamais des dates : c'est la pagination de l'API.
         */
        async listerMessages(canalId, { limite = 50, avant, apres } = {}) {
            const query = { limit: String(Math.min(limite, 100)) };
            if (avant) query.before = avant;
            if (apres) query.after = apres;
            const messages = await rest().get(`/channels/${canalId}/messages`, { query });
            return (messages || []).map(normaliserMessage);
        },

        async supprimerMessage(canalId, messageId, raison) {
            return rest().delete(`/channels/${canalId}/messages/${messageId}`, { raison });
        },

        /**
         * Suppression groupée.
         *
         * @returns {Promise<{supprimes: number, ignores: number}>}
         *   `supprimes` ne compte que les lots que l'API a réellement acceptés.
         *   L'API ne rend aucun corps sur un 204 : le seul fait vérifiable est
         *   qu'elle n'a pas refusé. Un lot en échec n'est donc PAS compté, et
         *   l'erreur remonte à l'appelant.
         *
         * ⚠️ `ignores` vaut 0 : Fluxer n'applique aucune borne d'âge. Voir la
         * note de AGE_MAX_SUPPRESSION_LOT_MS en tête de fichier.
         * ⚠️ « An ID that names no message in the channel is skipped » : un lot
         * partiellement périmé réussit, et `supprimes` surestime alors le nombre
         * réellement effacé. C'est le même compromis que côté Discord, où le 204
         * ne dit rien non plus.
         */
        async supprimerMessagesEnLot(canalId, ids, raison) {
            const uniques = [...new Set(ids)];
            const eligibles = AGE_MAX_SUPPRESSION_LOT_MS === null
                ? uniques
                : uniques.filter(id => dateDuSnowflake(id) > Date.now() - AGE_MAX_SUPPRESSION_LOT_MS);
            let supprimes = 0;

            for (let debut = 0; debut < eligibles.length; debut += TAILLE_LOT_SUPPRESSION) {
                const lot = eligibles.slice(debut, debut + TAILLE_LOT_SUPPRESSION);
                // « message_ids? | array[snowflake] » ; `messages` en est un
                // alias, mais « supplying both uses message_ids » : on envoie le
                // nom canonique, un seul.
                //
                // ⚠️ La route ne lit AUCUN en-tête de motif : « The operation
                // reads no audit reason header. » `raison` est donc accepté pour
                // la symétrie de signature et n'est pas transmis — l'envoyer
                // laisserait croire qu'il apparaîtra dans le journal d'audit.
                await rest().post(`/channels/${canalId}/messages/bulk-delete`, {
                    body: { message_ids: lot },
                });
                supprimes += lot.length;
            }
            return { supprimes, ignores: uniques.length - eligibles.length };
        },

        async ajouterReaction(canalId, messageId, emoji) {
            return rest().put(
                `/channels/${canalId}/messages/${messageId}/reactions/${encoderEmoji(emoji)}/@me`
            );
        },

        /**
         * Retire une réaction. Sans `utilisateurId`, retire CELLE DU BOT.
         *
         * Le cas courant est l'inverse : les panneaux de rôles retirent la
         * réaction de la personne pour garder le panneau propre et faire office
         * d'accusé de réception. Cette opération demande MANAGE_MESSAGES
         * (« remove another member's reaction », permissions.mdx) et échoue sans
         * elle — comportement identique à Discord, l'appelant décide s'il
         * l'ignore.
         */
        async retirerReaction(canalId, messageId, emoji, utilisateurId = null) {
            const code = encoderEmoji(emoji);
            const base = `/channels/${canalId}/messages/${messageId}/reactions/${code}`;
            return rest().delete(utilisateurId ? `${base}/${utilisateurId}` : `${base}/@me`);
        },

        // ─── Membres ─────────────────────────────────────────────────────────

        /**
         * @returns {Promise<object|null>} `null` UNIQUEMENT si le membre ou le
         *   serveur n'existe pas. Une panne réseau ou une permission manquante
         *   LÈVENT : les confondre avec une absence ferait conclure « la personne
         *   n'est plus là » à chaque coupure.
         */
        async obtenirMembre(guildeId, membreId) {
            try {
                return normMembre(await membreBrut(guildeId, membreId), guildeId);
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /**
         * Le bot peut-il appliquer cette sanction à ce membre ?
         *
         * Les deux causes sont SÉPARÉES parce qu'elles n'appellent pas la même
         * correction : remonter le rôle du bot, ou lui cocher une permission. Un
         * message unique « permission manquante » envoie chercher au mauvais
         * endroit une fois sur deux — et sur Fluxer ce serait systématique, les
         * DEUX refus partageant le code `MISSING_PERMISSIONS`.
         *
         * ⚠️ La hiérarchie de Fluxer porte sur LE MEMBRE, pas sur le rôle :
         * « Banning a target who is a member also requires role hierarchy
         * authority over that member. The guild owner holds that authority over
         * everyone, and no other caller holds it over the owner. »
         * (guild-moderation.mdx). C'est exactement ce que l'issue #844 décrivait
         * en avril 2026, et ce n'est plus un défaut : c'est la règle publiée.
         *
         * @returns {Promise<null|'hierarchie'|'permission'>} `null` = rien ne
         *   s'y oppose, y compris quand la réponse est INDÉTERMINABLE. Inventer
         *   un refus empêcherait une sanction légitime, alors qu'en laissant
         *   passer c'est la plateforme qui tranchera — et son erreur sera
         *   traduite.
         */
        async verifierMembreSanctionnable(guildeId, membreId, action) {
            const permission = PERMISSION_PAR_SANCTION[action];
            if (!permission) {
                throw new Error(
                    `verifierMembreSanctionnable : action « ${action} » inconnue. `
                    + `Valeurs acceptées : ${SANCTIONS.join(', ')}.`
                );
            }

            const guilde = etat().guilde(guildeId);
            const monId = moiId();
            // Ni serveur hors cache, ni identité du bot inconnue ne sont des
            // refus STRUCTURELS : ce pré-contrôle ne sert qu'à dire « inutile
            // d'essayer », jamais à inventer un motif.
            if (!guilde || !monId) return null;

            const proprietaireId = guilde.proprietes?.owner_id ?? null;
            // Le propriétaire est intouchable, et le bot ne se sanctionne pas.
            // Deux absolus, avant toute lecture de rôle.
            if (proprietaireId && String(membreId) === String(proprietaireId)) return 'hierarchie';
            if (String(membreId) === String(monId)) return 'hierarchie';

            let cible;
            let moi;
            try {
                cible = await membreBrut(guildeId, membreId);
                moi = await membreBrut(guildeId, monId);
            } catch {
                return null;
            }
            if (!cible || !moi) return null;

            // Le propriétaire du serveur surclasse tout le monde, y compris un
            // bot placé au sommet des rôles.
            if (proprietaireId && String(monId) !== String(proprietaireId)) {
                const rangCible = rangMembre(cible.roles, etat().roles(guildeId));
                const rangMoi = rangMembre(moi.roles, etat().roles(guildeId));
                if (comparerRangs(rangMoi, rangCible) <= 0) return 'hierarchie';
            }

            const masque = masqueMembre({
                membreId: monId,
                rolesMembre: moi.roles,
                roles: etat().roles(guildeId),
                guildeId,
                proprietaireId,
            });
            return aPermission(masque, permission) ? null : 'permission';
        },

        /**
         * @param {object} patch  { roles?, pseudo?, muet?, sourd?, canalVocalId?, timeoutJusqua? }
         *   `timeoutJusqua` accepte une Date, un timestamp ou null (levée).
         * @returns {Promise<object>} le membre après modification, normalisé.
         *
         * ⚠️ « roles | array[snowflake] | The complete replacement role set » :
         * c'est un REMPLACEMENT, pas un ajout, exactement comme chez Discord.
         * ⚠️ « A role ID absent from the supplied array is removed from the
         * member », et « A roles entry that does not resolve to an existing role
         * of the guild is dropped from the replacement, so a request naming only
         * unknown roles clears the member's role set ». Un identifiant périmé ne
         * fait donc pas échouer l'appel : il VIDE le membre. Passer une liste
         * relue depuis la base sans la filtrer est ici un risque réel.
         */
        async modifierMembre(guildeId, membreId, patch = {}, raison) {
            const body = {};
            if (patch.roles !== undefined) body.roles = patch.roles;
            if (patch.pseudo !== undefined) body.nick = patch.pseudo;
            if (patch.muet !== undefined) body.mute = Boolean(patch.muet);
            if (patch.sourd !== undefined) body.deaf = Boolean(patch.sourd);
            if (patch.canalVocalId !== undefined) body.channel_id = patch.canalVocalId;
            if (patch.timeoutJusqua !== undefined) {
                body.communication_disabled_until = patch.timeoutJusqua === null
                    ? null
                    : new Date(patch.timeoutJusqua).toISOString();
                // « timeout_reason has no effect unless communication_disabled_until
                // is also supplied » : on ne le pose que là, et jamais seul.
                if (raison && patch.timeoutJusqua !== null) {
                    body.timeout_reason = String(raison).slice(0, 512);
                }
            }
            const membre = await rest().patch(`/guilds/${guildeId}/members/${membreId}`, { body, raison });
            etat().poserMembre(guildeId, membre);
            return normMembre(membre, guildeId);
        },

        async ajouterRole(guildeId, membreId, roleId, raison) {
            return rest().put(`/guilds/${guildeId}/members/${membreId}/roles/${roleId}`, { raison });
        },

        async retirerRole(guildeId, membreId, roleId, raison) {
            return rest().delete(`/guilds/${guildeId}/members/${membreId}/roles/${roleId}`, { raison });
        },

        /** kick */
        async exclureMembre(guildeId, membreId, raison) {
            return rest().delete(`/guilds/${guildeId}/members/${membreId}`, { raison });
        },

        /**
         * @param {object} [options]
         * @param {number} [options.supprimerMessagesSecondes] 0 à 604800
         *   (7 jours), comme chez Discord.
         */
        async bannirMembre(guildeId, membreId, raison, { supprimerMessagesSecondes = 0 } = {}) {
            return rest().put(`/guilds/${guildeId}/bans/${membreId}`, {
                // « An omitted or null reason falls back to the X-Audit-Log-Reason
                // value » : on pose les deux, le motif est ainsi stocké SUR LE
                // BAN et pas seulement dans le journal d'audit — c'est lui que
                // `obtenirBannissement` relira.
                body: { delete_message_seconds: supprimerMessagesSecondes, ...(raison ? { reason: String(raison).slice(0, 512) } : {}) },
                raison,
            });
        },

        async debannirMembre(guildeId, membreId, raison) {
            return rest().delete(`/guilds/${guildeId}/bans/${membreId}`, { raison });
        },

        /**
         * Timeout de communication natif.
         *
         * « Null and any communication_disabled_until that is not in the future
         * both clear the timeout. A time more than 365.25 days ahead returns
         * TIMEOUT_CANNOT_EXCEED_365_DAYS. » (guild-members.mdx)
         *
         * @param {Date|number|null} expireLe  null lève le timeout
         */
        async appliquerTimeout(guildeId, membreId, expireLe, raison) {
            const body = {
                communication_disabled_until: expireLe === null ? null : new Date(expireLe).toISOString(),
            };
            // Le motif est stocké SUR LE MEMBRE en plus du journal d'audit, ce
            // que Discord ne sait pas faire. On ne le pose qu'à la pose du
            // timeout : à la levée, il « has no effect » et brouillerait la
            // lecture du champ.
            if (raison && expireLe !== null) body.timeout_reason = String(raison).slice(0, 512);

            const membre = await rest().patch(`/guilds/${guildeId}/members/${membreId}`, { body, raison });
            etat().poserMembre(guildeId, membre);
            return normMembre(membre, guildeId);
        },

        // ─── Rôles ───────────────────────────────────────────────────────────

        /**
         * Le bot peut-il attribuer ce rôle ?
         *
         * La règle est celle de `bot/utils/assignableRole.js`, appelée telle
         * quelle : elle est partagée par six entrées de configuration et ne doit
         * exister qu'une fois. On lui fabrique la forme qu'elle attend à partir
         * de l'état local — c'est un pont, pas une seconde implémentation.
         *
         * @returns {Promise<null|'missing'|'everyone'|'managed'|'hierarchy'>}
         */
        async verifierRoleAttribuable(guildeId, roleId) {
            const { checkAssignableRole } = require('../../utils/assignableRole');
            const guilde = etat().guilde(guildeId);
            if (!guilde) return 'missing';

            const role = etat().role(guildeId, roleId)
                || (await rest().get(`/guilds/${guildeId}/roles`).catch(() => []))
                    .find(r => String(r.id) === String(roleId));
            if (!role) return 'missing';

            const monId = moiId();
            const moi = monId ? etat().membre(guildeId, monId) : null;
            const rang = moi ? rangMembre(moi.roles, etat().roles(guildeId)) : null;

            return checkAssignableRole(
                {
                    id: guildeId,
                    // `members.me.roles.highest.position` : la forme que le
                    // module partagé lit. Sans rang connu on ne pose pas `me`,
                    // et il laisse passer — même repli que côté Discord.
                    members: rang ? { me: { roles: { highest: { position: rang.position } } } } : {},
                },
                role,
            );
        },

        /** @returns {Promise<object|null>} `null` si le rôle n'existe plus ; lève sur une panne. */
        async obtenirRole(guildeId, roleId) {
            try {
                const cache = etat().role(guildeId, roleId);
                if (cache) return normaliserRole(cache, { guildeId });
                // Il n'existe AUCUNE route « lire un rôle » : permissions.mdx
                // n'expose que « List guild roles », qui « returns the complete
                // collection in one response ». On liste et on filtre.
                const roles = await rest().get(`/guilds/${guildeId}/roles`);
                const trouve = (roles || []).find(r => String(r.id) === String(roleId));
                return trouve ? normaliserRole(trouve, { guildeId }) : null;
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        // ─── Salons et guildes ───────────────────────────────────────────────

        /**
         * @param {object} spec { nom, type, parentId?, sujet?, permissions?, position?, limiteUtilisateurs? }
         *   `type` est un nom canonique (platform/channels.js).
         * @returns {Promise<object>} le salon créé, NORMALISÉ
         *
         * ⚠️ `position` n'est PAS accepté par Fluxer à la création : « The new
         * channel takes a position derived from its siblings » et la table du
         * corps n'en déclare aucun. Il est ignoré ici plutôt que rejeté — un
         * salon créé une place trop bas reste un salon, et lever ferait échouer
         * un TempVoice parfaitement portable. Le repositionnement passe par
         * `PATCH /guilds/{id}/channels`, hors du contrat neutre.
         */
        async creerCanal(guildeId, spec = {}, raison) {
            const [type] = versTypesFluxer(exigerTypeCanalCanonique(spec.type));
            const body = { name: spec.nom, type };
            if (spec.parentId !== undefined) body.parent_id = spec.parentId;
            if (spec.sujet !== undefined) body.topic = spec.sujet;
            if (spec.limiteUtilisateurs !== undefined) body.user_limit = spec.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(spec.permissions);
            if (overwrites) body.permission_overwrites = overwrites;

            const canal = await rest().post(`/guilds/${guildeId}/channels`, { body, raison });
            etat().poserCanal(canal);
            return normaliserCanal(canal);
        },

        /**
         * ⚠️ `permissions` REMPLACE l'intégralité des overwrites du salon. Pour
         * modifier UNE cible sans toucher aux autres, utilisez
         * `definirOverwrite`. Ne passez `permissions` ici que si vous réécrivez
         * sciemment tout le jeu.
         */
        async modifierCanal(canalId, patch = {}, raison) {
            const body = {};
            if (patch.nom !== undefined) body.name = patch.nom;
            if (patch.sujet !== undefined) body.topic = patch.sujet;
            if (patch.parentId !== undefined) body.parent_id = patch.parentId;
            if (patch.position !== undefined) body.position = patch.position;
            if (patch.limiteUtilisateurs !== undefined) body.user_limit = patch.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(patch.permissions);
            if (overwrites) body.permission_overwrites = overwrites;

            const canal = await rest().patch(`/channels/${canalId}`, { body, raison });
            etat().poserCanal(canal);
            return normaliserCanal(canal);
        },

        /**
         * Modifie l'overwrite d'UNE cible, sans toucher aux autres.
         *
         * « One identifier addresses one overwrite, so storing an overwrite for
         * an identifier that already has one replaces it » (channels.mdx) : le
         * PUT est bien unitaire, il ne remplace que cette entrée.
         *
         * @param {Record<string, true|false|null>} deltas  autorisée / refusée / héritée
         * @param {{type?: 'role'|'membre', raison?: string}} [options]
         */
        async definirOverwrite(canalId, cibleId, deltas, { type, raison } = {}) {
            const actuel = await lireOverwrite(canalId, cibleId);
            const typeCible = type !== undefined
                ? (type === 'role' ? 0 : type === 'membre' ? 1 : type)
                : actuel?.type;

            if (typeCible === undefined || typeCible === null) {
                throw new Error(
                    `definirOverwrite : aucun overwrite existant pour ${cibleId} sur le salon ${canalId}, `
                    + 'et « type » n\'est pas précisé. Passez { type: \'role\' } ou { type: \'membre\' }.'
                );
            }

            const { allow, deny } = appliquerDeltas(actuel?.allow ?? 0n, actuel?.deny ?? 0n, deltas);

            return rest().put(`/channels/${canalId}/permissions/${cibleId}`, {
                body: {
                    type: typeCible,
                    allow: serialiserBitfield(allow),
                    deny: serialiserBitfield(deny),
                },
                raison,
            });
        },

        /** Retire complètement l'overwrite d'une cible (retour à l'héritage). */
        async supprimerOverwrite(canalId, cibleId, raison) {
            return rest().delete(`/channels/${canalId}/permissions/${cibleId}`, { raison });
        },

        async supprimerCanal(canalId, raison) {
            return rest().delete(`/channels/${canalId}`, { raison });
        },

        /**
         * @returns {Promise<string>} identifiant du salon privé
         *
         * « recipient_id opens a direct message » (users/private-channels.mdx) —
         * même route et même corps que chez Discord. « Fluxer reads no block
         * state, no friendship, and no shared guild on this route » : le salon
         * s'ouvre toujours, et c'est l'ENVOI qui peut être refusé par
         * `CANNOT_SEND_MESSAGES_TO_USER`.
         */
        async ouvrirMessagePrive(utilisateurId) {
            const canal = await rest().post('/users/@me/channels', { body: { recipient_id: utilisateurId } });
            return canal.id;
        },

        /**
         * @returns {Promise<object|null>} `null` UNIQUEMENT si le bot n'est plus
         *   sur ce serveur (code neutre 'guilde_inconnue').
         *
         * ⚠️ Une panne réseau LÈVE, et c'est le point le plus important de cette
         *   méthode : le balayage des bannissements temporaires en déduit s'il
         *   doit OUBLIER une échéance.
         */
        async obtenirGuilde(guildeId) {
            const cache = etat().guilde(guildeId);
            if (cache?.proprietes?.name) return normaliserGuilde(cache);
            try {
                return normaliserGuilde(await rest().get(`/guilds/${guildeId}`));
            } catch (err) {
                return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue]);
            }
        },

        /** @returns {Promise<object|null>} `null` si le salon n'existe plus ; lève sur une panne. */
        async obtenirCanal(canalId) {
            const cache = etat().canal(canalId);
            if (cache) return normaliserCanal(cache);
            try {
                return normaliserCanal(await rest().get(`/channels/${canalId}`));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /**
         * Bannissement en cours d'une personne sur un serveur.
         *
         * ⚠️ Il n'existe AUCUNE route « lire un bannissement » : « List guild
         * bans is the only operation that reads a ban record »
         * (guild-moderation.mdx), et elle « returns the complete collection in
         * one response and has no limit or cursor parameters ». On liste donc
         * TOUT le serveur pour répondre sur une personne. C'est le coût réel de
         * cette méthode sur Fluxer, et il croît avec le nombre de bannis.
         *
         * Bonne nouvelle : « The response excludes an expired temporary ban »,
         * donc l'absence est exacte, sans comparaison de date à faire.
         *
         * @returns {Promise<{utilisateur, raison}|null>}
         */
        async obtenirBannissement(guildeId, utilisateurId) {
            try {
                const bans = await rest().get(`/guilds/${guildeId}/bans`);
                const trouve = (bans || []).find(b => String(b.user?.id) === String(utilisateurId));
                if (!trouve) return null;
                return { utilisateur: normaliserUtilisateur(trouve.user), raison: trouve.reason ?? null };
            } catch (err) {
                return absenceOuLeve(err, [...ABSENCES, CODES_NEUTRES.deja_fait]);
            }
        },

        /**
         * Permissions effectives d'un membre DANS UN SALON donné — overwrites
         * appliqués, ce que `obtenirMembre().aPermission` ne fait pas.
         *
         * @returns {Promise<{aPermission: (nom: string) => boolean}|null>}
         *   `null` si le salon ou le membre est introuvable, ou si le salon n'a
         *   pas de permissions propres (message privé).
         */
        async permissionsSurCanal(canalId, membreId) {
            let canal = etat().canal(canalId);
            if (!canal) {
                try {
                    canal = await rest().get(`/channels/${canalId}`);
                } catch (err) {
                    return absenceOuLeve(err);
                }
            }
            // Un salon privé n'a ni serveur ni overwrites : il n'y a rien à
            // calculer, et répondre « aucune permission » serait faux.
            const guildeId = canal?.guild_id ?? null;
            if (!canal || !guildeId) return null;

            let membre;
            try {
                membre = await membreBrut(guildeId, membreId);
            } catch (err) {
                return absenceOuLeve(err);
            }
            if (!membre) return null;

            const proprietaireId = etat().guilde(guildeId)?.proprietes?.owner_id ?? null;
            const serveur = masqueMembre({
                membreId,
                rolesMembre: membre.roles,
                roles: etat().roles(guildeId),
                guildeId,
                proprietaireId,
            });
            const masque = masqueSurCanal(serveur, canal.permission_overwrites, {
                membreId, rolesMembre: membre.roles, guildeId,
            });
            return { aPermission: (nom) => aPermission(masque, nom) };
        },

        // ─── Inventaires d'un serveur ────────────────────────────────────────
        //
        //  Alimentent les SÉLECTEURS du dashboard, et la liste des destinataires
        //  d'une notification de violation (RGPD art. 33). Tous rendent `null`
        //  pour « je ne vois pas ce serveur » et `[]` pour « il n'a rien » : un
        //  sélecteur vide et un sélecteur indisponible n'appellent pas le même
        //  message, et pour l'article 33 c'est `null` qui permet de dire combien
        //  de serveurs n'ont PAS été atteints.
        //
        //  ⚠️ L'état local est privilégié quand il porte la réponse — les
        //  salons, les rôles et les emojis arrivent dans la rafale de
        //  GUILD_CREATE et sont tenus à jour par les événements. Le REST est le
        //  repli, pas la voie nominale : un dashboard ouvert sur dix serveurs
        //  ferait sinon dix appels par chargement de page, sur des routes
        //  limitées à 40 requêtes / 10 s.

        /**
         * Salons d'un serveur, normalisés (`position` comprise).
         * @returns {Promise<object[]|null>} `null` si le serveur est illisible.
         */
        async listerCanaux(guildeId) {
            const connus = etat().guilde(guildeId)?.canaux;
            if (connus?.size) return [...connus.values()].map(normaliserCanal);
            try {
                const canaux = await rest().get(`/guilds/${guildeId}/channels`);
                for (const canal of canaux || []) etat().poserCanal({ guild_id: String(guildeId), ...canal });
                return (canaux || []).map(c => normaliserCanal({ guild_id: String(guildeId), ...c }));
            } catch (err) {
                return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue, CODES_NEUTRES.introuvable]);
            }
        },

        /**
         * Rôles d'un serveur, normalisés (`parDefaut` compris).
         *
         * « Returns every guild role object in the guild, in descending position
         * order » (http-api/permissions.mdx) : la route rend TOUT en une fois,
         * il n'y a pas de pagination à mener.
         *
         * @returns {Promise<object[]|null>} `null` si le serveur est illisible.
         */
        async listerRoles(guildeId) {
            const connus = etat().roles(guildeId);
            if (connus?.size) return [...connus.values()].map(r => normaliserRole(r, { guildeId }));
            try {
                const roles = await rest().get(`/guilds/${guildeId}/roles`);
                for (const role of roles || []) etat().poserRole(guildeId, role);
                return (roles || []).map(r => normaliserRole(r, { guildeId }));
            } catch (err) {
                return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue, CODES_NEUTRES.introuvable]);
            }
        },

        /**
         * Emojis personnalisés d'un serveur.
         *
         * `identifiant` est la forme ÉCRITE dans un message — `<:nom:id>` ou
         * `<a:nom:id>` — et c'est elle que `reaction_roles.emoji` stocke. Rendre
         * l'identifiant nu ferait choisir au dashboard une valeur que le bot ne
         * retrouverait jamais au moment du clic.
         *
         * `url` passe par le proxy média : `GET /emojis/{emoji_id}.{ext}`
         * (media-proxy/routes.mdx). ⚠️ « Fluxer issues emoji paths without an
         * `a_` prefix, so an emoji request defaults to static output and needs
         * `animated=true` for animation » — sans ce paramètre, un emoji animé
         * s'afficherait figé dans le sélecteur.
         *
         * @returns {Promise<Array<{id, nom, anime, identifiant, url}>|null>}
         */
        async listerEmojis(guildeId) {
            let emojis = etat().guilde(guildeId)?.proprietes?.emojis;
            if (!Array.isArray(emojis)) {
                try {
                    emojis = await rest().get(`/guilds/${guildeId}/emojis`);
                } catch (err) {
                    return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue, CODES_NEUTRES.introuvable]);
                }
            }
            const base = media();
            return (emojis || []).map(emoji => ({
                id: emoji.id,
                nom: emoji.name,
                anime: Boolean(emoji.animated),
                identifiant: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
                url: `${base}/emojis/${emoji.id}.webp?size=${TAILLE_EMOJI}`
                    + (emoji.animated ? '&animated=true' : ''),
            }));
        },

        /**
         * Membres d'un serveur, normalisés.
         *
         * ⚠️ Coûteux, et à n'appeler que pour les lectures qui ont besoin de la
         * LISTE — en pratique les destinataires d'une notification de violation.
         * Un sélecteur ne doit pas passer par ici.
         *
         * La route est PAGINÉE, et son défaut est un piège : « limit? | integer |
         * The maximum number of members to return (1-1000, default 1) », avec la
         * note « A caller that wants a batch states limit explicitly, because the
         * default returns one member. » Omettre `limit` rendrait donc UN membre,
         * et la notification de violation ne partirait qu'au propriétaire — sans
         * la moindre erreur.
         *
         * Le curseur `after` est exclusif et il n'existe aucune forme
         * descendante : on remonte les identifiants croissants jusqu'à ce qu'une
         * page soit incomplète. Le plafond total existe pour que le balayage d'un
         * très grand serveur ne bloque pas une requête de dashboard ; il est
         * signalé plutôt que silencieux.
         *
         * @returns {Promise<object[]|null>} `null` si le serveur est illisible.
         */
        async listerMembres(guildeId) {
            const membres = [];
            let apres = null;

            for (let page = 0; page < PAGES_MAX_MEMBRES; page += 1) {
                const query = { limit: String(TAILLE_PAGE_MEMBRES) };
                if (apres) query.after = apres;

                let lot;
                try {
                    lot = await rest().get(`/guilds/${guildeId}/members`, { query });
                } catch (err) {
                    // Une panne au MILIEU d'un balayage ne doit pas faire perdre
                    // les pages déjà lues : un destinataire de moins vaut mieux
                    // qu'un serveur compté comme non atteint. Seul un échec sur
                    // la PREMIÈRE page rend `null`.
                    if (membres.length > 0) {
                        console.error(
                            `[Quasar] Énumération des membres de ${guildeId} interrompue après `
                            + `${membres.length} : ${err?.codeNeutre || err?.code || err?.message}.`
                        );
                        return membres;
                    }
                    return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue, CODES_NEUTRES.introuvable]);
                }

                if (!Array.isArray(lot) || lot.length === 0) return membres;
                for (const membre of lot) {
                    etat().poserMembre(guildeId, membre);
                    membres.push(normMembre(membre, guildeId));
                }
                // Page incomplète : c'est la dernière, la route n'a pas de
                // drapeau « encore » à lire.
                if (lot.length < TAILLE_PAGE_MEMBRES) return membres;
                apres = lot[lot.length - 1]?.user?.id ?? null;
                if (!apres) return membres;
            }

            console.warn(
                `[Quasar] Énumération des membres de ${guildeId} arrêtée au plafond `
                + `(${PAGES_MAX_MEMBRES * TAILLE_PAGE_MEMBRES}). La liste rendue est PARTIELLE.`
            );
            return membres;
        },

        /**
         * Membres actuellement connectés à un salon vocal.
         *
         * ⚠️ Aucune route REST ne répond à cette question sur Fluxer. Les états
         * vocaux arrivent par la passerelle — dans le `voice_states` du
         * GUILD_CREATE, puis par VOICE_STATE_UPDATE — et l'état local est la
         * SEULE source. Conséquence : au tout début d'une session, avant la
         * rafale de GUILD_CREATE, la réponse est `null` (« je ne sais pas ») et
         * non `[]` (« personne »).
         *
         * @returns {Promise<object[]|null>} membres normalisés, `[]` si le salon
         *   est vide, `null` si le salon est inconnu ou n'est pas vocal.
         */
        async listerMembresVocal(canalId) {
            const canal = etat().canal(canalId);
            // Type 2 = GUILD_VOICE (channels.mdx, § Channel types).
            if (canal && canal.type !== 2) return null;
            const occupants = etat().membresDuVocal(canalId);
            if (occupants === null) return null;
            return occupants.map(m => normMembre(m, m.guild_id));
        },

        // ─── Serveur : suspension des invitations ────────────────────────────

        /**
         * Suspend les invitations du serveur.
         *
         * ⚠️ LÈVE TOUJOURS. La capacité `pauseInvitations` est déclarée FAUSSE
         * côté Fluxer, et le code métier doit la tester avant d'appeler. Un appel
         * qui arrive ici est un défaut de ce code métier : l'avaler en silence le
         * laisserait croire que le serveur est fermé alors qu'il reste ouvert —
         * exactement ce qu'un mode panique ne doit pas faire.
         *
         * Ce qui existe réellement : `INVITES_DISABLED` est un drapeau de
         * `features` modifiable par `PATCH /v1/guilds/{id}` (guilds.mdx, note 14 :
         * « The user-toggleable features are INVITES_DISABLED, … »). Mais c'est
         * une fermeture PERMANENTE, sans échéance : il n'y a pas d'équivalent de
         * l'action d'incident à durée de Discord, sur laquelle le balayage du
         * mode panique s'appuie pour rouvrir. Déclarer la capacité vraie
         * laisserait donc des serveurs fermés indéfiniment.
         */
        async mettreInvitationsEnPause(guildeId, jusquA, raison) {
            throw new Error(
                'mettreInvitationsEnPause : Fluxer n\'a pas de suspension d\'invitations À ÉCHÉANCE. '
                + 'La capacité « pauseInvitations » vaut false sur cette plateforme : testez-la avant '
                + 'd\'appeler (if (ctx.capacites.pauseInvitations) …). '
                + 'Une fermeture PERMANENTE reste possible par le drapeau INVITES_DISABLED de '
                + 'PATCH /v1/guilds/{id}, mais sans échéance rien ne la rouvrirait.'
            );
        },

        /**
         * @returns {Promise<{enPauseJusqua: number|null, desactiveesEnDur: boolean}|null>}
         *   `null` si le serveur est introuvable.
         *
         * La LECTURE, elle, est possible et exacte : le drapeau `INVITES_DISABLED`
         * est publié dans `features`. `enPauseJusqua` vaut donc toujours `null` —
         * il n'y a pas d'échéance à lire — et `desactiveesEnDur` dit la vérité.
         * C'est ce qui permet au mode panique de CONSTATER qu'un serveur est
         * fermé, même s'il ne peut pas le fermer lui-même.
         */
        async obtenirEtatInvitations(guildeId) {
            let guilde = etat().guilde(guildeId)?.proprietes;
            if (!guilde?.features) {
                try {
                    guilde = await rest().get(`/guilds/${guildeId}`);
                } catch (err) {
                    return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue]);
                }
            }
            return {
                enPauseJusqua: null,
                desactiveesEnDur: Boolean(guilde?.features?.includes('INVITES_DISABLED')),
            };
        },

        /**
         * Identifiants des serveurs où le bot est présent.
         *
         * ⚠️ `null` signifie « INDÉTERMINABLE », pas « aucun ». C'est le
         * garde-fou du balayage du mode panique : conclure « aucun serveur »
         * ferait supprimer des échéances. Et le risque est PLUS grand ici que
         * côté Discord — READY précède la rafale de GUILD_CREATE, donc la liste
         * est vide pendant un court instant APRÈS la connexion.
         *
         * @returns {Promise<string[]|null>}
         */
        async listerGuildes() {
            if (!client.isReady?.()) return null;
            const connues = [...etat().guildes.keys()];
            // Session prête mais aucun serveur connu : on ne peut pas distinguer
            // « bot sans serveur » de « rafale pas encore arrivée ». On tranche
            // par la lecture REST, qui est autoritative.
            if (connues.length > 0) return connues;
            try {
                const guildes = await rest().get('/users/@me/guilds');
                return (guildes || []).map(g => String(g.id));
            } catch {
                return null;
            }
        },

        // ─── Panneaux ────────────────────────────────────────────────────────

        /**
         * Repose des choix sur un panneau déjà posté.
         *
         * Symétrique de `ctx.poserPanneau`, pour griser un panneau, en changer
         * les options, ou le remettre à jour après une modification de
         * configuration.
         *
         * Côté Fluxer, « reposer les choix » veut dire trois choses :
         *   1. réécrire le message avec la LÉGENDE à jour — c'est elle qui dit
         *      ce que chaque emoji déclenche ;
         *   2. apposer les réactions manquantes ;
         *   3. RETIRER celles des choix devenus `desactive: true`, sans quoi un
         *      choix grisé dans la légende resterait cliquable — le pire des
         *      deux mondes.
         *
         * ⚠️ Le point 3 demande MANAGE_MESSAGES quand des tiers ont déjà réagi
         * (« Remove all reactions for emoji »). Un échec n'interrompt pas :
         * l'appelant a demandé une mise à jour, pas une transaction.
         */
        async modifierPanneau(canalId, messageId, contenuOuEmbed, choix, { panneau } = {}) {
            const { exigerNomPanneau } = require('./context');
            exigerNomPanneau('api.modifierPanneau', panneau);
            if (!canalId || !messageId) {
                throw new Error('api.modifierPanneau : le salon et le message à réécrire sont obligatoires.');
            }
            const { reactions } = rendreChoix(choix, panneau);
            const message = await api.modifierMessage(
                canalId, messageId, corpsPanneau(contenuOuEmbed, choix, panneau),
            );

            const actives = new Set(reactions.map(r => r.emoji));
            const posees = new Set((message?.reactions || []).map(r => r.emoji?.cle).filter(Boolean));

            for (const reaction of reactions) {
                if (posees.has(reaction.emoji)) continue;
                try {
                    await api.ajouterReaction(canalId, messageId, reaction.emoji);
                } catch (err) {
                    console.error(
                        `[Quasar] Panneau ${panneau} : réaction ${reaction.emoji} non posée `
                        + `(${err?.codeNeutre || err?.code || err?.message}).`
                    );
                }
            }
            for (const emoji of posees) {
                if (actives.has(emoji)) continue;
                try {
                    // Retire TOUT le groupe, pas seulement la réaction du bot :
                    // les personnes qui avaient déjà cliqué doivent cesser de
                    // compter, sinon le choix reste vivant côté routage.
                    await rest().delete(
                        `/channels/${canalId}/messages/${messageId}/reactions/${encoderEmoji(emoji)}`
                    );
                } catch (err) {
                    console.error(
                        `[Quasar] Panneau ${panneau} : réaction ${emoji} non retirée `
                        + `(${err?.codeNeutre || err?.code || err?.message}).`
                    );
                }
            }

            return { canalId, messageId };
        },
    });

    // ─── Hors contrat, volontairement non énumérable ─────────────────────────
    //
    // `indiquerSaisie` est la plomberie de `ctx.differer` : elle n'existe pas
    // côté Discord, où l'on diffère une interaction au lieu de signaler qu'on
    // écrit. L'exposer en clair ferait diverger la surface de `api` entre les
    // deux adaptateurs, que le test de miroir compare clé pour clé — et cette
    // comparaison est le seul filet qui garantisse qu'une commande migrée trouve
    // bien la même chose des deux côtés. Elle est donc posée en NON ÉNUMÉRABLE,
    // la même convention que `err.codeNeutre` : accessible à qui la nomme,
    // invisible à qui énumère.
    Object.defineProperty(api, 'indiquerSaisie', {
        value: async (canalId) => rest().post(`/channels/${canalId}/typing`),
        enumerable: false,
    });

    return api;
}

module.exports = {
    creerApi,
    appliquerDeltas,
    absenceOuLeve,
    PERMISSION_PAR_SANCTION,
    SANCTIONS,
    normaliserOverwrites,
    resoudreBits,
    encoderEmoji,
    corpsMessage,
    requeteMessage,
    rangMembre,
    comparerRangs,
    CLES_CORPS_REST,
    CLES_MENTIONS_REST,
    TAILLE_EMOJI,
    TAILLE_PAGE_MEMBRES,
    PAGES_MAX_MEMBRES,
    dateDuSnowflake,
    AGE_MAX_SUPPRESSION_LOT_MS,
    TAILLE_LOT_SUPPRESSION,
};
