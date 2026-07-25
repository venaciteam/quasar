const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('../utils/modlog');
const { countWarnsInEscalationWindow, getRetentionMonths } = require('../modules/retention/sanctions');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Avertir un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Le membre à avertir').setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison de l\'avertissement').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const target = interaction.options.getUser('membre');
        const reason = interaction.options.getString('raison') || 'Aucune raison spécifiée';
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);

        if (!member) {
            return userError(interaction, {
                title: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur, ou son compte n\'existe plus.',
                action: 'Vérifie qu\'elle est toujours membre. Pour sanctionner quelqu\'un qui est parti, utilise `/ban` avec son identifiant.',
            });
        }

        if (target.id === interaction.user.id) {
            return userError(interaction, {
                title: 'Tu ne peux pas t\'avertir toi-même',
                cause: 'Un modérateur ne peut pas s\'appliquer une sanction à lui-même.',
                action: 'Choisis un autre membre.',
            });
        }

        if (target.bot) {
            return userError(interaction, {
                title: 'Les bots ne peuvent pas être avertis',
                cause: 'Un avertissement s\'adresse à une personne : il n\'a aucun effet sur un bot.',
                action: 'Si un bot pose problème, retire-le du serveur ou contacte la personne qui l\'a ajouté.',
            });
        }

        // Enregistrer le warn
        const db = getDb();
        const result = db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'warn', ?)
        `).run(interaction.guild.id, target.id, interaction.user.id, reason);

        // Compter les warns qui pèsent encore dans l'escalade. Le comptage est borné
        // par la durée de conservation du serveur : un warn trop ancien pour être
        // conservé ne peut pas déclencher un auto-kick ou un auto-ban.
        const warnCount = countWarnsInEscalationWindow(interaction.guild.id, target.id);

        // Le libellé dit explicitement sur quelle période porte le compte : sans ça,
        // un modérateur qui voit « 2 warns » alors que le membre en a cinq dans
        // l'historique croit à un bug.
        const months = getRetentionMonths(interaction.guild.id);
        const warnCountLabel = months === 0
            ? 'Warns actifs'
            : `Warns actifs (${months} mois)`;

        const embed = new EmbedBuilder()
            .setTitle('⚠️ Avertissement')
            .setColor(0xf1c40f)
            .addFields(
                { name: 'Membre', value: `${target} (${target.tag})`, inline: true },
                { name: 'Modérateur', value: `${interaction.user}`, inline: true },
                { name: 'Raison', value: reason },
                { name: warnCountLabel, value: `${warnCount}`, inline: true },
                { name: 'ID sanction', value: `#${result.lastInsertRowid}`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        // Vérifier les sanctions auto
        await checkAutoSanctions(interaction, target, member, warnCount);

        // Log
        await sendModLog(interaction.guild, embed);
    }
};

async function checkAutoSanctions(interaction, target, member, warnCount) {
    const db = getDb();
    const modConfig = db.prepare(`
        SELECT config FROM modules WHERE guild_id = ? AND module_name = 'moderation'
    `).get(interaction.guild.id);

    if (!modConfig) return;
    const config = JSON.parse(modConfig.config || '{}');
    const auto = config.autoSanctions || {};

    if (auto.banAt && warnCount >= auto.banAt) {
        try {
            await member.ban({ reason: `Auto-ban : ${warnCount} avertissements atteints` });
            await interaction.followUp({ content: `🔴 ${target} a été **banni automatiquement** (${warnCount} warns).` });
        } catch (e) { console.error('[Quasar] Auto-ban failed:', e); }
    } else if (auto.kickAt && warnCount >= auto.kickAt) {
        try {
            await member.kick(`Auto-kick : ${warnCount} avertissements atteints`);
            await interaction.followUp({ content: `🟠 ${target} a été **kick automatiquement** (${warnCount} warns).` });
        } catch (e) { console.error('[Quasar] Auto-kick failed:', e); }
    } else if (auto.muteAt && warnCount >= auto.muteAt) {
        const duration = (auto.muteDuration || 60) * 60 * 1000; // minutes → ms
        try {
            await member.timeout(duration, `Auto-mute : ${warnCount} avertissements atteints`);
            await interaction.followUp({ content: `🟡 ${target} a été **mute automatiquement** pour ${auto.muteDuration || 60} min (${warnCount} warns).` });
        } catch (e) { console.error('[Quasar] Auto-mute failed:', e); }
    }
}
