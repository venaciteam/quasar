const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { reportIncident, userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Supprimer des messages')
        .addIntegerOption(opt => opt.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
        .addUserOption(opt => opt.setName('membre').setDescription('Supprimer uniquement les messages de ce membre').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        const amount = interaction.options.getInteger('nombre');
        const targetUser = interaction.options.getUser('membre');

        await interaction.deferReply({ ephemeral: true });

        try {
            if (targetUser) {
                // Récupérer les messages et filtrer par utilisateur
                const messages = await interaction.channel.messages.fetch({ limit: 100 });
                const userMessages = messages
                    .filter(m => m.author.id === targetUser.id)
                    .first(amount);

                if (userMessages.length === 0) {
                    return userError(interaction, {
                        title: 'Aucun message à supprimer',
                        cause: `Je n'ai trouvé aucun message de ${targetUser} parmi les 100 derniers messages de ce salon.`,
                        action: 'Cette personne n\'a peut-être rien écrit récemment ici. La recherche ne remonte pas au-delà de 100 messages.',
                    });
                }

                const deleted = await interaction.channel.bulkDelete(userMessages, true);
                await interaction.editReply({
                    content: `🗑️ **${deleted.size}** message(s) de ${targetUser} supprimé(s).`
                });
            } else {
                const deleted = await interaction.channel.bulkDelete(amount, true);
                await interaction.editReply({
                    content: `🗑️ **${deleted.size}** message(s) supprimé(s).`
                });
            }
        } catch (e) {
            // 50034 : Discord interdit la suppression groupée au-delà de 14 jours.
            // C'est une limite de la plateforme, pas un bug — inutile d'alarmer.
            if (e?.code === 50034) {
                return userError(interaction, {
                    title: 'Messages trop anciens',
                    cause: 'Discord interdit la suppression groupée des messages de plus de 14 jours.',
                    action: 'Supprime-les manuellement, ou relance la commande avec un nombre plus petit pour ne viser que les messages récents.',
                });
            }
            return reportIncident(interaction, e, { command: '/clear' });
        }
    }
};
