const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

// Vérifie que l'utilisateur est dans un vocal temporaire dont il est owner
function getOwnedChannel(interaction) {
    const db = getDb();
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return null;

    const active = db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ? AND owner_id = ?')
        .get(voiceChannel.id, interaction.user.id);

    return active ? { channel: voiceChannel, categoryId: active.category_id } : null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Personnaliser votre salon vocal temporaire')
        .addSubcommand(sub =>
            sub.setName('name')
                .setDescription('Renommer votre salon')
                .addStringOption(opt =>
                    opt.setName('nom')
                        .setDescription('Nouveau nom du salon')
                        .setRequired(true)
                        .setMaxLength(100)
                )
        )
        .addSubcommand(sub =>
            sub.setName('limit')
                .setDescription('Limiter le nombre de places')
                .addIntegerOption(opt =>
                    opt.setName('places')
                        .setDescription('Nombre de places (0 = illimité)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(99)
                )
        )
        .addSubcommand(sub =>
            sub.setName('lock')
                .setDescription('Verrouiller votre salon (personne ne peut rejoindre)')
        )
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Déverrouiller votre salon')
        )
        .addSubcommand(sub =>
            sub.setName('permit')
                .setDescription('Autoriser quelqu\'un à rejoindre (si verrouillé)')
                .addUserOption(opt =>
                    opt.setName('utilisateur')
                        .setDescription('L\'utilisateur à autoriser')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('kick')
                .setDescription('Expulser quelqu\'un de votre salon')
                .addUserOption(opt =>
                    opt.setName('utilisateur')
                        .setDescription('L\'utilisateur à expulser')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('reset')
                .setDescription('Réinitialiser vos préférences mémorisées')
        ),

    async execute(interaction) {
        const db = getDb();
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const sub = interaction.options.getSubcommand();

        const owned = getOwnedChannel(interaction);
        if (!owned) {
            return userError(interaction, {
                title: 'Vous n\'êtes pas dans un salon vocal temporaire',
                cause: 'Cette commande ne fonctionne que si vous êtes connecté·e à un salon vocal temporaire dont vous êtes propriétaire.',
                action: 'Rejoignez le salon d\'accueil pour créer votre salon, puis relancez la commande depuis celui-ci.',
            });
        }

        const { channel, categoryId } = owned;

        if (sub === 'name') {
            const name = interaction.options.getString('nom');
            await channel.setName(name);

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET channel_name = excluded.channel_name, updated_at = unixepoch()
            `).run(guildId, userId, categoryId, name);

            return interaction.reply({ content: `✅ Salon renommé en **${name}**`, ephemeral: true });
        }

        if (sub === 'limit') {
            const limit = interaction.options.getInteger('places');
            await channel.setUserLimit(limit);

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, user_limit, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET user_limit = excluded.user_limit, updated_at = unixepoch()
            `).run(guildId, userId, categoryId, limit);

            return interaction.reply({ content: limit === 0 ? '✅ Limite retirée (illimité)' : `✅ Limite fixée à **${limit}** places`, ephemeral: true });
        }

        if (sub === 'lock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                Connect: false
            });
            const name = channel.name.replace(/ 🔒$/, '');
            await channel.setName(`${name} 🔒`);
            return interaction.reply({ content: '🔒 Salon verrouillé — plus personne ne peut rejoindre.', ephemeral: true });
        }

        if (sub === 'unlock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                Connect: null
            });
            if (channel.name.endsWith(' 🔒')) {
                await channel.setName(channel.name.replace(/ 🔒$/, ''));
            }
            return interaction.reply({ content: '🔓 Salon déverrouillé.', ephemeral: true });
        }

        if (sub === 'permit') {
            const target = interaction.options.getUser('utilisateur');
            await channel.permissionOverwrites.edit(target.id, {
                Connect: true,
                ViewChannel: true
            });
            return interaction.reply({ content: `✅ ${target} peut maintenant rejoindre votre salon.`, ephemeral: true });
        }

        if (sub === 'kick') {
            const target = interaction.options.getUser('utilisateur');
            const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);

            if (!targetMember || targetMember.voice.channelId !== channel.id) {
                return userError(interaction, {
                    title: 'Cette personne n\'est pas dans votre salon',
                    cause: 'Elle a quitté le salon, ou n\'y est jamais entrée.',
                    action: 'Vérifiez qui est connecté à votre salon vocal.',
                });
            }

            if (targetMember.id === userId) {
                return userError(interaction, {
                    title: 'Vous ne pouvez pas vous expulser vous-même',
                    cause: 'Vous êtes propriétaire de ce salon.',
                    action: 'Pour partir, quitte simplement le salon vocal — il se supprimera s\'il devient vide.',
                });
            }

            await targetMember.voice.disconnect('Expulsé par le propriétaire du vocal');
            return interaction.reply({ content: `✅ ${target} a été expulsé du salon.`, ephemeral: true });
        }

        if (sub === 'reset') {
            db.prepare('DELETE FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
                .run(guildId, userId, categoryId);
            return interaction.reply({ content: '✅ Vos préférences pour cette catégorie ont été réinitialisées.', ephemeral: true });
        }
    }
};
