const { isLogEnabled, getLogConfig } = require('./logger');

/**
 * Envoie un embed de modération dans le salon de logs du serveur.
 *
 * Le type de log est obligatoire et respecté. Cette fonction envoyait auparavant
 * dès qu'un salon de logs était défini, sans jamais consulter les cases « Types de
 * logs » du dashboard : décocher « ⚠️ Warn » n'avait donc aucun effet. Un réglage
 * affiché mais ignoré est pire que pas de réglage du tout — on cherche longtemps
 * pourquoi « ça ne marche pas ».
 *
 * @param {Guild} guild
 * @param {EmbedBuilder} embed
 * @param {string} logType — clé de LOG_CATEGORIES : mod_warn, mod_mute, mod_kick, mod_ban…
 */
async function sendModLog(guild, embed, logType) {
    if (!logType) {
        // Garde-fou : un appel sans type contournerait silencieusement les réglages.
        console.error('[Quasar] sendModLog appelé sans type de log — envoi annulé.');
        return;
    }

    // Les types mod_* sont actifs par défaut (voir isLogEnabled) : le comportement
    // ne change donc pas pour un serveur qui n'a jamais touché à ces cases.
    if (!isLogEnabled(guild.id, logType)) return;

    const config = getLogConfig(guild.id);
    if (!config.logChannel) return;

    const channel = guild.channels.cache.get(config.logChannel);
    if (!channel) return;

    await channel.send({ embeds: [embed] }).catch(err => {
        console.error(`[Quasar] Erreur envoi du log ${logType}:`, err.message);
    });
}

module.exports = { sendModLog };
