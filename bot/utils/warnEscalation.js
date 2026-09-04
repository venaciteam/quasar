// ═══════════════════════════════════════════════════════════════
//  Escalade par avertissements
//
//  Quand une personne accumule des avertissements, Quasar applique la punition
//  du palier atteint. Ce module remplace la cascade if/else if qui vivait dans
//  bot/commands/warn.js et lisait modules.config.autoSanctions — un système
//  bien réel, utilisé, et limité à trois paliers figés (mute / kick / ban).
//  Désormais : N paliers par serveur, punitions composables du socle, portée
//  par palier.
//
//  Trois décisions structurent tout ce fichier.
//
//  1. UN SEUL PALIER S'APPLIQUE : LE PLUS HAUT ATTEINT.
//     C'est le comportement de la cascade d'origine, et il est conservé. Quand
//     quelqu'un passe de 2 à 5 avertissements d'un coup (import, plusieurs
//     avertissements rapprochés), appliquer TOUS les paliers franchis
//     enchaînerait mute + kick + ban sur le même warn : trois sanctions, trois
//     entrées d'historique et trois messages privés pour un seul fait, dont deux
//     rendues sans objet par la troisième. Le palier le plus haut est celui que
//     l'administrateur a prévu pour ce niveau d'accumulation ; c'est lui qui
//     s'applique.
//
//  2. LE COMPTAGE N'EST PAS REFAIT ICI.
//     Il vient de countWarnsInEscalationWindow(), qui borne le compte à la durée
//     de conservation du serveur : un avertissement trop ancien pour être
//     conservé ne peut pas déclencher un bannissement. C'est une garantie de
//     conformité (RGPD, article 5.1.e), pas un détail d'implémentation —
//     recompter à la main ici la ferait sauter en silence.
//
//  3. RIEN NE LÈVE D'EXCEPTION.
//     L'escalade se déclenche APRÈS que l'avertissement a été enregistré et que
//     la commande a répondu. Une erreur ici ne doit ni faire échouer la commande
//     /warn, ni remonter en rejet non capturé : l'API et le bot partagent le même
//     processus.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { isInScope } = require('./scopeFilter');
const {
    applyPunishments,
    parsePunishments,
    formatDuration,
    sendAutomodLog,
    SOURCE_LABELS,
} = require('./punishments');

// Bornes des seuils. 1 minimum : un palier à 0 se déclencherait sur un membre
// sans aucun avertissement, ce qui n'est pas une escalade. 100 en plafond :
// au-delà, la valeur est une faute de frappe, pas une intention.
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 100;

// Plafond de paliers par serveur. Volontairement bas : au-delà d'une poignée,
// une escalade devient impossible à se représenter, et la liste illisible.
const MAX_TIERS_PER_GUILD = 10;

const SOURCE = 'escalation';

// Actions qui retirent la personne du serveur. Elles rendent les paliers
// supérieurs inatteignables tant qu'elle n'est pas revenue — l'interface le dit
// plutôt que de laisser configurer un palier qui ne se déclenchera jamais.
const REMOVES_MEMBER = new Set(['ban', 'tempban']);

// ─── Lecture ────────────────────────────────────────────────────────────────

/**
 * Paliers d'un serveur, du plus bas seuil au plus haut.
 * Renvoie les lignes BRUTES : les colonnes JSON de portée ne sont pas parsées
 * ici, isInScope() s'en charge (et lui seul, pour ne pas avoir deux lectures
 * divergentes de la même colonne).
 *
 * @returns {Array<object>} vide si le serveur n'a rien configuré, ou en cas
 *          d'erreur de lecture — jamais une exception.
 */
function listTiers(guildId) {
    try {
        return getDb().prepare(
            'SELECT * FROM warn_escalation WHERE guild_id = ? ORDER BY threshold ASC'
        ).all(guildId);
    } catch (err) {
        console.error('[Quasar Escalade] Lecture des paliers en échec :', err.message);
        return [];
    }
}

/** Un palier précis d'un serveur, ou null. */
function findTier(guildId, tierId) {
    if (!Number.isInteger(tierId)) return null;
    try {
        return getDb().prepare('SELECT * FROM warn_escalation WHERE guild_id = ? AND id = ?')
            .get(guildId, tierId) || null;
    } catch (err) {
        console.error('[Quasar Escalade] Lecture du palier en échec :', err.message);
        return null;
    }
}

/**
 * Palier à appliquer pour un nombre d'avertissements donné : le plus haut seuil
 * atteint, parmi les paliers actifs. Fonction pure — c'est elle qui porte la
 * décision décrite en tête de fichier, et elle est testable sans Discord.
 *
 * @param {Array<object>} tiers — paliers du serveur (actifs ou non)
 * @param {number} warnCount
 * @returns {object|null}
 */
function selectTier(tiers, warnCount) {
    if (!Array.isArray(tiers) || !Number.isFinite(warnCount)) return null;

    let best = null;
    for (const tier of tiers) {
        if (!tier || !tier.enabled) continue;
        const threshold = Number(tier.threshold);
        if (!Number.isInteger(threshold) || threshold < MIN_THRESHOLD) continue; // donnée anormale : ignorée
        if (threshold > warnCount) continue;
        if (!best || threshold > Number(best.threshold)) best = tier;
    }
    return best;
}

/**
 * Identifiants des paliers qu'un palier inférieur rend inatteignables : un
 * bannissement au seuil 3 retire la personne du serveur, elle ne peut plus
 * accumuler d'avertissement jusqu'au seuil 5.
 *
 * L'expulsion n'est PAS comptée ici : on peut revenir après un kick, et
 * l'historique des avertissements, lui, reste. Signaler ces paliers-là comme
 * morts serait faux.
 *
 * @returns {Array<{ id: number, blockedBy: number }>}
 */
function findUnreachableTiers(tiers) {
    const sorted = [...(tiers || [])]
        .filter(t => t && t.enabled)
        .sort((a, b) => Number(a.threshold) - Number(b.threshold));

    const unreachable = [];
    let blockedBy = null;

    for (const tier of sorted) {
        if (blockedBy !== null) {
            unreachable.push({ id: tier.id, blockedBy });
            continue;
        }
        const { punishments } = parsePunishments(tier.punishments);
        if (punishments.some(p => REMOVES_MEMBER.has(p.action))) {
            blockedBy = Number(tier.threshold);
        }
    }
    return unreachable;
}

// ─── Déclenchement ──────────────────────────────────────────────────────────

/**
 * Motif inscrit dans l'historique et affiché dans les journaux. Il dit le
 * compte ET le palier : « 5 avertissements » sans « palier 5 » laisse croire à
 * une coïncidence, « palier 5 » sans le compte ne se vérifie pas.
 */
function buildReason(tier, warnCount) {
    return `Escalade des avertissements : ${warnCount} avertissement(s) actif(s), palier ${tier.threshold} atteint`;
}

/**
 * Alerte du mode « alerte seule ». Un palier sans punition est une
 * configuration valide et volontaire — surveiller sans sanctionner — mais il
 * doit produire quelque chose de visible, sinon il ne se distingue pas d'une
 * escalade en panne.
 */
async function sendAlertOnly(guild, tier, targetId, warnCount) {
    const embed = new EmbedBuilder()
        .setTitle('⚠️ Palier d\'avertissements atteint')
        .setColor(0xf1c40f)
        .addFields(
            { name: 'Membre', value: targetId ? `<@${targetId}> (${targetId})` : 'Inconnu', inline: true },
            { name: 'Déclencheur', value: SOURCE_LABELS[SOURCE], inline: true },
            { name: 'Palier', value: `${tier.threshold} avertissement(s)`, inline: true },
            { name: 'Avertissements actifs', value: `${warnCount}`, inline: true },
            { name: 'Sanction', value: 'Aucune : ce palier est réglé en alerte seule.' }
        )
        .setTimestamp();

    await sendAutomodLog(guild, embed, 'mod_warn', tier.log_channel);
}

/**
 * Évalue l'escalade après l'enregistrement d'un avertissement, et l'applique.
 * Ne lève jamais.
 *
 * @param {object} ctx
 * @param {import('discord.js').Guild} ctx.guild
 * @param {import('discord.js').GuildMember|null} ctx.member — null si la
 *        personne a quitté le serveur entre l'avertissement et la sanction
 * @param {string} ctx.userId       — cible, y compris quand `member` est null
 * @param {number} ctx.warnCount    — compte borné par la rétention (cf. en-tête)
 * @param {string} ctx.moderatorId  — identifiant du bot : la sanction est automatique
 * @param {object} [ctx.channel]    — salon d'où l'avertissement a été donné, pour la portée
 * @returns {Promise<{tier: object, results: Array, alertOnly: boolean, skipped: string|null}|null>}
 *          null quand aucun palier n'est atteint : le cas courant, il ne doit
 *          rien coûter et rien afficher.
 */
async function runWarnEscalation(ctx = {}) {
    try {
        const { guild, member = null, userId, warnCount, moderatorId, channel = null } = ctx;
        if (!guild || !Number.isFinite(warnCount)) return null;

        const tier = selectTier(listTiers(guild.id), warnCount);
        if (!tier) return null;

        // Portée par palier : rôles et salons concernés ou exemptés. Évaluée par
        // le socle, jamais réimplémentée — une exemption qui ne s'applique pas
        // partout pareil ne protège personne.
        if (!isInScope(tier, { member, channel })) {
            return { tier, results: [], alertOnly: false, skipped: 'scope' };
        }

        const reason = buildReason(tier, warnCount);

        const { punishments } = parsePunishments(tier.punishments);
        if (!punishments.length) {
            await sendAlertOnly(guild, tier, member?.id || userId || null, warnCount);
            return { tier, results: [], alertOnly: true, skipped: null };
        }

        const results = await applyPunishments(punishments, {
            guild,
            member,
            userId: member?.id || userId,
            reason,
            source: SOURCE,
            moderatorId,
            logChannelId: tier.log_channel,
            responseMessage: tier.response_message,
        });

        return { tier, results, alertOnly: false, skipped: null };
    } catch (err) {
        // Un incident d'escalade ne doit pas faire échouer la commande /warn :
        // l'avertissement, lui, est déjà enregistré.
        console.error('[Quasar Escalade] Application du palier en échec :', err);
        return null;
    }
}

// ─── Restitution au modérateur ──────────────────────────────────────────────

/** Nom lisible d'une action, avec sa durée quand elle en a une. */
function describeAction(result, punishments) {
    const match = (punishments || []).find(p => p.action === result.action);
    if (!match?.durationMs) return result.action;
    return `${result.action} ${formatDuration(match.durationMs)}`;
}

/**
 * Message posté en suite de la réponse à /warn. Il dit ce qui vient de se
 * passer, y compris quand rien n'a pu être appliqué : une escalade silencieuse
 * qui échoue laisse croire à une personne qui modère que la sanction est tombée.
 *
 * @returns {string|null} null quand il n'y a rien à annoncer.
 */
function formatEscalationFeedback(outcome, warnCount) {
    if (!outcome) return null;
    const { tier, results, alertOnly, skipped } = outcome;

    // Hors de portée : par construction, personne n'attend de sanction ici.
    if (skipped === 'scope') return null;

    const header = `⚡ Palier **${tier.threshold}** atteint (${warnCount} avertissement(s) actif(s)).`;

    if (alertOnly) {
        return `${header} Aucune sanction n'est configurée sur ce palier : c'est une alerte seule.`;
    }

    const { punishments } = parsePunishments(tier.punishments);

    const deferred = results.find(r => r.action === 'defer' && r.ok);
    if (deferred) {
        return `${header} ${deferred.note || 'Le cas est transmis au salon d\'arbitrage.'} `
            + 'Aucune sanction n\'est appliquée avant décision.';
    }

    const applied = results.filter(r => r.ok).map(r => describeAction(r, punishments));
    // Un échec bénin (messages privés fermés, par exemple) est un choix de la
    // personne visée, pas un incident : l'annoncer comme une panne ferait
    // chercher un problème qui n'existe pas.
    const failed = results.filter(r => !r.ok && !r.benign);
    const notes = results.filter(r => r.ok && r.note).map(r => r.note);

    const parts = [header];
    if (applied.length) parts.push(`Appliqué : ${applied.join(', ')}.`);
    if (!applied.length && failed.length) parts.push('Aucune sanction n\'a pu être appliquée.');
    for (const note of notes) parts.push(note);
    for (const failure of failed) parts.push(`❌ ${failure.action} : ${failure.error}`);

    return parts.join(' ');
}

module.exports = {
    listTiers,
    findTier,
    selectTier,
    findUnreachableTiers,
    runWarnEscalation,
    formatEscalationFeedback,
    MIN_THRESHOLD,
    MAX_THRESHOLD,
    MAX_TIERS_PER_GUILD,
};
