// Commandes désactivées : fichiers de bot/commands/ ignorés au chargement (bot/index.js)
// ET au déploiement des slash commands (deploy-commands.js).
//
// Musique coupée le 2026-06-18 : YouTube/Google bloquent la lecture, maintenance trop fréquente.
// Pour réactiver : retirer les entrées du tableau (les fichiers commandes et le module
// bot/modules/music/ sont restés intacts). Penser aussi à réactiver le dashboard (sidebar,
// moduleList, routing, fonction loadMusic dans dashboard/js/app.js) et les deps Docker
// (ffmpeg + yt-dlp dans le Dockerfile).
module.exports = {
    DISABLED_COMMAND_FILES: ['play.js', 'musicconfig.js', 'musiccontrols.js']
};
