const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const {
    normalizeRetentionMonths,
    DEFAULT_RETENTION_MONTHS,
} = require('../../bot/modules/retention/sanctions');
const router = express.Router({ mergeParams: true });

// GET config modération
router.get('/config', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const mod = db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = ?')
        .get(req.params.guildId, 'moderation');
    let config = {};
    try { config = mod ? JSON.parse(mod.config || '{}') : {}; } catch { config = {}; }
    // Exposer la valeur effective, pas l'absence de réglage : le dashboard doit
    // afficher la durée réellement appliquée.
    config.sanctionRetentionMonths = 'sanctionRetentionMonths' in config
        ? normalizeRetentionMonths(config.sanctionRetentionMonths)
        : DEFAULT_RETENTION_MONTHS;
    res.json(config);
});

// PUT config modération
router.put('/config', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();

    // La durée de conservation des sanctions commande une suppression définitive
    // de données : elle est normalisée ici plutôt que d'être écrite telle quelle.
    const body = { ...req.body };
    if ('sanctionRetentionMonths' in body) {
        body.sanctionRetentionMonths = normalizeRetentionMonths(body.sanctionRetentionMonths);
    }

    const config = JSON.stringify(body);
    db.prepare(`
        INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
        ON CONFLICT(guild_id, module_name) DO UPDATE SET config = ?, enabled = 1
    `).run(req.params.guildId, config, config);
    res.json({ success: true });
});

// GET sanctions
router.get('/sanctions', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const { user, type, limit = 50 } = req.query;
    let query = 'SELECT * FROM sanctions WHERE guild_id = ?';
    const params = [req.params.guildId];
    if (user) { query += ' AND user_id = ?'; params.push(user); }
    if (type) { query += ' AND type = ?'; params.push(type); }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(Math.max(parseInt(limit) || 50, 1), 1000));
    res.json(db.prepare(query).all(...params));
});

// GET log categories (pour le dashboard)
router.get('/log-categories', requireAuth, requireGuildAdmin, (req, res) => {
    const { LOG_CATEGORIES } = require('../../bot/utils/logger');
    res.json(LOG_CATEGORIES);
});

module.exports = router;
