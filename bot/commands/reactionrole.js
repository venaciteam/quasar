const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');
const { checkAssignableRole, describeRefusal } = require('../utils/assignableRole');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reactionrole')
        .setDescription('Gérer les panels de reaction roles')
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Créer un panel de reaction roles')
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel où poster le panel').addChannelTypes(ChannelType.GuildText).setRequired(true))
            .addStringOption(opt => opt.setName('titre').setDescription('Titre du panel').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('Description du panel').setRequired(false))
            .addStringOption(opt => opt.setName('mode').setDescription('unique = un seul rôle, multiple = cumul').addChoices(
                { name: 'Multiple (cumul)', value: 'multiple' },
                { name: 'Unique (exclusif)', value: 'unique' }
            ).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Ajouter un emoji → rôle à un panel')
            .addIntegerOption(opt => opt.setName('panel_id').setDescription('ID du panel').setRequired(true))
            .addStringOption(opt => opt.setName('emoji').setDescription('L\'emoji à utiliser').setRequired(true))
            .addRoleOption(opt => opt.setName('role').setDescription('Le rôle associé').setRequired(true))
            .addStringOption(opt => opt.setName('description').setDescription('Description optionnelle').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Retirer un emoji d\'un panel')
            .addIntegerOption(opt => opt.setName('panel_id').setDescription('ID du panel').setRequired(true))
            .addStringOption(opt => opt.setName('emoji').setDescription('L\'emoji à retirer').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Supprimer un panel entier')
            .addIntegerOption(opt => opt.setName('panel_id').setDescription('ID du panel').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Lister les panels de reaction roles')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const db = getDb();

        if (sub === 'create') {
            const channel = interaction.options.getChannel('channel');
            const titre = interaction.options.getString('titre');
            const description = interaction.options.getString('description') || 'Cliquez sur un emoji pour obtenir le rôle correspondant.';
            const mode = interaction.options.getString('mode') || 'multiple';

            // Créer le panel en DB
            const result = db.prepare(`
                INSERT INTO reaction_panels (guild_id, channel_id, title, mode)
                VALUES (?, ?, ?, ?)
            `).run(interaction.guild.id, channel.id, titre, mode);

            const panelId = result.lastInsertRowid;

            // Poster l'embed dans le channel
            const embed = new EmbedBuilder()
                .setTitle(titre)
                .setDescription(description + '\n\n*(Aucun rôle configuré — utilise `/reactionrole add` pour en ajouter)*')
                .setColor(0xc86e8e)
                .setFooter({ text: `Panel #${panelId} • Mode ${mode}` });

            const msg = await channel.send({ embeds: [embed] });

            // Sauvegarder le message_id
            db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Panel créé')
                    .setColor(0x2ecc71)
                    .addFields(
                        { name: 'ID Panel', value: `#${panelId}`, inline: true },
                        { name: 'Channel', value: `${channel}`, inline: true },
                        { name: 'Mode', value: mode, inline: true }
                    )
                    .setDescription(`Utilisez \`/reactionrole add panel_id:${panelId} emoji:🎮 role:@Role\` pour ajouter des rôles.`)
                    .setTimestamp()],
                ephemeral: true
            });

        } else if (sub === 'add') {
            const panelId = interaction.options.getInteger('panel_id');
            const emoji = interaction.options.getString('emoji');
            const role = interaction.options.getRole('role');
            const description = interaction.options.getString('description') || null;

            const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
                .get(panelId, interaction.guild.id);

            if (!panel) {
                return userError(interaction, {
                title: 'Panel introuvable',
                cause: 'Aucun panel de rôles-réactions ne porte cet identifiant sur ce serveur.',
                action: 'Retrouvez le bon identifiant avec `/reactionrole list`.',
            });
            }

            // Un rôle inattribuable ne se voit qu'au premier clic sur l'emoji,
            // dans les logs du bot : le refus arrive ici, avec son motif.
            const refusal = checkAssignableRole(interaction.guild, role);
            if (refusal) return userError(interaction, describeRefusal(refusal, role));

            db.prepare(`
                INSERT INTO reaction_roles (panel_id, emoji, role_id, description)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(panel_id, emoji) DO UPDATE SET role_id = ?, description = ?
            `).run(panelId, emoji, role.id, description, role.id, description);

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Rôle ajouté au panel')
                    .setColor(0xc86e8e)
                    .addFields(
                        { name: 'Emoji', value: emoji, inline: true },
                        { name: 'Rôle', value: `${role}`, inline: true }
                    )
                    .setTimestamp()],
                ephemeral: true
            });

            // Mettre à jour l'embed du panel (après la réponse)
            try {
                await refreshPanel(interaction.guild, panel.channel_id, panel.message_id, panelId, db);
            } catch (e) {
                console.error('[Quasar] Erreur refresh panel:', e.message);
                await interaction.followUp({ content: `⚠️ Le rôle a été ajouté, mais le panel n'a pas pu être mis à jour : ${e.message}`, ephemeral: true });
            }

        } else if (sub === 'remove') {
            const panelId = interaction.options.getInteger('panel_id');
            const emoji = interaction.options.getString('emoji');

            const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
                .get(panelId, interaction.guild.id);

            if (!panel) return userError(interaction, {
                title: 'Panel introuvable',
                cause: 'Aucun panel de rôles-réactions ne porte cet identifiant sur ce serveur.',
                action: 'Retrouvez le bon identifiant avec `/reactionrole list`.',
            });

            db.prepare('DELETE FROM reaction_roles WHERE panel_id = ? AND emoji = ?').run(panelId, emoji);

            await interaction.reply({ content: `✅ Emoji ${emoji} retiré du panel #${panelId}.`, ephemeral: true });

            try {
                await refreshPanel(interaction.guild, panel.channel_id, panel.message_id, panelId, db);
            } catch (e) {
                console.error('[Quasar] Erreur refresh panel:', e.message);
                await interaction.followUp({ content: `⚠️ L'emoji a été retiré, mais le panel n'a pas pu être mis à jour : ${e.message}`, ephemeral: true });
            }

        } else if (sub === 'delete') {
            const panelId = interaction.options.getInteger('panel_id');
            const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
                .get(panelId, interaction.guild.id);

            if (!panel) return userError(interaction, {
                title: 'Panel introuvable',
                cause: 'Aucun panel de rôles-réactions ne porte cet identifiant sur ce serveur.',
                action: 'Retrouvez le bon identifiant avec `/reactionrole list`.',
            });

            // Supprimer le message Discord
            try {
                const channel = interaction.guild.channels.cache.get(panel.channel_id);
                const msg = await channel?.messages.fetch(panel.message_id);
                await msg?.delete();
            } catch {} // Message or channel may already be deleted

            db.prepare('DELETE FROM reaction_panels WHERE id = ?').run(panelId);

            await interaction.reply({ content: `✅ Panel #${panelId} supprimé.`, ephemeral: true });

        } else if (sub === 'list') {
            const panels = db.prepare('SELECT * FROM reaction_panels WHERE guild_id = ?').all(interaction.guild.id);

            if (panels.length === 0) {
                return interaction.reply({ content: 'Aucun panel de reaction roles configuré.', ephemeral: true });
            }

            const lines = panels.map(p => {
                const count = db.prepare('SELECT COUNT(*) as c FROM reaction_roles WHERE panel_id = ?').get(p.id).c;
                return `**#${p.id}** — ${p.title} • <#${p.channel_id}> • ${count} rôle(s) • mode: ${p.mode}`;
            });

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🎭 Reaction Role Panels')
                    .setColor(0x6e8ec8)
                    .setDescription(lines.join('\n'))
                    .setTimestamp()],
                ephemeral: true
            });
        }
    }
};

async function refreshPanel(guild, channelId, messageId, panelId, db) {
    try {
        const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ?').get(panelId);
        const entries = db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY rowid ASC').all(panelId);

        const channel = guild.channels.cache.get(channelId);
        if (!channel) return;
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg) return;

        let description = 'Cliquez sur un emoji pour obtenir le rôle correspondant.\n\n';

        if (entries.length === 0) {
            description += '*(Aucun rôle configuré)*';
        } else {
            description += entries.map(e =>
                `${e.emoji} → <@&${e.role_id}>${e.description ? ` — *${e.description}*` : ''}`
            ).join('\n');
        }

        const embed = new EmbedBuilder()
            .setTitle(panel.title)
            .setDescription(description)
            .setColor(0xc86e8e)
            .setFooter({ text: `Panel #${panelId} • Mode ${panel.mode}` });

        await msg.edit({ embeds: [embed] });

        // Ajouter les réactions manquantes (dans l'ordre d'insertion)
        for (const entry of entries) {
            const existing = msg.reactions.cache.find(r => {
                const rEmoji = r.emoji.id
                    ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>`
                    : r.emoji.name;
                return rEmoji === entry.emoji;
            });
            if (!existing || !existing.me) {
                await msg.react(entry.emoji).catch(() => {});
            }
        }
    } catch (e) {
        console.error('[Quasar] Erreur refresh panel:', e.message);
    }
}
