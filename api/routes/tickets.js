const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const router = express.Router({ mergeParams: true });

const ACCENT_COLOR = 0xDE3163;

const DEFAULT_PANEL_TITLE = '🎫 Support — Ouvrir un ticket';
const DEFAULT_PANEL_DESC = 'Clique sur le bouton ci-dessous pour ouvrir un ticket.\nUn membre du staff te répondra dès que possible.';

function buildPanelEmbed(config) {
    return new EmbedBuilder()
        .setTitle(config?.panel_title || DEFAULT_PANEL_TITLE)
        .setDescription(config?.panel_description || DEFAULT_PANEL_DESC)
        .setColor(ACCENT_COLOR)
        .setTimestamp();
}

function buildPanelRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_open')
            .setLabel('Ouvrir un ticket')
            .setEmoji('🎫')
            .setStyle(ButtonStyle.Primary)
    );
}

// GET /api/guilds/:guildId/tickets — config tickets du serveur
router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(req.params.guildId);

    if (!config) {
        return res.json({ configured: false });
    }

    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(req.params.guildId);

    const channel = guild?.channels.cache.get(config.channel_id);
    const category = config.category_id ? guild?.channels.cache.get(config.category_id) : null;
    const role = guild?.roles.cache.get(config.staff_role_id);

    res.json({
        configured: true,
        channel_id: config.channel_id,
        channel_name: channel?.name || '(supprimé)',
        category_id: config.category_id || null,
        category_name: category?.name || null,
        staff_role_id: config.staff_role_id,
        staff_role_name: role?.name || '(supprimé)',
        welcome_message: config.welcome_message,
        panel_title: config.panel_title || '',
        panel_description: config.panel_description || '',
        enabled: !!config.enabled
    });
});

// POST /api/guilds/:guildId/tickets/setup — setup initial depuis le dashboard
router.post('/setup', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const { channel_id, staff_role_id, category_id, welcome_message, panel_title, panel_description } = req.body;

    if (!channel_id || !staff_role_id) {
        return res.status(400).json({ error: 'Le salon et le rôle staff sont requis.' });
    }

    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });

    const channel = guild.channels.cache.get(channel_id);
    if (!channel) return res.status(404).json({ error: 'Salon introuvable.' });

    // Sauvegarder la config
    db.prepare(`
        INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, panel_title, panel_description, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(guild_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            category_id = excluded.category_id,
            staff_role_id = excluded.staff_role_id,
            welcome_message = COALESCE(excluded.welcome_message, ticket_config.welcome_message),
            panel_title = excluded.panel_title,
            panel_description = excluded.panel_description,
            enabled = 1
    `).run(guildId, channel_id, category_id || null, staff_role_id, welcome_message || null, panel_title || null, panel_description || null);

    const configForEmbed = { panel_title, panel_description };

    // Envoyer l'embed avec le bouton dans le salon
    try {
        await channel.send({ embeds: [buildPanelEmbed(configForEmbed)], components: [buildPanelRow()] });
    } catch (err) {
        return res.status(500).json({ error: 'Impossible d\'envoyer le message dans le salon : ' + err.message });
    }

    res.json({ success: true });
});

// POST /api/guilds/:guildId/tickets/resend — renvoyer le message d'ouverture
router.post('/resend', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const { channel_id } = req.body;

    const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guildId);
    if (!config) return res.status(404).json({ error: 'Tickets non configurés.' });

    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Serveur introuvable.' });

    // Utiliser le channel_id fourni ou celui de la config
    const targetChannelId = channel_id || config.channel_id;
    const channel = guild.channels.cache.get(targetChannelId);
    if (!channel) return res.status(404).json({ error: 'Salon introuvable.' });

    // Mettre à jour le channel_id si changé
    if (channel_id && channel_id !== config.channel_id) {
        db.prepare('UPDATE ticket_config SET channel_id = ? WHERE guild_id = ?').run(channel_id, guildId);
    }

    try {
        await channel.send({ embeds: [buildPanelEmbed(config)], components: [buildPanelRow()] });
    } catch (err) {
        return res.status(500).json({ error: 'Impossible d\'envoyer le message : ' + err.message });
    }

    res.json({ success: true });
});

// PUT /api/guilds/:guildId/tickets — update config
router.put('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const { staff_role_id, category_id, welcome_message, panel_title, panel_description, enabled } = req.body;

    const existing = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guildId);
    if (!existing) {
        return res.status(404).json({ error: 'Tickets non configurés. Utilisez le setup d\'abord.' });
    }

    const updates = [];
    const params = [];

    if (staff_role_id !== undefined) { updates.push('staff_role_id = ?'); params.push(staff_role_id); }
    if (category_id !== undefined) { updates.push('category_id = ?'); params.push(category_id || null); }
    if (welcome_message !== undefined) { updates.push('welcome_message = ?'); params.push(welcome_message || null); }
    if (panel_title !== undefined) { updates.push('panel_title = ?'); params.push(panel_title || null); }
    if (panel_description !== undefined) { updates.push('panel_description = ?'); params.push(panel_description || null); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }

    if (updates.length > 0) {
        params.push(guildId);
        db.prepare(`UPDATE ticket_config SET ${updates.join(', ')} WHERE guild_id = ?`).run(...params);
    }

    res.json({ success: true });
});

// GET /api/guilds/:guildId/tickets/list — liste des tickets
router.get('/list', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;

    const open = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NULL ORDER BY opened_at DESC').all(guildId);
    const recentClosed = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50').all(guildId);

    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(guildId);

    const mapTicket = (t) => {
        const user = guild?.members.cache.get(t.user_id);
        const closedBy = t.closed_by ? guild?.members.cache.get(t.closed_by) : null;
        return {
            id: t.id,
            channel_id: t.channel_id,
            user_id: t.user_id,
            user_name: user?.displayName || user?.user?.tag || t.user_id,
            opened_at: t.opened_at,
            closed_at: t.closed_at,
            closed_by: t.closed_by,
            closed_by_name: closedBy?.displayName || closedBy?.user?.tag || t.closed_by,
            close_reason: t.close_reason
        };
    };

    res.json({
        open: open.map(mapTicket),
        recent_closed: recentClosed.map(mapTicket)
    });
});

// La route GET /:id/transcript a été retirée : Quasar ne conserve plus le contenu
// des conversations de tickets. Le transcript est remis en pièce jointe dans Discord
// à la fermeture du ticket (voir bot/utils/transcriptArchive.js) et relève ensuite
// de l'administrateur du serveur.

module.exports = router;
