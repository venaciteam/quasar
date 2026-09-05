const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('../utils/modlog');
const { reportIncident, userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Expulser un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Le membre à expulser').setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison du kick').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    async execute(interaction) {
        const target = interaction.options.getUser('membre');
        const reason = interaction.options.getString('raison') || 'Aucune raison spécifiée';
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
            return userError(interaction, {
                title: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur — elle est peut-être déjà partie.',
                action: 'Vérifiez la liste des membres du serveur.',
            });
        }
        if (!member.kickable) {
            return userError(interaction, {
                title: 'Je ne peux pas expulser ce membre',
                cause: 'Soit il me manque la permission **Expulser des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
                action: 'Vérifiez mes permissions, et placez mon rôle au-dessus du sien dans Paramètres du serveur → Rôles.',
            });
        }

        try {
            await member.kick(reason);
        } catch (e) {
            // Vraie exception : code d'incident pour retrouver la trace.
            return reportIncident(interaction, e, { command: '/kick' });
        }

        const db = getDb();
        db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'kick', ?)
        `).run(interaction.guild.id, target.id, interaction.user.id, reason);

        const embed = new EmbedBuilder()
            .setTitle('🔴 Expulsion')
            .setColor(0xe74c3c)
            .addFields(
                { name: 'Membre', value: `${target} (${target.tag})`, inline: true },
                { name: 'Modérateur', value: `${interaction.user}`, inline: true },
                { name: 'Raison', value: reason }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed, 'mod_kick');
    }
};
