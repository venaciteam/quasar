// ═══════════════════════════════════════════════════════════════
//  Journal de modération
//
//  Entierement neutre depuis le lot 7. La voie `Guild` discord.js n'avait qu'une
//  chaine d'appel :
//
//    api/routes/antiraid.js  -> antiraid.enterPanic(guild) / liftPanic(guild)
//    -> bot/modules/antiraid/panic.js (voie Guild)
//    -> punishments.sendAutomodLog(guild, ...)
//    -> sendModLog(guild, ...)
//
//  La route passe desormais une portee neutre, et la voie historique est tombee
//  sur toute la chaine — comme elle l'avait deja fait dans `bot/utils/logger.js`.
//  La detection de portee vient de `bot/utils/errors.js`, seul endroit du depot
//  ou elle est ecrite.
// ═══════════════════════════════════════════════════════════════

const { isLogEnabled, getLogConfig } = require('./logger');
const { resoudrePorteeNeutre } = require('./errors');

/**
 * Envoie un embed de modération dans le salon de logs du serveur.
 *
 * Le type de log est obligatoire et respecté. Cette fonction envoyait auparavant
 * dès qu'un salon de logs était défini, sans jamais consulter les cases « Types de
 * logs » du dashboard : décocher « ⚠️ Warn » n'avait donc aucun effet. Un réglage
 * affiché mais ignoré est pire que pas de réglage du tout — on cherche longtemps
 * pourquoi « ça ne marche pas ».
 *
 * @param {object} cible   portée neutre (un `ctx`, un adaptateur, ou
 *   `{ guildeId, api }`), reconnue à la présence d'un client REST normalisé.
 * @param {object} contenu embed neutre
 * @param {string} logType — clé de LOG_CATEGORIES : mod_warn, mod_mute, mod_kick, mod_ban…
 */
async function sendModLog(cible, contenu, logType) {
    if (!logType) {
        // Garde-fou : un appel sans type contournerait silencieusement les réglages.
        console.error('[Quasar] sendModLog appelé sans type de log — envoi annulé.');
        return;
    }

    const portee = resoudrePorteeNeutre(cible);
    if (!portee) return;
    const guildId = portee.guildeId;

    // Les types mod_* sont actifs par défaut (voir isLogEnabled) : le comportement
    // ne change donc pas pour un serveur qui n'a jamais touché à ces cases.
    if (!isLogEnabled(guildId, logType)) return;

    const config = getLogConfig(guildId);
    if (!config.logChannel) return;

    // Pas d'équivalent du « salon absent du cache » qui faisait renoncer la voie
    // historique sans un mot : le client REST neutre ne tient pas de cache. Un
    // salon supprimé produit donc une erreur, attrapée ici et journalisée
    // exactement comme un échec d'envoi.
    await portee.api.envoyerMessage(config.logChannel, contenu).catch(err => {
        console.error(`[Quasar] Erreur envoi du log ${logType}:`, err.message);
    });
}

module.exports = { sendModLog };
