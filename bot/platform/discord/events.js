// ═══════════════════════════════════════════════════════════════
//  Événements normalisés — Discord
//
//  Table de correspondance de la DA §7.2, et normalisation des payloads. Un
//  handler neutre reçoit toujours `(ctx, ...donnees)`, où `ctx` porte l'accès
//  à la plateforme et où `donnees` a la MÊME forme sur Discord et sur Fluxer.
//
//  Les payloads sont documentés ci-dessous, à l'endroit qui les porte : c'est
//  le contrat que consommeront les seize handlers de bot/events/ quand ils
//  seront migrés (lots 1 à 5). Toute donnée absente de ces structures est
//  inaccessible au code métier — si un handler en a besoin, elle s'ajoute ici
//  pour les DEUX plateformes, jamais en lisant `brut`.
//
//  ⚠️ `sanctionAutomatique` n'existe que sur Discord (Fluxer n'a pas d'automod).
//  C'est le seul événement de la table qui ne soit pas universel : le code qui
//  s'y abonne doit tester `capacites.automod`, jamais le nom de la plateforme.
// ═══════════════════════════════════════════════════════════════

const {
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    normaliserCanal,
    normaliserGuilde,
} = require('./context');

/**
 * message : { id, canalId, guildeId, auteur, contenu, embeds, estBot, partiel }
 * `partiel` signale un message hors cache : seuls `id`, `canalId` et `guildeId`
 * sont alors fiables. C'est le cas courant d'une suppression ou d'une réaction
 * sur un message antérieur au démarrage.
 */
function normaliserMessage(message) {
    if (!message) return null;
    return {
        id: message.id,
        canalId: message.channelId ?? message.channel?.id ?? null,
        guildeId: message.guildId ?? message.guild?.id ?? null,
        auteur: normaliserUtilisateur(message.author),
        contenu: message.content ?? null,
        embeds: message.embeds ?? [],
        estBot: Boolean(message.author?.bot),
        partiel: Boolean(message.partial),
    };
}

/**
 * reaction : { messageId, canalId, guildeId, emoji: { id, nom, cle } }
 * `cle` est la forme utilisée en base par les reaction roles : l'identifiant
 * pour un emoji personnalisé, le caractère unicode sinon.
 */
function normaliserReaction(reaction) {
    if (!reaction) return null;
    const emoji = reaction.emoji || {};
    return {
        messageId: reaction.message?.id ?? null,
        canalId: reaction.message?.channelId ?? null,
        guildeId: reaction.message?.guildId ?? null,
        emoji: { id: emoji.id ?? null, nom: emoji.name ?? null, cle: emoji.id || emoji.name || null },
    };
}

/** etatVocal : { guildeId, membreId, canalId, muet, sourd } */
function normaliserEtatVocal(etat) {
    if (!etat) return null;
    return {
        guildeId: etat.guild?.id ?? etat.guildId ?? null,
        membreId: etat.id ?? etat.member?.id ?? null,
        canalId: etat.channelId ?? null,
        muet: Boolean(etat.serverMute || etat.selfMute),
        sourd: Boolean(etat.serverDeaf || etat.selfDeaf),
    };
}

/** sanction : { guildeId, membreId, regleId, action, contenu, canalId } */
function normaliserSanction(execution) {
    if (!execution) return null;
    return {
        guildeId: execution.guild?.id ?? execution.guildId ?? null,
        membreId: execution.userId ?? null,
        regleId: execution.ruleId ?? null,
        action: execution.action?.type ?? null,
        contenu: execution.content ?? null,
        canalId: execution.channelId ?? null,
    };
}

// Nom neutre -> [nom discord.js, normalisation du payload].
// L'ordre des arguments d'un événement discord.js est repris tel quel : c'est
// lui qui décide de la signature neutre.
const EVENEMENTS = Object.freeze({
    pret: ['clientReady', () => []],
    messageCree: ['messageCreate', (message) => [normaliserMessage(message)]],
    messageModifie: ['messageUpdate', (avant, apres) => [normaliserMessage(avant), normaliserMessage(apres)]],
    messageSupprime: ['messageDelete', (message) => [normaliserMessage(message)]],
    reactionAjoutee: ['messageReactionAdd', (reaction, user) => [normaliserReaction(reaction), normaliserUtilisateur(user)]],
    reactionRetiree: ['messageReactionRemove', (reaction, user) => [normaliserReaction(reaction), normaliserUtilisateur(user)]],
    membreRejoint: ['guildMemberAdd', (membre) => [normaliserMembre(membre), normaliserGuilde(membre?.guild)]],
    membreParti: ['guildMemberRemove', (membre) => [normaliserMembre(membre), normaliserGuilde(membre?.guild)]],
    membreModifie: ['guildMemberUpdate', (avant, apres) => [normaliserMembre(avant), normaliserMembre(apres)]],
    guildeRejointe: ['guildCreate', (guilde) => [normaliserGuilde(guilde)]],
    guildeQuittee: ['guildDelete', (guilde) => [normaliserGuilde(guilde)]],
    canalCree: ['channelCreate', (canal) => [normaliserCanal(canal)]],
    canalSupprime: ['channelDelete', (canal) => [normaliserCanal(canal)]],
    roleCree: ['roleCreate', (role) => [normaliserRole(role)]],
    roleSupprime: ['roleDelete', (role) => [normaliserRole(role)]],
    etatVocalModifie: ['voiceStateUpdate', (avant, apres) => [normaliserEtatVocal(avant), normaliserEtatVocal(apres)]],
    sanctionAutomatique: ['autoModerationActionExecution', (execution) => [normaliserSanction(execution)]],
});

const NOMS_EVENEMENTS = Object.freeze(Object.keys(EVENEMENTS));

/**
 * Abonne un handler neutre à un événement de la passerelle Discord.
 *
 * Le handler reçoit `(ctx, ...donnees)`. Les exceptions ne sont PAS attrapées
 * ici : c'est `bot/index.js` qui pose le filet commun (journalisation avec code
 * d'incident et alerte), et deux filets superposés produiraient deux traces
 * pour un seul défaut.
 *
 * @param {import('discord.js').Client} client
 * @param {object} adaptateur
 * @param {string} nomNeutre
 * @param {(ctx: object, ...donnees: any[]) => any} handler
 * @param {{une?: boolean}} [options] `une: true` pour un abonnement unique
 */
function surEvenement(client, adaptateur, nomNeutre, handler, { une = false } = {}) {
    const entree = EVENEMENTS[nomNeutre];
    if (!entree) {
        throw new Error(
            `Événement neutre inconnu : "${nomNeutre}". Noms acceptés : ${NOMS_EVENEMENTS.join(', ')}.`
        );
    }
    const [nomNatif, normaliser] = entree;

    const pont = (...args) => handler(creerContexteEvenement(adaptateur), ...normaliser(...args));
    if (une) client.once(nomNatif, pont);
    else client.on(nomNatif, pont);

    return () => client.off(nomNatif, pont);
}

/**
 * Contexte servi aux handlers d'événements. Volontairement plus pauvre que
 * celui des commandes : un événement n'a personne à qui répondre, il agit par
 * `api`.
 */
function creerContexteEvenement(adaptateur) {
    return {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,
        moi: adaptateur.moi,
        api: adaptateur.api,
        get db() { return require('../../../api/services/database').getDb(); },
    };
}

module.exports = {
    EVENEMENTS,
    NOMS_EVENEMENTS,
    surEvenement,
    creerContexteEvenement,
    normaliserMessage,
    normaliserReaction,
    normaliserEtatVocal,
    normaliserSanction,
};
