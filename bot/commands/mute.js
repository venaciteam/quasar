const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('../utils/modlog');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Mute (timeout) un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Le membre à mute').setRequired(true))
        .addStringOption(opt => opt.setName('durée').setDescription('Durée (ex: 10m, 1h, 1d)').setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison du mute').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const target = interaction.options.getUser('membre');
        const durationStr = interaction.options.getString('durée');
        const reason = interaction.options.getString('raison') || 'Aucune raison spécifiée';

        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        if (!member) {
            return userError(interaction, {
                title: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur.',
                action: 'Vérifie qu\'elle en est toujours membre.',
            });
        }
        if (target.bot) {
            return userError(interaction, {
                title: 'Les bots ne peuvent pas être exclus temporairement',
                cause: 'Discord n\'applique pas les exclusions temporaires aux bots.',
                action: 'Retire ses permissions, ou expulse-le du serveur.',
            });
        }

        // Parser la durée
        const ms = parseDuration(durationStr);
        if (!ms || ms > 28 * 24 * 60 * 60 * 1000) {
            return userError(interaction, {
                title: 'Durée invalide',
                cause: 'Je n\'ai pas compris la durée, ou elle dépasse la limite de 28 jours imposée par Discord.',
                action: 'Utilise un nombre suivi de `m` (minutes), `h` (heures) ou `d` (jours). Par exemple : `10m`, `2h`, `1d`.',
            });
        }

        try {
            await member.timeout(ms, reason);
        } catch (e) {
            return userError(interaction, {
                title: 'Je ne peux pas exclure ce membre',
                cause: 'Soit il me manque la permission **Exclure temporairement des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
                action: 'Vérifie mes permissions, et place mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
            });
        }

        // Enregistrer en DB
        const db = getDb();
        db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration)
            VALUES (?, ?, ?, 'mute', ?, ?)
        `).run(interaction.guild.id, target.id, interaction.user.id, reason, durationStr);

        const embed = new EmbedBuilder()
            .setTitle('🔇 Mute')
            .setColor(0xe67e22)
            .addFields(
                { name: 'Membre', value: `${target} (${target.tag})`, inline: true },
                { name: 'Modérateur', value: `${interaction.user}`, inline: true },
                { name: 'Durée', value: durationStr, inline: true },
                { name: 'Raison', value: reason }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        await sendModLog(interaction.guild, embed, 'mod_mute');
    }
};

function parseDuration(str) {
    const match = str.match(/^(\d+)(m|h|d|j)$/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': case 'j': return val * 24 * 60 * 60 * 1000;
        default: return null;
    }
}
