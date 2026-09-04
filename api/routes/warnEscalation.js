// ═══════════════════════════════════════════════════════════════
//  Escalade par avertissements — configuration des paliers
//
//  Un palier = un seuil d'avertissements actifs + une chaîne de punitions
//  composables. Ce routeur ne décide de rien : il valide, écrit, et renvoie.
//  L'évaluation (quel palier s'applique, dans quelle portée) vit dans
//  bot/utils/warnEscalation.js, partagée avec la commande /warn — la question
//  « ce palier est-il atteignable ? » ne doit avoir qu'une seule réponse dans
//  le projet.
//
//  ─── Ce que ce module remplace ───
//  L'escalade historique tenait dans modules.config.autoSanctions : trois
//  paliers figés (mute / kick / ban), aucune portée, aucune composition. Les
//  configurations existantes ont été reprises en base par la migration
//  warn_escalation_from_autosanctions_v1 ; l'ancien chemin d'application a été
//  retiré de bot/commands/warn.js. Il n'y a plus qu'un seul système d'escalade,
//  et c'est celui-ci.
//
//  ─── Pourquoi la portée est ici complète, contrairement à l'AutoMod Discord ───
//  Le lot AutoMod n'expose que des exemptions, parce que l'API de Discord ne
//  connaît que ça. Ici, c'est Quasar qui décide d'appliquer ou non : les deux
//  directions — « seulement ces rôles / salons » et « jamais ces rôles /
//  salons » — sont réellement évaluées par bot/utils/scopeFilter.js.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { validatePunishments, ACTION_NAMES } = require('../../bot/utils/punishments');
const {
    listTiers, findTier, findUnreachableTiers,
    MIN_THRESHOLD, MAX_THRESHOLD, MAX_TIERS_PER_GUILD,
} = require('../../bot/utils/warnEscalation');
const { getRetentionMonths } = require('../../bot/modules/retention/sanctions');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_SCOPE_ENTRIES = 25;
const MAX_RESPONSE_MESSAGE = 1000;
const MAX_PUNISHMENTS_LENGTH = 200;

/**
 * Enveloppe un handler asynchrone.
 *
 * Express 4 ne capture PAS le rejet d'une promesse renvoyée par un handler : il
 * remonte en `unhandledRejection`, et Node arrête le processus — c'est-à-dire le
 * bot Discord entier, qui tourne dans le même processus que l'API. Un imprévu de
 * cette route (contrainte SQLite, donnée inattendue) ne doit pas pouvoir
 * déconnecter le bot de tous les serveurs.
 */
function guarded(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(err => {
        console.error('[Quasar Escalade] Erreur inattendue :', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Une erreur inattendue est survenue côté Quasar. Réessayez dans un instant.' });
        }
    });
}

// ─── Catalogue des actions ──────────────────────────────────────────────────
//
// La liste des actions valides vient du socle (ACTION_NAMES) : la recopier
// ferait diverger l'aide affichée de ce que la validation accepte réellement.
// Ce tableau n'ajoute que la formulation. Une action du socle sans entrée ici
// reste proposée, avec son nom brut — jamais masquée.

const ACTION_HELP = {
    delete: { label: 'Supprimer le message', duration: false, summary: 'Sans effet ici : l\'escalade ne part pas d\'un message.' },
    warn: { label: 'Ajouter un avertissement', duration: false, summary: 'Attention : cet avertissement compte lui aussi dans le total du membre.' },
    timeout: { label: 'Exclure temporairement', duration: true, summary: 'Exclusion native de Discord. 28 jours au maximum.' },
    tempmute: { label: 'Rendre muet un moment', duration: true, summary: 'Identique à l\'exclusion temporaire de Discord.' },
    mute: { label: 'Rendre muet', duration: false, summary: 'Exclusion au maximum autorisé par Discord (28 jours).' },
    kick: { label: 'Expulser', duration: false, summary: 'La personne peut revenir : ses avertissements, eux, restent.' },
    tempban: { label: 'Bannir un moment', duration: true, summary: 'Le bannissement est levé automatiquement à l\'échéance.' },
    ban: { label: 'Bannir', duration: false, summary: 'Définitif tant que le bannissement n\'est pas levé à la main.' },
    dm: { label: 'Prévenir en message privé', duration: false, summary: 'Utilise le message de ce palier. Sans effet si la personne ferme ses messages privés.' },
    defer: { label: 'Demander un arbitrage', duration: false, summary: 'Rien n\'est appliqué : le cas part dans le salon d\'arbitrage pour décision.' },
};

function buildCatalog() {
    return {
        actions: ACTION_NAMES.map(name => ({
            key: name,
            label: ACTION_HELP[name]?.label || name,
            duration: !!ACTION_HELP[name]?.duration,
            summary: ACTION_HELP[name]?.summary || '',
        })),
        limits: {
            MIN_THRESHOLD,
            MAX_THRESHOLD,
            MAX_TIERS_PER_GUILD,
            MAX_SCOPE_ENTRIES,
            MAX_RESPONSE_MESSAGE,
            MAX_PUNISHMENTS_LENGTH,
        },
    };
}

// ─── Lecture et validation des entrées ──────────────────────────────────────
//
// Tout est revalidé ici, jamais seulement dans le navigateur : le dashboard
// n'est qu'un client parmi d'autres du point de vue de cette API.

function readIdArray(raw, field) {
    if (raw === undefined || raw === null || raw === '') return { value: [] };
    if (!Array.isArray(raw)) return { error: `${field} doit être une liste d'identifiants.` };

    const value = [];
    for (const entry of raw) {
        const id = String(entry).trim();
        if (!id) continue;
        if (!SNOWFLAKE.test(id)) return { error: `${field} : identifiant invalide (« ${id.slice(0, 24)} »).` };
        if (!value.includes(id)) value.push(id);
    }
    if (value.length > MAX_SCOPE_ENTRIES) {
        return { error: `${field} : ${MAX_SCOPE_ENTRIES} au maximum (${value.length} reçus).` };
    }
    return { value };
}

function readOptionalChannelId(raw, field) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const id = String(raw).trim();
    if (!SNOWFLAKE.test(id)) return { error: `${field} : identifiant de salon invalide.` };
    return { value: id };
}

/**
 * Valide et normalise le corps d'une création ou d'une édition de palier.
 * @returns {{ error: string }|{ data: object }}
 */
function parseTierPayload(body) {
    if (!body || typeof body !== 'object') return { error: 'Requête vide.' };

    // Le seuil est lu strictement : « 3 » et 3 passent, « trois » et 3.5 non.
    // Un seuil accepté à la légère produirait un palier qui ne se déclenche
    // jamais, ou pire, un palier à 0 qui se déclenche pour tout le monde.
    const raw = body.threshold;
    const threshold = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isInteger(threshold)) {
        return { error: 'Le seuil doit être un nombre entier d\'avertissements.' };
    }
    if (threshold < MIN_THRESHOLD) {
        return { error: `Le seuil doit valoir au moins ${MIN_THRESHOLD} : un palier à 0 s'appliquerait à toute personne, même sans aucun avertissement.` };
    }
    if (threshold > MAX_THRESHOLD) {
        return { error: `Le seuil ne peut pas dépasser ${MAX_THRESHOLD} avertissements.` };
    }

    // Chaîne vide = mode « alerte seule », une configuration valide et
    // volontaire : le palier est journalisé sans que personne ne soit sanctionné.
    const punishments = String(body.punishments ?? '').trim();
    if (punishments.length > MAX_PUNISHMENTS_LENGTH) {
        return { error: `La liste de sanctions dépasse ${MAX_PUNISHMENTS_LENGTH} caractères.` };
    }
    const check = validatePunishments(punishments);
    if (!check.valid) return { error: check.errors.join(' ') };

    const affectedRoles = readIdArray(body.affected_roles, 'Les rôles concernés');
    if (affectedRoles.error) return { error: affectedRoles.error };
    const affectedChannels = readIdArray(body.affected_channels, 'Les salons concernés');
    if (affectedChannels.error) return { error: affectedChannels.error };
    const ignoredRoles = readIdArray(body.ignored_roles, 'Les rôles ignorés');
    if (ignoredRoles.error) return { error: ignoredRoles.error };
    const ignoredChannels = readIdArray(body.ignored_channels, 'Les salons ignorés');
    if (ignoredChannels.error) return { error: ignoredChannels.error };

    const logChannel = readOptionalChannelId(body.log_channel, 'Le salon des journaux');
    if (logChannel.error) return { error: logChannel.error };

    const responseMessage = String(body.response_message ?? '').trim();
    if (responseMessage.length > MAX_RESPONSE_MESSAGE) {
        return { error: `Le message envoyé à la personne dépasse ${MAX_RESPONSE_MESSAGE} caractères (${responseMessage.length}).` };
    }

    return {
        data: {
            threshold,
            enabled: !!body.enabled,
            punishments,
            affectedRoles: affectedRoles.value,
            affectedChannels: affectedChannels.value,
            ignoredRoles: ignoredRoles.value,
            ignoredChannels: ignoredChannels.value,
            logChannel: logChannel.value,
            responseMessage: responseMessage || null,
        },
    };
}

// ─── Vue renvoyée au dashboard ──────────────────────────────────────────────

/**
 * Relit une colonne JSON de portée pour l'affichage. Une valeur illisible est
 * renvoyée comme liste vide ET signalée : le formulaire doit pouvoir dire
 * « cette portée n'est plus lisible » plutôt que de laisser croire à une portée
 * ouverte — pour le bot, une colonne illisible bloque l'application du palier
 * (cf. scopeFilter.js).
 */
function readScopeColumn(raw, broken, key) {
    if (raw === null || raw === undefined || raw === '') return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) { broken.push(key); return []; }
        return parsed.map(String);
    } catch {
        broken.push(key);
        return [];
    }
}

function serializeTier(row, unreachable) {
    const broken = [];
    const blocked = unreachable.find(u => u.id === row.id) || null;
    return {
        id: row.id,
        threshold: row.threshold,
        enabled: !!row.enabled,
        punishments: row.punishments || '',
        affected_roles: readScopeColumn(row.affected_roles, broken, 'affected_roles'),
        affected_channels: readScopeColumn(row.affected_channels, broken, 'affected_channels'),
        ignored_roles: readScopeColumn(row.ignored_roles, broken, 'ignored_roles'),
        ignored_channels: readScopeColumn(row.ignored_channels, broken, 'ignored_channels'),
        log_channel: row.log_channel || null,
        response_message: row.response_message || null,
        // Un palier situé au-dessus d'un palier qui bannit ne se déclenchera pas
        // tant que la personne n'est pas revenue : autant le dire dans la liste.
        unreachable_after: blocked ? blocked.blockedBy : null,
        broken_scope: broken,
    };
}

function buildState(guildId) {
    const rows = listTiers(guildId);
    const unreachable = findUnreachableTiers(rows);
    const months = getRetentionMonths(guildId);
    return {
        tiers: rows.map(row => serializeTier(row, unreachable)),
        // La fenêtre de comptage est une information de première importance :
        // sans elle, une personne qui règle un palier à 10 ne sait pas que les
        // avertissements de plus d'un an ont cessé d'y compter.
        retention: { months, unlimited: months === 0 },
        catalog: buildCatalog(),
    };
}

/** Le seuil est-il déjà pris par un autre palier de ce serveur ? */
function thresholdTaken(guildId, threshold, exceptId = null) {
    const row = getDb().prepare(
        'SELECT id FROM warn_escalation WHERE guild_id = ? AND threshold = ?'
    ).get(guildId, threshold);
    return !!row && row.id !== exceptId;
}

const DUPLICATE_THRESHOLD = {
    error: 'Un palier existe déjà à ce seuil.',
    hint: 'Deux paliers au même seuil s\'annuleraient l\'un l\'autre : modifiez celui qui existe, ou choisissez un autre seuil.',
};

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET / — état complet du module pour ce serveur.
// Lecture en base uniquement : aucun appel à Discord, aucune tâche de fond.
router.get('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    res.json(buildState(req.params.guildId));
}));

// POST / — crée un palier.
router.post('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;

    const parsed = parseTierPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { data } = parsed;

    const count = listTiers(guildId).length;
    if (count >= MAX_TIERS_PER_GUILD) {
        return res.status(409).json({
            error: `Ce serveur a atteint ses ${MAX_TIERS_PER_GUILD} paliers.`,
            hint: 'Supprimez ou modifiez un palier existant pour en ajouter un autre.',
        });
    }
    if (thresholdTaken(guildId, data.threshold)) {
        return res.status(409).json(DUPLICATE_THRESHOLD);
    }

    let result;
    try {
        result = getDb().prepare(`
            INSERT INTO warn_escalation
                (guild_id, enabled, threshold, punishments,
                 affected_roles, affected_channels, ignored_roles, ignored_channels,
                 log_channel, response_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            guildId, data.enabled ? 1 : 0, data.threshold, data.punishments,
            JSON.stringify(data.affectedRoles), JSON.stringify(data.affectedChannels),
            JSON.stringify(data.ignoredRoles), JSON.stringify(data.ignoredChannels),
            data.logChannel, data.responseMessage
        );
    } catch (err) {
        // Course entre deux onglets ouverts sur la même page : la contrainte
        // d'unicité de la base tranche, et le refus reste lisible.
        if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
            return res.status(409).json(DUPLICATE_THRESHOLD);
        }
        throw err;
    }

    res.status(201).json({ success: true, id: Number(result.lastInsertRowid) });
}));

// PUT /:id — édite un palier.
router.put('/:id', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;
    const tier = findTier(guildId, Number(req.params.id));
    if (!tier) return res.status(404).json({ error: 'Palier introuvable.' });

    const parsed = parseTierPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { data } = parsed;

    if (thresholdTaken(guildId, data.threshold, tier.id)) {
        return res.status(409).json(DUPLICATE_THRESHOLD);
    }

    try {
        getDb().prepare(`
            UPDATE warn_escalation
            SET enabled = ?, threshold = ?, punishments = ?,
                affected_roles = ?, affected_channels = ?,
                ignored_roles = ?, ignored_channels = ?,
                log_channel = ?, response_message = ?, updated_at = unixepoch()
            WHERE id = ? AND guild_id = ?
        `).run(
            data.enabled ? 1 : 0, data.threshold, data.punishments,
            JSON.stringify(data.affectedRoles), JSON.stringify(data.affectedChannels),
            JSON.stringify(data.ignoredRoles), JSON.stringify(data.ignoredChannels),
            data.logChannel, data.responseMessage, tier.id, guildId
        );
    } catch (err) {
        if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) {
            return res.status(409).json(DUPLICATE_THRESHOLD);
        }
        throw err;
    }

    res.json({ success: true });
}));

// PUT /:id/enabled — bascule d'activation, sans repasser par tout le formulaire.
router.put('/:id/enabled', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;
    const tier = findTier(guildId, Number(req.params.id));
    if (!tier) return res.status(404).json({ error: 'Palier introuvable.' });

    const enabled = !!req.body?.enabled;
    getDb().prepare('UPDATE warn_escalation SET enabled = ?, updated_at = unixepoch() WHERE id = ? AND guild_id = ?')
        .run(enabled ? 1 : 0, tier.id, guildId);

    res.json({ success: true, enabled });
}));

// DELETE /:id — supprime un palier.
router.delete('/:id', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;
    const tier = findTier(guildId, Number(req.params.id));
    if (!tier) return res.status(404).json({ error: 'Palier introuvable.' });

    getDb().prepare('DELETE FROM warn_escalation WHERE id = ? AND guild_id = ?').run(tier.id, guildId);
    res.json({ success: true });
}));

module.exports = router;
