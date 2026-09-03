// ═══════════════════════════════════════════════════════════════
//  Quasar — Garde-fous de l'ouverture (sous-lot E)
//  Routeur owner-only, monté sur /api/owner par l'intégration.
//
//  L'instance est ouverte à tout admin (pas d'invitation). Deux garde-fous,
//  réservés à la propriétaire (BOT_OWNER_ID), compensent cette ouverture :
//    1. Coupure ciblée : suspendre/réactiver un serveur (drapeau réversible,
//       aucune donnée supprimée, le bot reste). L'enforcement effectif est
//       câblé ailleurs via bot/utils/suspension.js — ici on ne fait que
//       basculer le drapeau `guilds.suspended`.
//    2. Compteur de serveurs connectés + seuil de vigilance, pour repérer un
//       changement d'échelle du traitement.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { getDb } = require('../services/database');
const router = express.Router();

// Ligne technique de la table `guilds` (héritée de la migration atom→quasar) :
// ce n'est pas un serveur Discord, elle ne doit jamais compter dans le total.
const INSTANCE_ROW_ID = '__quasar_instance_id';

// Seuil de vigilance : au-delà, réévaluer l'échelle du traitement (cf. DA,
// « quelques dizaines de serveurs »). Purement indicatif — ne bloque rien.
const VIGILANCE_THRESHOLD = 30;

// Longueur max d'un motif de suspension (garde-fou anti-abus, pas juridique).
const MAX_REASON_LENGTH = 500;

// Tout /api/owner/* est strictement réservé au propriétaire du bot.
router.use(requireAuth, requireOwner);

// Construit la vue « serveurs connectés » + le compteur.
// Source de vérité des serveurs connectés : le cache du client Discord. On y
// greffe le statut de suspension lu en base. La ligne `__quasar_instance_id`
// n'est jamais dans le cache Discord, donc naturellement exclue du compte ;
// on l'exclut aussi explicitement du repli base, par sécurité.
function buildGuildList(req) {
    const db = getDb();
    const client = req.app.get('discordClient');

    // Statuts de suspension (+ noms) connus en base, indexés par guild_id.
    // Try/catch : les colonnes suspended* peuvent manquer avant la migration lot2
    // (dégradation gracieuse) — on retombe alors sur le nom seul.
    const dbRows = new Map();
    try {
        const rows = db.prepare(
            'SELECT guild_id, name, suspended, suspended_at, suspended_reason FROM guilds'
        ).all();
        for (const r of rows) {
            if (r.guild_id === INSTANCE_ROW_ID) continue;
            dbRows.set(r.guild_id, r);
        }
    } catch {
        try {
            const rows = db.prepare('SELECT guild_id, name FROM guilds').all();
            for (const r of rows) {
                if (r.guild_id === INSTANCE_ROW_ID) continue;
                dbRows.set(r.guild_id, r);
            }
        } catch { /* table absente au tout premier boot */ }
    }

    let servers;
    if (client?.guilds?.cache) {
        // Cas nominal : on liste les serveurs réellement connectés.
        servers = [...client.guilds.cache.values()].map(g => {
            const s = dbRows.get(g.id) || {};
            return {
                id: g.id,
                name: g.name,
                memberCount: g.memberCount,
                suspended: !!s.suspended,
                suspended_at: s.suspended_at || null,
                suspended_reason: s.suspended_reason || null,
            };
        });
    } else {
        // Repli si le client Discord n'est pas prêt : liste depuis la base, sans
        // memberCount. Permet à l'UI owner de rester fonctionnelle (suspendre /
        // réactiver) même pendant une brève indisponibilité du client.
        servers = [...dbRows.values()].map(r => ({
            id: r.guild_id,
            name: r.name || r.guild_id,
            memberCount: undefined,
            suspended: !!r.suspended,
            suspended_at: r.suspended_at || null,
            suspended_reason: r.suspended_reason || null,
        }));
    }

    servers.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr'));

    const serverCount = servers.length;
    return {
        servers,
        serverCount,
        vigilanceThreshold: VIGILANCE_THRESHOLD,
        warn: serverCount >= VIGILANCE_THRESHOLD,
    };
}

// GET /api/owner/guilds — liste des serveurs connectés + compteur + seuil.
router.get('/guilds', (req, res) => {
    try {
        res.json(buildGuildList(req));
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/owner/guilds:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// GET /api/owner/stats — projection du compteur seul (affichage léger).
router.get('/stats', (req, res) => {
    try {
        const { serverCount, vigilanceThreshold, warn } = buildGuildList(req);
        res.json({ serverCount, vigilanceThreshold, warn });
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/owner/stats:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/owner/guilds/:guildId/suspend { reason } — coupure ciblée.
// Motif OBLIGATOIRE (traçabilité). Ne supprime rien, ne retire pas le bot.
router.post('/guilds/:guildId/suspend', (req, res) => {
    try {
        const guildId = req.params.guildId;
        const reason = (req.body?.reason || '').trim();

        if (!reason) {
            return res.status(400).json({ error: 'Un motif de suspension est requis.' });
        }
        if (reason.length > MAX_REASON_LENGTH) {
            return res.status(400).json({
                error: `Le motif ne peut pas dépasser ${MAX_REASON_LENGTH} caractères.`,
            });
        }

        const db = getDb();
        const now = Math.floor(Date.now() / 1000); // unixepoch (s), cf. Conventions DA

        // Garantir l'existence de la ligne (normalement créée au guildCreate).
        // Évite qu'une course fasse échouer l'UPDATE sur un serveur pourtant connu.
        // On récupère le nom depuis le cache si disponible.
        const cached = req.app.get('discordClient')?.guilds?.cache?.get(guildId);
        db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)')
            .run(guildId, cached?.name || null);

        db.prepare(
            'UPDATE guilds SET suspended = 1, suspended_at = ?, suspended_reason = ? WHERE guild_id = ?'
        ).run(now, reason, guildId);

        console.log(`[Quasar] Serveur ${guildId} suspendu par ${req.user.username} — motif : ${reason}`);
        res.json({ id: guildId, suspended: true, suspended_at: now, suspended_reason: reason });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/owner/guilds/:guildId/suspend:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/owner/guilds/:guildId/unsuspend — lève la coupure (réversible).
router.post('/guilds/:guildId/unsuspend', (req, res) => {
    try {
        const guildId = req.params.guildId;
        const db = getDb();

        const result = db.prepare(
            'UPDATE guilds SET suspended = 0, suspended_at = NULL, suspended_reason = NULL WHERE guild_id = ?'
        ).run(guildId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Serveur introuvable.' });
        }

        console.log(`[Quasar] Serveur ${guildId} réactivé par ${req.user.username}`);
        res.json({ id: guildId, suspended: false, suspended_at: null, suspended_reason: null });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/owner/guilds/:guildId/unsuspend:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

module.exports = router;
