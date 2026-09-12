// ═══════════════════════════════════════════════════════════════
//  Journal de modération
//
//  Bi-format, et RETENU par `api/**` (lot 7). Une seule chaîne y mène encore :
//
//    api/routes/antiraid.js  -> antiraid.enterPanic(guild) / liftPanic(guild)
//    -> bot/modules/antiraid/panic.js (voie Guild)
//    -> punishments.sendAutomodLog(guild, ...)
//    -> sendModLog(guild, ...)
//
//  Le jour ou cette route recoit l'adaptateur au lieu du client, la voie
//  historique tombe ici comme elle est deja tombee dans `bot/utils/logger.js`.
//  La detection de portee vient de `bot/utils/errors.js`, seul endroit du depot
//  ou elle est ecrite.
// ═══════════════════════════════════════════════════════════════

const { isLogEnabled, getLogConfig } = require('./logger');
const { resoudrePorteeNeutre, versEmbedDiscord } = require('./errors');

/**
 * Envoie un embed de modération dans le salon de logs du serveur.
 *
 * Le type de log est obligatoire et respecté. Cette fonction envoyait auparavant
 * dès qu'un salon de logs était défini, sans jamais consulter les cases « Types de
 * logs » du dashboard : décocher « ⚠️ Warn » n'avait donc aucun effet. Un réglage
 * affiché mais ignoré est pire que pas de réglage du tout — on cherche longtemps
 * pourquoi « ça ne marche pas ».
 *
 * @param {object} cible   portée neutre (un `ctx`, ou `{ guildeId, api }`),
 *   reconnue à la présence d'un client REST normalisé ; ou `Guild` discord.js
 *   sur la voie retenue par `api/routes/antiraid.js` (cf. en-tête).
 * @param {object} contenu embed neutre, ou `EmbedBuilder`. Un embed neutre passé
 *   avec une `Guild` est rendu au vol : c'est exactement ce que fait le mode
 *   panique, dont les embeds sont neutres depuis le lot 5b.
 * @param {string} logType — clé de LOG_CATEGORIES : mod_warn, mod_mute, mod_kick, mod_ban…
 */
async function sendModLog(cible, contenu, logType) {
    if (!logType) {
        // Garde-fou : un appel sans type contournerait silencieusement les réglages.
        console.error('[Quasar] sendModLog appelé sans type de log — envoi annulé.');
        return;
    }

    const portee = resoudrePorteeNeutre(cible);
    const guildId = portee ? portee.guildeId : cible.id;

    // Les types mod_* sont actifs par défaut (voir isLogEnabled) : le comportement
    // ne change donc pas pour un serveur qui n'a jamais touché à ces cases.
    if (!isLogEnabled(guildId, logType)) return;

    const config = getLogConfig(guildId);
    if (!config.logChannel) return;

    if (portee) {
        // Pas d'équivalent du « salon absent du cache » qui fait renoncer la voie
        // historique sans un mot : le client REST neutre ne tient pas de cache.
        // Un salon supprimé produit donc une erreur, attrapée ici et journalisée
        // exactement comme un échec d'envoi.
        await portee.api.envoyerMessage(config.logChannel, contenu).catch(err => {
            console.error(`[Quasar] Erreur envoi du log ${logType}:`, err.message);
        });
        return;
    }

    // ⚠️ VOIE NATIVE — une `Guild` discord.js — RETENUE par `api/**`, lot 7 :
    //   api/routes/antiraid.js  -> antiraid.enterPanic(guild) / liftPanic(guild)
    //   -> bot/modules/antiraid/panic.js (voie Guild)
    //   -> punishments.sendAutomodLog(guild) -> ICI.
    // C'est la seule chaîne qui y mène encore. Elle tombe le jour où la route du
    // dashboard passe l'adaptateur au lieu du client.
    const channel = cible.channels.cache.get(config.logChannel);
    if (!channel) return;

    await channel.send({ embeds: [versEmbedDiscord(contenu)] }).catch(err => {
        console.error(`[Quasar] Erreur envoi du log ${logType}:`, err.message);
    });
}

module.exports = { sendModLog };
