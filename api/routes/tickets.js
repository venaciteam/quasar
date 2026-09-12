// ═══════════════════════════════════════════════════════════════
//  Tickets — configuration depuis le dashboard
//
//  ⚠️ Le panneau posé ici est le MÊME que celui que pose `/ticket setup` :
//  même nom de panneau (`ticket`), même clé de choix (`ouvrir`). Ce n'est pas
//  une coquetterie : depuis la consolidation, un clic n'atteint du code métier
//  que par `platform.routerPanneau`, qui lit `panneau:cle` dans l'identifiant du
//  composant. Un panneau posé avec l'ancien `ticket_open` s'affiche
//  parfaitement, et son bouton ne répond jamais.
//
//  La pose passe par `api/services/panneau.js`, qui emprunte l'adaptateur.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { embed } = require('../../bot/platform/embed');
const plateforme = require('../services/plateforme');
const { poserPanneau } = require('../services/panneau');
const router = express.Router({ mergeParams: true });

const ACCENT_COLOR = 0xDE3163;

const DEFAULT_PANEL_TITLE = '🎫 Support — Ouvrir un ticket';
const DEFAULT_PANEL_DESC = 'Cliquez sur le bouton ci-dessous pour ouvrir un ticket.\nUn membre du staff vous répondra dès que possible.';

// Nom du panneau et choix d'ouverture, à l'identique de `bot/commands/ticket.js`.
// Recopiés plutôt qu'importés parce que le descripteur d'une commande n'expose
// pas ses constantes internes ; `test/lot5-tickets-arbitrage.test.js` vérifie
// que le nom correspond bien à un panneau DÉCLARÉ par la commande, pour qu'une
// divergence casse un test au lieu de produire un bouton muet.
const PANNEAU = 'ticket';
const CHOIX_OUVRIR = Object.freeze({
    cle: 'ouvrir', libelle: 'Ouvrir un ticket', emoji: '🎫', style: 'primaire',
});

/** Embed du panneau, au format NEUTRE. Identique à celui de `/ticket setup`. */
function buildPanelEmbed(config) {
    return embed({
        titre: config?.panel_title || DEFAULT_PANEL_TITLE,
        description: config?.panel_description || DEFAULT_PANEL_DESC,
        couleur: ACCENT_COLOR,
        horodatage: true,
    });
}

/** Pose le panneau d'ouverture dans un salon. Lève si l'envoi échoue. */
function poserPanneauTicket(req, canalId, config) {
    return poserPanneau(
        plateforme.adaptateur(req),
        canalId,
        buildPanelEmbed(config),
        [CHOIX_OUVRIR],
        { panneau: PANNEAU, guildeId: req.params.guildId },
    );
}

// GET /api/guilds/:guildId/tickets — config tickets du serveur
router.get('/', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(req.params.guildId);

    if (!config) {
        return res.json({ configured: false });
    }

    // Noms d'affichage. Un échec de lecture vaut « supprimé », comme un cache
    // froid avant migration : la page reste utilisable, la configuration aussi.
    const api = plateforme.api(req);
    const lire = (appel) => (api ? appel().catch(() => null) : Promise.resolve(null));

    const [channel, category, role] = await Promise.all([
        lire(() => api.obtenirCanal(config.channel_id)),
        config.category_id ? lire(() => api.obtenirCanal(config.category_id)) : Promise.resolve(null),
        lire(() => api.obtenirRole(req.params.guildId, config.staff_role_id)),
    ]);

    res.json({
        configured: true,
        channel_id: config.channel_id,
        channel_name: channel?.nom || '(supprimé)',
        category_id: config.category_id || null,
        category_name: category?.nom || null,
        staff_role_id: config.staff_role_id,
        staff_role_name: role?.nom || '(supprimé)',
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

    const api = plateforme.api(req);
    if (!api) return res.status(404).json({ error: 'Serveur introuvable.' });

    const channel = await api.obtenirCanal(channel_id).catch(() => null);
    if (!channel || channel.guildeId !== guildId) {
        return res.status(404).json({ error: 'Salon introuvable.' });
    }

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

    // Envoyer le panneau dans le salon
    try {
        await poserPanneauTicket(req, channel_id, configForEmbed);
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

    const api = plateforme.api(req);
    if (!api) return res.status(404).json({ error: 'Serveur introuvable.' });

    // Utiliser le channel_id fourni ou celui de la config
    const targetChannelId = channel_id || config.channel_id;
    const channel = await api.obtenirCanal(targetChannelId).catch(() => null);
    if (!channel || channel.guildeId !== guildId) {
        return res.status(404).json({ error: 'Salon introuvable.' });
    }

    // Mettre à jour le channel_id si changé
    if (channel_id && channel_id !== config.channel_id) {
        db.prepare('UPDATE ticket_config SET channel_id = ? WHERE guild_id = ?').run(channel_id, guildId);
    }

    try {
        await poserPanneauTicket(req, targetChannelId, config);
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

// Plafond de résolution de noms pour la liste des tickets. Au-delà, l'affichage
// retombe sur l'identifiant — ce que faisait déjà un cache froid avant
// migration. Une page de dashboard n'a pas à déclencher deux cents appels.
const MAX_MEMBRES_RESOLUS = 100;

// GET /api/guilds/:guildId/tickets/list — liste des tickets
router.get('/list', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;

    const open = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NULL ORDER BY opened_at DESC').all(guildId);
    const recentClosed = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50').all(guildId);

    // Noms d'affichage : une seule résolution par identifiant, quel que soit le
    // nombre de tickets qui le citent. Un membre parti rend `null` et la ligne
    // affiche son identifiant, comme avant.
    const api = plateforme.api(req);
    const identifiants = [...new Set(
        [...open, ...recentClosed].flatMap(t => [t.user_id, t.closed_by]).filter(Boolean)
    )].slice(0, MAX_MEMBRES_RESOLUS);

    const noms = new Map();
    if (api) {
        const resolus = await Promise.all(identifiants.map(id => api.obtenirMembre(guildId, id).catch(() => null)));
        identifiants.forEach((id, i) => {
            const membre = resolus[i];
            if (membre) noms.set(id, membre.nom || membre.etiquette || id);
        });
    }

    const mapTicket = (t) => ({
        id: t.id,
        channel_id: t.channel_id,
        user_id: t.user_id,
        user_name: noms.get(t.user_id) || t.user_id,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
        closed_by: t.closed_by,
        closed_by_name: t.closed_by ? (noms.get(t.closed_by) || t.closed_by) : t.closed_by,
        close_reason: t.close_reason
    });

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
module.exports.PANNEAU = PANNEAU;
module.exports.CHOIX_OUVRIR = CHOIX_OUVRIR;
