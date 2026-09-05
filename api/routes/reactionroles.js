const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const router = express.Router({ mergeParams: true });
const { checkAssignableRole, describeForApi } = require('../../bot/utils/assignableRole');

// Les rôles automatiques (autorôles, rôles vocaux) passent tous par la même
// vérification : cf. bot/utils/assignableRole.js. Résout le rôle dans le cache du
// serveur et renvoie soit { role }, soit { status, error } prêt à renvoyer.
function resolveAssignableRole(req, roleId) {
    const guild = req.app.get('discordClient')?.guilds.cache.get(req.params.guildId);
    if (!guild) return { status: 404, error: 'Ce serveur est introuvable pour le bot.' };

    const role = guild.roles.cache.get(roleId);
    const refusal = checkAssignableRole(guild, role);
    if (refusal) return { status: 400, error: describeForApi(refusal, role) };

    return { role };
}

// Autoroles
router.get('/autoroles', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').all(req.params.guildId));
});

// Les mêmes gardes que `/autorole add`, qui manquaient ici : un rôle
// inattribuable s'insérait sans broncher et n'échouait qu'à l'arrivée du premier
// membre, dans un `console.error` que personne ne lit. Depuis la v4.6.1 les
// autorôles s'appliquent sur tous les serveurs, plus seulement ceux qui ont un
// message de bienvenue : autant refuser tout de suite, avec un motif.
router.post('/autoroles', requireAuth, requireGuildAdmin, (req, res) => {
    const roleId = typeof req.body?.role_id === 'string' ? req.body.role_id.trim() : '';
    if (!roleId) return res.status(400).json({ error: 'Aucun rôle fourni.' });

    const resolved = resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)').run(req.params.guildId, roleId);
    res.json({ success: true });
});

router.delete('/autoroles/:roleId', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM autoroles WHERE guild_id = ? AND role_id = ?').run(req.params.guildId, req.params.roleId);
    res.json({ success: true });
});

// Voice roles
router.get('/voiceroles', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    try {
        res.json(db.prepare('SELECT channel_id, role_id FROM voice_roles WHERE guild_id = ?').all(req.params.guildId));
    } catch { res.json([]); }
});

// Mêmes gardes que pour les autorôles : un rôle vocal inattribuable échoue à
// chaque connexion en vocal, en silence côté administrateur.
router.post('/voiceroles', requireAuth, requireGuildAdmin, (req, res) => {
    const channelId = typeof req.body?.channel_id === 'string' ? req.body.channel_id.trim() : '';
    const roleId = typeof req.body?.role_id === 'string' ? req.body.role_id.trim() : '';
    if (!channelId || !roleId) return res.status(400).json({ error: 'Salon ou rôle manquant.' });

    const resolved = resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    // Le salon doit exister et être vocal : la table est indexée dessus, une
    // ligne pointant un salon textuel ne se déclencherait jamais.
    const { ChannelType } = require('discord.js');
    const guild = req.app.get('discordClient')?.guilds.cache.get(req.params.guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel) return res.status(400).json({ error: 'Ce salon n\'existe pas sur ce serveur.' });
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
        return res.status(400).json({ error: 'Ce salon n\'est pas un salon vocal.' });
    }

    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS voice_roles (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (guild_id, channel_id))`);
    db.prepare(`INSERT INTO voice_roles (guild_id, channel_id, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET role_id = ?`)
        .run(req.params.guildId, channelId, roleId, roleId);
    res.json({ success: true });
});

router.delete('/voiceroles/:channelId', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM voice_roles WHERE guild_id = ? AND channel_id = ?').run(req.params.guildId, req.params.channelId);
    res.json({ success: true });
});

// Panels
router.get('/panels', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const panels = db.prepare('SELECT * FROM reaction_panels WHERE guild_id = ?').all(req.params.guildId);
    if (panels.length === 0) return res.json([]);

    const panelIds = panels.map(p => p.id);
    const placeholders = panelIds.map(() => '?').join(',');
    const allEntries = db.prepare(`SELECT * FROM reaction_roles WHERE panel_id IN (${placeholders}) ORDER BY rowid ASC`).all(...panelIds);

    const entriesByPanel = {};
    for (const e of allEntries) {
        (entriesByPanel[e.panel_id] ||= []).push(e);
    }

    res.json(panels.map(p => ({ ...p, entries: entriesByPanel[p.id] || [] })));
});

// Vérifier le statut des panels (message encore existant ?)
router.get('/panels/status', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panels = db.prepare('SELECT id, channel_id, message_id FROM reaction_panels WHERE guild_id = ?').all(req.params.guildId);
    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(req.params.guildId);

    const status = {};
    for (const p of panels) {
        try {
            const channel = guild?.channels.cache.get(p.channel_id);
            const msg = await channel?.messages.fetch(p.message_id);
            status[p.id] = msg ? 'active' : 'missing';
        } catch {
            status[p.id] = 'missing';
        }
    }
    res.json(status);
});

// Créer un panel
router.post('/panels', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { channel_id, title, description, mode } = req.body;
    if (!channel_id || !title) return res.status(400).json({ error: 'channel_id et title requis' });

    const client = req.app.get('discordClient');
    const guild = client?.guilds.cache.get(req.params.guildId);
    const channel = guild?.channels.cache.get(channel_id);
    if (!channel) return res.status(400).json({ error: 'Channel introuvable' });

    const result = db.prepare('INSERT INTO reaction_panels (guild_id, channel_id, title, mode) VALUES (?, ?, ?, ?)')
        .run(req.params.guildId, channel_id, title, mode || 'multiple');
    const panelId = result.lastInsertRowid;

    // Poster l'embed
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription((description || 'Cliquez sur un emoji pour obtenir le rôle correspondant.') + '\n\n*(Aucun rôle configuré)*')
        .setColor(0xc86e8e)
        .setFooter({ text: `Panel #${panelId} • Mode ${mode || 'multiple'}` });

    try {
        const msg = await channel.send({ embeds: [embed] });
        db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
        res.json({ success: true, id: panelId, message_id: msg.id });
    } catch (e) {
        res.status(500).json({ error: 'Erreur envoi message: ' + e.message });
    }
});

// Ajouter un emoji → rôle à un panel
router.post('/panels/:panelId/entries', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { emoji, role_id, description } = req.body;
    const panelId = req.params.panelId;

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    // Mêmes gardes que les autorôles et les rôles vocaux : sans elles, un rôle
    // inattribuable n'échoue qu'au premier clic sur l'emoji.
    const roleId = typeof role_id === 'string' ? role_id.trim() : '';
    if (!roleId) return res.status(400).json({ error: 'Aucun rôle fourni.' });
    const resolved = resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    db.prepare(`INSERT INTO reaction_roles (panel_id, emoji, role_id, description) VALUES (?, ?, ?, ?)
        ON CONFLICT(panel_id, emoji) DO UPDATE SET role_id = ?, description = ?`)
        .run(panelId, emoji, roleId, description || null, roleId, description || null);

    // Refresh le panel Discord
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Retirer un emoji d'un panel
router.delete('/panels/:panelId/entries/:emoji', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;
    const emoji = decodeURIComponent(req.params.emoji);

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    db.prepare('DELETE FROM reaction_roles WHERE panel_id = ? AND emoji = ?').run(panelId, emoji);
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Re-poster un panel dont le message a été supprimé
router.post('/panels/:panelId/repost', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;
    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    // Forcer le refresh (qui re-poste automatiquement si le message est absent)
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Supprimer un panel entier
router.delete('/panels/:panelId', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.json({ success: true });

    // Supprimer le message Discord
    try {
        const client = req.app.get('discordClient');
        const guild = client?.guilds.cache.get(req.params.guildId);
        const channel = guild?.channels.cache.get(panel.channel_id);
        const msg = await channel?.messages.fetch(panel.message_id);
        await msg?.delete();
    } catch {} // Message or channel may already be deleted

    db.prepare('DELETE FROM reaction_panels WHERE id = ?').run(panelId);
    res.json({ success: true });
});

async function refreshPanelFromApi(req, panel, panelId, db) {
    try {
        const { EmbedBuilder } = require('discord.js');
        const entries = db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY rowid ASC').all(panelId);
        const client = req.app.get('discordClient');
        const guild = client?.guilds.cache.get(panel.guild_id);
        const channel = guild?.channels.cache.get(panel.channel_id);
        if (!channel) return;

        const p = db.prepare('SELECT * FROM reaction_panels WHERE id = ?').get(panelId);

        let description = 'Cliquez sur un emoji pour obtenir le rôle correspondant.\n\n';
        if (entries.length === 0) {
            description += '*(Aucun rôle configuré)*';
        } else {
            description += entries.map(e =>
                `${e.emoji} → <@&${e.role_id}>${e.description ? ` — *${e.description}*` : ''}`
            ).join('\n');
        }

        const embed = new EmbedBuilder()
            .setTitle(p.title)
            .setDescription(description)
            .setColor(0xc86e8e)
            .setFooter({ text: `Panel #${panelId} • Mode ${p.mode}` });

        // Tenter de récupérer le message existant
        let msg = await channel.messages.fetch(panel.message_id).catch(() => null);

        if (!msg) {
            // Message supprimé par un admin → re-poster
            console.log(`[Quasar] Panel #${panelId} : message supprimé, re-post...`);
            msg = await channel.send({ embeds: [embed] });
            db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
        } else {
            await msg.edit({ embeds: [embed] });
        }

        // Ajouter les réactions manquantes
        for (const entry of entries) {
            const existing = msg.reactions.cache.find(r => {
                const rEmoji = r.emoji.id
                    ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>`
                    : r.emoji.name;
                return rEmoji === entry.emoji;
            });
            if (!existing || !existing.me) {
                await msg.react(entry.emoji).catch(() => {});
            }
        }
    } catch (e) {
        console.error('[Quasar] Erreur refresh panel API:', e.message);
    }
}

module.exports = router;
