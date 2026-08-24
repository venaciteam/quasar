const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { parseMentions, serializeMentions } = require('../services/mentions');
const router = express.Router({ mergeParams: true });

// Colonnes de mention, communes à tous les objets « pingables » (cf. services/mentions.js)
const MENTION_COLUMNS = 'mention_roles, mention_users, mention_everyone, mention_here';

router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const embeds = db.prepare(
        `SELECT id, name, data, ${MENTION_COLUMNS}, updated_at FROM embeds WHERE guild_id = ? ORDER BY updated_at DESC`
    ).all(req.params.guildId);
    res.json(embeds.map(e => {
        let data;
        try { data = JSON.parse(e.data); } catch { data = {}; }
        // Mentions renvoyées en types JS (arrays + booléens) pour le dashboard
        return { ...e, data, ...serializeMentions(e) };
    }));
});

router.post('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const { name, data } = req.body;
    if (!name || !data) return res.status(400).json({ error: 'name et data requis' });
    // Les mentions ne sont jamais stockées dans `data` : ce JSON n'est que le
    // contenu de l'embed. Elles ont leurs propres colonnes, validées ici.
    const mentions = parseMentions(req.body);
    const existing = db.prepare('SELECT id FROM embeds WHERE guild_id = ? AND name = ?').get(req.params.guildId, name);
    if (existing) {
        db.prepare(`UPDATE embeds SET data = ?, mention_roles = ?, mention_users = ?,
            mention_everyone = ?, mention_here = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(JSON.stringify(data), mentions.mention_roles, mentions.mention_users,
                mentions.mention_everyone, mentions.mention_here, existing.id);
        return res.json({ success: true, id: existing.id, updated: true });
    }
    const result = db.prepare(
        `INSERT INTO embeds (guild_id, name, data, ${MENTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(req.params.guildId, name, JSON.stringify(data),
        mentions.mention_roles, mentions.mention_users, mentions.mention_everyone, mentions.mention_here);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/:id', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM embeds WHERE id = ? AND guild_id = ?').run(req.params.id, req.params.guildId);
    res.json({ success: true });
});

module.exports = router;
