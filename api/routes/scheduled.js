const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { computeNextRun, getGuildTimezone } = require('../../bot/modules/scheduler');

const router = express.Router({ mergeParams: true });

const VALID_TYPES = ['once', 'daily', 'weekly', 'monthly'];
const SNOWFLAKE = /^\d{17,20}$/;
const HHMM = /^\d{2}:\d{2}$/;
const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

function safeJson(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

function parseAndValidate(body) {
    const errors = [];
    const out = {};

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        errors.push('name requis');
    } else {
        out.name = body.name.trim().slice(0, 80);
    }

    if (!body.channel_id || !SNOWFLAKE.test(String(body.channel_id))) {
        errors.push('channel_id invalide');
    } else {
        out.channel_id = String(body.channel_id);
    }

    if (body.content_type !== 'text' && body.content_type !== 'embed') {
        errors.push('content_type doit être text ou embed');
    } else {
        out.content_type = body.content_type;
    }

    if (out.content_type === 'text') {
        if (typeof body.content_text !== 'string' || !body.content_text.trim()) {
            errors.push('content_text requis');
        } else {
            out.content_text = body.content_text.slice(0, 2000);
        }
        out.embed_id = null;
    } else if (out.content_type === 'embed') {
        const eid = Number(body.embed_id);
        if (!Number.isInteger(eid) || eid <= 0) errors.push('embed_id requis');
        else out.embed_id = eid;
        out.content_text = null;
    }

    out.mention_roles = JSON.stringify(
        Array.isArray(body.mention_roles)
            ? body.mention_roles.map(String).filter(r => SNOWFLAKE.test(r))
            : []
    );
    out.mention_users = JSON.stringify(
        Array.isArray(body.mention_users)
            ? body.mention_users.map(String).filter(u => SNOWFLAKE.test(u))
            : []
    );
    out.mention_everyone = body.mention_everyone ? 1 : 0;
    out.mention_here = body.mention_here ? 1 : 0;

    if (!VALID_TYPES.includes(body.schedule_type)) {
        errors.push('schedule_type invalide');
    } else {
        out.schedule_type = body.schedule_type;
    }

    if (!body.schedule_time || !HHMM.test(body.schedule_time)) {
        errors.push('schedule_time invalide (HH:MM)');
    } else {
        const [h, m] = body.schedule_time.split(':').map(Number);
        if (h < 0 || h > 23 || m < 0 || m > 59) errors.push('schedule_time hors plage');
        else out.schedule_time = body.schedule_time;
    }

    if (out.schedule_type === 'once') {
        if (!body.schedule_date || !YYYYMMDD.test(body.schedule_date)) {
            errors.push('schedule_date requis pour once (YYYY-MM-DD)');
        } else {
            out.schedule_date = body.schedule_date;
        }
        out.schedule_day = null;
    } else if (out.schedule_type === 'weekly') {
        const d = Number(body.schedule_day);
        if (!Number.isInteger(d) || d < 0 || d > 6) errors.push('schedule_day invalide (0-6)');
        else out.schedule_day = d;
        out.schedule_date = null;
    } else if (out.schedule_type === 'monthly') {
        const d = Number(body.schedule_day);
        if (!Number.isInteger(d) || d < 1 || d > 31) errors.push('schedule_day invalide (1-31)');
        else out.schedule_day = d;
        out.schedule_date = null;
    } else {
        out.schedule_day = null;
        out.schedule_date = null;
    }

    out.enabled = body.enabled === false ? 0 : 1;

    return { errors, data: out };
}

function serialize(row) {
    return {
        ...row,
        mention_roles: safeJson(row.mention_roles, []),
        mention_users: safeJson(row.mention_users, []),
        mention_everyone: !!row.mention_everyone,
        mention_here: !!row.mention_here,
        enabled: !!row.enabled
    };
}

// GET /api/guilds/:guildId/scheduled
router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    // NULLS LAST émulé : IS NULL renvoie 1 (true) si NULL → trie après les non-NULL
    const rows = db.prepare(`
        SELECT * FROM scheduled_messages
        WHERE guild_id = ?
        ORDER BY enabled DESC, next_run IS NULL, next_run ASC
    `).all(req.params.guildId);
    res.json(rows.map(serialize));
});

// POST /api/guilds/:guildId/scheduled
router.post('/', requireAuth, requireGuildAdmin, (req, res) => {
    const { errors, data } = parseAndValidate(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const db = getDb();
    if (data.content_type === 'embed') {
        const exists = db.prepare('SELECT 1 FROM embeds WHERE id = ? AND guild_id = ?')
            .get(data.embed_id, req.params.guildId);
        if (!exists) return res.status(400).json({ error: 'embed inexistant pour ce serveur' });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tz = getGuildTimezone(req.params.guildId);
    const next = computeNextRun(data, Date.now(), tz);

    const result = db.prepare(`
        INSERT INTO scheduled_messages
        (guild_id, name, channel_id, content_type, content_text, embed_id,
         mention_roles, mention_users, mention_everyone, mention_here,
         schedule_type, schedule_time, schedule_day, schedule_date,
         next_run, enabled, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        req.params.guildId, data.name, data.channel_id, data.content_type, data.content_text, data.embed_id,
        data.mention_roles, data.mention_users, data.mention_everyone, data.mention_here,
        data.schedule_type, data.schedule_time, data.schedule_day, data.schedule_date,
        next ? Math.floor(next / 1000) : null, data.enabled, nowSec, nowSec, req.user?.id || null
    );

    res.json({
        success: true,
        id: result.lastInsertRowid,
        next_run: next ? Math.floor(next / 1000) : null
    });
});

// PUT /api/guilds/:guildId/scheduled/:id
router.put('/:id', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM scheduled_messages WHERE id = ? AND guild_id = ?')
        .get(id, req.params.guildId);
    if (!existing) return res.status(404).json({ error: 'introuvable' });

    const { errors, data } = parseAndValidate(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    if (data.content_type === 'embed') {
        const exists = db.prepare('SELECT 1 FROM embeds WHERE id = ? AND guild_id = ?')
            .get(data.embed_id, req.params.guildId);
        if (!exists) return res.status(400).json({ error: 'embed inexistant pour ce serveur' });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const tz = getGuildTimezone(req.params.guildId);
    const next = computeNextRun(data, Date.now(), tz);

    db.prepare(`
        UPDATE scheduled_messages SET
            name = ?, channel_id = ?, content_type = ?, content_text = ?, embed_id = ?,
            mention_roles = ?, mention_users = ?, mention_everyone = ?, mention_here = ?,
            schedule_type = ?, schedule_time = ?, schedule_day = ?, schedule_date = ?,
            next_run = ?, enabled = ?, updated_at = ?
        WHERE id = ? AND guild_id = ?
    `).run(
        data.name, data.channel_id, data.content_type, data.content_text, data.embed_id,
        data.mention_roles, data.mention_users, data.mention_everyone, data.mention_here,
        data.schedule_type, data.schedule_time, data.schedule_day, data.schedule_date,
        next ? Math.floor(next / 1000) : null, data.enabled, nowSec,
        id, req.params.guildId
    );

    res.json({ success: true, next_run: next ? Math.floor(next / 1000) : null });
});

// POST /api/guilds/:guildId/scheduled/:id/toggle
router.post('/:id/toggle', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND guild_id = ?')
        .get(id, req.params.guildId);
    if (!row) return res.status(404).json({ error: 'introuvable' });

    const newEnabled = row.enabled ? 0 : 1;
    const nowSec = Math.floor(Date.now() / 1000);
    let nextSec = null;
    if (newEnabled) {
        const tz = getGuildTimezone(req.params.guildId);
        const next = computeNextRun(row, Date.now(), tz);
        nextSec = next ? Math.floor(next / 1000) : null;
    }
    db.prepare('UPDATE scheduled_messages SET enabled = ?, next_run = ?, updated_at = ? WHERE id = ?')
        .run(newEnabled, nextSec, nowSec, id);
    res.json({ success: true, enabled: !!newEnabled, next_run: nextSec });
});

// DELETE /api/guilds/:guildId/scheduled/:id
router.delete('/:id', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND guild_id = ?')
        .run(req.params.id, req.params.guildId);
    res.json({ success: true });
});

module.exports = router;
