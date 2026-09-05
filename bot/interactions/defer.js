// ═══════════════════════════════════════════════════════════════
//  Boutons du salon d'arbitrage
//
//  Deux boutons, un cas : appliquer les sanctions proposées, ou ignorer. Routé
//  depuis bot/index.js sur le préfixe `defer_`, comme les tickets et les vocaux
//  temporaires.
//
//  L'identifiant du cas est lu dans le customId, jamais dans un état en mémoire :
//  c'est ce qui rend les boutons cliquables après un redémarrage du bot.
// ═══════════════════════════════════════════════════════════════

const { PermissionFlagsBits } = require('discord.js');
const {
    getCase,
    claimCase,
    buildDisabledComponents,
    buildResolvedEmbed,
} = require('../modules/defer');
const { applyPunishments, parsePunishments } = require('../utils/punishments');
const { userError } = require('../utils/errors');

/** `defer_apply_42` → { verb: 'apply', caseId: 42 } ; null si le format ne colle pas. */
function parseCustomId(customId) {
    const match = /^defer_(apply|ignore)_(\d+)$/.exec(customId || '');
    if (!match) return null;
    return { verb: match[1], caseId: Number(match[2]) };
}

/** Ligne de compte rendu par action, affichée dans le message d'arbitrage. */
function formatOutcome(result) {
    if (result.ok) return `✅ \`${result.action}\`${result.note ? ` — ${result.note}` : ''}`;
    return `⚠️ \`${result.action}\` — ${result.error || 'échec'}`;
}

async function handleDeferInteraction(interaction) {
    if (!interaction.isButton()) return;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    if (!interaction.guild) {
        return userError(interaction, {
            title: 'Arbitrage indisponible ici',
            cause: 'Ce bouton ne fonctionne que dans le serveur où le cas a été ouvert.',
            action: 'Retournez dans le salon d\'arbitrage du serveur concerné.',
        });
    }

    // Le salon d'arbitrage peut être visible par plus de monde que l'équipe de
    // modération : le droit d'agir se vérifie ici, pas seulement par les
    // permissions du salon.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
        return userError(interaction, {
            title: 'Arbitrage réservé à la modération',
            cause: 'Trancher un cas exige la permission « Exclure temporairement des membres » sur ce serveur.',
            action: 'Demandez à un membre de l\'équipe de modération de traiter ce cas.',
        });
    }

    const row = getCase(parsed.caseId);
    if (!row || row.guild_id !== interaction.guild.id) {
        return userError(interaction, {
            title: 'Cas introuvable',
            cause: 'Ce cas d\'arbitrage n\'existe plus : il a pu être purgé avec les données du serveur.',
            action: 'Vous pouvez ignorer ce message, il ne correspond plus à rien.',
        });
    }

    if (row.status !== 'pending') {
        // Cas déjà tranché — typiquement deux personnes qui cliquent en même
        // temps, ou un vieux message rouvert. On rafraîchit l'affichage pour que
        // le salon cesse de mentir sur l'état du cas.
        await interaction.update({
            embeds: [buildResolvedEmbed(row, { resolvedBy: row.resolved_by, outcomeLines: [] })],
            components: buildDisabledComponents(row.id),
        }).catch(() => {});
        return;
    }

    const newStatus = parsed.verb === 'apply' ? 'approved' : 'rejected';
    if (!claimCase(row.id, newStatus, interaction.user.id)) {
        // Perdu la course : quelqu'un vient de trancher entre la lecture et
        // l'écriture. Aucune sanction n'est appliquée deux fois.
        const fresh = getCase(row.id) || row;
        await interaction.update({
            embeds: [buildResolvedEmbed(fresh, { resolvedBy: fresh.resolved_by, outcomeLines: [] })],
            components: buildDisabledComponents(row.id),
        }).catch(() => {});
        return;
    }

    const resolved = getCase(row.id) || { ...row, status: newStatus, resolved_by: interaction.user.id };
    let outcomeLines = [];

    if (newStatus === 'approved') {
        // Réponse différée : bannir, expulser et écrire les logs dépasse
        // facilement les trois secondes accordées à une interaction.
        await interaction.deferUpdate().catch(() => {});

        const { punishments } = parsePunishments(resolved.proposed_punishments || '');
        // `defer` est retiré de la proposition : un cas ne peut pas rouvrir un cas.
        const toApply = punishments.filter(p => p.action !== 'defer');

        if (!toApply.length) {
            outcomeLines = ['Aucune sanction à appliquer : le cas était un signalement seul.'];
        } else {
            const member = await interaction.guild.members.fetch(resolved.target_user_id).catch(() => null);
            const results = await applyPunishments(toApply, {
                guild: interaction.guild,
                member,
                userId: resolved.target_user_id,
                reason: `Arbitrage du cas #${resolved.id} : ${resolved.reason || 'modération automatique'}`,
                source: resolved.source,
                // Le modérateur qui tranche est le vrai auteur de la sanction :
                // c'est son identifiant qui doit apparaître dans l'historique,
                // pas celui du bot.
                moderatorId: interaction.user.id,
                allowDefer: false,
            });
            outcomeLines = results.map(formatOutcome);
        }

        await interaction.message.edit({
            embeds: [buildResolvedEmbed(resolved, { resolvedBy: interaction.user.id, outcomeLines })],
            components: buildDisabledComponents(resolved.id),
        }).catch(() => {});
        return;
    }

    await interaction.update({
        embeds: [buildResolvedEmbed(resolved, {
            resolvedBy: interaction.user.id,
            outcomeLines: ['Aucune sanction appliquée.'],
        })],
        components: buildDisabledComponents(resolved.id),
    }).catch(() => {});
}

module.exports = { handleDeferInteraction };
