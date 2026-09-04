// ═══════════════════════════════════════════════════════════════
//  Anti-raid sur les arrivées — configuration et mode panique
//
//  Une seule ligne de configuration par serveur (`antiraid_config`), plus deux
//  opérations qui agissent réellement sur Discord : poser et lever le mode
//  panique. Ce routeur valide et écrit ; toute la logique de détection et la
//  mécanique du mode panique vivent dans bot/modules/antiraid/, partagées avec
//  l'événement `guildMemberAdd` — la question « ce réglage est-il exploitable ? »
//  ne doit avoir qu'une seule réponse dans le projet.
//
//  ─── Pourquoi aucun réglage de portée ici ───
//  `antiraid_config` porte les six colonnes de portée communes à toutes les
//  tables de la modération automatique. Quatre d'entre elles n'ont AUCUN SENS
//  pour ce module et ne sont ni exposées ni écrites : elles restent à leur
//  défaut '[]'.
//    • `affected_roles` / `ignored_roles` : une personne qui vient de rejoindre
//      n'a aucun rôle. Discord ne les restaure pas au retour, et les autorôles
//      ne sont posés qu'APRÈS mon évaluation. Une exemption par rôle ne pourrait
//      jamais correspondre à personne.
//    • `affected_channels` / `ignored_channels` : une arrivée n'a pas de salon.
//  Afficher une case qui ne ferait rien serait pire que son absence — c'est
//  exactement le bug que raconte l'en-tête de bot/utils/modlog.js, où des types
//  de logs décochés continuaient d'être envoyés. Le lot AutoMod Discord a pris
//  la même décision, pour une raison différente (l'API de Discord ne connaît
//  que les exemptions).
//  `log_channel` et `response_message`, eux, sont pleinement gérés : ce ne sont
//  pas des restrictions de portée mais des réglages fonctionnels.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { validatePunishments, ACTION_NAMES } = require('../../bot/utils/punishments');
const antiraid = require('../../bot/modules/antiraid');
const { LIMITS, normalize } = require('../../bot/modules/antiraid/config');
const { MAX_PUNISHED_PER_WAVE } = require('../../bot/modules/antiraid/window');

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
        console.error('[Quasar Anti-raid] Erreur inattendue :', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Une erreur inattendue est survenue côté Quasar. Réessayez dans un instant.' });
        }
    });
}

// ─── Catalogue des actions ──────────────────────────────────────────────────
//
// La liste des actions valides vient du socle (ACTION_NAMES) : la recopier
// ferait diverger l'aide affichée de ce que la validation accepte réellement.
// Ce tableau n'ajoute que la formulation, propre à ce module — « supprimer le
// message » n'a pas le même sens ici que dans l'escalade.

const ACTION_HELP = {
    delete: { label: 'Supprimer le message', duration: false, summary: 'Sans effet ici : une arrivée n\'est pas un message.' },
    warn: { label: 'Ajouter un avertissement', duration: false, summary: 'Trace l\'arrivée dans l\'historique, sans rien empêcher.' },
    timeout: { label: 'Exclure temporairement', duration: true, summary: 'Exclusion native de Discord. Laisse le temps de vérifier avant de trancher.' },
    tempmute: { label: 'Rendre muet un moment', duration: true, summary: 'Identique à l\'exclusion temporaire de Discord.' },
    mute: { label: 'Rendre muet', duration: false, summary: 'Exclusion au maximum autorisé par Discord (28 jours).' },
    kick: { label: 'Expulser', duration: false, summary: 'La personne peut revenir dès que les invitations rouvrent.' },
    tempban: { label: 'Bannir un moment', duration: true, summary: 'Le choix le plus courant en anti-raid : bloque le compte, et se lève tout seul en cas de faux positif.' },
    ban: { label: 'Bannir', duration: false, summary: 'Définitif tant que le bannissement n\'est pas levé à la main. Sur un faux positif, c\'est irréversible sans intervention.' },
    dm: { label: 'Prévenir en message privé', duration: false, summary: 'Utilise le message de ce serveur. Sans effet si la personne ferme ses messages privés.' },
    defer: { label: 'Demander un arbitrage', duration: false, summary: 'Rien n\'est appliqué : un cas par compte part dans le salon d\'arbitrage. Sur une vague, cela fait beaucoup de cas.' },
};

function buildCatalog() {
    return {
        actions: ACTION_NAMES.map(name => ({
            key: name,
            label: ACTION_HELP[name]?.label || name,
            duration: !!ACTION_HELP[name]?.duration,
            summary: ACTION_HELP[name]?.summary || '',
        })),
        limits: { ...LIMITS, MAX_PUNISHED_PER_WAVE },
    };
}

// ─── Lecture et validation des entrées ──────────────────────────────────────
//
// Tout est revalidé ici, jamais seulement dans le navigateur : le dashboard
// n'est qu'un client parmi d'autres du point de vue de cette API.

/**
 * Entier strict dans ses bornes. « 10 » et 10 passent, « dix » et 10.5 non.
 * Un nombre accepté à la légère produirait une détection qui ne se déclenche
 * jamais — ou pire, qui se déclenche sur chaque arrivée.
 */
function readInt(raw, { field, min, max, hint }) {
    const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isInteger(value)) return { error: `${field} doit être un nombre entier.` };
    if (value < min || value > max) {
        return { error: `${field} doit être compris entre ${min} et ${max}.${hint ? ` ${hint}` : ''}` };
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
 * Valide et normalise le corps d'un enregistrement de configuration.
 * @returns {{ error: string }|{ data: object }}
 */
function parseConfigPayload(body) {
    if (!body || typeof body !== 'object') return { error: 'Requête vide.' };

    const joinCount = readInt(body.join_count, {
        field: 'Le nombre d\'arrivées', min: LIMITS.MIN_JOIN_COUNT, max: LIMITS.MAX_JOIN_COUNT,
        hint: 'À une seule arrivée, la règle ne décrirait plus une vague mais chaque personne qui rejoint.',
    });
    if (joinCount.error) return { error: joinCount.error };

    const windowSeconds = readInt(body.join_window_seconds, {
        field: 'La fenêtre de détection', min: LIMITS.MIN_WINDOW_SECONDS, max: LIMITS.MAX_WINDOW_SECONDS,
        hint: 'En dessous de quelques secondes, la fenêtre est plus courte que le délai de propagation des événements Discord.',
    });
    if (windowSeconds.error) return { error: windowSeconds.error };

    const accountAge = readInt(body.min_account_age_hours, {
        field: 'L\'âge de compte minimum', min: LIMITS.MIN_ACCOUNT_AGE_HOURS, max: LIMITS.MAX_ACCOUNT_AGE_HOURS,
        hint: '0 désactive ce contrôle.',
    });
    if (accountAge.error) return { error: accountAge.error };

    const panicSeconds = readInt(body.panic_duration_seconds, {
        field: 'La durée du mode panique', min: LIMITS.MIN_PANIC_SECONDS, max: LIMITS.MAX_PANIC_SECONDS,
        hint: 'Discord plafonne la mise en pause des invitations à 24 heures. 0 désactive le mode panique.',
    });
    if (panicSeconds.error) return { error: panicSeconds.error };

    // Chaîne vide = mode « alerte seule », une configuration valide, volontaire,
    // et recommandée pour démarrer : la vague est journalisée sans que personne
    // ne soit sanctionné.
    const punishments = String(body.punishments ?? '').trim();
    if (punishments.length > LIMITS.MAX_PUNISHMENTS_LENGTH) {
        return { error: `La liste de sanctions dépasse ${LIMITS.MAX_PUNISHMENTS_LENGTH} caractères.` };
    }
    const check = validatePunishments(punishments);
    if (!check.valid) return { error: check.errors.join(' ') };

    const logChannel = readOptionalChannelId(body.log_channel, 'Le salon des journaux');
    if (logChannel.error) return { error: logChannel.error };

    const responseMessage = String(body.response_message ?? '').trim();
    if (responseMessage.length > LIMITS.MAX_RESPONSE_MESSAGE) {
        return { error: `Le message envoyé à la personne dépasse ${LIMITS.MAX_RESPONSE_MESSAGE} caractères (${responseMessage.length}).` };
    }

    return {
        data: {
            enabled: !!body.enabled,
            joinCount: joinCount.value,
            windowSeconds: windowSeconds.value,
            accountAgeHours: accountAge.value,
            panicSeconds: panicSeconds.value,
            punishments,
            logChannel: logChannel.value,
            responseMessage: responseMessage || null,
        },
    };
}

// ─── Vue renvoyée au dashboard ──────────────────────────────────────────────

// Défauts du schéma (cf. api/services/database.js). Un serveur qui n'a jamais
// ouvert cet onglet n'a pas de ligne : le formulaire doit tout de même
// s'afficher, avec les valeurs qui seront écrites au premier enregistrement.
const DEFAULT_ROW = Object.freeze({
    enabled: 0,
    join_count: 10,
    join_window_seconds: 60,
    min_account_age_hours: 0,
    punishments: '',
    panic_duration_seconds: 300,
    log_channel: null,
    response_message: null,
});

function readRow(guildId) {
    return getDb().prepare('SELECT * FROM antiraid_config WHERE guild_id = ?').get(guildId) || null;
}

function buildState(guildId) {
    const row = readRow(guildId);
    const source = row || DEFAULT_ROW;
    // `normalize` porte le verdict d'exploitabilité du bot. On le rejoue ici
    // plutôt que de le réécrire : une base éditée à la main doit produire le
    // même diagnostic dans l'interface et dans le module.
    const verdict = normalize(source);

    return {
        configured: !!row,
        config: {
            enabled: !!source.enabled,
            join_count: source.join_count,
            join_window_seconds: source.join_window_seconds,
            min_account_age_hours: source.min_account_age_hours,
            punishments: source.punishments || '',
            panic_duration_seconds: source.panic_duration_seconds,
            log_channel: source.log_channel || null,
            response_message: source.response_message || null,
        },
        // Réglages illisibles relevés en base : le formulaire doit pouvoir dire
        // « je n'applique rien tant que ce n'est pas corrigé », plutôt que de
        // laisser croire à une protection active.
        problems: verdict?.problems || [],
        panic: antiraid.getPanicState(guildId),
        catalog: buildCatalog(),
    };
}

// ─── Accès au serveur Discord ───────────────────────────────────────────────

/**
 * Serveur Discord vu par le bot, ou la raison lisible pour laquelle il ne l'est
 * pas. Le mode panique agit sur Discord : sans client, il n'y a rien à faire.
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

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET / — état complet du module pour ce serveur.
// Lecture en base uniquement : aucun appel à Discord.
router.get('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    res.json(buildState(req.params.guildId));
}));

// PUT / — enregistre la configuration.
router.put('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;

    const parsed = parseConfigPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { data } = parsed;

    getDb().prepare(`
        INSERT INTO antiraid_config
            (guild_id, enabled, join_count, join_window_seconds, min_account_age_hours,
             punishments, panic_duration_seconds, log_channel, response_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            enabled = excluded.enabled,
            join_count = excluded.join_count,
            join_window_seconds = excluded.join_window_seconds,
            min_account_age_hours = excluded.min_account_age_hours,
            punishments = excluded.punishments,
            panic_duration_seconds = excluded.panic_duration_seconds,
            log_channel = excluded.log_channel,
            response_message = excluded.response_message,
            updated_at = unixepoch()
    `).run(
        guildId, data.enabled ? 1 : 0, data.joinCount, data.windowSeconds, data.accountAgeHours,
        data.punishments, data.panicSeconds, data.logChannel, data.responseMessage
    );

    // Le bot met la configuration en cache pour ne pas relire la base à chaque
    // arrivée : sans cette invalidation, une personne qui règle son anti-raid et
    // teste dans la foulée verrait encore l'ancien réglage s'appliquer.
    antiraid.invalidateConfig(guildId);

    res.json({ success: true, ...buildState(guildId) });
}));

// POST /panic — bascule le serveur en mode panique, à la demande.
// La durée du corps est optionnelle : sans elle, celle de la configuration.
router.post('/panic', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const stored = readRow(guildId) || DEFAULT_ROW;
    let seconds = stored.panic_duration_seconds;

    if (req.body?.duration_seconds !== undefined) {
        const asked = readInt(req.body.duration_seconds, {
            field: 'La durée du mode panique',
            // Une pose manuelle à 0 seconde n'a pas de sens : c'est une demande
            // d'action, pas un réglage. La borne basse est donc 1, pas 0.
            min: 1, max: LIMITS.MAX_PANIC_SECONDS,
            hint: 'Discord plafonne la mise en pause des invitations à 24 heures.',
        });
        if (asked.error) return res.status(400).json({ error: asked.error });
        seconds = asked.value;
    }

    if (!seconds) {
        return res.status(400).json({
            error: 'Le mode panique est désactivé sur ce serveur (durée réglée à 0).',
            hint: 'Indiquez une durée supérieure à 0 dans les réglages, ou précisez-en une pour cette activation.',
        });
    }

    const result = await antiraid.enterPanic(guild, {
        durationSeconds: seconds,
        reason: 'Mode panique activé depuis le tableau de bord',
        triggeredBy: req.user?.id || null,
        logChannelId: stored.log_channel || null,
    });

    if (!result.ok) {
        return res.status(result.error ? 502 : 400).json({
            error: result.error || 'Le mode panique n\'a pas pu être activé.',
        });
    }

    res.json({ success: true, panic: antiraid.getPanicState(guildId) });
}));

// DELETE /panic — levée manuelle, sans attendre l'échéance.
router.delete('/panic', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;
    const { guild, error } = resolveGuild(req);
    if (error) return res.status(error.status).json(error.body);

    const result = await antiraid.liftPanic(guild, {
        liftedBy: req.user?.id || null,
        logChannelId: (readRow(guildId) || DEFAULT_ROW).log_channel || null,
    });

    if (!result.ok && result.skipped === 'not_active') {
        return res.status(409).json({ error: 'Aucun mode panique n\'est en cours sur ce serveur.' });
    }
    if (!result.ok) {
        return res.status(502).json({
            error: result.error || 'Le mode panique n\'a pas pu être levé.',
            hint: 'Vérifiez que Quasar a bien la permission « Gérer le serveur », puis réessayez.',
        });
    }

    res.json({ success: true, panic: antiraid.getPanicState(guildId) });
}));

module.exports = router;
