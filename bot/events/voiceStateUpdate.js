const { EmbedBuilder, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendLog } = require('../utils/logger');

// Rate limit : 1 création par utilisateur toutes les 10 secondes
const tempvoiceCooldowns = new Map();
const COOLDOWN_MS = 10_000;

// Nettoyage périodique des cooldowns expirés (évite fuite mémoire sur Pi)
setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of tempvoiceCooldowns) {
        if (now - ts > COOLDOWN_MS) tempvoiceCooldowns.delete(key);
    }
}, 60_000);

// Track TempVoice channel IDs for channelCreate/Delete filtering
const tempvoiceChannelIds = new Set();
let tempvoiceCreating = false; // Flag: a TempVoice creation is in progress
module.exports.tempvoiceChannelIds = tempvoiceChannelIds;
module.exports.isTempVoiceCreating = () => tempvoiceCreating;

module.exports = {
    name: 'voiceStateUpdate',
    once: false,
    async execute(oldState, newState) {
        const db = getDb();
        const guild = newState.guild;
        const member = newState.member;
        if (!member || member.user.bot) return;

        const oldChannelId = oldState.channelId;
        const newChannelId = newState.channelId;

        // Si le channel n'a pas changé (mute/unmute/etc.), on ignore
        if (oldChannelId === newChannelId) return;

        // ═══════════════════════════════════════
        //  LOGS VOCAUX
        // ═══════════════════════════════════════

        // Skip les logs si c'est un mouvement TempVoice
        const isTriggerNew = newChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1').get(guild.id, newChannelId); }
            catch { return false; }
        })();
        const isTriggerOld = oldChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1').get(guild.id, oldChannelId); }
            catch { return false; }
        })();
        const isLeavingTemp = oldChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(oldChannelId); }
            catch { return false; }
        })();
        const isJoiningTemp = newChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(newChannelId); }
            catch { return false; }
        })();
        const isTempVoiceMove = isTriggerNew || isTriggerOld || (isLeavingTemp && isJoiningTemp);

        if (!isTempVoiceMove) {
            if (!oldChannelId && newChannelId) {
                const embed = new EmbedBuilder()
                    .setTitle('🔊 Rejoint un vocal')
                    .setColor(0x2ecc71)
                    .addFields(
                        { name: 'Membre', value: `${member} (${member.user.tag})`, inline: true },
                        { name: 'Salon', value: `<#${newChannelId}>`, inline: true }
                    )
                    .setTimestamp();
                await sendLog(guild, 'voice_join', embed);
            } else if (oldChannelId && !newChannelId) {
                // Skip si c'est un TempVoice qui va être supprimé (dernier membre parti)
                const oldChannel = guild.channels.cache.get(oldChannelId);
                const willBeDeleted = isLeavingTemp && (!oldChannel || oldChannel.members.size === 0);
                if (!willBeDeleted) {
                    const embed = new EmbedBuilder()
                        .setTitle('🔇 Quitte un vocal')
                        .setColor(0xe74c3c)
                        .addFields(
                            { name: 'Membre', value: `${member} (${member.user.tag})`, inline: true },
                            { name: 'Salon', value: `<#${oldChannelId}>`, inline: true }
                        )
                        .setTimestamp();
                    await sendLog(guild, 'voice_leave', embed);
                }
            } else if (oldChannelId && newChannelId) {
                const embed = new EmbedBuilder()
                    .setTitle('🔄 Change de vocal')
                    .setColor(0x3498db)
                    .addFields(
                        { name: 'Membre', value: `${member} (${member.user.tag})`, inline: true },
                        { name: 'Avant', value: `<#${oldChannelId}>`, inline: true },
                        { name: 'Après', value: `<#${newChannelId}>`, inline: true }
                    )
                    .setTimestamp();
                await sendLog(guild, 'voice_move', embed);
            }
        }

        // ═══════════════════════════════════════
        //  VOICE ROLES
        // ═══════════════════════════════════════

        try {
            db.prepare('SELECT 1 FROM voice_roles LIMIT 1').get();

            if (oldChannelId) {
                const voiceRole = db.prepare('SELECT role_id FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                    .get(guild.id, oldChannelId);
                if (voiceRole) {
                    try { await member.roles.remove(voiceRole.role_id); } catch (e) {
                        console.error('[Quasar] Erreur retrait rôle vocal:', e.message);
                    }
                }
            }

            if (newChannelId) {
                const voiceRole = db.prepare('SELECT role_id FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                    .get(guild.id, newChannelId);
                if (voiceRole) {
                    try { await member.roles.add(voiceRole.role_id); } catch (e) {
                        console.error('[Quasar] Erreur ajout rôle vocal:', e.message);
                    }
                }
            }
        } catch {
            // Table voice_roles pas encore créée, on ignore
        }

        // ═══════════════════════════════════════
        //  TEMPVOICE — Création (multi-trigger)
        // ═══════════════════════════════════════

        if (newChannelId) {
            try {
                const trigger = db.prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1')
                    .get(guild.id, newChannelId);

                if (trigger) {
                    const categoryId = trigger.category_id || '';

                    // Vérifier que l'utilisateur n'a pas déjà un vocal actif dans cette catégorie
                    const existing = db.prepare('SELECT channel_id FROM tempvoice_active WHERE guild_id = ? AND owner_id = ? AND category_id = ?')
                        .get(guild.id, member.id, categoryId);

                    if (existing) {
                        const existingChannel = guild.channels.cache.get(existing.channel_id);
                        if (existingChannel) {
                            try { await member.voice.setChannel(existingChannel); } catch {} // Member may have disconnected
                            return;
                        } else {
                            db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(existing.channel_id);
                        }
                    }

                    // Rate limit check
                    const cooldownKey = `${guild.id}-${member.id}`;
                    const lastCreate = tempvoiceCooldowns.get(cooldownKey);
                    if (lastCreate && Date.now() - lastCreate < COOLDOWN_MS) {
                        try { await member.voice.disconnect('Création trop rapide'); } catch {} // Member may have already left
                        return;
                    }
                    tempvoiceCooldowns.set(cooldownKey, Date.now());

                    await createTempVoice(guild, member, newState.channel, categoryId, db);
                }
            } catch (e) {
                console.error('[Quasar] Erreur TempVoice création:', e);
            }
        }

        // ═══════════════════════════════════════
        //  TEMPVOICE — Suppression (salon vidé)
        // ═══════════════════════════════════════

        if (oldChannelId) {
            try {
                const isTemp = db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ?')
                    .get(oldChannelId);

                if (isTemp) {
                    const oldChannel = guild.channels.cache.get(oldChannelId);
                    if (oldChannel && oldChannel.members.size === 0) {
                        const channelName = oldChannel.name;
                        await oldChannel.delete().catch(() => {});
                        db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(oldChannelId);
                        // Keep in Set briefly so channelDelete can filter it
                        setTimeout(() => tempvoiceChannelIds.delete(oldChannelId), 5000);
                        console.log(`[Quasar] TempVoice supprimé: ${oldChannelId}`);

                        // Log unique suppression
                        const owner = guild.members.cache.get(isTemp.owner_id);
                        const ownerLabel = owner ? `${owner} (${owner.user.tag})` : isTemp.owner_id;
                        const tvEmbed = new EmbedBuilder()
                            .setTitle('🎧 Vocal temporaire supprimé')
                            .setColor(0xe74c3c)
                            .addFields(
                                { name: 'Salon', value: `${channelName}`, inline: true },
                                { name: 'Dernier membre', value: `${member} (${member.user.tag})`, inline: true },
                                { name: 'Créé par', value: ownerLabel, inline: true }
                            )
                            .setTimestamp();
                        sendLog(guild, 'tempvoice_delete', tvEmbed).catch(() => {});
                    }
                }
            } catch (e) {
                console.error('[Quasar] Erreur TempVoice suppression:', e);
            }
        }
    }
};

async function createTempVoice(guild, member, triggerChannel, categoryId, db) {
    // Charger les préférences pour cette catégorie
    const prefs = db.prepare('SELECT * FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
        .get(guild.id, member.id, categoryId);

    const channelName = prefs?.channel_name || `🎧 Salon de ${member.displayName}`;
    const userLimit = prefs?.user_limit || 0;

    // Créer le vocal dans la même catégorie (hérite des permissions)
    tempvoiceCreating = true;
    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: triggerChannel.parentId,
        userLimit: userLimit,
    });

    // Track + reset flag
    tempvoiceChannelIds.add(channel.id);
    tempvoiceCreating = false;

    // Ajouter les permissions owner APRÈS la création (ne casse pas la sync catégorie)
    await channel.permissionOverwrites.edit(member.id, {
        ManageChannels: true,
        MoveMembers: true,
        MuteMembers: true,
        DeafenMembers: true,
    });

    // Déplacer l'utilisateur
    await member.voice.setChannel(channel);
    db.prepare('INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
        .run(channel.id, guild.id, member.id, categoryId);

    console.log(`[Quasar] TempVoice créé: "${channelName}" pour ${member.user.tag} (catégorie: ${categoryId || 'aucune'})`);

    // Log unique TempVoice
    const tvEmbed = new EmbedBuilder()
        .setTitle('🎧 Vocal temporaire créé')
        .setColor(0xc86e8e)
        .addFields(
            { name: 'Créé par', value: `${member} (${member.user.tag})`, inline: true },
            { name: 'Salon', value: `<#${channel.id}>`, inline: true }
        )
        .setTimestamp();
    sendLog(guild, 'tempvoice_create', tvEmbed).catch(() => {});

    // Message de bienvenue avec boutons
    try {
        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`tv_rename_${channel.id}`)
                .setLabel('Renommer')
                .setEmoji('✏️')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`tv_limit_${channel.id}`)
                .setLabel('Limite')
                .setEmoji('👥')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`tv_lock_${channel.id}`)
                .setLabel('Verrouiller')
                .setEmoji('🔒')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`tv_unlock_${channel.id}`)
                .setLabel('Déverrouiller')
                .setEmoji('🔓')
                .setStyle(ButtonStyle.Secondary),
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`tv_permit_${channel.id}`)
                .setLabel('Autoriser')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`tv_kick_${channel.id}`)
                .setLabel('Expulser')
                .setEmoji('👋')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`tv_reset_${channel.id}`)
                .setLabel('Reset préfs')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),
        );

        await channel.send({
            embeds: [{
                title: `🎧 C'est votre salon, ${member.displayName} !`,
                description:
                    `Personnalise-le avec les boutons ci-dessous ou les commandes \`/voice\`.\n\n` +
                    `Vos préférences (nom, limite) seront **mémorisées** pour cette catégorie. ✨`,
                color: 0xc86e8e,
                footer: { text: 'Ce salon sera supprimé quand tout le monde sera parti.' }
            }],
            components: [row1, row2]
        });
    } catch (e) {
        console.error('[Quasar] Erreur envoi panneau TempVoice:', e.message || e);
    }
}
