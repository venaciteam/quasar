// ═══════════════════════════════════════════════════════════════
//  API admin du journal des nouveautés
//
//  Publier une nouveauté ne demande AUCUN redéploiement : la skill
//  quasar-nouveautes poste le bloc markdown ici, et la page /nouveautes le sert
//  immédiatement. Voir api/services/nouveautes.js pour la persistance.
//
//  Ces routes sont montées dans les DEUX modes qui servent la vitrine (`site`
//  et `public`) — elles ne dépendent ni du bot, ni de la base SQLite.
//
//  Authentification : clé d'API en header X-API-Key (convention VNCT), ou
//  Bearer. AUCUNE clé par défaut : si QUASAR_ADMIN_API_KEY n'est pas définie,
//  les routes répondent 503 et rien ne peut être publié. Un défaut ouvert
//  exposerait le changelog public de toutes les instances auto-hébergées.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const nouveautes = require('../services/nouveautes');

const router = express.Router();

// Taille maximale d'un bloc. Large pour une note de version, mais borné : la
// route écrit sur le volume, elle ne doit pas pouvoir servir de dépôt de fichiers.
const MAX_BLOCK_LENGTH = 20_000;

/** Comparaison à temps constant : une comparaison naïve fuite la clé caractère
 *  par caractère via le temps de réponse. */
function safeEqual(a, b) {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    // timingSafeEqual exige des longueurs égales : on hache pour les normaliser
    // sans révéler la longueur de la clé attendue.
    const ha = crypto.createHash('sha256').update(ba).digest();
    const hb = crypto.createHash('sha256').update(bb).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function adminAuth(req, res, next) {
    const expected = (process.env.QUASAR_ADMIN_API_KEY || '').trim();
    if (!expected) {
        return res.status(503).json({ error: "QUASAR_ADMIN_API_KEY n'est pas configurée sur cette instance." });
    }

    const header = req.get('x-api-key');
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
    const provided = (header || bearer || '').trim();

    if (!provided || !safeEqual(provided, expected)) {
        return res.status(401).json({ error: 'Clé d\'API invalide.' });
    }
    return next();
}

router.use(adminAuth);

/** Liste complète, la plus récente d'abord. Sert à la skill pour relire l'état. */
router.get('/admin/nouveautes', (_req, res) => {
    res.json({ entries: nouveautes.list() });
});

/**
 * Publie (ou corrige) un bloc. L'upsert se fait par (date + version) : re-poster
 * le même bloc corrigé remplace l'entrée au lieu d'en créer une seconde.
 * Corps attendu : { block: "## 🌌 Quasar — vX.Y.Z\n### ...\n> *JJ mois AAAA*\n..." }
 */
router.post('/admin/nouveautes', (req, res) => {
    const block = req.body?.block;
    if (typeof block !== 'string' || !block.trim()) {
        return res.status(400).json({ error: 'Champ « block » manquant ou vide.' });
    }
    if (block.length > MAX_BLOCK_LENGTH) {
        return res.status(413).json({ error: `Bloc trop long (max ${MAX_BLOCK_LENGTH} caractères).` });
    }
    if (!/^##(?!#)\s/mu.test(block)) {
        return res.status(400).json({ error: 'Le bloc doit commencer par une ligne « ## » (en-tête de version).' });
    }

    const { entry, persisted } = nouveautes.upsert(block);
    // 200 même si la persistance échoue : l'entrée EST publiée pour cette
    // instance. Le drapeau dit la vérité sur sa survie à un redémarrage plutôt
    // que de faire croire à un échec total.
    return res.json({ entry, persisted });
});

/** Retire une entrée par son id (celui renvoyé par GET / POST). */
router.delete('/admin/nouveautes/:id', (req, res) => {
    const { removed, persisted } = nouveautes.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Entrée introuvable.' });
    return res.json({ removed: true, persisted });
});

module.exports = router;
