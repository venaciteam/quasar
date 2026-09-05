// ═══════════════════════════════════════════════════════════════
//  Salon d'arbitrage — configuration et suivi des cas
//
//  L'arbitrage lui-même se fait dans Discord (boutons du salon) : cette API ne
//  sert qu'à désigner le salon et à consulter l'historique des cas depuis le
//  dashboard. Aucune route ne résout un cas — sinon deux chemins de résolution
//  coexisteraient, avec deux endroits où oublier la protection contre la double
//  application.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{17,20}$/;
const VALID_STATUSES = ['pending', 'approved', 'rejected'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// GET /api/guilds/:guildId/defer — configuration du salon d'arbitrage
router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const row = getDb().prepare('SELECT * FROM defer_config WHERE guild_id = ?').get(req.params.guildId);
    // Absence de ligne = arbitrage jamais configuré : on renvoie l'état par
    // défaut plutôt qu'un 404, le dashboard affiche un formulaire vide.
    res.json({
        channel_id: row?.channel_id || null,
        enabled: !!row?.enabled,
    });
});

// PUT /api/guilds/:guildId/defer
router.put('/', requireAuth, requireGuildAdmin, (req, res) => {
    const enabled = req.body?.enabled ? 1 : 0;
    const rawChannel = req.body?.channel_id;
    let channelId = null;

    if (rawChannel !== null && rawChannel !== undefined && rawChannel !== '') {
        channelId = String(rawChannel);
        if (!SNOWFLAKE.test(channelId)) {
            return res.status(400).json({ error: 'Identifiant de salon invalide.' });
        }
    }

    // Activer sans salon donnerait une protection qui échoue en silence à chaque
    // cas : le refus est explicite.
    if (enabled && !channelId) {
        return res.status(400).json({ error: 'Choisissez un salon avant d\'activer l\'arbitrage.' });
    }

    getDb().prepare(`
        INSERT INTO defer_config (guild_id, channel_id, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            enabled = excluded.enabled,
            updated_at = unixepoch()
    `).run(req.params.guildId, channelId, enabled);

    res.json({ success: true });
});

// GET /api/guilds/:guildId/defer/cases?status=pending&limit=50
router.get('/cases', requireAuth, requireGuildAdmin, (req, res) => {
    const params = [req.params.guildId];
    let query = 'SELECT * FROM defer_cases WHERE guild_id = ?';

    const status = req.query.status;
    if (status) {
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Statut inconnu.' });
        }
        query += ' AND status = ?';
        params.push(status);
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    query += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    res.json(getDb().prepare(query).all(...params));
});

module.exports = router;
