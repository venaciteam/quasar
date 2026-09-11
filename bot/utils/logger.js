// ═══════════════════════════════════════════════════════════════
//  Journalisation des événements de serveur
//
//  Bi-format le temps de la migration multiplateforme : `sendLog` est appelée
//  par quinze fichiers, migrés ou non. La voie historique reçoit une `Guild`
//  discord.js et un `EmbedBuilder` ; la voie neutre reçoit une portée
//  (`ctx`, ou `{ guildeId, api }`) et un embed neutre. La détection vient de
//  `bot/utils/errors.js`, seul endroit du dépôt où elle est écrite.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../api/services/database');
const { resoudrePorteeNeutre, versEmbedDiscord } = require('./errors');

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
    try {
        return JSON.parse(mod.config || '{}');
    } catch (err) {
        // Une seule ligne `modules.config` corrompue faisait lever cette
        // fonction, donc `sendLog`, donc `guildMemberAdd` — AVANT le message de
        // bienvenue et AVANT les autorôles. L'équipe du serveur constatait « les
        // autorôles ne marchent plus », sans aucun lien visible avec la cause.
        // Une configuration de journalisation illisible ne doit priver que de la
        // journalisation : on repart sur une configuration vide, et on le dit
        // une fois dans les journaux du serveur.
        console.error(`[Quasar] Configuration de journalisation illisible pour le serveur ${guildId} : ${err.message}. Journalisation désactivée pour ce serveur jusqu'à correction.`);
        return {};
    }
}

function isLogEnabled(guildId, logType) {
    const config = getLogConfig(guildId);
    if (!config.logChannel) return false;
    const logs = config.enabledLogs || {};
    // Par défaut, modération + tempvoice activés, le reste désactivé
    if (logType.startsWith('mod_') || logType.startsWith('tempvoice_')) return logs[logType] !== false;
    return logs[logType] === true;
}

/**
 * Envoie un embed dans le salon de journalisation du serveur.
 *
 * @param {object} cible   `Guild` discord.js (voie historique), ou portée neutre :
 *   un `ctx`, ou `{ guildeId, api }`. Reconnue à la présence d'un `api` normalisé.
 * @param {string} logType clé de LOG_CATEGORIES
 * @param {object} contenu embed neutre, ou `EmbedBuilder` sur la voie historique.
 *   Un embed neutre passé avec une `Guild` est rendu au vol : un fichier à demi
 *   migré (embed neutre, guilde discord.js) reste fonctionnel.
 */
async function sendLog(cible, logType, contenu) {
    const portee = resoudrePorteeNeutre(cible);
    const guildId = portee ? portee.guildeId : cible.id;

    if (!isLogEnabled(guildId, logType)) return;
    const config = getLogConfig(guildId);
    if (!config.logChannel) return;

    if (portee) {
        try {
            // Pas d'équivalent du « salon absent du cache » qui fait renoncer la
            // voie historique sans un mot : le client REST neutre ne tient pas de
            // cache. Un salon supprimé produit donc une erreur, attrapée ici et
            // journalisée exactement comme un échec d'envoi.
            await portee.api.envoyerMessage(config.logChannel, contenu);
        } catch (e) {
            console.error(`[Quasar] Erreur log ${logType}:`, e.message);
        }
        return;
    }

    // TRANSITION : format historique, à retirer au lot de consolidation
    const channel = cible.channels.cache.get(config.logChannel);
    if (!channel) return;

    try {
        await channel.send({ embeds: [versEmbedDiscord(contenu)] });
    } catch (e) {
        console.error(`[Quasar] Erreur log ${logType}:`, e.message);
    }
}

module.exports = { LOG_CATEGORIES, isLogEnabled, sendLog, getLogConfig };
