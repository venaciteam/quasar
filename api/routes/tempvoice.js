const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const plateforme = require('../services/plateforme');
const router = express.Router({ mergeParams: true });

/** Salon normalisé, ou `null`. Un échec de lecture vaut « supprimé ». */
function lireCanal(req, canalId) {
    const api = plateforme.api(req);
    if (!api || !canalId) return Promise.resolve(null);
    return api.obtenirCanal(String(canalId)).catch(() => null);
}

// GET /api/guilds/:guildId/tempvoice/triggers
router.get('/triggers', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const triggers = db.prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ?').all(guildId);

    const result = await Promise.all(triggers.map(async (t) => {
        const [ch, cat] = await Promise.all([
            lireCanal(req, t.channel_id),
            t.category_id ? lireCanal(req, t.category_id) : null,
        ]);
        return {
            channel_id: t.channel_id,
            channel_name: ch?.nom || '(supprimé)',
            category_id: t.category_id || '',
            category_name: cat?.nom || (t.category_id ? '(supprimé)' : 'Sans catégorie'),
            enabled: !!t.enabled
        };
    }));

    res.json(result);
});

// POST /api/guilds/:guildId/tempvoice/triggers
router.post('/triggers', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const { channel_id } = req.body;

    if (!channel_id) return res.status(400).json({ error: 'channel_id requis' });

    const channel = await lireCanal(req, channel_id);
    const categoryId = channel?.parentId || '';

    // Vérifier max 1 par catégorie
    const existing = db.prepare('SELECT channel_id FROM tempvoice_triggers WHERE guild_id = ? AND category_id = ?')
        .get(guildId, categoryId);

    if (existing && existing.channel_id !== channel_id) {
        return res.status(409).json({ error: 'Un trigger existe déjà dans cette catégorie.' });
    }

    db.prepare(`
        INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(guild_id, channel_id) DO UPDATE SET enabled = 1
    `).run(guildId, channel_id, categoryId);

    res.json({ success: true });
});

// DELETE /api/guilds/:guildId/tempvoice/triggers/:channelId
router.delete('/triggers/:channelId', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ?')
        .run(req.params.guildId, req.params.channelId);
    res.json({ success: true });
});

// PUT /api/guilds/:guildId/tempvoice/triggers/:channelId/toggle
router.put('/triggers/:channelId/toggle', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const { enabled } = req.body;
    db.prepare('UPDATE tempvoice_triggers SET enabled = ? WHERE guild_id = ? AND channel_id = ?')
        .run(enabled ? 1 : 0, req.params.guildId, req.params.channelId);
    res.json({ success: true });
});

// GET /api/guilds/:guildId/tempvoice/active
router.get('/active', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const active = db.prepare('SELECT * FROM tempvoice_active WHERE guild_id = ?').all(guildId);
    const api = plateforme.api(req);

    const result = await Promise.all(active.map(async (row) => {
        const [channel, owner, cat, occupants] = await Promise.all([
            lireCanal(req, row.channel_id),
            api ? api.obtenirMembre(guildId, row.owner_id).catch(() => null) : null,
            row.category_id ? lireCanal(req, row.category_id) : null,
            // `listerMembresVocal` rend `null` si le salon n'existe plus ou n'est
            // pas vocal : le compte retombe alors sur 0, comme le faisait
            // `channel?.members.size` sur un salon absent du cache.
            api ? api.listerMembresVocal(String(row.channel_id)).catch(() => null) : null,
        ]);
        return {
            channel_id: row.channel_id,
            channel_name: channel?.nom || '(supprimé)',
            owner_id: row.owner_id,
            owner_name: owner?.nom || owner?.etiquette || row.owner_id,
            member_count: occupants?.length || 0,
            category_name: cat?.nom || 'Sans catégorie',
            created_at: row.created_at
        };
    }));

    res.json(result);
});

// DELETE /api/guilds/:guildId/tempvoice/active/:channelId
router.delete('/active/:channelId', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { channelId } = req.params;

    const api = plateforme.api(req);
    const channel = await lireCanal(req, channelId);

    if (api && channel) {
        try { await api.supprimerCanal(String(channelId), 'Salon temporaire supprimé depuis le dashboard'); } catch (e) {
            console.error('[Quasar] Erreur suppression TempVoice:', e.message);
        }
    }

    // `AND guild_id = ?` obligatoire : `channel_id` est la clé primaire de la
    // table, donc sans cloisonnement, l'identifiant d'un salon d'un AUTRE serveur
    // supprimait sa ligne depuis n'importe quel serveur où l'appelant est admin.
    // Le reste du fichier scope déjà toutes ses requêtes sur guild_id ; celle-ci
    // était la seule à ne pas le faire.
    db.prepare('DELETE FROM tempvoice_active WHERE guild_id = ? AND channel_id = ?')
        .run(req.params.guildId, channelId);
    res.json({ success: true });
});

// GET /api/guilds/:guildId/tempvoice/stats
router.get('/stats', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;

    const activeCount = db.prepare('SELECT COUNT(*) as count FROM tempvoice_active WHERE guild_id = ?').get(guildId).count;
    const prefsCount = db.prepare('SELECT COUNT(*) as count FROM tempvoice_preferences WHERE guild_id = ?').get(guildId).count;
    const triggerCount = db.prepare('SELECT COUNT(*) as count FROM tempvoice_triggers WHERE guild_id = ?').get(guildId).count;

    res.json({ active: activeCount, preferences: prefsCount, triggers: triggerCount });
});

module.exports = router;
