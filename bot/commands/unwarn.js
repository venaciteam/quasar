const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unwarn')
        .setDescription('Retirer un avertissement')
        .addIntegerOption(opt => opt.setName('id').setDescription('ID de la sanction à retirer').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const sanctionId = interaction.options.getInteger('id');
        const db = getDb();

        const sanction = db.prepare(`
            SELECT * FROM sanctions WHERE id = ? AND guild_id = ? AND type = 'warn'
        `).get(sanctionId, interaction.guild.id);

        if (!sanction) {
            return userError(interaction, {
                title: 'Avertissement introuvable',
                cause: 'Aucun avertissement ne porte cet identifiant sur ce serveur. Il a peut-être été supprimé, ou l\'identifiant appartient à un autre serveur.',
                action: 'Retrouvez le bon identifiant avec `/warns @membre` — il est affiché à côté de chaque avertissement.',
            });
        }

        if (!sanction.active) {
            return userError(interaction, {
                title: 'Avertissement déjà retiré',
                cause: 'Cet avertissement a déjà été retiré : il ne compte plus dans le total du membre.',
                action: 'Aucune action nécessaire. `/warns @membre` affiche les avertissements encore actifs.',
            });
        }

        db.prepare('UPDATE sanctions SET active = 0 WHERE id = ?').run(sanctionId);

        const embed = new EmbedBuilder()
            .setTitle('✅ Avertissement retiré')
            .setColor(0x2ecc71)
            .addFields(
                { name: 'Sanction', value: `#${sanctionId}`, inline: true },
                { name: 'Membre', value: `<@${sanction.user_id}>`, inline: true },
                { name: 'Retiré par', value: `${interaction.user}`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
