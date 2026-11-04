// ═══════════════════════════════════════════════════════════════
//  Événements normalisés — Fluxer
//
//  Table de correspondance de la DA §7.2, normalisation des payloads, et
//  chargement de bot/events/ dans les deux formats.
//
//  Un handler neutre reçoit toujours `(ctx, ...donnees)`, où `donnees` a la
//  MÊME forme que côté Discord — clé pour clé. C'est la promesse du chantier :
//  les seize handlers de `bot/events/` ne sont écrits qu'une fois.
//
//  ⚠️ TROIS ÉVÉNEMENTS NE LIVRENT QUE LE NOUVEL ÉTAT, là où le contrat neutre
//  passe (avant, après) :
//
//    MESSAGE_UPDATE        — « The payload is the complete current message object »
//    GUILD_MEMBER_UPDATE   — « the complete guild member object with guild_id added »
//    VOICE_STATE_UPDATE    — « The payload is a voice state object »
//
//  L'« avant » vient de l'état local du client, interrogé AVANT d'y écrire le
//  nouvel état. L'ordre est donc structurant, et c'est pour cela que ces trois
//  familles sont mises à jour ICI et non dans `appliquerAEtat` : le faire deux
//  fois détruirait l'« avant ». Hors cache, l'« avant » est un objet PARTIEL —
//  jamais `null`, ce qui casserait un handler qui lit `avant.contenu`.
//
//  Deux autres événements sont dans le même cas sans porter d'« avant » : le
//  rôle de `GUILD_ROLE_DELETE` et le serveur de `GUILD_DELETE` doivent être LUS
//  avant d'être retirés, sans quoi un journal de suppression n'aurait qu'un
//  identifiant à afficher. Leur retrait est donc fait ici aussi.
//
//  ⚠️ `sanctionAutomatique` n'existe pas : Fluxer n'a aucun automod, ni route,
//  ni événement, ni fichier dans son dépôt. Le handler qui s'y abonne déclare
//  `capaciteRequise: 'automod'`, et le chargeur ne le branche pas.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    normaliserCanal,
    normaliserGuilde,
    poserPanneau,
} = require('./context');
const { EVENEMENTS_NEUTRES, estDescripteurEvenement } = require('../events');
const { dateDuSnowflake } = require('./snowflake');

// Types de message écrits par un humain. Tout le reste est un message SYSTÈME
// que personne n'a tapé — sans cette distinction, un salon piège qui se trouve
// être le salon système sanctionne chaque arrivée.
//
// « 0 DEFAULT | 19 REPLY » sont les deux seuls types qu'une personne produit en
// écrivant (messages.mdx, § Message types) ; 1 à 7 sont des messages système
// (ajout/retrait de destinataire, appel, changement de nom ou d'icône,
// épinglage, arrivée). Les mêmes valeurs que chez Discord, par héritage.
const TYPES_MESSAGE_HUMAINS = new Set([0, 19]);

// Base des liens de message.
//
// À VÉRIFIER EN RECETTE : la documentation HTTP de Fluxer ne publie AUCUNE forme
// d'URL de client web — c'est une convention du client, pas de l'API. Celle-ci
// reprend la forme de Discord, que le client Fluxer suit très probablement.
// Un lien faux n'empêche rien de fonctionner : il rend seulement le « voir le
// message » d'un journal de modération inopérant. À confirmer en ouvrant un
// message dans le client et en comparant l'URL.
const BASE_LIEN_MESSAGE = 'https://fluxer.app/channels';

/**
 * message : { id, canalId, guildeId, auteur, contenu, embeds, reactions,
 *             piecesJointes, lien, creeLe, estBot, estSysteme, estWebhook,
 *             estFil, canalParentId, partiel }
 *
 * Mêmes clés que côté Discord, sans exception — c'est ce que vérifie le test de
 * miroir des normaliseurs.
 *
 * `partiel` signale un message dont seuls `id`, `canalId` et `guildeId` sont
 * fiables. Sur Fluxer c'est plus rare que sur Discord : `MESSAGE_DELETE` porte
 * `content`, `author_id` et `member`, là où Discord ne livre qu'un message
 * partiel hors cache. Le cas subsiste quand la suppression vient des outils de
 * modération — « Both fields are omitted when the deletion came from moderation
 * tools ».
 */
function normaliserMessage(message) {
    if (!message) return null;
    return {
        id: message.id,
        canalId: message.channelId ?? message.channel_id ?? message.channel?.id ?? null,
        guildeId: message.guildId ?? message.guild_id ?? message.guild?.id ?? null,
        auteur: normaliserUtilisateur(message.author),
        contenu: message.content ?? null,
        embeds: message.embeds ?? [],
        reactions: normaliserReactions(message),
        piecesJointes: normaliserPiecesJointes(message),
        lien: lienMessage(message),
        // Date d'émission. Le transcript d'un ticket écrit « [ISO] auteur :
        // contenu » et c'est souvent la seule copie d'une conversation : une
        // ligne sans date est une pièce dégradée. Fluxer publie `timestamp`
        // (« Creation time derived from the message snowflake ») ; le snowflake
        // reste le dernier recours.
        creeLe: message.createdTimestamp
            ?? (message.timestamp ? Date.parse(message.timestamp) : dateDuSnowflake(message.id)),
        estBot: Boolean(message.author?.bot),
        estSysteme: !TYPES_MESSAGE_HUMAINS.has(message.type ?? 0),
        estWebhook: Boolean(message.webhookId ?? message.webhook_id),
        // ⚠️ TOUJOURS false : Fluxer n'a aucun type de fil. Sa table « Channel
        // types » n'en déclare pas, et sa passerelle ne dispatche aucun
        // THREAD_*. Le champ existe parce que le contrat le porte — le chemin
        // rapide du salon piège le lit pour chaque message — et il dit ici la
        // vérité : il n'y a pas de fil où se réfugier.
        estFil: false,
        // Le parent d'un salon ordinaire est sa CATÉGORIE. `channel_type` est
        // joint à MESSAGE_CREATE mais pas le parent : il se lit dans l'état
        // local par `api.obtenirCanal`, pas ici — le chemin rapide ne peut pas
        // payer un aller-retour par message.
        canalParentId: message.channel?.parentId ?? message.channel?.parent_id ?? null,
        partiel: Boolean(message.partial),
    };
}

/**
 * piecesJointes : [{ id, nom, url, taille }]
 *
 * Le journal de suppression n'a souvent que cette liste de noms comme trace : le
 * fichier, lui, disparaît avec le message.
 */
function normaliserPiecesJointes(message) {
    const brut = message.attachments;
    if (!brut) return [];
    const liste = Array.isArray(brut) ? brut : [...(brut.cache?.values?.() || brut.values?.() || [])];
    return liste.map(piece => ({
        id: piece.id ?? null,
        nom: piece.name ?? piece.filename ?? null,
        url: piece.url ?? null,
        taille: piece.size ?? piece.file_size ?? null,
    }));
}

/**
 * Lien permanent vers le message.
 *
 * Construit ici et pas dans le code métier : une URL de plateforme écrite dans
 * un handler neutre serait exactement ce que ce chantier retire.
 */
function lienMessage(message) {
    if (typeof message.url === 'string' && message.url) return message.url;
    const canalId = message.channelId ?? message.channel_id ?? message.channel?.id;
    if (!canalId || !message.id) return null;
    const guildeId = message.guildId ?? message.guild_id ?? message.guild?.id ?? '@me';
    return `${BASE_LIEN_MESSAGE}/${guildeId}/${canalId}/${message.id}`;
}

/**
 * reactions : [{ emoji: { id, nom, anime, cle }, nombre, parMoi }]
 *
 * `parMoi` dit si le bot a DÉJÀ posé cette réaction : sans lui, un panneau doit
 * reposer chaque emoji à chaque modification, faute de pouvoir constater qu'il
 * est déjà là. Un PUT par entrée au lieu de zéro, sur une route limitée à
 * 30 requêtes / 10 s.
 *
 * ⚠️ « me? […] Present and true only when the authenticated user has this
 * reaction, and omitted entirely otherwise, so an absent key must be read as
 * false. » Le `Boolean()` fait exactement cela.
 */
function normaliserReactions(message) {
    const brut = message.reactions;
    if (!brut) return [];

    const liste = Array.isArray(brut) ? brut : [...(brut.cache?.values?.() || [])];
    return liste.map(reaction => ({
        emoji: {
            id: reaction.emoji?.id ?? null,
            nom: reaction.emoji?.name ?? null,
            anime: Boolean(reaction.emoji?.animated),
            cle: cleEmoji(reaction.emoji),
        },
        nombre: reaction.count ?? 0,
        parMoi: Boolean(reaction.me),
    }));
}

/**
 * Clé d'un emoji, telle qu'elle est STOCKÉE EN BASE.
 *
 * ⚠️ Ce n'est pas l'identifiant. `bot/commands/reactionrole.js` enregistre la
 * chaîne saisie — `🎮` pour un unicode, `<:nom:id>` ou `<a:nom:id>` pour un
 * emoji personnalisé — et c'est cette forme exacte que `reaction_roles.emoji`
 * contient. Rendre `emoji.id` donnerait `55` là où la base porte `<:quasar:55>`.
 *
 * ⚠️ PIÈGE PROPRE À FLUXER : « animated? […] Present only on the Message
 * Reaction Add that creates the FIRST reaction with that emoji on the message.
 * An addition to an emoji that already has a reactor, a Message Reaction Remove,
 * and a Message Reaction Remove Emoji omit the field. » — et surtout « A client
 * MUST NOT read an absent animated as false ».
 *
 * Conséquence directe : la clé d'un emoji personnalisé ANIMÉ vaut `<a:nom:id>`
 * au premier clic et `<:nom:id>` aux suivants. Un panneau de rôles-réactions
 * fondé sur un emoji animé attribuerait son rôle à la première personne et à
 * personne d'autre. On ne devine pas l'animation : `resoudreCleEmoji` (plus bas)
 * la retrouve dans l'état des emojis du serveur avant de construire la clé.
 */
function cleEmoji(emoji) {
    if (!emoji) return null;
    if (emoji.id) return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
    return emoji.name ?? null;
}

/** reaction : { messageId, canalId, guildeId, emoji: { id, nom, anime, cle } } */
function normaliserReaction(reaction) {
    if (!reaction) return null;
    const emoji = reaction.emoji || {};
    return {
        // Payload de passerelle : les identifiants sont à plat, il n'y a pas
        // d'objet message à traverser comme chez discord.js.
        messageId: reaction.message?.id ?? reaction.message_id ?? null,
        canalId: reaction.message?.channelId ?? reaction.channel_id ?? null,
        guildeId: reaction.message?.guildId ?? reaction.guild_id ?? null,
        emoji: {
            id: emoji.id ?? null,
            nom: emoji.name ?? null,
            anime: Boolean(emoji.animated),
            cle: cleEmoji(emoji),
        },
    };
}

/**
 * etatVocal : { guildeId, membreId, membre, canalId, muetServeur, muetSoi,
 *               sourdServeur, sourdSoi, muet, sourd }
 *
 * Les quatre drapeaux sont exposés séparément et `muet`/`sourd` n'en sont que le
 * résumé : fusionner « rendu muet par un modérateur » et « s'est mis en muet »
 * est une perte irréversible, et un journal qui les confond annonce une sanction
 * là où quelqu'un a coupé son micro. Les quatre existent à l'identique dans le
 * VOICE_STATE_UPDATE de Fluxer (`mute`, `deaf`, `self_mute`, `self_deaf`).
 */
function normaliserEtatVocal(etat, { etatClient = null } = {}) {
    if (!etat) return null;
    const guildeId = etat.guild?.id ?? etat.guildId ?? etat.guild_id ?? null;
    const membreId = etat.id ?? etat.member?.id ?? etat.member?.user?.id ?? etat.user_id ?? null;
    return {
        guildeId,
        membreId,
        membre: etat.member
            ? normaliserMembre(etat.member, { etat: etatClient, guildeId })
            : (etatClient && guildeId && membreId
                ? normaliserMembre(etatClient.membre(guildeId, membreId), { etat: etatClient, guildeId })
                : null),
        canalId: etat.channelId ?? etat.channel_id ?? null,
        muetServeur: Boolean(etat.serverMute ?? etat.mute),
        muetSoi: Boolean(etat.selfMute ?? etat.self_mute),
        sourdServeur: Boolean(etat.serverDeaf ?? etat.deaf),
        sourdSoi: Boolean(etat.selfDeaf ?? etat.self_deaf),
        get muet() { return this.muetServeur || this.muetSoi; },
        get sourd() { return this.sourdServeur || this.sourdSoi; },
    };
}

/**
 * sanction : { guildeId, membreId, regleId, action, contenu, canalId, … }
 *
 * ⚠️ SANS OBJET SUR FLUXER. La plateforme n'a aucune modération automatique
 * native : pas de route, pas d'événement dans `event_atoms.erl`, pas un fichier
 * dans son dépôt. Rend donc toujours `null`.
 *
 * La fonction existe pour deux raisons, et aucune n'est cosmétique. D'abord la
 * surface du module doit être la même des deux côtés, ce qu'un test de miroir
 * vérifie. Ensuite, le jour où Fluxer livrerait un automod, c'est ici et nulle
 * part ailleurs que la traduction s'écrirait — et la capacité basculerait dans
 * `index.js`, sans qu'une ligne de `bot/events/` soit touchée.
 */
function normaliserSanction() {
    return null;
}

// ─── Table de correspondance (DA §7.2) ───────────────────────────────────────
//
// Nom neutre -> [nom de l'événement Fluxer, normalisation du payload].
//
// Le normaliseur reçoit `(d, contexte)` où `contexte` porte l'état local et
// l'« avant » qu'il a fallu lire avant d'écrire. Il rend le TABLEAU des
// arguments passés au handler, dans le même ordre que côté Discord.

const EVENEMENTS = Object.freeze({
    pret: ['READY', () => []],

    messageCree: ['MESSAGE_CREATE', (d, { etat }) => {
        etat?.poserMessage(d);
        if (d?.guild_id && d.member) {
            etat?.poserMembre(d.guild_id, { ...d.member, user: d.author });
        }
        return [normaliserMessage(d)];
    }],

    // ⚠️ Pas d'« avant » dans le payload : on le prend dans l'état local AVANT
    // d'y écrire la nouvelle version. Hors cache, l'« avant » est un message
    // PARTIEL — jamais null : un handler qui compare `avant.contenu` à
    // `apres.contenu` doit pouvoir lire les deux.
    messageModifie: ['MESSAGE_UPDATE', (d, { etat }) => {
        const ancien = etat?.poserMessage(d) ?? null;
        const avant = ancien
            ? normaliserMessage(ancien)
            : normaliserMessage({ id: d?.id, channel_id: d?.channel_id, guild_id: d?.guild_id, partial: true });
        return [avant, normaliserMessage(d)];
    }],

    // Payload plus riche que celui de Discord : il porte `content`, `author_id`
    // et `member`. On le complète tout de même par le cache, parce que « Both
    // fields are omitted when the deletion came from moderation tools » — et
    // c'est précisément le cas où un journal de suppression est le plus utile.
    messageSupprime: ['MESSAGE_DELETE', (d, { etat }) => {
        const connu = etat?.retirerMessage(d?.id) ?? null;
        const fusionne = {
            ...(connu || {}),
            id: d?.id,
            channel_id: d?.channel_id ?? connu?.channel_id,
            guild_id: d?.guild_id ?? connu?.guild_id,
            content: d?.content ?? connu?.content ?? null,
            author: connu?.author
                ?? (d?.author_id ? { id: d.author_id, ...(d.member?.user || {}) } : null),
            partial: !connu && d?.content === undefined,
        };
        return [normaliserMessage(fusionne)];
    }],

    reactionAjoutee: ['MESSAGE_REACTION_ADD', (d, { etat }) => {
        if (d?.guild_id && d.member) etat?.poserMembre(d.guild_id, d.member);
        return [
            normaliserReaction({ ...d, emoji: resoudreEmoji(d, etat) }),
            normaliserUtilisateur(d?.member?.user ?? { id: d?.user_id }),
        ];
    }],

    reactionRetiree: ['MESSAGE_REACTION_REMOVE', (d, { etat }) => [
        normaliserReaction({ ...d, emoji: resoudreEmoji(d, etat) }),
        normaliserUtilisateur(d?.member?.user ?? { id: d?.user_id }),
    ]],

    // Le payload est le membre complet avec `guild_id` ajouté — mais SANS le nom
    // du serveur. Il vient de l'état local, alimenté par la rafale de
    // GUILD_CREATE : aucun appel REST n'est payé à chaque arrivée.
    membreRejoint: ['GUILD_MEMBER_ADD', (d, { etat }) => {
        etat?.poserMembre(d?.guild_id, d);
        return [
            normaliserMembre(d, { etat, guildeId: d?.guild_id }),
            guildePourEvenement(d?.guild_id, etat),
        ];
    }],

    // « The object has id alone. No other account field is sent, so a client MUST
    // resolve the account from state it already holds. » Sans le cache, un
    // message d'au revoir n'aurait ni nom ni avatar — c'est la raison d'être de
    // `etat.membres`.
    membreParti: ['GUILD_MEMBER_REMOVE', (d, { etat }) => {
        const connu = etat?.retirerMembre(d?.guild_id, d?.user?.id) ?? null;
        const membre = connu
            ? { ...connu, user: connu.user || d?.user }
            : { user: d?.user, roles: [], guild_id: d?.guild_id };
        return [
            normaliserMembre(membre, { etat, guildeId: d?.guild_id }),
            guildePourEvenement(d?.guild_id, etat),
        ];
    }],

    // Même piège que messageModifie : pas d'« avant » dans le payload.
    // Le SERVEUR est le troisième argument, comme côté Discord.
    membreModifie: ['GUILD_MEMBER_UPDATE', (d, { etat }) => {
        const ancien = etat?.poserMembre(d?.guild_id, d) ?? null;
        return [
            normaliserMembre(ancien ?? { user: d?.user, roles: [], guild_id: d?.guild_id },
                { etat, guildeId: d?.guild_id }),
            normaliserMembre(d, { etat, guildeId: d?.guild_id }),
            guildePourEvenement(d?.guild_id, etat),
        ];
    }],

    // Le payload est un « guild ready object » : le serveur est sous
    // `properties`, pas à la racine. `normaliserGuilde` accepte les deux formes.
    guildeRejointe: ['GUILD_CREATE', (d) => [
        normaliserGuilde(d?.properties ? { id: d.id, ...d.properties, member_count: d.member_count } : d),
    ]],

    // « Without unavailable, the account is no longer a member […] With
    // unavailable: true, the guild is retained in a placeholder state. » Le
    // drapeau `disponible` transporte la nuance : sans lui, la purge des données
    // se déclencherait sur une simple panne.
    guildeQuittee: ['GUILD_DELETE', (d, { etat }) => {
        const connu = etat?.guilde(d?.id) ?? null;
        const proprietes = { ...(connu?.proprietes || {}) };
        etat?.retirerGuilde(d?.id, { indisponible: d?.unavailable === true });
        return [normaliserGuilde({ id: d?.id, ...proprietes, unavailable: d?.unavailable === true })];
    }],

    canalCree: ['CHANNEL_CREATE', (d) => [normaliserCanal(d)]],
    canalSupprime: ['CHANNEL_DELETE', (d) => [normaliserCanal(d)]],

    roleCree: ['GUILD_ROLE_CREATE', (d) => [normaliserRole(d?.role, { guildeId: d?.guild_id })]],

    // Le payload ne porte que `role_id` : le rôle supprimé vient de l'état local,
    // lu AVANT que `appliquerAEtat` ne l'en retire. Sans lui, un journal de
    // suppression de rôle n'aurait qu'un identifiant à afficher.
    roleSupprime: ['GUILD_ROLE_DELETE', (d, { etat }) => {
        const connu = etat?.role(d?.guild_id, d?.role_id) ?? null;
        etat?.retirerRole(d?.guild_id, d?.role_id);
        return [normaliserRole(connu ?? { id: d?.role_id, name: null, position: 0, color: 0 },
            { guildeId: d?.guild_id })];
    }],

    etatVocalModifie: ['VOICE_STATE_UPDATE', (d, { etat }) => {
        const ancien = etat?.poserEtatVocal(d) ?? null;
        // L'« avant » d'une personne qui n'était dans aucun salon est un état
        // vide sur le même serveur — et non `null`, que `voiceStateUpdate.js`
        // déréférencerait. C'est ce que produit discord.js pour une arrivée.
        const avant = ancien ?? {
            guild_id: d?.guild_id, user_id: d?.user_id, channel_id: null, member: d?.member,
        };
        return [
            normaliserEtatVocal(avant, { etatClient: etat }),
            normaliserEtatVocal(d, { etatClient: etat }),
        ];
    }],

    // Aucun événement en face. Déclaré à `null` plutôt qu'omis : la table doit
    // rester EXHAUSTIVE sur le vocabulaire neutre, et l'omission ne dirait pas
    // si c'est un manque de la plateforme ou un oubli de l'adaptateur.
    sanctionAutomatique: [null, () => [normaliserSanction()]],
});

const NOMS_EVENEMENTS = Object.freeze(Object.keys(EVENEMENTS));

// La table doit couvrir tout le vocabulaire neutre. Un nom déclaré au contrat
// mais absent ici ferait échouer un abonnement au démarrage, très loin du
// fichier fautif.
const manquants = EVENEMENTS_NEUTRES.filter(nom => !EVENEMENTS[nom]);
if (manquants.length > 0) {
    throw new Error(
        `Table des événements Fluxer incomplète : ${manquants.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/fluxer/events.js.'
    );
}

/** Guilde normalisée pour un payload qui ne porte que `guild_id`. */
function guildePourEvenement(guildeId, etat) {
    if (!guildeId) return null;
    const connu = etat?.guilde(guildeId);
    return normaliserGuilde(connu ?? { id: guildeId });
}

/**
 * Emoji d'un événement de réaction, avec son animation rétablie.
 *
 * Voir l'avertissement de `cleEmoji` : Fluxer n'envoie `animated` que sur la
 * PREMIÈRE réaction d'un emoji donné sur un message. Un panneau de rôles indexé
 * sur `<a:nom:id>` cesserait donc de fonctionner dès la deuxième personne.
 * On retrouve l'information dans les emojis du serveur, qui sont livrés par
 * GUILD_CREATE et tenus à jour par GUILD_EMOJIS_UPDATE.
 *
 * À VÉRIFIER EN RECETTE : un rôle-réaction sur un emoji personnalisé ANIMÉ,
 * cliqué par deux personnes successives. Les deux doivent recevoir le rôle.
 */
function resoudreEmoji(d, etat) {
    const emoji = d?.emoji;
    if (!emoji?.id || emoji.animated !== undefined) return emoji;
    const guilde = etat?.guilde(d?.guild_id);
    const connu = (guilde?.proprietes?.emojis || []).find(e => String(e.id) === String(emoji.id));
    return connu ? { ...emoji, animated: Boolean(connu.animated) } : emoji;
}

/**
 * Filet d'erreur par défaut d'un handler d'événement.
 *
 * Il ne remplace pas celui de `bot/index.js` (qui produit un code d'incident) :
 * il existe pour qu'un abonnement pris hors du chargeur ne laisse JAMAIS une
 * promesse flottante, où elle deviendrait un « rejet non capté » anonyme — sans
 * le nom de l'événement, donc sans le seul indice utile.
 */
function surErreurParDefaut(err, contexte) {
    console.error(
        `[Quasar] ⚠️  Événement ${contexte.evenement} | ${err?.name || 'Error'}: ${err?.message || err}`
    );
    if (err?.stack) console.error(err.stack);
}

/**
 * Abonne un handler neutre à un événement de la passerelle Fluxer.
 *
 * @param {object} client      client Fluxer
 * @param {object} adaptateur
 * @param {string} nomNeutre
 * @param {(ctx, ...donnees) => any} handler
 * @param {{une?: boolean, surErreur?: Function}} [options]
 * @returns {() => void} fonction de désabonnement
 */
function surEvenement(client, adaptateur, nomNeutre, handler, { une = false, surErreur } = {}) {
    const entree = EVENEMENTS[nomNeutre];
    if (!entree) {
        throw new Error(
            `Événement neutre inconnu : "${nomNeutre}". Noms acceptés : ${NOMS_EVENEMENTS.join(', ')}.`
        );
    }
    const [nomNatif] = entree;
    if (nomNatif === null) {
        throw new Error(
            `L'événement « ${nomNeutre} » n'existe pas sur Fluxer : la plateforme ne le dispatche pas. `
            + 'Déclarez « capaciteRequise » sur le handler pour qu\'il ne soit branché que là où la '
            + 'capacité existe, plutôt que de tester le nom de la plateforme.'
        );
    }
    return adaptateur.abonner(nomNeutre, handler, { une, surErreur: surErreur || surErreurParDefaut });
}

/**
 * Contexte servi aux handlers d'événements. Volontairement plus pauvre que celui
 * des commandes : un événement n'a personne à qui répondre, il agit par `api`.
 */
function creerContexteEvenement(adaptateur) {
    return {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,
        moi: adaptateur.moi,
        api: adaptateur.api,
        get db() { return require('../../../api/services/database').getDb(); },

        /**
         * Pose un panneau persistant. Même méthode, même signature et même
         * routage que sur un contexte de commande : c'est `canalId` qui décide
         * du salon, pas l'origine de l'appel.
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, options);
        },
    };
}

/**
 * Charge bot/events/ et branche chaque handler, dans LES DEUX formats.
 *
 * ⚠️ Le format HISTORIQUE (`{ name, once, execute }`) est REFUSÉ, comme côté
 * Discord depuis la consolidation — et ici la raison est doublement forte : ces
 * handlers reçoivent des objets discord.js bruts, un `Message`, un
 * `GuildMember`, qui n'existent pas sur Fluxer. Les brancher produirait des
 * `undefined` en cascade très loin du fichier fautif ; les IGNORER ferait
 * disparaître une fonctionnalité du bot sans erreur, sans journal et sans
 * symptôme qui désigne sa cause. On lève.
 */
function chargerEvenements({ dossier, adaptateur, surErreur } = {}) {
    if (!dossier || !fs.existsSync(dossier)) return [];
    const client = adaptateur.client;
    const signaler = surErreur || surErreurParDefaut;
    const charges = [];

    for (const fichier of fs.readdirSync(dossier).filter(f => f.endsWith('.js'))) {
        const mod = require(path.join(dossier, fichier));

        if (estDescripteurEvenement(mod)) {
            // Un handler qui exige une capacité absente n'est pas branché : c'est
            // la voie par laquelle `sanctionAutomatique` reste Discord-only sans
            // qu'aucun code métier ne nomme la plateforme.
            if (mod.capaciteRequise && !adaptateur.capacites[mod.capaciteRequise]) {
                charges.push({ nom: mod.nom, fichier, neutre: true, branche: false });
                continue;
            }
            // Seconde barrière : un événement que Fluxer ne dispatche pas. Elle
            // est distincte de la première — un handler peut très bien ne
            // déclarer aucune capacité et viser un événement absent.
            if (EVENEMENTS[mod.nom]?.[0] === null) {
                charges.push({ nom: mod.nom, fichier, neutre: true, branche: false });
                continue;
            }
            surEvenement(client, adaptateur, mod.nom, mod.executer, { une: mod.une, surErreur: signaler });
            charges.push({ nom: mod.nom, fichier, neutre: true, branche: true });
            continue;
        }

        if (typeof mod?.name === 'string' && typeof mod?.execute === 'function') {
            throw new Error(
                `bot/events/${fichier} : le handler « ${mod.name} » est au format historique `
                + '`{ name, execute(...objets discord.js) }`, que le chargeur n\'accepte plus. '
                + 'Décrivez-le avec `definirEvenement({ nom, executer(ctx, …) })` (bot/platform/events.js), '
                + `en reprenant le nom NEUTRE de l'événement (${EVENEMENTS_NEUTRES.join(', ')}).`
            );
        }
    }

    return charges;
}

module.exports = {
    EVENEMENTS,
    NOMS_EVENEMENTS,
    surEvenement,
    chargerEvenements,
    creerContexteEvenement,
    surErreurParDefaut,
    normaliserMessage,
    normaliserReactions,
    normaliserPiecesJointes,
    lienMessage,
    TYPES_MESSAGE_HUMAINS,
    normaliserReaction,
    normaliserEtatVocal,
    normaliserSanction,
    cleEmoji,
    resoudreEmoji,
    guildePourEvenement,
    BASE_LIEN_MESSAGE,
};
