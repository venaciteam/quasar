const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { isValidTimezone, DEFAULT_TIMEZONE } = require('../../bot/modules/scheduler');
const router = express.Router();

// Liste des serveurs où l'utilisateur est admin ET où Quasar est présent
router.get('/', requireAuth, (req, res) => {
    const db = getDb();
    const botGuilds = db.prepare('SELECT guild_id, name FROM guilds').all();
    const botGuildIds = new Set(botGuilds.map(g => g.guild_id));

    const userGuilds = req.user.guilds
        .filter(g => {
            const isAdmin = (BigInt(g.permissions) & BigInt(0x8)) === BigInt(0x8);
            return isAdmin && botGuildIds.has(g.id);
        })
        .map(g => ({
            id: g.id,
            name: g.name,
            icon: g.icon
        }));

    res.json(userGuilds);
});

// Config modules d'un serveur — détection intelligente
router.get('/:guildId/modules', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;

    // Une seule requête pour compter toutes les tables liées au guild
    const counts = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM sanctions WHERE guild_id = ?) as sanctions,
            (SELECT COUNT(*) FROM reaction_panels WHERE guild_id = ?) as panels,
            (SELECT COUNT(*) FROM autoroles WHERE guild_id = ?) as autoroles,
            (SELECT COUNT(*) FROM embeds WHERE guild_id = ?) as embeds,
            (SELECT COUNT(*) FROM custom_commands WHERE guild_id = ?) as cmds
    `).get(guildId, guildId, guildId, guildId, guildId);

    const modConfig = db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = ?').get(guildId, 'moderation');
    const welcomeConfig = db.prepare('SELECT welcome_enabled, leave_enabled FROM welcome_config WHERE guild_id = ?').get(guildId);

    let voiceRoleCount = 0;
    try { voiceRoleCount = db.prepare('SELECT COUNT(*) as c FROM voice_roles WHERE guild_id = ?').get(guildId)?.c || 0; } catch {} // Table may not exist yet
    let tvEnabled = false;
    try { tvEnabled = !!db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND enabled = 1').get(guildId); } catch {} // Table may not exist yet
    let ticketsEnabled = false;
    try { ticketsEnabled = !!db.prepare("SELECT enabled FROM ticket_config WHERE guild_id = ? AND enabled = 1").get(guildId); } catch {} // Table may not exist yet
    let scheduledEnabled = false;
    try { scheduledEnabled = !!db.prepare("SELECT 1 FROM scheduled_messages WHERE guild_id = ? AND enabled = 1").get(guildId); } catch {} // Table may not exist yet

    res.json({
        moderation: { enabled: !!(modConfig || counts.sanctions > 0) },
        welcome: { enabled: !!(welcomeConfig?.welcome_enabled || welcomeConfig?.leave_enabled) },
        reactionroles: { enabled: !!(counts.panels || counts.autoroles || voiceRoleCount) },
        embeds: { enabled: counts.embeds > 0 },
        customcmds: { enabled: counts.cmds > 0 },
        tempvoice: { enabled: tvEnabled },
        tickets: { enabled: ticketsEnabled },
        scheduled: { enabled: scheduledEnabled }
        // Musique désactivée — réactiver en décommentant (remettre la virgule ci-dessus)
        // music: { enabled: true }
    });
});

// Activer/désactiver un module
router.put('/:guildId/modules/:moduleName', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const { enabled, config } = req.body;

    db.prepare(`
        INSERT INTO modules (guild_id, module_name, enabled, config)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, module_name) 
        DO UPDATE SET enabled = ?, config = ?
    `).run(
        req.params.guildId,
        req.params.moduleName,
        enabled ? 1 : 0,
        JSON.stringify(config || {}),
        enabled ? 1 : 0,
        JSON.stringify(config || {})
    );

    res.json({ success: true });
});

// Liste des channels du serveur (pour les sélecteurs)
router.get('/:guildId/channels', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        // On utilise le client Discord pour récupérer les channels
        const guild = req.app.get('discordClient')?.guilds.cache.get(req.params.guildId);
        if (!guild) return res.json([]);

        const channels = guild.channels.cache
            .filter(c => c.type === 0 || c.type === 2 || c.type === 4 || c.type === 13) // Text + Voice + Category + Stage
            .map(c => ({ id: c.id, name: c.name, position: c.position, type: c.type }))
            .sort((a, b) => a.position - b.position);

        res.json(channels);
    } catch (error) {
        console.error('[Quasar] Erreur channels:', error);
        res.json([]);
    }
});

// Liste des rôles du serveur
router.get('/:guildId/roles', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const guild = req.app.get('discordClient')?.guilds.cache.get(req.params.guildId);
        if (!guild) return res.json([]);

        const roles = guild.roles.cache
            .filter(r => r.id !== guild.id && !r.managed) // Exclure @everyone et rôles bots
            .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position }))
            .sort((a, b) => b.position - a.position);

        res.json(roles);
    } catch (error) {
        console.error('[Quasar] Erreur rôles:', error);
        res.json([]);
    }
});

// Liste des emojis du serveur
router.get('/:guildId/emojis', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const guild = req.app.get('discordClient')?.guilds.cache.get(req.params.guildId);
        if (!guild) return res.json([]);

        const emojis = guild.emojis.cache.map(e => ({
            id: e.id,
            name: e.name,
            animated: e.animated,
            identifier: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
            url: e.imageURL({ size: 32 })
        }));

        res.json(emojis);
    } catch {
        res.json([]);
    }
});

// Settings d'un serveur (timezone, etc.)
router.get('/:guildId/settings', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT timezone FROM guilds WHERE guild_id = ?').get(req.params.guildId);
    res.json({
        timezone: row?.timezone || DEFAULT_TIMEZONE
    });
});

router.put('/:guildId/settings', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const updates = [];
    const values = [];

    if (typeof req.body.timezone === 'string') {
        if (!isValidTimezone(req.body.timezone)) {
            return res.status(400).json({ error: `Timezone IANA invalide : "${req.body.timezone}"` });
        }
        updates.push('timezone = ?');
        values.push(req.body.timezone);
    }

    if (!updates.length) {
        return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    }

    values.push(req.params.guildId);
    db.prepare(`UPDATE guilds SET ${updates.join(', ')} WHERE guild_id = ?`).run(...values);

    // Recalculer next_run de tous les rappels enabled du guild (la TZ a pu changer)
    if (req.body.timezone) {
        try {
            const { computeNextRun } = require('../../bot/modules/scheduler');
            const rows = db.prepare(
                'SELECT * FROM scheduled_messages WHERE guild_id = ? AND enabled = 1'
            ).all(req.params.guildId);
            const upd = db.prepare(
                'UPDATE scheduled_messages SET next_run = ?, updated_at = ? WHERE id = ?'
            );
            const nowSec = Math.floor(Date.now() / 1000);
            for (const row of rows) {
                const next = computeNextRun(row, Date.now(), req.body.timezone);
                upd.run(next ? Math.floor(next / 1000) : null, nowSec, row.id);
            }
        } catch (e) {
            console.error('[Quasar] Recalc next_run après changement TZ:', e.message);
        }
    }

    res.json({ success: true });
});

module.exports = router;
