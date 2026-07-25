const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { buildTranscriptFile, deliverTranscript } = require('../utils/transcriptArchive');

const ACCENT_COLOR = 0xDE3163;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Gérer le système de tickets')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Configurer le système de tickets')
                .addChannelOption(opt =>
                    opt.setName('salon')
                        .setDescription('Le salon où envoyer le message d\'ouverture de ticket')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addRoleOption(opt =>
                    opt.setName('staff')
                        .setDescription('Le rôle staff qui aura accès aux tickets')
                        .setRequired(true)
                )
                .addChannelOption(opt =>
                    opt.setName('categorie')
                        .setDescription('La catégorie où créer les tickets')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt.setName('message')
                        .setDescription('Message d\'accueil custom (affiché à l\'ouverture du ticket)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('close')
                .setDescription('Fermer le ticket actuel')
                .addStringOption(opt =>
                    opt.setName('raison')
                        .setDescription('Raison de la fermeture')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Ajouter un membre au ticket')
                .addUserOption(opt =>
                    opt.setName('membre')
                        .setDescription('Le membre à ajouter')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Retirer un membre du ticket')
                .addUserOption(opt =>
                    opt.setName('membre')
                        .setDescription('Le membre à retirer')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('config')
                .setDescription('Voir la configuration actuelle des tickets')
        )
        .setDefaultMemberPermissions(0),

    async execute(interaction) {
        const db = getDb();
        const guildId = interaction.guild.id;
        const sub = interaction.options.getSubcommand();

        if (sub === 'setup') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ Tu as besoin de la permission **Gérer le serveur**.', ephemeral: true });
            }

            const channel = interaction.options.getChannel('salon');
            const staffRole = interaction.options.getRole('staff');
            const category = interaction.options.getChannel('categorie');
            const welcomeMessage = interaction.options.getString('message') || null;

            db.prepare(`
                INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, enabled)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(guild_id) DO UPDATE SET
                    channel_id = excluded.channel_id,
                    category_id = excluded.category_id,
                    staff_role_id = excluded.staff_role_id,
                    welcome_message = excluded.welcome_message,
                    enabled = 1
            `).run(guildId, channel.id, category?.id || null, staffRole.id, welcomeMessage);

            const panelConfig = db.prepare('SELECT panel_title, panel_description FROM ticket_config WHERE guild_id = ?').get(guildId);

            const setupEmbed = new EmbedBuilder()
                .setTitle(panelConfig?.panel_title || '🎫 Support — Ouvrir un ticket')
                .setDescription(panelConfig?.panel_description || 'Clique sur le bouton ci-dessous pour ouvrir un ticket.\nUn membre du staff te répondra dès que possible.')
                .setColor(ACCENT_COLOR)
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_open')
                    .setLabel('Ouvrir un ticket')
                    .setEmoji('🎫')
                    .setStyle(ButtonStyle.Primary)
            );

            await channel.send({ embeds: [setupEmbed], components: [row] });

            const confirmEmbed = new EmbedBuilder()
                .setTitle('🎫 Système de tickets configuré')
                .setColor(ACCENT_COLOR)
                .addFields(
                    { name: 'Salon', value: `<#${channel.id}>`, inline: true },
                    { name: 'Rôle staff', value: `<@&${staffRole.id}>`, inline: true },
                    { name: 'Catégorie', value: category ? category.name : 'Aucune (racine)', inline: true }
                )
                .setTimestamp();

            if (welcomeMessage) {
                confirmEmbed.addFields({ name: 'Message d\'accueil', value: welcomeMessage });
            }

            return interaction.reply({ embeds: [confirmEmbed], ephemeral: true });
        }

        if (sub === 'close') {
            const reason = interaction.options.getString('raison') || 'Aucune raison fournie';
            await closeTicket(interaction, reason);
            return;
        }

        if (sub === 'add') {
            const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ? AND closed_at IS NULL')
                .get(guildId, interaction.channel.id);

            if (!ticket) {
                return interaction.reply({ content: '❌ Cette commande ne peut être utilisée que dans un ticket.', ephemeral: true });
            }

            const member = interaction.options.getUser('membre');
            await interaction.channel.permissionOverwrites.edit(member.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            });

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ ${member} a été ajouté au ticket.`)
                        .setColor(ACCENT_COLOR)
                ]
            });
        }

        if (sub === 'remove') {
            const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ? AND closed_at IS NULL')
                .get(guildId, interaction.channel.id);

            if (!ticket) {
                return interaction.reply({ content: '❌ Cette commande ne peut être utilisée que dans un ticket.', ephemeral: true });
            }

            const member = interaction.options.getUser('membre');
            await interaction.channel.permissionOverwrites.delete(member.id);

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ ${member} a été retiré du ticket.`)
                        .setColor(ACCENT_COLOR)
                ]
            });
        }

        if (sub === 'config') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({ content: '❌ Tu as besoin de la permission **Gérer le serveur**.', ephemeral: true });
            }

            const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guildId);

            if (!config) {
                return interaction.reply({ content: '🎫 Aucune configuration de tickets. Utilise `/ticket setup` pour commencer.', ephemeral: true });
            }

            const openCount = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND closed_at IS NULL').get(guildId).count;
            const totalCount = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?').get(guildId).count;

            const embed = new EmbedBuilder()
                .setTitle('🎫 Configuration des tickets')
                .setColor(ACCENT_COLOR)
                .addFields(
                    { name: 'Statut', value: config.enabled ? '✅ Activé' : '❌ Désactivé', inline: true },
                    { name: 'Salon', value: `<#${config.channel_id}>`, inline: true },
                    { name: 'Rôle staff', value: `<@&${config.staff_role_id}>`, inline: true },
                    { name: 'Catégorie', value: config.category_id ? `<#${config.category_id}>` : 'Aucune (racine)', inline: true },
                    { name: 'Tickets ouverts', value: `${openCount}`, inline: true },
                    { name: 'Total tickets', value: `${totalCount}`, inline: true }
                )
                .setTimestamp();

            if (config.welcome_message) {
                embed.addFields({ name: 'Message d\'accueil', value: config.welcome_message });
            }

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
};

async function closeTicket(interaction, reason) {
    const db = getDb();
    const guildId = interaction.guild.id;

    const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ? AND closed_at IS NULL')
        .get(guildId, interaction.channel.id);

    if (!ticket) {
        return interaction.reply({ content: '❌ Ce salon n\'est pas un ticket ouvert.', ephemeral: true });
    }

    // La collecte des messages puis l'envoi du fichier prennent plus de 3 secondes
    // sur un ticket fourni : on prend le délai avant de commencer.
    await interaction.deferReply();

    // L'ordre compte. Le salon Discord va être supprimé et la conversation n'est
    // plus conservée en base : tant que le transcript n'a pas été remis à
    // l'administrateur, la fermeture ne doit pas avoir lieu.
    const { transcript, messageCount } = await collectTranscript(interaction.channel);

    const logEmbed = new EmbedBuilder()
        .setTitle('🎫 Ticket fermé')
        .setColor(ACCENT_COLOR)
        .addFields(
            { name: 'Ticket', value: `#${ticket.id} — ${interaction.channel.name}`, inline: true },
            { name: 'Ouvert par', value: `<@${ticket.user_id}>`, inline: true },
            { name: 'Fermé par', value: `${interaction.user}`, inline: true },
            { name: 'Raison', value: reason }
        )
        .setTimestamp();

    const file = buildTranscriptFile({
        ticketId: ticket.id,
        guild: interaction.guild,
        ticket,
        closedBy: interaction.user.id,
        reason,
        transcript,
        messageCount,
    });

    const delivery = await deliverTranscript({
        guild: interaction.guild,
        moderator: interaction.user,
        embed: logEmbed,
        file,
    });

    // Échec des deux destinations : on refuse de fermer plutôt que de supprimer le
    // salon avec la conversation dedans. Le ticket reste ouvert, rien n'est perdu.
    if (!delivery.ok) {
        console.error(`[Quasar] Fermeture du ticket #${ticket.id} refusée — transcript non remis : ${delivery.error}`);
        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('❌ Fermeture annulée — transcript non archivé')
                    .setDescription(
                        'Quasar ne conserve pas les conversations de tickets : le transcript doit être ' +
                        'remis avant que le salon soit supprimé. Ici, aucune des deux voies n\'a fonctionné.\n\n' +
                        '**Pour débloquer, au choix :**\n' +
                        '• configurer un salon de logs auquel Quasar peut écrire (`/log`) ;\n' +
                        '• ou ouvrir tes messages privés pour ce serveur, puis relancer la fermeture.\n\n' +
                        '_Le ticket reste ouvert, aucun message n\'a été perdu._'
                    )
                    .setColor(0xED4245)
                    .setTimestamp()
            ]
        });
    }

    // Archivage acquis : on peut clore. Le transcript n'est PAS écrit en base.
    db.prepare(`
        UPDATE tickets SET closed_at = datetime('now'), closed_by = ?, close_reason = ?
        WHERE id = ?
    `).run(interaction.user.id, reason, ticket.id);

    const notices = [];
    if (delivery.via === 'dm') {
        notices.push('📄 Le transcript t\'a été envoyé en message privé (aucun salon de logs disponible).');
    } else {
        notices.push('📄 Le transcript a été archivé dans le salon de logs.');
    }
    if (delivery.truncated) {
        notices.push('⚠️ La conversation était trop longue : le transcript a été tronqué.');
    }

    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('🎫 Ticket fermé')
                .setDescription(
                    `Fermé par ${interaction.user}\n**Raison :** ${reason}\n\n${notices.join('\n')}`
                )
                .setColor(ACCENT_COLOR)
                .setTimestamp()
        ]
    });

    // Supprimer le channel après 5 secondes
    setTimeout(async () => {
        try {
            await interaction.channel.delete();
        } catch (e) {
            console.error('[Quasar] Erreur suppression ticket:', e.message);
        }
    }, 5000);
}

// Collecte les messages du salon pour en faire un transcript remis à l'administrateur.
// Le résultat n'est jamais persisté : il part directement en pièce jointe.
async function collectTranscript(channel) {
    const messages = [];
    let lastId;

    // Récupérer jusqu'à 500 messages
    for (let i = 0; i < 5; i++) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const fetched = await channel.messages.fetch(options);
        if (fetched.size === 0) break;

        fetched.forEach(msg => {
            messages.push({
                author: msg.author?.tag || 'Inconnu',
                content: msg.content || '',
                attachments: msg.attachments.map(a => a.url).join(', '),
                timestamp: msg.createdAt.toISOString()
            });
        });

        lastId = fetched.last().id;
        if (fetched.size < 100) break;
    }

    messages.reverse();

    const lines = messages.map(m => {
        let line = `[${m.timestamp}] ${m.author}: ${m.content}`;
        if (m.attachments) line += ` [Pièces jointes: ${m.attachments}]`;
        return line;
    });

    return { transcript: lines.join('\n'), messageCount: messages.length };
}

module.exports.closeTicket = closeTicket;
