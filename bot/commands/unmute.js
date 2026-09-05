const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Unmute un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Le membre à unmute').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const target = interaction.options.getUser('membre');
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
            return userError(interaction, {
                title: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur.',
                action: 'Vérifiez qu\'elle en est toujours membre.',
            });
        }

        if (!member.communicationDisabledUntilTimestamp) {
            return userError(interaction, {
                title: 'Ce membre n\'est pas exclu',
                cause: 'Aucune exclusion temporaire n\'est en cours pour cette personne — elle a peut-être déjà expiré.',
                action: 'Aucune action nécessaire.',
            });
        }

        try {
            await member.timeout(null);
        } catch (e) {
            return userError(interaction, {
                title: 'Je ne peux pas lever cette exclusion',
                cause: 'Soit il me manque la permission **Exclure temporairement des membres**, soit ce membre a un rôle situé au-dessus du mien.',
                action: 'Vérifiez mes permissions, et placez mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🔊 Unmute')
            .setColor(0x2ecc71)
            .addFields(
                { name: 'Membre', value: `${target} (${target.tag})`, inline: true },
                { name: 'Unmute par', value: `${interaction.user}`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
