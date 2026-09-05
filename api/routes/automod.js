// ═══════════════════════════════════════════════════════════════
//  Règles AutoMod Discord — façade sur l'AutoMod natif
//
//  Ce routeur ne configure AUCUNE punition Quasar. Il crée, édite et supprime des
//  règles chez Discord ; les sanctions appliquées sont celles portées par la règle
//  Discord elle-même (bloquer le message, alerter, exclure temporairement). Quasar
//  historise et journalise les déclenchements — il ne re-punit pas par-dessus.
//
//  Le miroir en base et la logique de rapprochement vivent dans
//  bot/utils/automodSync.js, partagés avec l'événement de déclenchement : la
//  question « cette règle existe-t-elle encore chez Discord ? » ne doit avoir
//  qu'une seule réponse dans le projet.
//
//  ─── Le piège de la portée, dit franchement ───
//  L'API AutoMod ne connaît QUE des exemptions : « n'applique pas cette règle à
//  ces rôles / dans ces salons ». Il n'existe aucun équivalent de « n'applique
//  cette règle QUE dans ces salons ». Les colonnes `affected_roles` et
//  `affected_channels` ne sont donc ni exposées ni écrites par ce module : elles
//  restent à leur défaut '[]'. Afficher une case qui ne ferait rien serait pire
//  que son absence — c'est exactement le bug que raconte l'en-tête de
//  bot/utils/modlog.js, où des types de logs décochés continuaient d'être envoyés.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb, SCOPE_COLUMNS } = require('../services/database');
const {
    LIMITS, TRIGGERS, ACTIONS, PRESETS,
    checkPermissions, describeDiscordError, syncGuildRules,
    countByTrigger, serializeRule, findRow, nowSeconds,
} = require('../../bot/utils/automodSync');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Enveloppe un handler asynchrone.
 *
 * Express 4 ne capture PAS le rejet d'une promesse renvoyée par un handler : il
 * remonte en `unhandledRejection`, et Node arrête le processus — c'est-à-dire le
 * bot Discord entier, qui tourne dans le même processus que l'API. Un imprévu de
 * cette route (contrainte SQLite, réponse inattendue de Discord) ne doit pas
 * pouvoir déconnecter le bot de tous les serveurs.
 */
function guarded(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(err => {
        console.error('[Quasar AutoMod] Erreur inattendue :', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Une erreur inattendue est survenue côté Quasar. Réessayez dans un instant.' });
        }
    });
}

// Colonnes de portée réellement pilotées par ce module. La liste de référence
// vient de database.js : la recopier ferait diverger la validation du domaine des
// tables le jour où une colonne y est ajoutée.
const SCOPE_KEYS = Object.keys(SCOPE_COLUMNS);
const MANAGED_SCOPE_KEYS = ['ignored_roles', 'ignored_channels', 'log_channel', 'response_message'];
const UNSUPPORTED_SCOPE_KEYS = SCOPE_KEYS.filter(k => !MANAGED_SCOPE_KEYS.includes(k));

// ─── Accès au serveur Discord ───────────────────────────────────────────────

/**
 * Serveur Discord vu par le bot, ou la raison lisible pour laquelle il ne l'est pas.
 * @returns {{ guild: object|null, error: { status: number, body: object }|null }}
 */
function resolveGuild(req) {
    const client = req.app.get('discordClient');
    const guild = client?.guilds?.cache?.get(req.params.guildId);
    if (!guild) {
        return {
            guild: null,
            error: {
                status: 503,
                body: {
                    error: 'Le bot n\'est pas connecté à ce serveur pour le moment.',
                    hint: 'Vérifiez que Quasar y est toujours présent, puis réessayez dans un instant.',
                },
            },
        };
    }
    return { guild, error: null };
}

/** Refus de quota, formulé avec le bon nombre : « une seule » lit mieux que « 1 règle(s) ». */
function quotaMessage(trigger) {
    return trigger.maxPerGuild === 1
        ? `Discord n'autorise qu'une seule règle « ${trigger.label} » par serveur, et elle existe déjà.`
        : `Discord limite ce serveur à ${trigger.maxPerGuild} règles « ${trigger.label} », et elles sont toutes utilisées.`;
}

// Message unique du refus pour permission manquante : il doit dire quoi faire,
// pas seulement ce qui manque.
const MANAGE_GUILD_HINT = 'Dans Discord : Paramètres du serveur → Rôles → rôle de Quasar → activez « Gérer le serveur ». '
    + 'Ajoutez « Modérer les membres » si vous voulez que les règles puissent exclure temporairement.';

function requireManageGuild(guild, res) {
    const perms = checkPermissions(guild);
    if (perms.manageGuild) return perms;
    res.status(403).json({
        error: perms.known
            ? 'Quasar n\'a pas la permission « Gérer le serveur », indispensable pour piloter l\'AutoMod de Discord.'
            : 'Impossible de lire les permissions de Quasar sur ce serveur.',
        hint: MANAGE_GUILD_HINT,
    });
    return null;
}

// ─── Lecture et validation des entrées ──────────────────────────────────────
//
// Tout est revalidé ici, jamais seulement dans le navigateur : le dashboard
// n'est qu'un client parmi d'autres du point de vue de cette API.

function readStringArray(raw, { max, maxLength, field }) {
    if (raw === undefined || raw === null || raw === '') return { value: [] };
    if (!Array.isArray(raw)) return { error: `${field} doit être une liste.` };

    const value = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') return { error: `${field} ne doit contenir que du texte.` };
        const trimmed = entry.trim();
        if (!trimmed) continue; // ligne vide de la saisie : ignorée, pas refusée
        if (trimmed.length > maxLength) {
            return { error: `${field} : « ${trimmed.slice(0, 30)}… » dépasse ${maxLength} caractères.` };
        }
        value.push(trimmed);
    }
    if (value.length > max) return { error: `${field} : ${max} entrées au maximum (${value.length} reçues).` };
    return { value };
}

function readIdArray(raw, { max, field }) {
    if (raw === undefined || raw === null || raw === '') return { value: [] };
    if (!Array.isArray(raw)) return { error: `${field} doit être une liste d'identifiants.` };

    const value = [];
    for (const entry of raw) {
        const id = String(entry).trim();
        if (!id) continue;
        if (!SNOWFLAKE.test(id)) return { error: `${field} : identifiant invalide (« ${id.slice(0, 24)} »).` };
        if (!value.includes(id)) value.push(id);
    }
    if (value.length > max) return { error: `${field} : ${max} au maximum (${value.length} reçus).` };
    return { value };
}

function readOptionalChannelId(raw, field) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const id = String(raw).trim();
    if (!SNOWFLAKE.test(id)) return { error: `${field} : identifiant de salon invalide.` };
    return { value: id };
}

/**
 * Valide et normalise le corps d'une création ou d'une édition.
 *
 * @param {object} body
 * @param {object} trigger — entrée du catalogue TRIGGERS (déclencheur figé :
 *        Discord ne permet pas d'en changer sur une règle existante)
 * @param {{ moderateMembers: boolean }} perms
 * @returns {{ error: string }|{ data: object }}
 */
function parseRulePayload(body, trigger, perms) {
    if (!body || typeof body !== 'object') return { error: 'Requête vide.' };

    const name = String(body.name ?? '').trim();
    if (!name) return { error: 'Donnez un nom à la règle.' };
    if (name.length > LIMITS.NAME_MAX) return { error: `Le nom dépasse ${LIMITS.NAME_MAX} caractères.` };

    // ─── Métadonnées du déclencheur ───
    const meta = {};

    if (trigger.fields.includes('keyword_filter')) {
        const kw = readStringArray(body.keyword_filter, {
            max: LIMITS.KEYWORD_COUNT, maxLength: LIMITS.KEYWORD_LENGTH, field: 'Les mots interdits',
        });
        if (kw.error) return { error: kw.error };
        meta.keywordFilter = kw.value;

        const re = readStringArray(body.regex_patterns, {
            max: LIMITS.REGEX_COUNT, maxLength: LIMITS.REGEX_LENGTH, field: 'Les expressions régulières',
        });
        if (re.error) return { error: re.error };
        meta.regexPatterns = re.value;

        if (!meta.keywordFilter.length && !meta.regexPatterns.length) {
            return { error: 'Indiquez au moins un mot interdit ou une expression régulière.' };
        }
    }

    if (trigger.fields.includes('presets')) {
        const raw = Array.isArray(body.presets) ? body.presets : [];
        const presets = [];
        for (const key of raw) {
            const preset = PRESETS[String(key)];
            if (!preset) return { error: `Liste de mots inconnue : « ${String(key).slice(0, 24)} ».` };
            if (!presets.includes(preset.discordType)) presets.push(preset.discordType);
        }
        if (!presets.length) return { error: 'Choisissez au moins une liste de mots de Discord.' };
        meta.presets = presets;
    }

    if (trigger.allowListMax > 0) {
        const allow = readStringArray(body.allow_list, {
            max: trigger.allowListMax, maxLength: LIMITS.ALLOW_LIST_LENGTH, field: 'Les mots autorisés',
        });
        if (allow.error) return { error: allow.error };
        meta.allowList = allow.value;
    }

    if (trigger.fields.includes('mention_total_limit')) {
        const limit = Number(body.mention_total_limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.MENTION_TOTAL) {
            return { error: `Le nombre de mentions autorisées doit être un entier entre 1 et ${LIMITS.MENTION_TOTAL}.` };
        }
        meta.mentionTotalLimit = limit;
        meta.mentionRaidProtectionEnabled = !!body.mention_raid_protection_enabled;
    }

    // ─── Actions portées par la règle Discord ───
    const actions = [];
    const allowed = trigger.allowedActions;

    const wantsBlock = !!body.block_message;
    let responseMessage = null;
    if (wantsBlock) {
        if (!allowed.includes('BLOCK_MESSAGE')) {
            return { error: `« ${ACTIONS.BLOCK_MESSAGE.label} » n'est pas disponible pour « ${trigger.label} ».` };
        }
        const custom = String(body.response_message ?? '').trim();
        if (custom.length > LIMITS.CUSTOM_MESSAGE) {
            return { error: `Le message affiché à la personne dépasse ${LIMITS.CUSTOM_MESSAGE} caractères (${custom.length}).` };
        }
        responseMessage = custom || null;
        actions.push({
            type: ACTIONS.BLOCK_MESSAGE.discordType,
            metadata: responseMessage ? { customMessage: responseMessage } : {},
        });
    }

    const alert = readOptionalChannelId(body.alert_channel_id, 'Le salon d\'alerte');
    if (alert.error) return { error: alert.error };
    if (alert.value) {
        if (!allowed.includes('SEND_ALERT_MESSAGE')) {
            return { error: `« ${ACTIONS.SEND_ALERT_MESSAGE.label} » n'est pas disponible pour « ${trigger.label} ».` };
        }
        actions.push({ type: ACTIONS.SEND_ALERT_MESSAGE.discordType, metadata: { channel: alert.value } });
    }

    const timeoutRaw = body.timeout_seconds;
    if (timeoutRaw !== undefined && timeoutRaw !== null && timeoutRaw !== '') {
        const seconds = Number(timeoutRaw);
        if (!allowed.includes('TIMEOUT')) {
            // Contrainte de l'API, pas un choix de Quasar : Discord réserve
            // l'exclusion temporaire aux règles de mots-clés et de mentions.
            return { error: `Discord ne permet pas d'exclure temporairement avec « ${trigger.label} ».` };
        }
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > LIMITS.TIMEOUT_SECONDS) {
            return { error: 'La durée d\'exclusion doit être comprise entre 1 seconde et 28 jours.' };
        }
        if (!perms.moderateMembers) {
            return {
                error: 'Quasar n\'a pas la permission « Modérer les membres », nécessaire pour qu\'une règle exclue temporairement.',
            };
        }
        actions.push({ type: ACTIONS.TIMEOUT.discordType, metadata: { durationSeconds: seconds } });
    }

    if (body.block_member_interaction) {
        if (!allowed.includes('BLOCK_MEMBER_INTERACTION')) {
            return { error: `« ${ACTIONS.BLOCK_MEMBER_INTERACTION.label} » n'est pas disponible pour « ${trigger.label} ».` };
        }
        actions.push({ type: ACTIONS.BLOCK_MEMBER_INTERACTION.discordType, metadata: {} });
    }

    if (!actions.length) return { error: 'Choisissez au moins une action à appliquer quand la règle se déclenche.' };

    // ─── Exemptions ───
    const exemptRoles = readIdArray(body.exempt_roles, { max: LIMITS.EXEMPT_ROLES, field: 'Les rôles exemptés' });
    if (exemptRoles.error) return { error: exemptRoles.error };
    const exemptChannels = readIdArray(body.exempt_channels, { max: LIMITS.EXEMPT_CHANNELS, field: 'Les salons exemptés' });
    if (exemptChannels.error) return { error: exemptChannels.error };

    // ─── Journalisation Quasar (inconnue de Discord) ───
    const logChannel = readOptionalChannelId(body.log_channel, 'Le salon des journaux');
    if (logChannel.error) return { error: logChannel.error };

    return {
        data: {
            name,
            enabled: !!body.enabled,
            eventType: trigger.eventType,
            triggerMetadata: meta,
            actions,
            exemptRoles: exemptRoles.value,
            exemptChannels: exemptChannels.value,
            logChannel: logChannel.value,
            responseMessage,
        },
    };
}

// ─── Vue renvoyée au dashboard ──────────────────────────────────────────────

/**
 * Catalogue statique envoyé une fois avec la liste : l'interface décrit les
 * déclencheurs et les plafonds en langage d'utilisateur sans les redéfinir de son
 * côté, où ils finiraient par diverger de la validation serveur.
 */
function buildCatalog() {
    return {
        triggers: Object.values(TRIGGERS).map(t => ({
            key: t.key,
            label: t.label,
            summary: t.summary,
            max_per_guild: t.maxPerGuild,
            fields: t.fields,
            allow_list_max: t.allowListMax,
            allowed_actions: t.allowedActions,
        })),
        actions: Object.values(ACTIONS).map(a => ({ key: a.key, label: a.label, summary: a.summary })),
        presets: Object.values(PRESETS).map(p => ({ key: p.key, label: p.label })),
        limits: LIMITS,
        // Dit à l'interface ce que ce module NE pilote PAS, pour qu'elle
        // l'explique au lieu de le passer sous silence.
        unsupported_scope: UNSUPPORTED_SCOPE_KEYS,
    };
}

function buildQuotas(counts) {
    const quotas = {};
    for (const trigger of Object.values(TRIGGERS)) {
        const used = counts[trigger.key] || 0;
        quotas[trigger.key] = { used, max: trigger.maxPerGuild, remaining: Math.max(0, trigger.maxPerGuild - used) };
    }
    return quotas;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET / — synchronise puis renvoie l'état complet du module pour ce serveur.
// La synchronisation est déclenchée ICI, à l'ouverture de l'onglet : pas de tâche
// de fond, les instances sur Raspberry Pi ne paient que ce qui est regardé.
router.get('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const permissions = checkPermissions(guild);
    const catalog = buildCatalog();

    // Sans « Gérer le serveur », l'API AutoMod est entièrement fermée — lecture
    // comprise. On répond quand même 200 avec ce que la base sait : l'interface
    // affiche l'explication et les règles déjà connues, au lieu d'une page vide
    // sur une erreur d'API brute.
    if (!permissions.manageGuild) {
        const rows = getDb().prepare('SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id ASC').all(guild.id);
        return res.json({
            permissions: { manage_guild: false, moderate_members: permissions.moderateMembers, known: permissions.known },
            permission_hint: MANAGE_GUILD_HINT,
            synced: false,
            quotas: buildQuotas({}),
            rules: rows.map(row => serializeRule(row, null)),
            catalog,
        });
    }

    try {
        const { rows, discordRules } = await syncGuildRules(guild);
        res.json({
            permissions: { manage_guild: true, moderate_members: permissions.moderateMembers, known: true },
            synced: true,
            quotas: buildQuotas(countByTrigger(discordRules)),
            rules: rows.map(row => serializeRule(row, row.discord_rule_id ? discordRules.get(row.discord_rule_id) : null)),
            catalog,
        });
    } catch (err) {
        console.error('[Quasar AutoMod] Synchronisation des règles en échec :', err.message);
        res.status(502).json({ error: describeDiscordError(err) });
    }
}));

// POST / — crée une règle chez Discord, puis l'enregistre dans le miroir.
router.post('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const perms = requireManageGuild(guild, res);
    if (!perms) return;

    const trigger = TRIGGERS[String(req.body?.trigger_type ?? '')];
    if (!trigger) return res.status(400).json({ error: 'Type de règle inconnu.' });

    const parsed = parseRulePayload(req.body, trigger, perms);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let discordRules;
    try {
        ({ discordRules } = await syncGuildRules(guild));
    } catch (err) {
        return res.status(502).json({ error: describeDiscordError(err) });
    }

    // Quota vérifié sur les règles RÉELLES de Discord, juste avant l'envoi.
    const used = countByTrigger(discordRules)[trigger.key] || 0;
    if (used >= trigger.maxPerGuild) {
        return res.status(409).json({
            error: quotaMessage(trigger),
            hint: 'Modifiez ou supprimez une règle existante de ce type pour en créer une nouvelle.',
        });
    }

    const { data } = parsed;
    let created;
    try {
        created = await guild.autoModerationRules.create({
            name: data.name,
            eventType: data.eventType,
            triggerType: trigger.discordType,
            triggerMetadata: data.triggerMetadata,
            actions: data.actions,
            enabled: data.enabled,
            exemptRoles: data.exemptRoles,
            exemptChannels: data.exemptChannels,
            reason: `Règle AutoMod créée depuis le dashboard Quasar par ${req.user.username}`,
        });
    } catch (err) {
        console.error('[Quasar AutoMod] Création de règle refusée :', err.message);
        return res.status(400).json({ error: describeDiscordError(err) });
    }

    const ts = nowSeconds();
    const result = getDb().prepare(`
        INSERT INTO automod_rules
            (guild_id, discord_rule_id, trigger_type, name, enabled, discord_missing,
             last_synced_at, ignored_roles, ignored_channels, log_channel, response_message)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
        guild.id, created.id, trigger.key, data.name, data.enabled ? 1 : 0, ts,
        JSON.stringify(data.exemptRoles), JSON.stringify(data.exemptChannels),
        data.logChannel, data.responseMessage
    );

    res.status(201).json({ success: true, id: Number(result.lastInsertRowid), discord_rule_id: created.id });
}));

// PUT /:id — édite la règle chez Discord.
//
// Cas particulier assumé : si la règle a disparu de Discord (discord_missing, ou
// ligne jamais poussée), cette même route la RECRÉE à partir du formulaire. C'est
// le chemin de récupération demandé par l'interface — inutile d'ajouter un
// endpoint « recréer » qui ferait exactement la même chose.
router.put('/:id', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const perms = requireManageGuild(guild, res);
    if (!perms) return;

    const row = findRow(guild.id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Règle introuvable.' });

    const trigger = TRIGGERS[row.trigger_type];
    if (!trigger) {
        return res.status(400).json({
            error: 'Cette règle utilise un type que Quasar ne sait pas modifier.',
            hint: 'Modifiez-la directement dans les réglages AutoMod de Discord.',
        });
    }

    const parsed = parseRulePayload(req.body, trigger, perms);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { data } = parsed;

    // On repart de l'état réel de Discord : la règle a pu être supprimée depuis le
    // chargement de la page, et le miroir mis à jour ici évite d'éditer dans le vide.
    let discordRules;
    try {
        ({ discordRules } = await syncGuildRules(guild));
    } catch (err) {
        return res.status(502).json({ error: describeDiscordError(err) });
    }

    const live = row.discord_rule_id ? discordRules.get(row.discord_rule_id) : null;
    const reason = `Règle AutoMod modifiée depuis le dashboard Quasar par ${req.user.username}`;

    let discordRuleId = row.discord_rule_id;
    try {
        if (live) {
            await guild.autoModerationRules.edit(live.id, {
                name: data.name,
                eventType: data.eventType,
                triggerMetadata: data.triggerMetadata,
                actions: data.actions,
                enabled: data.enabled,
                exemptRoles: data.exemptRoles,
                exemptChannels: data.exemptChannels,
                reason,
            });
        } else {
            const used = countByTrigger(discordRules)[trigger.key] || 0;
            if (used >= trigger.maxPerGuild) {
                return res.status(409).json({
                    error: `Impossible de recréer cette règle. ${quotaMessage(trigger)}`,
                    hint: 'Supprimez une règle existante de ce type, ou supprimez cette configuration devenue orpheline.',
                });
            }
            const recreated = await guild.autoModerationRules.create({
                name: data.name,
                eventType: data.eventType,
                triggerType: trigger.discordType,
                triggerMetadata: data.triggerMetadata,
                actions: data.actions,
                enabled: data.enabled,
                exemptRoles: data.exemptRoles,
                exemptChannels: data.exemptChannels,
                reason: `Règle AutoMod recréée depuis le dashboard Quasar par ${req.user.username}`,
            });
            discordRuleId = recreated.id;
        }
    } catch (err) {
        console.error('[Quasar AutoMod] Édition de règle refusée :', err.message);
        return res.status(400).json({ error: describeDiscordError(err) });
    }

    const ts = nowSeconds();
    getDb().prepare(`
        UPDATE automod_rules
        SET discord_rule_id = ?, name = ?, enabled = ?, discord_missing = 0,
            ignored_roles = ?, ignored_channels = ?, log_channel = ?, response_message = ?,
            last_synced_at = ?, updated_at = ?
        WHERE id = ?
    `).run(
        discordRuleId, data.name, data.enabled ? 1 : 0,
        JSON.stringify(data.exemptRoles), JSON.stringify(data.exemptChannels),
        data.logChannel, data.responseMessage, ts, ts, row.id
    );

    res.json({ success: true, discord_rule_id: discordRuleId });
}));

// PUT /:id/enabled — bascule d'activation, sans repasser par tout le formulaire.
router.put('/:id/enabled', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const perms = requireManageGuild(guild, res);
    if (!perms) return;

    const row = findRow(guild.id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Règle introuvable.' });
    if (!row.discord_rule_id || row.discord_missing) {
        return res.status(409).json({
            error: 'Cette règle n\'existe plus dans Discord : elle ne peut pas être activée.',
            hint: 'Ouvrez-la pour la recréer, ou supprimez la configuration devenue orpheline.',
        });
    }

    const enabled = !!req.body?.enabled;
    try {
        await guild.autoModerationRules.edit(row.discord_rule_id, {
            enabled,
            reason: `Règle AutoMod ${enabled ? 'activée' : 'désactivée'} depuis le dashboard Quasar par ${req.user.username}`,
        });
    } catch (err) {
        // Une règle supprimée entre-temps se manifeste ici : on met le miroir à
        // jour plutôt que de laisser l'interface croire à un échec passager.
        if (err.code === 10241 || err.status === 404) {
            const ts = nowSeconds();
            getDb().prepare('UPDATE automod_rules SET discord_missing = 1, enabled = 0, last_synced_at = ?, updated_at = ? WHERE id = ?')
                .run(ts, ts, row.id);
            return res.status(409).json({ error: 'Cette règle a été supprimée dans Discord entre-temps.' });
        }
        console.error('[Quasar AutoMod] Bascule d\'activation refusée :', err.message);
        return res.status(400).json({ error: describeDiscordError(err) });
    }

    const ts = nowSeconds();
    getDb().prepare('UPDATE automod_rules SET enabled = ?, last_synced_at = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, ts, ts, row.id);

    res.json({ success: true, enabled });
}));

// DELETE /:id — supprime la règle chez Discord puis la ligne locale.
// Sur une règle déjà disparue de Discord, c'est le nettoyage de la configuration
// orpheline : la ligne part sans que Discord soit sollicité.
router.delete('/:id', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const row = findRow(guild.id, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Règle introuvable.' });

    const dropRow = () => getDb().prepare('DELETE FROM automod_rules WHERE id = ?').run(row.id);

    if (!row.discord_rule_id || row.discord_missing) {
        dropRow();
        return res.json({ success: true, discord_deleted: false });
    }

    const perms = requireManageGuild(guild, res);
    if (!perms) return;

    try {
        await guild.autoModerationRules.delete(
            row.discord_rule_id,
            `Règle AutoMod supprimée depuis le dashboard Quasar par ${req.user.username}`
        );
    } catch (err) {
        // Déjà supprimée côté Discord : le résultat voulu est atteint, on nettoie.
        if (err.code === 10241 || err.status === 404) {
            dropRow();
            return res.json({ success: true, discord_deleted: false });
        }
        console.error('[Quasar AutoMod] Suppression de règle refusée :', err.message);
        return res.status(400).json({ error: describeDiscordError(err) });
    }

    dropRow();
    res.json({ success: true, discord_deleted: true });
}));

module.exports = router;
