// ═══════════════════════════════════
//     Quasar — Présence du bot
//     GET + PUT /api/presence
//     Owner only pour la modification
// ═══════════════════════════════════

const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { getDb } = require('../services/database');
const plateforme = require('../services/plateforme');
const router = express.Router();

// Valeurs autorisées
const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const VALID_ACTIVITY_TYPES = [-1, 0, 1, 2, 3, 5]; // -1 = Aucune, 0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching, 5 = Competing
const MAX_TEXT_LENGTH = 128;

// GET /api/presence — Lire la config actuelle + isOwner
router.get('/', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const presence = db.prepare('SELECT * FROM bot_presence WHERE id = 1').get();

        const ownerId = process.env.BOT_OWNER_ID;
        const isOwner = !!(ownerId && req.user.id === ownerId);

        if (presence) {
            res.json({
                status: presence.status,
                activity_type: presence.activity_type,
                activity_text: presence.activity_text,
                isOwner
            });
        } else {
            // Pas encore de config en DB — renvoyer les valeurs par défaut
            res.json({
                status: 'online',
                activity_type: 3,
                activity_text: 'atlas.vena.city',
                isOwner
            });
        }
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/presence:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// PUT /api/presence — Modifier la présence (owner uniquement)
router.put('/', requireAuth, requireOwner, (req, res) => {
    try {
        const { status, activity_type, activity_text } = req.body;

        // Validation du statut
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Statut invalide. Valeurs acceptées : ${VALID_STATUSES.join(', ')}` });
        }

        // Validation du type d'activité
        const actType = parseInt(activity_type);
        if (!VALID_ACTIVITY_TYPES.includes(actType)) {
            return res.status(400).json({ error: `Type d'activité invalide. Valeurs acceptées : ${VALID_ACTIVITY_TYPES.join(', ')}` });
        }

        // Validation du texte (requis sauf si aucune activité)
        const text = (activity_text || '').trim();
        if (actType !== -1) {
            if (!text) {
                return res.status(400).json({ error: 'Le texte d\'activité ne peut pas être vide' });
            }
            if (text.length > MAX_TEXT_LENGTH) {
                return res.status(400).json({ error: `Le texte ne peut pas dépasser ${MAX_TEXT_LENGTH} caractères` });
            }
        }

        // ⚠️ Le CONTRAT ne couvre pas la présence (voir
        // `plateforme.definirPresenceNative`). L'application passe donc par le
        // client natif, et cette route ne le nomme pas elle-même.
        //
        // REFUS EXPLICITE quand la plateforme ne sait pas faire, et rien n'est
        // stocké. La version précédente écrivait en base, n'appliquait rien, et
        // rendait `{ success: true }` : le dashboard affichait « Statut du bot
        // mis à jour » pour un réglage sans aucun effet, et la ligne en base
        // mentait sur l'état réel du bot. Un réglage qu'on ne sait pas appliquer
        // se refuse, il ne se range pas.
        const applique = plateforme.definirPresenceNative(req, actType === -1
            // Aucune activité — statut uniquement
            ? { status, activities: [] }
            : { status, activities: [{ name: text, type: actType }] });

        if (!applique) {
            return res.status(501).json({
                error: 'Cette plateforme ne sait pas définir la présence du bot : le réglage n\'a pas été enregistré.',
                hint: 'Le statut et l\'activité du bot se règlent directement sur la plateforme, quand elle le permet.',
            });
        }

        // Upsert en DB — après l'application : la base ne doit décrire que des
        // états réellement appliqués.
        const db = getDb();
        db.prepare(`INSERT OR REPLACE INTO bot_presence (id, status, activity_type, activity_text)
                    VALUES (1, ?, ?, ?)`).run(status, actType, actType === -1 ? '' : text);

        console.log(`[Quasar] Présence mise à jour par ${req.user.username}: ${status}${actType === -1 ? ' (aucune activité)' : ` — ${text} (type ${actType})`}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Quasar] Erreur PUT /api/presence:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

module.exports = router;
