// ═══════════════════════════════════════════════════════════════
//  Salon d'arbitrage (« defer »)
//
//  Toute règle de modération automatique peut, au lieu de sanctionner, poser le
//  cas dans un salon où l'équipe tranche. C'est la soupape du chantier : une
//  règle trop large ne bannit personne tant qu'une personne n'a pas validé.
//
//  Deux contraintes commandent toute la conception de ce module :
//
//   • LE BOT REDÉMARRE. Aucun état n'est gardé en mémoire : l'identifiant du cas
//     voyage dans le customId des boutons, et tout le reste est relu en base. Un
//     bouton cliqué trois semaines et deux redéploiements plus tard fonctionne.
//   • DEUX PERSONNES CLIQUENT EN MÊME TEMPS. La résolution passe par un UPDATE
//     conditionné à `status = 'pending'` : c'est la base qui départage, et la
//     seconde personne reçoit un refus explicite au lieu d'une double sanction.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../../api/services/database');
const { SOURCE_LABELS } = require('../../utils/punishments');

const COLOR_PENDING = 0xf1c40f;
const COLOR_APPLIED = 0xe74c3c;
const COLOR_IGNORED = 0x95a5a6;

// Préfixe unique des boutons de ce module, routé dans bot/index.js.
const CUSTOM_ID_PREFIX = 'defer_';

/** Configuration du salon d'arbitrage d'un serveur, ou null. */
function getDeferConfig(guildId) {
    try {
        return getDb().prepare('SELECT * FROM defer_config WHERE guild_id = ?').get(guildId) || null;
    } catch (err) {
        console.error('[Quasar Arbitrage] Lecture de la configuration en échec :', err.message);
        return null;
    }
}

function getCase(caseId) {
    try {
        return getDb().prepare('SELECT * FROM defer_cases WHERE id = ?').get(caseId) || null;
    } catch (err) {
        console.error('[Quasar Arbitrage] Lecture du cas en échec :', err.message);
        return null;
    }
}

/**
 * Tente de s'attribuer un cas encore en attente. C'est le point de sérialisation
 * du module : l'UPDATE ne touche la ligne que si elle est toujours `pending`, donc
 * un seul appel concurrent peut réussir.
 *
 * @returns {boolean} true si l'appelant vient de résoudre le cas.
 */
function claimCase(caseId, status, resolvedBy) {
    try {
        const result = getDb().prepare(`
            UPDATE defer_cases
            SET status = ?, resolved_by = ?, resolved_at = unixepoch()
            WHERE id = ? AND status = 'pending'
        `).run(status, resolvedBy, caseId);
        return result.changes === 1;
    } catch (err) {
        console.error('[Quasar Arbitrage] Résolution du cas en échec :', err.message);
        return false;
    }
}

function buildCaseEmbed(row, { evidence } = {}) {
    const embed = new EmbedBuilder()
        .setTitle(`⚖️ Cas d'arbitrage #${row.id}`)
        .setColor(COLOR_PENDING)
        .setDescription('Une règle de modération automatique propose une sanction. Rien n\'a encore été appliqué.')
        .addFields(
            { name: 'Membre', value: `<@${row.target_user_id}> (${row.target_user_id})`, inline: true },
            { name: 'Déclencheur', value: SOURCE_LABELS[row.source] || 'Modération automatique', inline: true },
            { name: 'Motif', value: (row.reason || 'Aucun motif précisé').slice(0, 1024) },
            {
                name: 'Sanctions proposées',
                value: row.proposed_punishments
                    ? `\`${String(row.proposed_punishments).slice(0, 1000)}\``
                    : 'Aucune — signalement seul.',
            }
        )
        .setTimestamp(row.created_at ? row.created_at * 1000 : Date.now());

    // La preuve est affichée mais jamais conservée en base : elle vit dans ce
    // message, comme le reste du salon, et disparaît avec lui.
    if (evidence) {
        embed.addFields({ name: 'Élément déclencheur', value: String(evidence).slice(0, 1024) });
    }
    return embed;
}

function buildCaseComponents(caseId) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}apply_${caseId}`)
            .setLabel('Appliquer les sanctions')
            .setEmoji('⚖️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}ignore_${caseId}`)
            .setLabel('Ignorer le cas')
            .setEmoji('🕊️')
            .setStyle(ButtonStyle.Secondary)
    )];
}

/**
 * Embed d'un cas déjà tranché. Un salon d'arbitrage où l'on ne sait plus ce qui a
 * été traité, par qui et quand ne sert à rien : le message d'origine est réécrit,
 * jamais laissé tel quel avec ses boutons morts.
 */
function buildResolvedEmbed(row, { resolvedBy, outcomeLines }) {
    const applied = row.status === 'approved';
    const embed = new EmbedBuilder()
        .setTitle(`⚖️ Cas d'arbitrage #${row.id} — ${applied ? 'sanctions appliquées' : 'cas ignoré'}`)
        .setColor(applied ? COLOR_APPLIED : COLOR_IGNORED)
        .addFields(
            { name: 'Membre', value: `<@${row.target_user_id}> (${row.target_user_id})`, inline: true },
            { name: 'Déclencheur', value: SOURCE_LABELS[row.source] || 'Modération automatique', inline: true },
            { name: 'Motif', value: (row.reason || 'Aucun motif précisé').slice(0, 1024) },
            {
                name: 'Sanctions proposées',
                value: row.proposed_punishments
                    ? `\`${String(row.proposed_punishments).slice(0, 1000)}\``
                    : 'Aucune — signalement seul.',
            },
            {
                name: 'Arbitrage',
                value: `${applied ? 'Appliqué' : 'Ignoré'} par <@${resolvedBy}> — <t:${row.resolved_at || Math.floor(Date.now() / 1000)}:f>`,
            }
        )
        .setTimestamp();

    if (outcomeLines?.length) {
        embed.addFields({ name: 'Résultat', value: outcomeLines.join('\n').slice(0, 1024) });
    }
    return embed;
}

/** Mêmes boutons, désactivés : la trace de ce qui était proposé reste lisible. */
function buildDisabledComponents(caseId) {
    return buildCaseComponents(caseId).map(row => {
        row.components.forEach(button => button.setDisabled(true));
        return row;
    });
}

/**
 * Pose un cas dans le salon d'arbitrage. Ne lève jamais.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} caseData
 * @param {string} caseData.targetUserId
 * @param {string} caseData.source — 'automod' | 'escalation' | 'antiraid' | 'honeypot'
 * @param {string} caseData.reason
 * @param {string} caseData.proposedPunishments — chaîne de punitions composables
 * @param {string} [caseData.evidence] — extrait affiché, jamais stocké
 * @returns {Promise<{ ok: boolean, caseId?: number, error?: string }>}
 */
async function sendDeferCase(guild, caseData = {}) {
    if (!guild) return { ok: false, error: 'serveur indisponible' };
    if (!caseData.targetUserId) return { ok: false, error: 'membre visé inconnu' };

    const config = getDeferConfig(guild.id);
    if (!config || !config.enabled || !config.channel_id) {
        return { ok: false, error: 'aucun salon d\'arbitrage actif sur ce serveur' };
    }

    const channel = guild.channels.cache.get(String(config.channel_id));
    if (!channel) return { ok: false, error: 'le salon d\'arbitrage configuré n\'existe plus' };

    const me = guild.members.me;
    if (me && channel.permissionsFor) {
        const perms = channel.permissionsFor(me);
        if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
            return { ok: false, error: 'je n\'ai pas le droit d\'écrire dans le salon d\'arbitrage' };
        }
    }

    let row;
    try {
        const db = getDb();
        const inserted = db.prepare(`
            INSERT INTO defer_cases
                (guild_id, channel_id, target_user_id, source, reason, proposed_punishments, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `).run(
            guild.id,
            String(config.channel_id),
            String(caseData.targetUserId),
            caseData.source || 'automod',
            caseData.reason || null,
            caseData.proposedPunishments || null
        );
        row = getCase(inserted.lastInsertRowid);
    } catch (err) {
        console.error('[Quasar Arbitrage] Création du cas en échec :', err.message);
        return { ok: false, error: 'le cas n\'a pas pu être enregistré' };
    }
    if (!row) return { ok: false, error: 'le cas n\'a pas pu être enregistré' };

    let message;
    try {
        message = await channel.send({
            embeds: [buildCaseEmbed(row, { evidence: caseData.evidence })],
            components: buildCaseComponents(row.id),
        });
    } catch (err) {
        // Message impossible à poster : le cas serait invisible et resterait
        // « en attente » pour toujours. On le retire plutôt que de laisser une
        // file d'attente fantôme grossir en base.
        try { getDb().prepare('DELETE FROM defer_cases WHERE id = ?').run(row.id); } catch {}
        console.error('[Quasar Arbitrage] Envoi du cas en échec :', err.message);
        return { ok: false, error: 'le message d\'arbitrage n\'a pas pu être posté' };
    }

    try {
        getDb().prepare('UPDATE defer_cases SET message_id = ? WHERE id = ?').run(message.id, row.id);
    } catch (err) {
        // Sans identifiant de message, le cas reste arbitrable (les boutons
        // portent son identifiant) : seule la reprise depuis la base perdrait le
        // lien. Ce n'est pas un motif d'échec.
        console.error('[Quasar Arbitrage] Message du cas non mémorisé :', err.message);
    }

    return { ok: true, caseId: row.id };
}

module.exports = {
    CUSTOM_ID_PREFIX,
    getDeferConfig,
    getCase,
    claimCase,
    sendDeferCase,
    buildCaseEmbed,
    buildCaseComponents,
    buildDisabledComponents,
    buildResolvedEmbed,
};
