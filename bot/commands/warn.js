const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('../utils/modlog');
const { countWarnsInEscalationWindow, getRetentionMonths } = require('../modules/retention/sanctions');
const { runWarnEscalation, formatEscalationFeedback } = require('../utils/warnEscalation');
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
                action: 'Vérifiez qu\'elle est toujours membre. Pour sanctionner quelqu\'un qui est parti, utilisez `/ban` avec son identifiant.',
            });
        }

        if (target.id === interaction.user.id) {
            return userError(interaction, {
                title: 'Vous ne pouvez pas vous avertir vous-même',
                cause: 'Un modérateur ne peut pas s\'appliquer une sanction à lui-même.',
                action: 'Choisissez un autre membre.',
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

        // Escalade automatique. UN SEUL chemin d'escalade existe désormais : la
        // cascade if/else if qui lisait modules.config.autoSanctions a été
        // retirée d'ici au profit de bot/utils/warnEscalation.js, et les paliers
        // qu'elle portait ont été repris en base par la migration
        // warn_escalation_from_autosanctions_v1. Faire cohabiter les deux aurait
        // appliqué deux sanctions pour un même avertissement.
        //
        // `warnCount` est passé tel quel : il est déjà borné par la durée de
        // conservation du serveur (voir plus haut). Le recompter dans le module
        // d'escalade ferait sauter cette limite sans que personne ne le voie.
        const escalation = await runWarnEscalation({
            guild: interaction.guild,
            member,
            userId: target.id,
            warnCount,
            moderatorId: interaction.client.user.id,
            channel: interaction.channel,
        });

        const feedback = formatEscalationFeedback(escalation, warnCount);
        if (feedback) {
            // Un échec d'envoi ici ne doit pas transformer un avertissement
            // enregistré et une sanction appliquée en commande en erreur.
            await interaction.followUp({ content: feedback }).catch(err => {
                console.error('[Quasar Escalade] Message de suivi non envoyé :', err.message);
            });
        }

        // Log
        await sendModLog(interaction.guild, embed, 'mod_warn');
    }
};
