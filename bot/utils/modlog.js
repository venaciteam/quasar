// ═══════════════════════════════════════════════════════════════
//  Journal de modération
//
//  Bi-format le temps de la migration multiplateforme, pour la même raison que
//  `bot/utils/logger.js` : `sendModLog` garde un appelant non migré,
//  `sendAutomodLog` de bot/utils/punishments.js, qui lui passe encore une
//  `Guild` discord.js et un `EmbedBuilder` sur sa voie historique. La détection
//  vient de `bot/utils/errors.js`, seul endroit du dépôt où elle est écrite.
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
 *   sur la voie historique.
 * @param {object} contenu embed neutre, ou `EmbedBuilder` sur la voie historique.
 *   Un embed neutre passé avec une `Guild` est rendu au vol, comme dans `sendLog` :
 *   un fichier à demi migré reste fonctionnel.
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

    // TRANSITION : format historique, à retirer au lot de consolidation
    const channel = cible.channels.cache.get(config.logChannel);
    if (!channel) return;

    await channel.send({ embeds: [versEmbedDiscord(contenu)] }).catch(err => {
        console.error(`[Quasar] Erreur envoi du log ${logType}:`, err.message);
    });
}

module.exports = { sendModLog };
