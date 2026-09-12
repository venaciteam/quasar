// ═══════════════════════════════════════════════════════════════
//  Salon autorisé pour les commandes musique
//
//  ⚠️ HORS PÉRIMÈTRE DU CHANTIER MULTIPLATEFORME, et ce n'est pas un oubli.
//
//  Ce fichier reçoit une `interaction` discord.js et lui répond directement. Il
//  n'a pas été migré au contrat neutre parce que la famille MUSIQUE est COUPÉE
//  depuis le 2026-06-18 :
//    • `play.js`, `musicconfig.js` et `musiccontrols.js` sont dans
//      `DISABLED_COMMAND_FILES` — ni chargées, ni déployées ;
//    • `@discordjs/voice` n'est plus une dépendance du `package.json`, donc
//      `bot/modules/music/` ne peut même pas être requis ;
//    • la DA exclut explicitement la musique du portage Fluxer (voix en LiveKit,
//      sans protocole de signalisation publié).
//
//  Ses deux seuls appelants sont `play.js` et `musiccontrols.js`, donc personne.
//  Le migrer aurait été réécrire à l'aveugle du code que rien n'exécute et
//  qu'aucun test ne couvre. Si la musique est réactivée, ce fichier fait partie
//  du chantier : `interaction.reply` devient `ctx.erreurUtilisateur`, et
//  `interaction.channel.id` devient `ctx.canalId`.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../api/services/database');

/**
 * Vérifie si la commande musique est autorisée dans ce channel.
 * Retourne true si OK, false sinon (et répond à l'interaction).
 */
async function checkMusicChannel(interaction) {
    const db = getDb();

    try {
        db.exec(`ALTER TABLE music_config ADD COLUMN allowed_channel TEXT DEFAULT NULL`);
    } catch {} // Colonne déjà existante = ignoré

    try {
        const config = db.prepare('SELECT allowed_channel FROM music_config WHERE guild_id = ?').get(interaction.guild.id);
        if (!config?.allowed_channel) return true; // Pas de restriction

        if (interaction.channel.id !== config.allowed_channel) {
            await interaction.reply({
                content: `❌ Les commandes musique sont réservées au salon <#${config.allowed_channel}>.`,
                ephemeral: true
            });
            return false;
        }
    } catch {
        // Table pas encore créée = pas de restriction
    }

    return true;
}

module.exports = { checkMusicChannel };
