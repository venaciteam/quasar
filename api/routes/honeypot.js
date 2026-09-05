// ═══════════════════════════════════════════════════════════════
//  Salon piège (honeypot) — configuration
//
//  Une ligne par serveur (`honeypot_config`) : le salon surveillé, les sanctions
//  composables, la portée par rôle, le salon des journaux et le message envoyé à
//  la personne. Ce routeur valide et écrit ; ce qui décide du comportement du bot
//  vit dans bot/events/messageCreate.js, et c'est de là que viennent aussi les
//  bornes de saisie et le diagnostic d'une configuration illisible. Les rejouer
//  ici plutôt que de les réécrire garantit que l'interface dise exactement ce que
//  le bot fait — un formulaire qui affiche « tout va bien » sur une configuration
//  que le bot refuse d'appliquer est pire qu'un formulaire absent.
//
//  ─── Ce qui est exposé, et ce qui ne l'est pas ───
//  `honeypot_config` porte les six colonnes de portée communes à la modération
//  automatique. Deux d'entre elles n'ont AUCUN SENS ici et ne sont ni affichées
//  ni conservées : `affected_channels` / `ignored_channels` désigneraient des
//  salons, alors que le salon surveillé est déjà `channel_id`. Elles sont donc
//  remises à '[]' à chaque enregistrement — ce qu'aucune interface ne peut
//  montrer ne doit pas pouvoir changer le comportement en silence.
//
//  Les rôles, eux, sont pleinement exposés : contrairement à l'anti-raid (une
//  personne qui vient d'arriver n'a aucun rôle) et à l'AutoMod natif (l'API de
//  Discord ne connaît que les exemptions), ce module a un membre sous les yeux
//  avec ses rôles. Les deux directions sont réellement évaluées par
//  bot/utils/scopeFilter.js.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { validatePunishments, parsePunishments, ACTION_NAMES } = require('../../bot/utils/punishments');
// Le module du salon piège est un écouteur d'événement : sa configuration vit à
// côté de son unique consommateur, dans bot/events/messageCreate.js.
const honeypot = require('../../bot/events/messageCreate');

const { LIMITS, normalize, invalidateConfig } = honeypot;

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
        console.error('[Quasar Honeypot] Erreur inattendue :', err);
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
// message » a ici un sens qu'il n'a ni dans l'escalade ni dans l'anti-raid.

const ACTION_HELP = {
    delete: { label: 'Supprimer le message', duration: false, summary: 'Retire du salon piège le message qui a déclenché la règle.' },
    warn: { label: 'Ajouter un avertissement', duration: false, summary: 'Trace le passage dans l\'historique, sans rien empêcher. Compte aussi pour l\'escalade des avertissements.' },
    timeout: { label: 'Exclure temporairement', duration: true, summary: 'Exclusion native de Discord. Laisse le temps de vérifier avant de trancher.' },
    tempmute: { label: 'Rendre muet un moment', duration: true, summary: 'Identique à l\'exclusion temporaire de Discord.' },
    mute: { label: 'Rendre muet', duration: false, summary: 'Exclusion au maximum autorisé par Discord (28 jours).' },
    kick: { label: 'Expulser', duration: false, summary: 'La personne peut revenir dès qu\'elle a une invitation.' },
    tempban: { label: 'Bannir un moment', duration: true, summary: 'Bloque le compte et se lève tout seul : le choix le plus sûr sur un piège que personne n\'a encore éprouvé.' },
    ban: { label: 'Bannir', duration: false, summary: 'Définitif tant que le bannissement n\'est pas levé à la main.' },
    dm: { label: 'Prévenir en message privé', duration: false, summary: 'Utilise le message de ce serveur. Sans effet si la personne ferme ses messages privés.' },
    defer: { label: 'Demander un arbitrage', duration: false, summary: 'Rien n\'est appliqué : le cas part dans le salon d\'arbitrage, avec un lien vers le message.' },
};

function buildCatalog() {
    return {
        actions: ACTION_NAMES.map(name => ({
            key: name,
            label: ACTION_HELP[name]?.label || name,
            duration: !!ACTION_HELP[name]?.duration,
            summary: ACTION_HELP[name]?.summary || '',
        })),
        limits: { ...LIMITS },
    };
}

// ─── Lecture et validation des entrées ──────────────────────────────────────
//
// Tout est revalidé ici, jamais seulement dans le navigateur : le dashboard
// n'est qu'un client parmi d'autres du point de vue de cette API.

function readOptionalChannelId(raw, field) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const id = String(raw).trim();
    if (!SNOWFLAKE.test(id)) return { error: `${field} : identifiant de salon invalide.` };
    return { value: id };
}

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
    if (value.length > LIMITS.MAX_SCOPE_ENTRIES) {
        return { error: `${field} : ${LIMITS.MAX_SCOPE_ENTRIES} au maximum (${value.length} reçus).` };
    }
    return { value };
}

/**
 * Valide et normalise le corps d'un enregistrement.
 * @returns {{ error: string }|{ data: object }}
 */
function parseConfigPayload(body) {
    if (!body || typeof body !== 'object') return { error: 'Requête vide.' };

    const channel = readOptionalChannelId(body.channel_id, 'Le salon piège');
    if (channel.error) return { error: channel.error };

    const enabled = !!body.enabled;
    // Activer sans salon donnerait une protection qui ne surveille rien, sans le
    // dire. Le refus est explicite, comme pour le salon d'arbitrage.
    if (enabled && !channel.value) {
        return { error: 'Choisissez un salon piège avant d\'activer la surveillance.' };
    }

    // Chaîne vide = mode « alerte seule », une configuration valide, volontaire,
    // et recommandée pour démarrer : le passage est journalisé sans que personne
    // ne soit sanctionné.
    const punishments = String(body.punishments ?? '').trim();
    if (punishments.length > LIMITS.MAX_PUNISHMENTS_LENGTH) {
        return { error: `La liste de sanctions dépasse ${LIMITS.MAX_PUNISHMENTS_LENGTH} caractères.` };
    }
    const check = validatePunishments(punishments);
    if (!check.valid) return { error: check.errors.join(' ') };

    const affectedRoles = readIdArray(body.affected_roles, 'Les rôles concernés');
    if (affectedRoles.error) return { error: affectedRoles.error };
    const ignoredRoles = readIdArray(body.ignored_roles, 'Les rôles exemptés');
    if (ignoredRoles.error) return { error: ignoredRoles.error };

    const logChannel = readOptionalChannelId(body.log_channel, 'Le salon des journaux');
    if (logChannel.error) return { error: logChannel.error };

    const responseMessage = String(body.response_message ?? '').trim();
    if (responseMessage.length > LIMITS.MAX_RESPONSE_MESSAGE) {
        return { error: `Le message envoyé à la personne dépasse ${LIMITS.MAX_RESPONSE_MESSAGE} caractères (${responseMessage.length}).` };
    }

    return {
        data: {
            enabled,
            channelId: channel.value,
            punishments,
            affectedRoles: affectedRoles.value,
            ignoredRoles: ignoredRoles.value,
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
    channel_id: null,
    enabled: 0,
    punishments: '',
    affected_roles: '[]',
    affected_channels: '[]',
    ignored_roles: '[]',
    ignored_channels: '[]',
    log_channel: null,
    response_message: null,
});

function readRow(guildId) {
    return getDb().prepare('SELECT * FROM honeypot_config WHERE guild_id = ?').get(guildId) || null;
}

/**
 * Vérifications qui ne dépendent pas de la base mais de l'état réel du serveur
 * Discord. Elles n'empêchent rien d'enregistrer — d'où `warnings` et non
 * `problems` — mais elles nomment les trois façons dont un piège correctement
 * configuré ne se déclenche jamais : le salon a été supprimé, je n'y vois pas
 * les messages, ou je n'ai pas le droit d'y supprimer quoi que ce soit.
 */
function buildWarnings(req, row) {
    const warnings = [];
    if (!row.channel_id) return warnings;

    const client = req.app.get('discordClient');
    const guild = client?.guilds?.cache?.get(req.params.guildId);
    if (!guild) {
        warnings.push('Je ne suis pas connecté à ce serveur pour le moment : je n\'ai pas pu vérifier que le salon piège existe toujours.');
        return warnings;
    }

    const channel = guild.channels.cache.get(String(row.channel_id));
    if (!channel) {
        warnings.push('Le salon piège configuré n\'existe plus sur ce serveur : rien n\'est surveillé tant qu\'un autre salon n\'est pas choisi.');
        return warnings;
    }

    const me = guild.members.me;
    const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(PermissionFlagsBits.ViewChannel)) {
        warnings.push(`Je ne vois pas le salon ${channel.name} : Discord ne m'envoie pas les messages d'un salon auquel je n'ai pas accès, le piège ne peut donc pas se déclencher.`);
    }

    const usesDelete = parsePunishments(row.punishments || '').punishments.some(p => p.action === 'delete');
    if (usesDelete && perms && !perms.has(PermissionFlagsBits.ManageMessages)) {
        warnings.push(`Vos sanctions comportent « ${ACTION_HELP.delete.label} », mais je n'ai pas la permission « Gérer les messages » dans ${channel.name} : cette action échouera.`);
    }

    return warnings;
}

function buildState(req) {
    const guildId = req.params.guildId;
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
            channel_id: source.channel_id || null,
            punishments: source.punishments || '',
            affected_roles: verdict?.affectedRoles || [],
            ignored_roles: verdict?.ignoredRoles || [],
            log_channel: source.log_channel || null,
            response_message: source.response_message || null,
        },
        // Réglages illisibles relevés en base : le formulaire doit pouvoir dire
        // « je n'applique rien tant que ce n'est pas corrigé », plutôt que de
        // laisser croire à une protection active.
        problems: verdict?.problems || [],
        warnings: buildWarnings(req, source),
        catalog: buildCatalog(),
    };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET / — état complet du module pour ce serveur.
router.get('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    res.json(buildState(req));
}));

// PUT / — enregistre la configuration.
router.put('/', requireAuth, requireGuildAdmin, guarded(async (req, res) => {
    const guildId = req.params.guildId;

    const parsed = parseConfigPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { data } = parsed;

    // Les deux colonnes de salons sont écrites explicitement à '[]' : elles ne
    // sont pas exposées, et une valeur héritée d'une édition manuelle bloquerait
    // silencieusement tout le module (scopeFilter évalue les quatre colonnes).
    getDb().prepare(`
        INSERT INTO honeypot_config
            (guild_id, channel_id, enabled, punishments,
             affected_roles, affected_channels, ignored_roles, ignored_channels,
             log_channel, response_message)
        VALUES (?, ?, ?, ?, ?, '[]', ?, '[]', ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            enabled = excluded.enabled,
            punishments = excluded.punishments,
            affected_roles = excluded.affected_roles,
            affected_channels = '[]',
            ignored_roles = excluded.ignored_roles,
            ignored_channels = '[]',
            log_channel = excluded.log_channel,
            response_message = excluded.response_message,
            updated_at = unixepoch()
    `).run(
        guildId, data.channelId, data.enabled ? 1 : 0, data.punishments,
        JSON.stringify(data.affectedRoles), JSON.stringify(data.ignoredRoles),
        data.logChannel, data.responseMessage
    );

    // Le bot garde les salons pièges en mémoire pour ne pas relire la base à
    // chaque message : sans cette invalidation, une personne qui désigne son
    // salon et le teste dans la foulée verrait encore l'ancien réglage.
    invalidateConfig();

    res.json({ success: true, ...buildState(req) });
}));

module.exports = router;
