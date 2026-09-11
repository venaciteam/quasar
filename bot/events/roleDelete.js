// ⚠️ NON MIGRÉ AU LOT 2 — bloqué par le contrat neutre.
//
// Le payload de `roleCree` / `roleSupprime` ne porte que `normaliserRole`, soit
// { id, nom, mention, position, gere }. Il manque DEUX informations que ce
// handler utilise, et qu'aucune autre méthode du contrat ne rend :
//   • la couleur du rôle (`role.hexColor`), affichée dans le champ « Couleur » ;
//   • le serveur du rôle, sans lequel `sendLog` ne sait pas où écrire —
//     l'événement neutre ne transmet pas de guilde.
// `bot/platform/**` étant en lecture seule pour les lots parallèles, le fichier
// reste au format historique. Signalé dans le compte rendu du lot 2.
const { EmbedBuilder } = require('discord.js');
const { sendLog } = require('../utils/logger');

module.exports = {
    name: 'roleDelete',
    once: false,
    async execute(role) {
        const embed = new EmbedBuilder()
            .setTitle('🎭 Rôle supprimé')
            .setColor(0xe74c3c)
            .addFields(
                { name: 'Nom', value: role.name, inline: true },
                { name: 'Couleur', value: role.hexColor, inline: true }
            )
            .setTimestamp();
        await sendLog(role.guild, 'server_role', embed);
    }
};
