// ═══════════════════════════════════════════════════════════════
//  Notification de violation de données — Routeur (/api/breach)
//
//  Sous-lot C du lot 2 RGPD (art. 33). Monté sur /api/breach par l'intégration.
//  Deux niveaux d'accès :
//   • Gestion (requireOwner) : création d'incidents, prévisualisation, envoi
//     confirmé, traçabilité, clôture. Réservé à la propriétaire de l'instance.
//   • Bannière (requireAuth) : lecture des incidents ouverts + accusé de prise
//     de connaissance, pour TOUT admin d'un serveur connecté non suspendu. C'est
//     le filet indépendant de Discord (art. 33 : la notification doit aboutir
//     même si le bot est hors ligne).
//
//  ⚠️ Rien ne part d'ici. /preview n'envoie jamais ; /send se contente d'ENFILER
//  des breach_deliveries en 'pending'. C'est la boucle bot (bot/modules/breach)
//  qui dépile et envoie réellement sur Discord.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { getDb } = require('../services/database');

const router = express.Router();

// Ligne d'instance spéciale, jamais un vrai serveur (cf. retention/purge.js).
const INSTANCE_ROW_ID = '__quasar_instance_id';
// Un embed Discord plafonne sa description à 4096 caractères : au-delà, le
// message ne tiendrait pas dans une notification unique.
const MAX_BODY = 4096;

const nowSec = () => Math.floor(Date.now() / 1000);

// ─── Helpers destinataires ────────────────────────────────────────────────

/**
 * Serveurs cibles d'une notification : tous les serveurs connectés, hors ligne
 * d'instance spéciale et hors serveurs suspendus (coupure ciblée, sous-lot E).
 * Source = base de données (fiable même si le cache Discord est momentanément
 * vide au boot).
 */
function getTargetGuilds(db) {
    return db.prepare(
        `SELECT guild_id, name FROM guilds WHERE guild_id != ? AND COALESCE(suspended, 0) = 0`
    ).all(INSTANCE_ROW_ID);
}

/**
 * Destinataires d'un serveur : propriétaire + membres ayant la permission
 * ADMINISTRATOR, dédupliqués, hors bots. Nécessite le client Discord pour
 * énumérer les membres.
 * @returns {Promise<{ reachable: boolean, recipients: string[] }>}
 *          reachable=false si le bot ne voit pas le serveur (cache non chargé,
 *          bot retiré) — dans ce cas la liste de destinataires est vide.
 */
async function computeGuildRecipients(client, guildId) {
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return { reachable: false, recipients: [] };

    const ids = new Set();
    if (guild.ownerId) ids.add(guild.ownerId); // le propriétaire est toujours destinataire

    try {
        // fetch() peuple le cache avec tous les membres (intent GuildMembers actif).
        // Négligeable à l'échelle actuelle (poignée de serveurs) ; au-delà, voir la
        // note de scalabilité du compte-rendu.
        const members = await guild.members.fetch();
        for (const m of members.values()) {
            if (m.user?.bot) continue;
            if (m.permissions?.has(PermissionFlagsBits.Administrator)) ids.add(m.id);
        }
    } catch {
        // Énumération impossible : on retombe sur le cache déjà chargé + le
        // propriétaire, plutôt que de renvoyer une liste vide.
        for (const m of guild.members.cache.values()) {
            if (m.user?.bot) continue;
            if (m.permissions?.has(PermissionFlagsBits.Administrator)) ids.add(m.id);
        }
    }

    return { reachable: true, recipients: [...ids] };
}

/**
 * Calcule les destinataires pour tous les serveurs cibles. Utilisé à
 * l'identique par /preview (estimation) et /send (enfilage), pour garantir que
 * ce qui est prévisualisé correspond à ce qui est envoyé.
 */
async function computeTargets(client, db) {
    const guilds = getTargetGuilds(db);
    const out = [];
    for (const g of guilds) {
        const { reachable, recipients } = await computeGuildRecipients(client, g.guild_id);
        out.push({ guildId: g.guild_id, guildName: g.name, reachable, recipients });
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════
//  GESTION — réservée à la propriétaire (requireOwner)
// ═══════════════════════════════════════════════════════════════

// GET /api/breach — Incidents + messages (phases) + résumé de traçabilité.
router.get('/', requireAuth, requireOwner, (req, res) => {
    try {
        const db = getDb();
        const incidents = db.prepare('SELECT * FROM breach_incidents ORDER BY created_at DESC, id DESC').all();
        const msgStmt = db.prepare('SELECT * FROM breach_messages WHERE incident_id = ? ORDER BY phase ASC');
        const sumStmt = db.prepare(
            'SELECT status, COUNT(*) AS n FROM breach_deliveries WHERE message_id = ? GROUP BY status'
        );

        const payload = incidents.map((inc) => {
            const messages = msgStmt.all(inc.id).map((m) => {
                const deliveries = { sent: 0, failed: 0, pending: 0 };
                for (const r of sumStmt.all(m.id)) deliveries[r.status] = r.n;
                return { ...m, deliveries };
            });
            const totals = messages.reduce((acc, m) => {
                acc.sent += m.deliveries.sent;
                acc.failed += m.deliveries.failed;
                acc.pending += m.deliveries.pending;
                return acc;
            }, { sent: 0, failed: 0, pending: 0 });
            return { ...inc, messages, totals };
        });

        res.json(payload);
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/breach:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/breach/incidents { title } — Crée un incident (status 'open').
router.post('/incidents', requireAuth, requireOwner, (req, res) => {
    try {
        const title = (req.body?.title || '').toString().trim().slice(0, 200) || null;
        const db = getDb();
        const info = db.prepare(
            'INSERT INTO breach_incidents (title, status, created_at, created_by) VALUES (?, ?, ?, ?)'
        ).run(title, 'open', nowSec(), req.user.id);
        const incident = db.prepare('SELECT * FROM breach_incidents WHERE id = ?').get(info.lastInsertRowid);
        res.status(201).json(incident);
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/breach/incidents:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/breach/incidents/:id/preview { body }
// Calcule SANS ENVOYER : serveurs cibles, nombre estimé de destinataires, texte final.
router.post('/incidents/:id/preview', requireAuth, requireOwner, async (req, res) => {
    try {
        const db = getDb();
        const incident = db.prepare('SELECT * FROM breach_incidents WHERE id = ?').get(req.params.id);
        if (!incident) return res.status(404).json({ error: 'Incident introuvable' });

        const body = (req.body?.body || '').toString();
        if (!body.trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
        if (body.length > MAX_BODY) {
            return res.status(400).json({ error: `Le message dépasse ${MAX_BODY} caractères (limite d'un embed Discord).` });
        }

        const client = req.app.get('discordClient');
        const targets = await computeTargets(client, db);

        const nextPhase = (db.prepare('SELECT MAX(phase) AS m FROM breach_messages WHERE incident_id = ?').get(incident.id)?.m || 0) + 1;
        const estimatedRecipients = targets.reduce((n, t) => n + t.recipients.length, 0);
        const unreachableGuilds = targets.filter(t => !t.reachable).length;
        const botOnline = !!(client?.guilds?.cache && client.guilds.cache.size > 0);

        res.json({
            incidentId: incident.id,
            phase: nextPhase,
            finalText: body,
            estimatedRecipients,
            unreachableGuilds,
            botOnline,
            targets: targets.map(t => ({
                guildId: t.guildId,
                guildName: t.guildName,
                reachable: t.reachable,
                recipientCount: t.recipients.length,
            })),
        });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/breach/preview:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/breach/incidents/:id/send { body }
// ENVOI CONFIRMÉ : crée un breach_messages (nouvelle phase) puis ENFILE les
// breach_deliveries 'pending' (une par destinataire, channel='dm'). N'envoie
// RIEN sur Discord — c'est la boucle bot qui dépile.
router.post('/incidents/:id/send', requireAuth, requireOwner, async (req, res) => {
    try {
        const db = getDb();
        const incident = db.prepare('SELECT * FROM breach_incidents WHERE id = ?').get(req.params.id);
        if (!incident) return res.status(404).json({ error: 'Incident introuvable' });
        if (incident.status !== 'open') {
            return res.status(409).json({ error: 'Incident clôturé : impossible d\'y ajouter une notification.' });
        }

        const body = (req.body?.body || '').toString();
        if (!body.trim()) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
        if (body.length > MAX_BODY) {
            return res.status(400).json({ error: `Le message dépasse ${MAX_BODY} caractères.` });
        }

        const client = req.app.get('discordClient');
        const targets = await computeTargets(client, db);

        const ts = nowSec();
        const phase = (db.prepare('SELECT MAX(phase) AS m FROM breach_messages WHERE incident_id = ?').get(incident.id)?.m || 0) + 1;

        const insertMsg = db.prepare(
            'INSERT INTO breach_messages (incident_id, phase, body, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
        );
        const insertDm = db.prepare(
            `INSERT INTO breach_deliveries (message_id, guild_id, recipient_id, channel, status, attempts)
             VALUES (?, ?, ?, 'dm', 'pending', 0)`
        );
        const insertGuildFallback = db.prepare(
            `INSERT INTO breach_deliveries (message_id, guild_id, recipient_id, channel, status, attempts)
             VALUES (?, ?, NULL, 'guild_channel', 'pending', 0)`
        );

        let enqueued = 0;
        let guildFallbacks = 0;

        // Message + livraisons dans une seule transaction : soit tout est enfilé,
        // soit rien. Pas de dédup entre deux appels — deux envois = deux phases
        // assumées (la confirmation explicite côté front est le garde-fou).
        const runTx = db.transaction(() => {
            const messageId = insertMsg.run(incident.id, phase, body, ts, req.user.id).lastInsertRowid;
            for (const t of targets) {
                if (t.recipients.length > 0) {
                    for (const rid of t.recipients) {
                        insertDm.run(messageId, t.guildId, rid);
                        enqueued++;
                    }
                } else {
                    // Serveur sans destinataire MP identifiable (bot injoignable au moment
                    // de l'envoi) : on enfile directement un repli salon pour ne pas laisser
                    // ce serveur sans aucune tentative Discord. La bannière reste le filet.
                    insertGuildFallback.run(messageId, t.guildId);
                    guildFallbacks++;
                }
            }
            return messageId;
        });
        const messageId = runTx();

        const message = db.prepare('SELECT * FROM breach_messages WHERE id = ?').get(messageId);
        console.log(
            `[Quasar Violation] Notification enfilée — incident ${incident.id}, phase ${phase} : ` +
            `${enqueued} MP + ${guildFallbacks} repli(s) salon, par ${req.user.username || req.user.id}.`
        );
        res.status(201).json({ message, enqueued, guildFallbacks, phase });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/breach/send:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// GET /api/breach/incidents/:id/deliveries — Traçabilité détaillée.
router.get('/incidents/:id/deliveries', requireAuth, requireOwner, (req, res) => {
    try {
        const db = getDb();
        const incident = db.prepare('SELECT id FROM breach_incidents WHERE id = ?').get(req.params.id);
        if (!incident) return res.status(404).json({ error: 'Incident introuvable' });

        const rows = db.prepare(`
            SELECT d.*, m.phase AS phase, g.name AS guild_name
            FROM breach_deliveries d
            JOIN breach_messages m ON m.id = d.message_id
            LEFT JOIN guilds g ON g.guild_id = d.guild_id
            WHERE m.incident_id = ?
            ORDER BY m.phase ASC, d.guild_id ASC, d.id ASC
        `).all(incident.id);

        res.json(rows);
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/breach/deliveries:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/breach/incidents/:id/close — Clôture un incident.
router.post('/incidents/:id/close', requireAuth, requireOwner, (req, res) => {
    try {
        const db = getDb();
        const incident = db.prepare('SELECT id FROM breach_incidents WHERE id = ?').get(req.params.id);
        if (!incident) return res.status(404).json({ error: 'Incident introuvable' });
        db.prepare("UPDATE breach_incidents SET status = 'closed' WHERE id = ?").run(incident.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/breach/close:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  BANNIÈRE — accessible à tout admin connecté (requireAuth, PAS owner)
//  Filet indépendant de Discord : un admin qui se connecte voit les incidents
//  ouverts non encore acquittés, même si le MP / le repli salon a échoué.
// ═══════════════════════════════════════════════════════════════

// GET /api/breach/banner — Incidents ouverts non acquittés par cet admin.
router.get('/banner', requireAuth, (req, res) => {
    try {
        const db = getDb();

        // L'utilisateur est-il admin d'au moins un serveur connecté non suspendu ?
        const connected = new Set(getTargetGuilds(db).map(g => g.guild_id));
        const isAdminSomewhere = (req.user.guilds || []).some((g) => {
            const isAdmin = (BigInt(g.permissions) & BigInt(0x8)) === BigInt(0x8);
            return isAdmin && connected.has(g.id);
        });
        if (!isAdminSomewhere) return res.json([]);

        const openIncidents = db.prepare("SELECT * FROM breach_incidents WHERE status = 'open' ORDER BY created_at DESC").all();
        const ackStmt = db.prepare('SELECT 1 FROM breach_banner_ack WHERE incident_id = ? AND admin_id = ?');
        const lastMsgStmt = db.prepare('SELECT phase, body, created_at FROM breach_messages WHERE incident_id = ? ORDER BY phase DESC LIMIT 1');

        const out = [];
        for (const inc of openIncidents) {
            if (ackStmt.get(inc.id, req.user.id)) continue;   // déjà acquitté par cet admin
            const lastMessage = lastMsgStmt.get(inc.id);
            if (!lastMessage) continue;                        // incident ouvert mais sans notification encore envoyée
            out.push({ id: inc.id, title: inc.title, created_at: inc.created_at, lastMessage });
        }
        res.json(out);
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/breach/banner:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/breach/banner/:incidentId/ack — Accusé de prise de connaissance.
router.post('/banner/:incidentId/ack', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const incident = db.prepare('SELECT id FROM breach_incidents WHERE id = ?').get(req.params.incidentId);
        if (!incident) return res.status(404).json({ error: 'Incident introuvable' });

        // INSERT OR IGNORE : idempotent grâce à la PK (incident_id, admin_id).
        db.prepare(
            'INSERT OR IGNORE INTO breach_banner_ack (incident_id, admin_id, ack_at) VALUES (?, ?, ?)'
        ).run(incident.id, req.user.id, nowSec());
        res.json({ success: true });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/breach/banner/ack:', err.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

module.exports = router;
