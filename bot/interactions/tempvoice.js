const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

// Vérifie que l'utilisateur est owner du vocal
function checkOwner(interaction, channelId) {
    const db = getDb();
    const active = db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ? AND owner_id = ?')
        .get(channelId, interaction.user.id);
    return active;
}

async function handleTempVoiceInteraction(interaction) {
    const customId = interaction.customId;

    // ═══════════════════════════════════════
    //  BOUTONS
    // ═══════════════════════════════════════

    if (interaction.isButton() && customId.startsWith('tv_')) {
        const parts = customId.split('_');
        const action = parts[1];
        const channelId = parts.slice(2).join('_');

        const active = checkOwner(interaction, channelId);
        if (!active) {
            return userError(interaction, {
                title: 'Tu n\'es pas propriétaire de ce salon',
                cause: 'Seule la personne qui a créé ce salon vocal temporaire peut en modifier les réglages.',
                action: 'Demande-lui de faire la modification, ou crée ton propre salon en rejoignant le salon d\'accueil.',
            });
        }

        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            return userError(interaction, {
                title: 'Ce salon n\'existe plus',
                cause: 'Le salon vocal a été supprimé, probablement parce qu\'il s\'est vidé.',
                action: 'Rejoins le salon d\'accueil pour en créer un nouveau.',
            });
        }

        if (action === 'rename') {
            const modal = new ModalBuilder()
                .setCustomId(`tv_modal_rename_${channelId}`)
                .setTitle('Renommer le salon')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('name')
                            .setLabel('Nouveau nom')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('Mon salon cool')
                            .setMaxLength(100)
                            .setRequired(true)
                    )
                );
            return interaction.showModal(modal);
        }

        if (action === 'limit') {
            const modal = new ModalBuilder()
                .setCustomId(`tv_modal_limit_${channelId}`)
                .setTitle('Limite de places')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('limit')
                            .setLabel('Nombre de places (0 = illimité)')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('5')
                            .setMaxLength(2)
                            .setRequired(true)
                    )
                );
            return interaction.showModal(modal);
        }

        if (action === 'lock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
            const name = channel.name.replace(/ 🔒$/, '');
            await channel.setName(`${name} 🔒`);
            return interaction.reply({ content: '🔒 Salon verrouillé — plus personne ne peut rejoindre.', ephemeral: true });
        }

        if (action === 'unlock') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
            if (channel.name.endsWith(' 🔒')) {
                await channel.setName(channel.name.replace(/ 🔒$/, ''));
            }
            return interaction.reply({ content: '🔓 Salon déverrouillé.', ephemeral: true });
        }

        if (action === 'permit') {
            // Afficher un select menu pour choisir l'utilisateur
            const row = new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId(`tv_select_permit_${channelId}`)
                    .setPlaceholder('Choisir un utilisateur à autoriser')
                    .setMinValues(1)
                    .setMaxValues(1)
            );
            return interaction.reply({ content: '✅ Qui veux-tu autoriser ?', components: [row], ephemeral: true });
        }

        if (action === 'kick') {
            // Lister les membres du vocal (sauf l'owner)
            const members = channel.members.filter(m => m.id !== interaction.user.id);
            if (members.size === 0) {
                return userError(interaction, {
                    title: 'Personne d\'autre dans le salon',
                    cause: 'Tu es seul ici : il n\'y a personne à qui transférer la propriété.',
                    action: 'Attends que quelqu\'un rejoigne, puis réessaie.',
                });
            }

            const row = new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId(`tv_select_kick_${channelId}`)
                    .setPlaceholder('Choisir un utilisateur à expulser')
                    .setMinValues(1)
                    .setMaxValues(1)
            );
            return interaction.reply({ content: '👋 Qui veux-tu expulser ?', components: [row], ephemeral: true });
        }

        if (action === 'reset') {
            const db = getDb();
            db.prepare('DELETE FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
                .run(interaction.guild.id, interaction.user.id, active.category_id);
            return interaction.reply({ content: '✅ Tes préférences pour cette catégorie ont été réinitialisées.', ephemeral: true });
        }
    }

    // ═══════════════════════════════════════
    //  SELECT MENUS
    // ═══════════════════════════════════════

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('tv_select_')) {
        const parts = interaction.customId.split('_');
        const action = parts[2];
        const channelId = parts.slice(3).join('_');

        const active = checkOwner(interaction, channelId);
        if (!active) {
            return userError(interaction, {
                title: 'Tu n\'es pas propriétaire de ce salon',
                cause: 'Seule la personne qui a créé ce salon vocal peut effectuer cette action.',
                action: 'Demande-lui, ou crée ton propre salon depuis le salon d\'accueil.',
            });
        }

        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            return userError(interaction, {
                title: 'Ce salon n\'existe plus',
                cause: 'Le salon vocal a été supprimé, probablement parce qu\'il s\'est vidé.',
                action: 'Rejoins le salon d\'accueil pour en créer un nouveau.',
            });
        }

        const targetId = interaction.values[0];
        const target = await interaction.guild.members.fetch(targetId).catch(() => null);

        if (action === 'permit') {
            if (!target) {
                return interaction.update({
                    content: '❌ **Membre introuvable** — cette personne a quitté le serveur entre-temps.',
                    components: [],
                });
            }
            await channel.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
            return interaction.update({ content: `✅ ${target} peut maintenant rejoindre ton salon.`, components: [] });
        }

        if (action === 'kick') {
            if (!target || target.voice.channelId !== channelId) {
                return interaction.update({
                    content: '❌ **Cette personne n\'est pas dans ton salon** — elle l\'a quitté, ou n\'y est jamais entrée.',
                    components: [],
                });
            }
            await target.voice.disconnect('Expulsé par le propriétaire du vocal');
            return interaction.update({ content: `✅ ${target} a été expulsé.`, components: [] });
        }
    }

    // ═══════════════════════════════════════
    //  MODALS
    // ═══════════════════════════════════════

    if (interaction.isModalSubmit() && interaction.customId.startsWith('tv_modal_')) {
        const parts = interaction.customId.split('_');
        const action = parts[2];
        const channelId = parts.slice(3).join('_');

        const active = checkOwner(interaction, channelId);
        if (!active) {
            return userError(interaction, {
                title: 'Tu n\'es pas propriétaire de ce salon',
                cause: 'Seule la personne qui a créé ce salon vocal peut effectuer cette action.',
                action: 'Demande-lui, ou crée ton propre salon depuis le salon d\'accueil.',
            });
        }

        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel) {
            return userError(interaction, {
                title: 'Ce salon n\'existe plus',
                cause: 'Le salon vocal a été supprimé, probablement parce qu\'il s\'est vidé.',
                action: 'Rejoins le salon d\'accueil pour en créer un nouveau.',
            });
        }

        const db = getDb();
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        if (action === 'rename') {
            const name = interaction.fields.getTextInputValue('name');
            await channel.setName(name);

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET channel_name = excluded.channel_name, updated_at = unixepoch()
            `).run(guildId, userId, active.category_id, name);

            return interaction.reply({ content: `✅ Salon renommé en **${name}**`, ephemeral: true });
        }

        if (action === 'limit') {
            const raw = interaction.fields.getTextInputValue('limit');
            const limit = parseInt(raw, 10);

            if (isNaN(limit) || limit < 0 || limit > 99) {
                return userError(interaction, {
                    title: 'Nombre de places invalide',
                    cause: 'La limite doit être un nombre entre 0 et 99. Discord n\'accepte rien d\'autre.',
                    action: 'Saisis un nombre entre 1 et 99, ou 0 pour ne mettre aucune limite.',
                });
            }

            await channel.setUserLimit(limit);

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, user_limit, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET user_limit = excluded.user_limit, updated_at = unixepoch()
            `).run(guildId, userId, active.category_id, limit);

            return interaction.reply({ content: limit === 0 ? '✅ Limite retirée (illimité)' : `✅ Limite fixée à **${limit}** places`, ephemeral: true });
        }
    }
}

module.exports = { handleTempVoiceInteraction };
