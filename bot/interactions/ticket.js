const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendLog } = require('../utils/logger');
const { userError } = require('../utils/errors');

const ACCENT_COLOR = 0xDE3163;

async function handleTicketInteraction(interaction) {
    const customId = interaction.customId;

    // ═══════════════════════════════════════
    //  BOUTON : Ouvrir un ticket
    // ═══════════════════════════════════════

    if (interaction.isButton() && customId === 'ticket_open') {
        const db = getDb();
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ? AND enabled = 1').get(guildId);
        if (!config) {
            return userError(interaction, {
                title: 'Les tickets ne sont pas configurés',
                cause: 'Aucun salon d\'ouverture ni rôle staff n\'a été défini sur ce serveur.',
                action: 'Un administrateur doit lancer `/ticket setup` pour activer le système.',
            });
        }

        // Vérifier si l'utilisateur a déjà un ticket ouvert
        const existing = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND closed_at IS NULL').get(guildId, userId);
        if (existing) {
            const existingChannel = interaction.guild.channels.cache.get(existing.channel_id);
            if (existingChannel) {
                return userError(interaction, {
                    title: 'Tu as déjà un ticket ouvert',
                    cause: `Ton ticket en cours est <#${existing.channel_id}>. Un seul ticket à la fois est autorisé, pour éviter les doublons côté staff.`,
                    action: 'Poursuis la discussion dans ce salon. S\'il est résolu, ferme-le avec `/ticket close` avant d\'en ouvrir un nouveau.',
                });
            }
            // Channel supprimé mais ticket pas fermé — nettoyer
            db.prepare("UPDATE tickets SET closed_at = datetime('now'), closed_by = 'system', close_reason = 'Channel supprimé' WHERE id = ?").run(existing.id);
        }

        // Créer le channel
        const username = interaction.user.username.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20) || 'user';
        const ticketCount = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?').get(guildId).count;
        const channelName = `ticket-${username}-${ticketCount + 1}`;

        const permissionOverwrites = [
            {
                id: interaction.guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: userId,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles]
            },
            {
                id: config.staff_role_id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
            },
            {
                id: interaction.client.user.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory]
            }
        ];

        const channelOptions = {
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites
        };

        if (config.category_id) {
            channelOptions.parent = config.category_id;
        }

        let ticketChannel;
        try {
            ticketChannel = await interaction.guild.channels.create(channelOptions);
        } catch (e) {
            console.error('[Quasar] Erreur création ticket channel:', e);
            return userError(interaction, {
                title: 'Impossible de créer le ticket',
                cause: 'Je n\'ai pas pu créer le salon. Il me manque probablement la permission **Gérer les salons**, ou la catégorie configurée a été supprimée.',
                action: 'Préviens un administrateur : il doit vérifier mes permissions et relancer `/ticket setup` si la catégorie n\'existe plus.',
            });
        }

        // Enregistrer en DB
        const result = db.prepare(`
            INSERT INTO tickets (guild_id, channel_id, user_id, opened_at)
            VALUES (?, ?, ?, datetime('now'))
        `).run(guildId, ticketChannel.id, userId);

        const ticketId = result.lastInsertRowid;

        // Envoyer le message d'accueil
        const welcomeText = config.welcome_message || 'Un membre du staff va te répondre sous peu. Décris ton problème en détail.';

        const welcomeEmbed = new EmbedBuilder()
            .setTitle(`🎫 Ticket #${ticketId}`)
            .setDescription(`Bienvenue ${interaction.user} !\n\n${welcomeText}`)
            .setColor(ACCENT_COLOR)
            .addFields(
                { name: 'Ouvert par', value: `${interaction.user}`, inline: true },
                { name: 'Staff', value: `<@&${config.staff_role_id}>`, inline: true }
            )
            .setTimestamp();

        const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('ticket_close')
                .setLabel('Fermer le ticket')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Danger)
        );

        await ticketChannel.send({ content: `${interaction.user} | <@&${config.staff_role_id}>`, embeds: [welcomeEmbed], components: [closeRow] });

        await interaction.reply({ content: `✅ Ton ticket a été créé : <#${ticketChannel.id}>`, ephemeral: true });

        // Log
        const logEmbed = new EmbedBuilder()
            .setTitle('🎫 Ticket ouvert')
            .setColor(ACCENT_COLOR)
            .addFields(
                { name: 'Ticket', value: `#${ticketId} — <#${ticketChannel.id}>`, inline: true },
                { name: 'Par', value: `${interaction.user}`, inline: true }
            )
            .setTimestamp();

        sendLog(interaction.guild, 'ticket_open', logEmbed).catch(() => {});
        return;
    }

    // ═══════════════════════════════════════
    //  BOUTON : Fermer un ticket
    // ═══════════════════════════════════════

    if (interaction.isButton() && customId === 'ticket_close') {
        const modal = new ModalBuilder()
            .setCustomId('ticket_close_reason')
            .setTitle('Fermer le ticket')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('reason')
                        .setLabel('Raison de la fermeture (optionnel)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Problème résolu, spam, etc.')
                        .setMaxLength(1000)
                        .setRequired(false)
                )
            );

        return interaction.showModal(modal);
    }

    // ═══════════════════════════════════════
    //  MODAL : Raison de fermeture
    // ═══════════════════════════════════════

    if (interaction.isModalSubmit() && customId === 'ticket_close_reason') {
        const reason = interaction.fields.getTextInputValue('reason') || 'Aucune raison fournie';
        const { closeTicket } = require('../commands/ticket');
        await closeTicket(interaction, reason);
        return;
    }
}

module.exports = { handleTicketInteraction };
