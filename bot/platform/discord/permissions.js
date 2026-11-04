// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des permissions — Discord
//
//  Traduit les noms canoniques de `platform/permissions.js` (DA §7.1) en
//  bitfields discord.js. Fichier séparé de `index.js` pour être consommé sans
//  cycle par `commands.js` (permission par défaut d'une commande) et
//  `context.js` (`membre.aPermission`).
//
//  ⚠️ `PermissionFlagsBits` expose des BigInt, et c'est capital : plusieurs
//  permissions Discord dépassent 2^53. Toute arithmétique en `number` sur ces
//  valeurs perd des bits en silence.
// ═══════════════════════════════════════════════════════════════

const { PermissionFlagsBits } = require('discord.js');
const { PERMISSIONS, versBitfield, serialiserBitfield } = require('../permissions');

// Nom canonique -> drapeau discord.js. La table est vérifiée exhaustive au
// chargement, juste en dessous : un nom ajouté au vocabulaire neutre sans être
// traduit ici doit faire échouer le démarrage, pas produire un `undefined`.
const BITS = Object.freeze({
    ADMINISTRATOR: PermissionFlagsBits.Administrator,
    MANAGE_GUILD: PermissionFlagsBits.ManageGuild,
    MANAGE_ROLES: PermissionFlagsBits.ManageRoles,
    MANAGE_CHANNELS: PermissionFlagsBits.ManageChannels,
    MANAGE_MESSAGES: PermissionFlagsBits.ManageMessages,
    MANAGE_NICKNAMES: PermissionFlagsBits.ManageNicknames,
    MANAGE_WEBHOOKS: PermissionFlagsBits.ManageWebhooks,
    KICK_MEMBERS: PermissionFlagsBits.KickMembers,
    BAN_MEMBERS: PermissionFlagsBits.BanMembers,
    MODERATE_MEMBERS: PermissionFlagsBits.ModerateMembers,
    MOVE_MEMBERS: PermissionFlagsBits.MoveMembers,
    MUTE_MEMBERS: PermissionFlagsBits.MuteMembers,
    DEAFEN_MEMBERS: PermissionFlagsBits.DeafenMembers,
    VIEW_AUDIT_LOG: PermissionFlagsBits.ViewAuditLog,
    VIEW_CHANNEL: PermissionFlagsBits.ViewChannel,
    SEND_MESSAGES: PermissionFlagsBits.SendMessages,
    EMBED_LINKS: PermissionFlagsBits.EmbedLinks,
    ATTACH_FILES: PermissionFlagsBits.AttachFiles,
    ADD_REACTIONS: PermissionFlagsBits.AddReactions,
    READ_MESSAGE_HISTORY: PermissionFlagsBits.ReadMessageHistory,
    MENTION_EVERYONE: PermissionFlagsBits.MentionEveryone,
    CONNECT: PermissionFlagsBits.Connect,
});

const manquantes = PERMISSIONS.filter(nom => typeof BITS[nom] !== 'bigint');
if (manquantes.length > 0) {
    throw new Error(
        `Table des permissions Discord incomplète : ${manquantes.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/discord/permissions.js.'
    );
}

/** @param {string[]|string} noms @returns {bigint} */
const bitfield = (noms) => versBitfield(noms, BITS);

/** Bitfield sérialisé en chaîne, forme attendue par l'API REST. */
const bitfieldChaine = (noms) => serialiserBitfield(bitfield(noms));

/**
 * Le porteur de permissions a-t-il la permission canonique demandée ?
 * `perms` est un `PermissionsBitField` discord.js. En son absence on répond
 * « non » : transformer un « je ne sais pas » en droit accordé serait le pire
 * des replis (même règle que `memberIsAdministrator` dans bot/index.js).
 */
function aPermission(perms, nom) {
    const bit = BITS[nom];
    if (typeof bit !== 'bigint') {
        throw new Error(`Permission inconnue côté Discord : "${nom}".`);
    }
    return typeof perms?.has === 'function' ? perms.has(bit) : false;
}

module.exports = { BITS, bitfield, bitfieldChaine, aPermission };
