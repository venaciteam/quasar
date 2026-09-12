// ⚠️ NON MIGRÉE AU LOT 1 — il manque une pièce au contrat neutre.
//
// L'embed de confirmation affiche l'étiquette de la personne débannie
// (`ban.user.tag`), lue par `guild.bans.fetch()`. Le client REST normalisé
// (DA §4.3) ne sait pas lire un bannissement : il sait seulement en poser un et
// le lever. Sans `api.obtenirBannissement(guildeId, utilisateurId)`, la
// migration perdrait ce champ — donc l'information qui permet de vérifier qu'on
// a bien débanni la bonne personne. Voir le compte-rendu du lot 1.
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { reportIncident, userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Débannir un utilisateur')
        .addStringOption(opt => opt.setName('id').setDescription('L\'ID de l\'utilisateur à débannir').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        const userId = interaction.options.getString('id');

        try {
            const ban = await interaction.guild.bans.fetch(userId);
            await interaction.guild.members.unban(userId);

            const embed = new EmbedBuilder()
                .setTitle('✅ Débannissement')
                .setColor(0x2ecc71)
                .addFields(
                    { name: 'Utilisateur', value: `${ban.user.tag} (${userId})`, inline: true },
                    { name: 'Débanni par', value: `${interaction.user}`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (e) {
            // Discord renvoie 10026 (Unknown Ban) quand l'identifiant n'est pas banni :
            // c'est le cas courant, pas un incident. Le reste est un vrai problème.
            if (e?.code === 10026) {
                return userError(interaction, {
                    title: 'Cette personne n\'est pas bannie',
                    cause: 'Aucun bannissement en cours ne correspond à cet identifiant sur ce serveur.',
                    action: 'Vérifiez l\'identifiant dans Paramètres du serveur → Bannissements. Il s\'agit de l\'identifiant Discord, pas du pseudo.',
                });
            }
            return reportIncident(interaction, e, { command: '/unban' });
        }
    }
};
