const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voicerole')
        .setDescription('Gérer les rôles vocaux (attribués en vocal, retirés à la déconnexion)')
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Définir un rôle pour un salon vocal')
            .addChannelOption(opt => opt.setName('salon').setDescription('Le salon vocal').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true))
            .addRoleOption(opt => opt.setName('role').setDescription('Le rôle à attribuer').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Retirer le rôle vocal d\'un salon')
            .addChannelOption(opt => opt.setName('salon').setDescription('Le salon vocal').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Voir les rôles vocaux configurés')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const db = getDb();

        // Créer la table si elle n'existe pas
        db.exec(`
            CREATE TABLE IF NOT EXISTS voice_roles (
                guild_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                PRIMARY KEY (guild_id, channel_id)
            )
        `);

        if (sub === 'set') {
            const channel = interaction.options.getChannel('salon');
            const role = interaction.options.getRole('role');

            db.prepare(`
                INSERT INTO voice_roles (guild_id, channel_id, role_id)
                VALUES (?, ?, ?)
                ON CONFLICT(guild_id, channel_id)
                DO UPDATE SET role_id = ?
            `).run(interaction.guild.id, channel.id, role.id, role.id);

            const embed = new EmbedBuilder()
                .setTitle('🔊 Rôle vocal configuré')
                .setColor(0xc86e8e)
                .addFields(
                    { name: 'Salon', value: `${channel}`, inline: true },
                    { name: 'Rôle', value: `${role}`, inline: true }
                )
                .setDescription('Les membres recevront ce rôle en rejoignant le vocal et le perdront en partant.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (sub === 'remove') {
            const channel = interaction.options.getChannel('salon');

            const deleted = db.prepare('DELETE FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                .run(interaction.guild.id, channel.id);

            if (deleted.changes === 0) {
                return userError(interaction, {
                    title: 'Aucun rôle vocal pour ce salon',
                    cause: 'Ce salon vocal n\'a pas de rôle associé : personne ne reçoit de rôle en le rejoignant.',
                    action: 'Consulte la configuration avec `/voicerole list`, ou ajoute une règle avec `/voicerole set`.',
                });
            }

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🔇 Rôle vocal retiré')
                    .setColor(0xe74c3c)
                    .setDescription(`Le rôle vocal de ${channel} a été supprimé.`)
                    .setTimestamp()]
            });

        } else if (sub === 'list') {
            const voiceRoles = db.prepare('SELECT channel_id, role_id FROM voice_roles WHERE guild_id = ?')
                .all(interaction.guild.id);

            if (voiceRoles.length === 0) {
                return interaction.reply({ content: 'Aucun rôle vocal configuré.', ephemeral: true });
            }

            const lines = voiceRoles.map(vr => `🔊 <#${vr.channel_id}> → <@&${vr.role_id}>`);

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🔊 Rôles vocaux')
                    .setColor(0x6ecfc8)
                    .setDescription(lines.join('\n'))
                    .setTimestamp()]
            });
        }
    }
};
