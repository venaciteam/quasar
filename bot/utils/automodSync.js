// ═══════════════════════════════════════════════════════════════
//  AutoMod Discord — catalogue, permissions et synchronisation
//
//  Quasar ne scanne AUCUN message pour ce module : il pilote l'AutoMod NATIF de
//  Discord. Les règles vivent chez Discord, qui bloque en amont du bot — les
//  messages filtrés n'atteignent jamais la gateway. Un moteur de scan maison
//  ferait doublon avec ces filtres, donc double punition et logs incompréhensibles.
//
//  Conséquence directe sur les données : **Discord est la source de vérité**. La
//  table `automod_rules` n'est qu'un miroir, qui sert trois choses et rien de plus :
//    1. retrouver la règle déclenchée à la réception d'un événement ;
//    2. porter le seul réglage que Discord ne connaît pas — `log_channel`, le
//       salon où Quasar journalise ses propres traces pour cette règle ;
//    3. garder la trace d'une règle supprimée côté Discord (`discord_missing`),
//       pour la montrer à l'administrateur plutôt que de la faire disparaître.
//
//  Le détail d'une règle (mots, regex, actions, exemptions) n'est PAS dupliqué en
//  base : il est relu chez Discord à chaque affichage. Deux copies d'une même
//  configuration divergent toujours, et c'est la copie locale qu'on finit par
//  afficher à tort.
//
//  Performance — des instances tournent sur Raspberry Pi : AUCUNE resynchronisation
//  périodique. `syncGuildRules` n'est appelée qu'à la demande, quand l'onglet du
//  dashboard s'ouvre ou qu'une action est effectuée.
// ═══════════════════════════════════════════════════════════════

const {
    AutoModerationRuleTriggerType,
    AutoModerationRuleEventType,
    AutoModerationActionType,
    AutoModerationRuleKeywordPresetType,
    PermissionFlagsBits,
} = require('discord.js');
const { getDb } = require('../../api/services/database');

// ─── Plafonds imposés par l'API Discord ─────────────────────────────────────
// Repris de la documentation « Auto Moderation » (limites par serveur et par
// champ). Ils sont appliqués côté serveur ET affichés dans l'interface : un refus
// de Discord après coup laisse l'administrateur sans explication utilisable.
const LIMITS = Object.freeze({
    NAME_MAX: 100,
    KEYWORD_COUNT: 1000,
    KEYWORD_LENGTH: 60,
    REGEX_COUNT: 10,
    REGEX_LENGTH: 260,
    ALLOW_LIST_LENGTH: 60,
    EXEMPT_ROLES: 20,
    EXEMPT_CHANNELS: 50,
    CUSTOM_MESSAGE: 150,
    MENTION_TOTAL: 50,
    TIMEOUT_SECONDS: 28 * 24 * 60 * 60, // 4 semaines
});

// ─── Actions portées par la règle Discord elle-même ─────────────────────────
// Ce sont les SEULES sanctions de ce module. Quasar n'en ajoute aucune : Discord
// a déjà agi quand l'événement nous parvient, re-punir par-dessus donnerait deux
// sanctions pour un seul message.
const ACTIONS = Object.freeze({
    BLOCK_MESSAGE: {
        key: 'BLOCK_MESSAGE',
        discordType: AutoModerationActionType.BlockMessage,
        label: 'Bloquer le message',
        summary: 'Le message n\'est jamais publié. Son autrice ou son auteur voit un avertissement.',
    },
    SEND_ALERT_MESSAGE: {
        key: 'SEND_ALERT_MESSAGE',
        discordType: AutoModerationActionType.SendAlertMessage,
        label: 'Alerter l\'équipe dans un salon',
        summary: 'Discord publie sa propre alerte, avec le contenu incriminé, dans le salon choisi.',
    },
    TIMEOUT: {
        key: 'TIMEOUT',
        discordType: AutoModerationActionType.Timeout,
        label: 'Exclure temporairement',
        summary: 'Discord exclut la personne pour la durée choisie (28 jours au maximum).',
    },
    BLOCK_MEMBER_INTERACTION: {
        key: 'BLOCK_MEMBER_INTERACTION',
        discordType: AutoModerationActionType.BlockMemberInteraction,
        label: 'Empêcher toute interaction',
        summary: 'La personne ne peut plus écrire, parler ni interagir tant que son profil reste en infraction.',
    },
});

// ─── Déclencheurs exposés ───────────────────────────────────────────────────
//
// `allowedActions` n'est pas une préférence de design, c'est une contrainte de
// l'API : Discord refuse TIMEOUT ailleurs que sur KEYWORD et MENTION_SPAM.
// BLOCK_MEMBER_INTERACTION est réservé ici au filtrage de profil, seul cas où
// Discord le propose dans sa propre interface — un filtrage de profil n'a pas de
// message à bloquer ni de salon d'où alerter. Si Discord élargit un jour ces
// combinaisons, c'est cette table qu'il faut corriger, à un seul endroit.
const TRIGGERS = Object.freeze({
    KEYWORD: {
        key: 'KEYWORD',
        discordType: AutoModerationRuleTriggerType.Keyword,
        eventType: AutoModerationRuleEventType.MessageSend,
        maxPerGuild: 6,
        label: 'Mots interdits et liens',
        summary: 'Bloque les messages contenant les mots, expressions ou adresses que vous listez.',
        fields: ['keyword_filter', 'regex_patterns', 'allow_list'],
        allowListMax: 100,
        allowedActions: ['BLOCK_MESSAGE', 'SEND_ALERT_MESSAGE', 'TIMEOUT'],
    },
    SPAM: {
        key: 'SPAM',
        discordType: AutoModerationRuleTriggerType.Spam,
        eventType: AutoModerationRuleEventType.MessageSend,
        maxPerGuild: 1,
        label: 'Spam',
        summary: 'Laisse Discord détecter le spam générique. Rien à régler, la détection est la sienne.',
        fields: [],
        allowListMax: 0,
        allowedActions: ['BLOCK_MESSAGE', 'SEND_ALERT_MESSAGE'],
    },
    KEYWORD_PRESET: {
        key: 'KEYWORD_PRESET',
        discordType: AutoModerationRuleTriggerType.KeywordPreset,
        eventType: AutoModerationRuleEventType.MessageSend,
        maxPerGuild: 1,
        label: 'Listes de mots de Discord',
        summary: 'Utilise les listes tenues par Discord : grossièretés, contenu sexuel, insultes discriminatoires.',
        fields: ['presets', 'allow_list'],
        allowListMax: 1000,
        allowedActions: ['BLOCK_MESSAGE', 'SEND_ALERT_MESSAGE'],
    },
    MENTION_SPAM: {
        key: 'MENTION_SPAM',
        discordType: AutoModerationRuleTriggerType.MentionSpam,
        eventType: AutoModerationRuleEventType.MessageSend,
        maxPerGuild: 1,
        label: 'Mentions en masse',
        summary: 'Bloque les messages qui mentionnent trop de personnes ou de rôles d\'un coup.',
        fields: ['mention_total_limit', 'mention_raid_protection_enabled'],
        allowListMax: 0,
        allowedActions: ['BLOCK_MESSAGE', 'SEND_ALERT_MESSAGE', 'TIMEOUT'],
    },
    MEMBER_PROFILE: {
        key: 'MEMBER_PROFILE',
        discordType: AutoModerationRuleTriggerType.MemberProfile,
        // Seul déclencheur qui n'écoute pas les messages : il se déclenche quand
        // une personne modifie son pseudo ou sa bio, pas quand elle écrit.
        eventType: AutoModerationRuleEventType.MemberUpdate,
        maxPerGuild: 1,
        label: 'Profils de membres',
        summary: 'Empêche les pseudos et les descriptions qui contiennent les mots que vous listez.',
        fields: ['keyword_filter', 'regex_patterns', 'allow_list'],
        allowListMax: 100,
        allowedActions: ['BLOCK_MEMBER_INTERACTION'],
    },
});

// Listes de mots tenues par Discord (déclencheur KEYWORD_PRESET).
const PRESETS = Object.freeze({
    PROFANITY: { key: 'PROFANITY', discordType: AutoModerationRuleKeywordPresetType.Profanity, label: 'Grossièretés' },
    SEXUAL_CONTENT: { key: 'SEXUAL_CONTENT', discordType: AutoModerationRuleKeywordPresetType.SexualContent, label: 'Contenu sexuel' },
    SLURS: { key: 'SLURS', discordType: AutoModerationRuleKeywordPresetType.Slurs, label: 'Insultes discriminatoires' },
});

const TRIGGER_BY_DISCORD_TYPE = new Map(Object.values(TRIGGERS).map(t => [t.discordType, t]));
const ACTION_BY_DISCORD_TYPE = new Map(Object.values(ACTIONS).map(a => [a.discordType, a]));
const PRESET_BY_DISCORD_TYPE = new Map(Object.values(PRESETS).map(p => [p.discordType, p]));

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ─── Permissions ────────────────────────────────────────────────────────────

/**
 * Ce que le bot a réellement le droit de faire sur l'AutoMod de ce serveur.
 *
 * `MANAGE_GUILD` conditionne l'accès à TOUTES les ressources AutoMod (lecture
 * comprise) ; `MODERATE_MEMBERS` n'est exigé que pour poser une exclusion
 * temporaire. Les distinguer évite de refuser toute l'interface à un bot qui sait
 * parfaitement gérer des règles sans pouvoir exclure.
 *
 * @returns {{ manageGuild: boolean, moderateMembers: boolean, known: boolean }}
 *          known = false quand les permissions ne sont pas lisibles (bot absent
 *          du serveur, cache incomplet) : on ne transforme pas un « je ne sais
 *          pas » en « tout va bien ».
 */
function checkPermissions(guild) {
    const me = guild?.members?.me;
    if (!me?.permissions) return { manageGuild: false, moderateMembers: false, known: false };
    return {
        manageGuild: me.permissions.has(PermissionFlagsBits.ManageGuild),
        moderateMembers: me.permissions.has(PermissionFlagsBits.ModerateMembers),
        known: true,
    };
}

// ─── Erreurs Discord ────────────────────────────────────────────────────────

/**
 * Message d'erreur exploitable à partir d'un rejet de l'API Discord.
 *
 * Les regex d'AutoMod sont en syntaxe **Rust**, pas JavaScript : une expression
 * parfaitement valide dans le navigateur peut être refusée ici. Le message de
 * Discord dit alors précisément ce qui cloche — on le remonte tel quel plutôt que
 * de le remplacer par un « erreur inconnue » qui ferait chercher au mauvais endroit.
 */
function describeDiscordError(err) {
    if (!err) return 'Erreur inconnue.';

    if (err.code === 50013 || err.status === 403) {
        return 'Discord a refusé : le bot n\'a pas la permission « Gérer le serveur ».';
    }
    if (err.code === 10004) return 'Ce serveur est introuvable pour le bot.';
    if (err.status === 429) return 'Discord limite temporairement les requêtes. Réessayez dans quelques instants.';

    // Les erreurs de validation (400) arrivent avec un détail par champ : c'est
    // exactement ce dont l'administrateur a besoin pour corriger sa regex.
    const details = [];
    const walk = (node, path) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node._errors)) {
            for (const e of node._errors) details.push(path ? `${path} : ${e.message}` : e.message);
            return;
        }
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    };
    walk(err.rawError?.errors, '');

    if (details.length) return `Discord a refusé la règle — ${details.join(' ; ')}`;
    return err.rawError?.message || err.message || 'Discord a refusé la requête.';
}

// ─── Miroir en base ─────────────────────────────────────────────────────────

/**
 * Exemptions d'une règle Discord, dans la forme attendue par les colonnes de portée.
 *
 * L'API AutoMod ne connaît QUE des exemptions (`exempt_roles`, `exempt_channels`).
 * Elle n'a aucun équivalent de « n'appliquer que dans ces salons ». Les colonnes
 * `affected_*` restent donc à leur défaut `'[]'` pour ce module — les autres lots
 * s'en servent, pas celui-ci.
 */
function exemptionsOf(discordRule) {
    return {
        roles: [...(discordRule.exemptRoles?.keys() ?? [])].map(String),
        channels: [...(discordRule.exemptChannels?.keys() ?? [])].map(String),
    };
}

/** Message personnalisé porté par l'action « bloquer le message », s'il y en a un. */
function customMessageOf(discordRule) {
    const block = discordRule.actions?.find(a => a.type === AutoModerationActionType.BlockMessage);
    return block?.metadata?.customMessage || null;
}

/**
 * Rapproche les règles AutoMod de Discord et la table `automod_rules`.
 *
 * Trois cas, tous nécessaires :
 *  - règle connue des deux côtés → le miroir est rafraîchi (nom, activation,
 *    exemptions, message personnalisé) et `discord_missing` remis à 0 ;
 *  - ligne locale sans règle Discord → `discord_missing = 1`. On ne SUPPRIME
 *    JAMAIS la ligne : l'administrateur doit voir qu'une règle a disparu de
 *    Discord, et garder de quoi la recréer ou la nettoyer sciemment ;
 *  - règle Discord inconnue en base → adoption. Sans elle, une règle créée
 *    directement dans les réglages Discord fausserait les quotas affichés et ses
 *    déclenchements arriveraient sans configuration de journalisation.
 *
 * `log_channel` n'est jamais écrasé : Discord ne le connaît pas, il n'a donc
 * jamais de valeur à en donner.
 *
 * @returns {{ rows: object[], discordRules: Collection, missing: number, adopted: number }}
 * @throws  {Error} l'erreur brute de l'API Discord (permission, réseau) —
 *          l'appelant décide comment la présenter.
 */
async function syncGuildRules(guild) {
    const discordRules = await guild.autoModerationRules.fetch();
    const db = getDb();
    const ts = nowSeconds();

    const existing = db.prepare('SELECT * FROM automod_rules WHERE guild_id = ?').all(guild.id);
    const knownIds = new Set(existing.map(r => r.discord_rule_id).filter(Boolean));

    let missing = 0;
    let adopted = 0;

    const apply = db.transaction(() => {
        const markMissing = db.prepare(
            'UPDATE automod_rules SET discord_missing = 1, enabled = 0, last_synced_at = ?, updated_at = ? WHERE id = ?'
        );
        const refresh = db.prepare(`
            UPDATE automod_rules
            SET trigger_type = ?, name = ?, enabled = ?, discord_missing = 0,
                ignored_roles = ?, ignored_channels = ?, response_message = ?,
                last_synced_at = ?, updated_at = ?
            WHERE id = ?
        `);
        const insert = db.prepare(`
            INSERT INTO automod_rules
                (guild_id, discord_rule_id, trigger_type, name, enabled, discord_missing,
                 last_synced_at, ignored_roles, ignored_channels, response_message)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        `);

        for (const row of existing) {
            const rule = row.discord_rule_id ? discordRules.get(row.discord_rule_id) : null;
            if (!rule) {
                // Une ligne jamais poussée chez Discord (discord_rule_id NULL) n'a
                // rien « disparu » : elle est déjà signalée comme non publiée.
                if (row.discord_rule_id && !row.discord_missing) missing++;
                if (row.discord_rule_id) markMissing.run(ts, ts, row.id);
                continue;
            }
            const ex = exemptionsOf(rule);
            const trigger = TRIGGER_BY_DISCORD_TYPE.get(rule.triggerType);
            refresh.run(
                trigger?.key || row.trigger_type,
                rule.name ?? '',
                rule.enabled ? 1 : 0,
                JSON.stringify(ex.roles),
                JSON.stringify(ex.channels),
                customMessageOf(rule),
                ts, ts, row.id
            );
        }

        for (const rule of discordRules.values()) {
            if (knownIds.has(rule.id)) continue;
            const trigger = TRIGGER_BY_DISCORD_TYPE.get(rule.triggerType);
            // Déclencheur qu'on ne sait pas nommer : on l'adopte quand même, sous
            // sa valeur brute. Le quota le comptera, et l'interface le signalera
            // comme non modifiable depuis Quasar plutôt que de l'ignorer.
            const ex = exemptionsOf(rule);
            insert.run(
                guild.id, rule.id,
                trigger?.key || `UNKNOWN_${rule.triggerType}`,
                rule.name ?? '', rule.enabled ? 1 : 0,
                ts, JSON.stringify(ex.roles), JSON.stringify(ex.channels),
                customMessageOf(rule)
            );
            adopted++;
        }
    });

    apply();

    const rows = db.prepare('SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id ASC').all(guild.id);
    return { rows, discordRules, missing, adopted };
}

/**
 * Nombre de règles par déclencheur, tel que Discord les compte.
 *
 * Le quota est celui de Discord : on part de SES règles, pas des lignes locales.
 * Compter en base laisserait passer une septième règle de mots-clés créée
 * directement dans Discord, pour finir sur un refus incompréhensible à l'envoi.
 */
function countByTrigger(discordRules) {
    const counts = {};
    for (const key of Object.keys(TRIGGERS)) counts[key] = 0;
    for (const rule of discordRules.values()) {
        const trigger = TRIGGER_BY_DISCORD_TYPE.get(rule.triggerType);
        if (trigger) counts[trigger.key]++;
    }
    return counts;
}

/**
 * Vue complète d'une règle pour le dashboard : la ligne locale (identifiant
 * Quasar, salon de journalisation, état de désynchronisation) enrichie de la
 * configuration vivante lue chez Discord.
 */
function serializeRule(row, discordRule) {
    const trigger = TRIGGERS[row.trigger_type] || null;

    const base = {
        id: row.id,
        discord_rule_id: row.discord_rule_id,
        trigger_type: row.trigger_type,
        trigger_known: !!trigger,
        name: row.name,
        enabled: !!row.enabled,
        discord_missing: !!row.discord_missing,
        last_synced_at: row.last_synced_at,
        log_channel: row.log_channel,
        response_message: row.response_message,
    };

    if (!discordRule) return { ...base, actions: [], trigger_metadata: null, exempt_roles: [], exempt_channels: [] };

    const meta = discordRule.triggerMetadata || {};
    const ex = exemptionsOf(discordRule);

    return {
        ...base,
        actions: (discordRule.actions || []).map(a => ({
            type: ACTION_BY_DISCORD_TYPE.get(a.type)?.key || `UNKNOWN_${a.type}`,
            channel_id: a.metadata?.channelId || null,
            duration_seconds: a.metadata?.durationSeconds ?? null,
            custom_message: a.metadata?.customMessage || null,
        })),
        trigger_metadata: {
            keyword_filter: meta.keywordFilter || [],
            regex_patterns: meta.regexPatterns || [],
            allow_list: meta.allowList || [],
            presets: (meta.presets || []).map(p => PRESET_BY_DISCORD_TYPE.get(p)?.key || `UNKNOWN_${p}`),
            mention_total_limit: meta.mentionTotalLimit ?? null,
            mention_raid_protection_enabled: !!meta.mentionRaidProtectionEnabled,
        },
        exempt_roles: ex.roles,
        exempt_channels: ex.channels,
    };
}

/** Ligne locale d'une règle, par identifiant Quasar. */
function findRow(guildId, id) {
    return getDb().prepare('SELECT * FROM automod_rules WHERE guild_id = ? AND id = ?').get(guildId, id);
}

module.exports = {
    LIMITS,
    TRIGGERS,
    ACTIONS,
    PRESETS,
    TRIGGER_BY_DISCORD_TYPE,
    ACTION_BY_DISCORD_TYPE,
    PRESET_BY_DISCORD_TYPE,
    checkPermissions,
    describeDiscordError,
    syncGuildRules,
    countByTrigger,
    serializeRule,
    findRow,
    nowSeconds,
};
