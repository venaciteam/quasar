const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { isValidTimezone, DEFAULT_TIMEZONE } = require('../../bot/modules/scheduler');
const plateforme = require('../services/plateforme');
const router = express.Router();

// Types de salon proposés dans les sélecteurs du dashboard : texte, vocal,
// catégorie et conférence. Les noms sont ceux du vocabulaire canonique
// (bot/platform/channels.js) ; le `typeNatif` reste exposé tel quel, plusieurs
// pages du front comparent encore des entiers Discord.
const TYPES_SELECTIONNABLES = new Set(['texte', 'vocal', 'categorie', 'conference']);

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
//
// Les trois listes ci-dessous gardent LEUR FORME D'ORIGINE (`name`, `color`,
// `type`…) : c'est le contrat que le front consomme depuis toujours, et le
// changer reviendrait à réécrire une douzaine de pages pour un gain nul. La
// traduction se fait ici, à partir des entités neutres.
router.get('/:guildId/channels', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const canaux = await plateforme.listerCanaux(req, req.params.guildId);
        res.json(canaux
            .filter(c => TYPES_SELECTIONNABLES.has(c.type) || estTypeSelectionnableNatif(c))
            .map(c => ({ id: c.id, name: c.nom, position: c.position, type: c.typeNatif }))
            .sort((a, b) => a.position - b.position));
    } catch (error) {
        console.error('[Quasar] Erreur channels:', error);
        res.json([]);
    }
});

// Repli tant que le contrat ne publie pas `api.listerCanaux` : la voie de secours
// de `plateforme.listerCanaux` ne rend pas de nom canonique, seulement le type
// natif. Les quatre valeurs sont celles d'avant migration (texte, vocal,
// catégorie, conférence).
const TYPES_NATIFS_SELECTIONNABLES = new Set([0, 2, 4, 13]);
function estTypeSelectionnableNatif(canal) {
    return canal.type === undefined && TYPES_NATIFS_SELECTIONNABLES.has(canal.typeNatif);
}

// Liste des rôles du serveur
router.get('/:guildId/roles', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const roles = await plateforme.listerRoles(req, req.params.guildId);
        res.json(roles
            // Exclure @everyone et les rôles gérés par une intégration
            .filter(r => !r.parDefaut && !r.gere)
            .map(r => ({ id: r.id, name: r.nom, color: r.couleur, position: r.position }))
            .sort((a, b) => b.position - a.position));
    } catch (error) {
        console.error('[Quasar] Erreur rôles:', error);
        res.json([]);
    }
});

// Liste des emojis du serveur
router.get('/:guildId/emojis', requireAuth, requireGuildAdmin, async (req, res) => {
    try {
        const emojis = await plateforme.listerEmojis(req, req.params.guildId);
        res.json(emojis.map(e => ({
            id: e.id,
            name: e.nom,
            animated: e.anime,
            identifier: e.identifiant,
            url: e.url,
        })));
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
