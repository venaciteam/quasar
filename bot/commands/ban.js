const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('../utils/modlog');
const { reportIncident, userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Bannir un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Le membre à bannir').setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison du ban').setRequired(false))
        .addIntegerOption(opt => opt.setName('supprimer').setDescription('Supprimer les messages des X derniers jours (0-7)').setMinValue(0).setMaxValue(7).setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        const target = interaction.options.getUser('membre');
        const reason = interaction.options.getString('raison') || 'Aucune raison spécifiée';
        const deleteDays = interaction.options.getInteger('supprimer') || 0;
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (member && !member.bannable) {
            return userError(interaction, {
                title: 'Je ne peux pas bannir ce membre',
                cause: 'Soit il me manque la permission **Bannir des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
                action: 'Vérifie mes permissions, et place mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
            });
        }

        try {
            await interaction.guild.members.ban(target.id, {
                reason,
                deleteMessageSeconds: deleteDays * 86400
            });
        } catch (e) {
            // Vraie exception : code d'incident pour retrouver la trace.
            return reportIncident(interaction, e, { command: '/ban' });
        }

        const db = getDb();
        db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'ban', ?)
        `).run(interaction.guild.id, target.id, interaction.user.id, reason);

        const embed = new EmbedBuilder()
            .setTitle('🔨 Bannissement')
            .setColor(0xe74c3c)
            .addFields(
                { name: 'Membre', value: `${target} (${target.tag})`, inline: true },
                { name: 'Modérateur', value: `${interaction.user}`, inline: true },
                { name: 'Raison', value: reason },
                { name: 'Messages supprimés', value: `${deleteDays} jour(s)`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed);
    }
};
