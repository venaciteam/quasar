const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');

const LOG_CATEGORIES = {
    // Modération (déjà en place via modlog.js, on garde la compat)
    'mod_warn': { label: '⚠️ Warn', category: 'Modération' },
    'mod_mute': { label: '🔇 Mute / Unmute', category: 'Modération' },
    'mod_kick': { label: '🔴 Kick', category: 'Modération' },
    'mod_ban': { label: '🔨 Ban / Unban', category: 'Modération' },
    'mod_clear': { label: '🗑️ Clear messages', category: 'Modération' },
    // Membres
    'member_join': { label: '📥 Membre rejoint', category: 'Membres' },
    'member_leave': { label: '📤 Membre quitte', category: 'Membres' },
    'member_nick': { label: '✏️ Changement de pseudo', category: 'Membres' },
    'member_roles': { label: '🎭 Rôle ajouté/retiré', category: 'Membres' },
    // Messages
    'msg_edit': { label: '✏️ Message modifié', category: 'Messages' },
    'msg_delete': { label: '🗑️ Message supprimé', category: 'Messages' },
    // Vocal
    'voice_join': { label: '🔊 Rejoint un vocal', category: 'Vocal' },
    'voice_leave': { label: '🔇 Quitte un vocal', category: 'Vocal' },
    'voice_move': { label: '🔄 Change de vocal', category: 'Vocal' },
    // Serveur
    'server_channel': { label: '📝 Channel créé/supprimé', category: 'Serveur' },
    'server_role': { label: '🎭 Rôle créé/supprimé', category: 'Serveur' },
    // TempVoice
    'tempvoice_create': { label: '🎧 Vocal temporaire créé', category: 'Vocal' },
    'tempvoice_delete': { label: '🎧 Vocal temporaire supprimé', category: 'Vocal' },
    // Tickets
    'ticket_open': { label: '🎫 Ticket ouvert', category: 'Tickets' },
    'ticket_close': { label: '🎫 Ticket fermé', category: 'Tickets' },
    // Quasar
    'quasar_command': { label: '⚡ Commande utilisée', category: 'Quasar' },
    // Musique désactivée — réactiver en décommentant
    // 'quasar_music': { label: '🎵 Musique jouée', category: 'Quasar' },
};

function getLogConfig(guildId) {
    const db = getDb();
    const mod = db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = ?')
        .get(guildId, 'moderation');
    if (!mod) return {};
    return JSON.parse(mod.config || '{}');
}

function isLogEnabled(guildId, logType) {
    const config = getLogConfig(guildId);
    if (!config.logChannel) return false;
    const logs = config.enabledLogs || {};
    // Par défaut, modération + tempvoice activés, le reste désactivé
    if (logType.startsWith('mod_') || logType.startsWith('tempvoice_')) return logs[logType] !== false;
    return logs[logType] === true;
}

async function sendLog(guild, logType, embed) {
    if (!isLogEnabled(guild.id, logType)) return;
    const config = getLogConfig(guild.id);
    if (!config.logChannel) return;

    const channel = guild.channels.cache.get(config.logChannel);
    if (!channel) return;

    try {
        await channel.send({ embeds: [embed] });
    } catch (e) {
        console.error(`[Quasar] Erreur log ${logType}:`, e.message);
    }
}

module.exports = { LOG_CATEGORIES, isLogEnabled, sendLog, getLogConfig };
