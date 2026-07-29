// ═══════════════════════════════════════════════════════════════
//  Notification de violation — Construction + envoi Discord
//
//  Sous-lot C du lot 2 de conformité RGPD. La propriétaire de l'instance
//  (BOT_OWNER_ID) rédige une notification de violation ; ce module construit
//  l'embed correspondant et l'envoie à un destinataire (MP) ou, en repli, dans
//  un salon du serveur concerné.
//
//  Ce fichier ne décide de RIEN : il exécute un envoi et rend compte de son
//  résultat ({ ok, error }). La logique de file, de reprise et de repli est dans
//  index.js. La séparation est volontaire : un envoi qui échoue doit laisser une
//  trace exploitable (art. 33.5 — savoir qui n'a PAS reçu), pas lever une
//  exception qui remonte jusqu'à la boucle.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

// Rouge « alerte », cohérent avec bot/utils/errors.js — une notification de
// violation n'est pas un message anodin.
const COLOR_BREACH = 0xED4245;

// Discord plafonne la description d'un embed à 4096 caractères. On tronque
// proprement plutôt que de laisser l'API rejeter l'embed entier : une
// notification tronquée (avec renvoi au point de contact) vaut infiniment mieux
// qu'une notification jamais partie.
const MAX_DESCRIPTION = 4096;

// Point de contact du sous-traitant (Venacity), imposé par l'art. 33.3.b.
const CONTACT = 'contact@vena.city';

/**
 * Tronque un texte à `max` caractères en coupant de préférence sur un espace,
 * et en signalant explicitement la troncature.
 */
function truncate(text, max = MAX_DESCRIPTION) {
    const body = String(text || '');
    if (body.length <= max) return body;

    const suffix = '\n\n[…] Message tronqué — la version complète est disponible auprès du point de contact.';
    const room = Math.max(0, max - suffix.length);
    let cut = body.slice(0, room);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > room * 0.8) cut = cut.slice(0, lastSpace);
    return cut + suffix;
}

/**
 * Construit l'embed d'une notification de violation.
 * @param {object} incident — ligne breach_incidents (peut être partielle : title suffit)
 * @param {object} message  — ligne breach_messages (phase, body, created_at)
 * @returns {EmbedBuilder}
 */
function buildBreachEmbed(incident, message) {
    const phase = Number(message?.phase) || 1;
    const phaseLabel = phase === 1
        ? 'Phase 1 — notification initiale'
        : `Phase ${phase} — information complémentaire`;

    const embed = new EmbedBuilder()
        .setTitle('⚠️ Notification de violation de données')
        .setColor(COLOR_BREACH)
        .setDescription(truncate(message?.body))
        .addFields({ name: 'Notification', value: phaseLabel })
        .setFooter({ text: `Point de contact : ${CONTACT} — Venacity, sous-traitant (RGPD art. 28)` })
        .setTimestamp(message?.created_at ? message.created_at * 1000 : Date.now());

    if (incident?.title) {
        embed.setAuthor({ name: `Incident : ${incident.title}`.slice(0, 256) });
    }
    return embed;
}

/**
 * Réduit une exception à une chaîne courte et exploitable, stockée dans
 * breach_deliveries.error. On garde le code Discord/SQLite quand il existe : il
 * suffit à comprendre pourquoi un destinataire n'a pas reçu (MP fermés = 50007,
 * permission manquante = 50013…).
 */
function describeError(err) {
    if (!err) return 'erreur inconnue';
    const code = (err.code !== undefined && err.code !== null) ? `[${err.code}] ` : '';
    return (code + (err.message || String(err))).slice(0, 500);
}

/**
 * Envoie l'embed en message privé à un utilisateur.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function sendDM(client, userId, embed) {
    if (!client || !userId) return { ok: false, error: 'client ou destinataire indisponible' };
    try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [embed] });
        return { ok: true, error: null };
    } catch (err) {
        return { ok: false, error: describeError(err) };
    }
}

/**
 * Repli salon : poste l'embed dans le salon système du serveur s'il est
 * écrivable, sinon dans le premier salon texte où le bot peut écrire.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function sendToGuildChannel(client, guildId, embed) {
    if (!client || !guildId) return { ok: false, error: 'client ou serveur indisponible' };

    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return { ok: false, error: 'serveur introuvable dans le cache du bot' };

    const me = guild.members?.me;
    if (!me) return { ok: false, error: 'membre bot introuvable sur le serveur' };

    const canWrite = (ch) => {
        const perms = ch?.permissionsFor?.(me);
        return !!(perms
            && perms.has(PermissionFlagsBits.ViewChannel)
            && perms.has(PermissionFlagsBits.SendMessages));
    };

    // 1. Salon système si écrivable ; 2. sinon premier salon texte écrivable.
    let target = null;
    if (guild.systemChannel && canWrite(guild.systemChannel)) {
        target = guild.systemChannel;
    } else {
        target = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildText && canWrite(c))
            .sort((a, b) => a.rawPosition - b.rawPosition)
            .first();
    }

    if (!target) return { ok: false, error: 'aucun salon texte écrivable trouvé sur ce serveur' };

    try {
        await target.send({ embeds: [embed] });
        return { ok: true, error: null };
    } catch (err) {
        return { ok: false, error: describeError(err) };
    }
}

module.exports = {
    COLOR_BREACH,
    MAX_DESCRIPTION,
    CONTACT,
    truncate,
    buildBreachEmbed,
    describeError,
    sendDM,
    sendToGuildChannel,
};
