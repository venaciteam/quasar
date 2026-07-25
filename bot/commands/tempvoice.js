const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tempvoice')
        .setDescription('Configurer les salons vocaux temporaires')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Ajouter un salon trigger (Join to Create)')
                .addChannelOption(opt =>
                    opt.setName('salon')
                        .setDescription('Le salon vocal trigger')
                        .addChannelTypes(ChannelType.GuildVoice)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Retirer un salon trigger')
                .addChannelOption(opt =>
                    opt.setName('salon')
                        .setDescription('Le salon vocal trigger à retirer')
                        .addChannelTypes(ChannelType.GuildVoice)
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Désactiver tous les vocaux temporaires')
        )
        .addSubcommand(sub =>
            sub.setName('enable')
                .setDescription('Réactiver tous les vocaux temporaires')
        )
        .addSubcommand(sub =>
            sub.setName('info')
                .setDescription('Afficher la configuration actuelle')
        ),

    async execute(interaction) {
        const db = getDb();
        const guildId = interaction.guild.id;
        const sub = interaction.options.getSubcommand();

        if (sub === 'setup') {
            const channel = interaction.options.getChannel('salon');
            const categoryId = channel.parentId || '';

            // Vérifier qu'il n'y a pas déjà un trigger dans cette catégorie
            const existing = db.prepare('SELECT channel_id FROM tempvoice_triggers WHERE guild_id = ? AND category_id = ?')
                .get(guildId, categoryId);

            if (existing && existing.channel_id !== channel.id) {
                const existingChannel = interaction.guild.channels.cache.get(existing.channel_id);
                return interaction.reply({
                    content: `❌ Il y a déjà un trigger dans cette catégorie : <#${existing.channel_id}>${existingChannel ? '' : ' (supprimé)'}. Retire-le d'abord avec \`/tempvoice remove\`.`,
                    ephemeral: true
                });
            }

            db.prepare(`
                INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(guild_id, channel_id) DO UPDATE SET enabled = 1
            `).run(guildId, channel.id, categoryId);

            const embed = new EmbedBuilder()
                .setTitle('🎧 Trigger ajouté')
                .setDescription(`<#${channel.id}> est maintenant un salon "Join to Create".\n\nLes membres qui le rejoindront auront un vocal créé automatiquement dans la même catégorie.`)
                .setColor(0xc86e8e)
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'remove') {
            const channel = interaction.options.getChannel('salon');

            const deleted = db.prepare('DELETE FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ?')
                .run(guildId, channel.id);

            if (deleted.changes === 0) {
                return userError(interaction, {
                    title: 'Ce salon n\'est pas un salon d\'accueil',
                    cause: 'Ce salon vocal ne déclenche pas la création de salons temporaires.',
                    action: 'Consulte les salons d\'accueil configurés avec `/tempvoice list`.',
                });
            }

            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle('🎧 Trigger retiré')
                    .setDescription(`<#${channel.id}> n'est plus un salon trigger.`)
                    .setColor(0xe74c3c)
                    .setTimestamp()
            ] });
        }

        if (sub === 'disable') {
            const result = db.prepare('UPDATE tempvoice_triggers SET enabled = 0 WHERE guild_id = ?').run(guildId);
            if (result.changes === 0) {
                return userError(interaction, {
                    title: 'Aucun salon d\'accueil configuré',
                    cause: 'Les salons vocaux temporaires ne sont pas encore activés sur ce serveur.',
                    action: 'Configure un salon d\'accueil avec `/tempvoice setup`.',
                });
            }
            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle('🎧 Vocaux temporaires désactivés')
                    .setDescription('Tous les triggers sont désactivés. Les salons actifs resteront jusqu\'à ce qu\'ils soient vidés.')
                    .setColor(0xe74c3c)
                    .setTimestamp()
            ] });
        }

        if (sub === 'enable') {
            const result = db.prepare('UPDATE tempvoice_triggers SET enabled = 1 WHERE guild_id = ?').run(guildId);
            if (result.changes === 0) {
                return userError(interaction, {
                    title: 'Aucun salon d\'accueil configuré',
                    cause: 'Les salons vocaux temporaires ne sont pas encore activés sur ce serveur.',
                    action: 'Configure un salon d\'accueil avec `/tempvoice setup`.',
                });
            }
            return interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle('🎧 Vocaux temporaires réactivés')
                    .setDescription('Tous les triggers sont de nouveau actifs.')
                    .setColor(0xc86e8e)
                    .setTimestamp()
            ] });
        }

        if (sub === 'info') {
            const triggers = db.prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ?').all(guildId);

            if (triggers.length === 0) {
                return interaction.reply({ content: '🎧 Aucun trigger configuré. Utilise `/tempvoice setup` pour commencer.', ephemeral: true });
            }

            const activeCount = db.prepare('SELECT COUNT(*) as count FROM tempvoice_active WHERE guild_id = ?').get(guildId).count;
            const prefsCount = db.prepare('SELECT COUNT(*) as count FROM tempvoice_preferences WHERE guild_id = ?').get(guildId).count;

            const triggerList = triggers.map(t => {
                const ch = interaction.guild.channels.cache.get(t.channel_id);
                const cat = t.category_id ? interaction.guild.channels.cache.get(t.category_id) : null;
                const status = t.enabled ? '✅' : '❌';
                return `${status} <#${t.channel_id}> → ${cat ? cat.name : 'Sans catégorie'}`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setTitle('🎧 Vocaux temporaires — Config')
                .setColor(0xc86e8e)
                .addFields(
                    { name: 'Triggers', value: triggerList },
                    { name: 'Vocaux actifs', value: `${activeCount}`, inline: true },
                    { name: 'Préférences sauvées', value: `${prefsCount}`, inline: true }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }
    }
};
