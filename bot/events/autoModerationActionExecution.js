// ═══════════════════════════════════════════════════════════════
//  Déclenchement d'une règle AutoMod de Discord
//
//  Quand cet événement arrive, Discord A DÉJÀ AGI : le message a été bloqué,
//  l'alerte publiée, l'exclusion posée. Quasar ne fait donc ici que deux choses,
//  et surtout pas une troisième :
//    1. HISTORISER le déclenchement dans la table `sanctions`, pour qu'il
//       apparaisse dans l'historique de modération du dashboard au même titre
//       qu'une sanction manuelle ;
//    2. JOURNALISER dans le salon dédié de la règle (repli automatique sur le
//       modlog global assuré par sendAutomodLog).
//
//  Il n'APPLIQUE aucune punition. Rejouer une sanction par-dessus celle de
//  Discord donnerait deux exclusions pour un seul message, et un historique où
//  personne ne saurait dire qui a fait quoi.
//
//  ─── Un événement PAR ACTION exécutée ───
//  Une règle qui bloque ET exclut déclenche deux événements pour un seul message.
//  On enregistre donc une ligne par action réellement subie — un message bloqué et
//  une exclusion sont deux faits distincts — et AUCUNE ligne pour l'alerte, qui
//  n'est qu'une notification adressée à l'équipe, pas une sanction.
//
//  ─── Le type `automod` n'est pas un avertissement ───
//  Les blocages sont enregistrés sous le type `automod`, jamais `warn`.
//  L'escalade par avertissements compte les lignes `type = 'warn' AND active = 1` :
//  utiliser `warn` ici ferait sanctionner à nouveau, par un autre module, un
//  message que Discord avait déjà bloqué. C'est exactement la double punition que
//  l'architecture de ce module cherche à éviter.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, Events, AutoModerationActionType } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendAutomodLog, formatDuration } = require('../utils/punishments');
const { TRIGGER_BY_DISCORD_TYPE } = require('../utils/automodSync');

// Correspondance action Discord → ce qu'on en dit et ce qu'on en garde.
//
// `sanctionType` à null signifie « on journalise, on n'historise pas » :
// l'alerte n'est subie par personne.
// `logType` réutilise les catégories existantes de bot/utils/logger.js — toutes
// les catégories `mod_*` sont actives par défaut, un serveur qui se met à jour
// voit donc ces logs sans rien avoir à cocher.
const ACTION_VIEW = {
    [AutoModerationActionType.BlockMessage]: {
        sanctionType: 'automod',
        logType: 'mod_clear',
        title: '🛡️ Message bloqué par AutoMod',
        color: 0x95a5a6,
    },
    [AutoModerationActionType.SendAlertMessage]: {
        sanctionType: null,
        logType: 'mod_clear',
        title: '🛡️ Alerte AutoMod',
        color: 0x3498db,
    },
    [AutoModerationActionType.Timeout]: {
        sanctionType: 'mute',
        logType: 'mod_mute',
        title: '🔇 Exclusion temporaire par AutoMod',
        color: 0xe67e22,
    },
    [AutoModerationActionType.BlockMemberInteraction]: {
        sanctionType: 'automod',
        logType: 'mod_mute',
        title: '🛡️ Interactions bloquées par AutoMod',
        color: 0xe67e22,
    },
};

/**
 * Écrit l'historique du déclenchement.
 *
 * Volontairement local plutôt qu'emprunté à punishments.js : `recordSanction`
 * n'y est pas exporté, et ce module n'applique aucune punition — il n'a donc rien
 * d'autre à partager avec lui que cette insertion de trois lignes.
 *
 * Un échec d'écriture (table absente au tout premier démarrage, serveur inconnu
 * de la table `guilds` vers laquelle pointe la clé étrangère) ne doit pas
 * empêcher la journalisation : le fait s'est produit, il doit rester visible.
 */
function recordTrigger({ guildId, userId, moderatorId, type, reason, duration }) {
    try {
        return getDb().prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(guildId, userId, moderatorId, type, reason, duration || null).lastInsertRowid;
    } catch (err) {
        console.error('[Quasar AutoMod] Historisation du déclenchement en échec :', err.message);
        return null;
    }
}

/** Ligne miroir de la règle déclenchée, ou null si Quasar ne la connaît pas. */
function findRuleRow(guildId, ruleId) {
    try {
        return getDb().prepare('SELECT * FROM automod_rules WHERE guild_id = ? AND discord_rule_id = ?')
            .get(guildId, ruleId) || null;
    } catch (err) {
        console.error('[Quasar AutoMod] Lecture de la règle déclenchée en échec :', err.message);
        return null;
    }
}

module.exports = {
    name: Events.AutoModerationActionExecution,
    once: false,

    /**
     * @param {import('discord.js').AutoModerationActionExecution} execution
     */
    async execute(execution) {
        const guild = execution?.guild;
        if (!guild) return;

        const view = ACTION_VIEW[execution.action?.type];
        // Action inconnue de cette version : Discord peut en ajouter. On ne
        // devine pas ce qu'elle fait, et on ne l'enregistre pas comme une sanction.
        if (!view) {
            console.warn(`[Quasar AutoMod] Action Discord inconnue (type ${execution.action?.type}) — déclenchement non journalisé.`);
            return;
        }

        // La règle peut être totalement inconnue de Quasar : créée directement
        // dans les réglages Discord, ou supprimée du miroir. Ce n'est pas une
        // erreur — la journalisation retombe simplement sur le modlog global.
        const row = findRuleRow(guild.id, execution.ruleId);
        const trigger = TRIGGER_BY_DISCORD_TYPE.get(execution.ruleTriggerType);

        const ruleName = row?.name || 'règle non enregistrée dans Quasar';
        const triggerLabel = trigger?.label || 'déclencheur inconnu';
        const reason = `AutoMod Discord — ${ruleName} (${triggerLabel})`;

        const durationSeconds = execution.action?.metadata?.durationSeconds ?? null;
        const duration = view.sanctionType === 'mute' && durationSeconds
            ? formatDuration(durationSeconds * 1000)
            : null;

        let sanctionId = null;
        if (view.sanctionType) {
            sanctionId = recordTrigger({
                guildId: guild.id,
                userId: execution.userId,
                moderatorId: guild.client.user?.id || '0',
                type: view.sanctionType,
                reason,
                duration,
            });
        }

        const embed = new EmbedBuilder()
            .setTitle(view.title)
            .setColor(view.color)
            .addFields(
                { name: 'Membre', value: execution.userId ? `<@${execution.userId}> (${execution.userId})` : 'Inconnu', inline: true },
                { name: 'Règle', value: ruleName.slice(0, 1024), inline: true },
                { name: 'Filtre', value: triggerLabel, inline: true }
            )
            .setTimestamp();

        if (execution.channelId) embed.addFields({ name: 'Salon', value: `<#${execution.channelId}>`, inline: true });
        if (duration) embed.addFields({ name: 'Durée', value: duration, inline: true });
        if (sanctionId) embed.addFields({ name: 'Numéro de sanction', value: `#${sanctionId}`, inline: true });
        if (execution.matchedKeyword) {
            embed.addFields({ name: 'Terme détecté', value: `\`${execution.matchedKeyword.slice(0, 200)}\`` });
        }
        // Le contenu incriminé n'est ajouté que s'il est effectivement transmis
        // (il dépend de l'intent « Contenu des messages »). Tronqué court : un
        // journal de modération n'a pas vocation à rediffuser intégralement ce que
        // Discord vient de bloquer.
        if (execution.content) {
            embed.addFields({ name: 'Contenu', value: `\`\`\`${execution.content.slice(0, 500).replace(/```/g, "'''")}\`\`\`` });
        }
        embed.setFooter({ text: 'Filtré par Discord — Quasar ne fait qu\'enregistrer.' });

        await sendAutomodLog(guild, embed, view.logType, row?.log_channel).catch(err => {
            console.error('[Quasar AutoMod] Journalisation du déclenchement en échec :', err.message);
        });
    },
};
