// ═══════════════════════════════════════════════════════════════════
//     Quasar — Contrat de sous-traitance (Lot 2 RGPD, art. 28)
//     GET  /api/contract/status  — état d'acceptation de l'admin courant
//     POST /api/contract/accept  — enregistre l'acceptation (idempotent)
//
//     Ce routeur est monté sur /api/contract par l'agent d'intégration.
//     Toute la logique métier vit dans api/services/contract.js (module socle) :
//     ce fichier ne fait que l'exposer en HTTP, à l'image de routes/presence.js.
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
    CONTRACT_VERSION,
    getContractPublicUrl,
    CONTRACT_SUMMARY,
    hasAcceptedCurrent,
    recordAcceptance,
    isContractRequired,
} = require('../services/contract');

const router = express.Router();

// Copie locale servable du texte intégral (page autonome du dashboard). Sert de
// référence de repli tant que CONTRACT_PUBLIC_URL (Strata) n'est pas publié — et
// reste la version que l'écran d'acceptation ouvre par défaut.
const CONTRACT_LOCAL_URL = '/dashboard/legal/contrat.html';

// GET /api/contract/status
// Renvoie l'état d'acceptation de l'admin authentifié + les données d'affichage
// nécessaires à l'écran d'acceptation (résumé, version, liens). Le gating front
// (contractGate.js) se base sur `accepted`, qui teste la VERSION COURANTE : un admin
// ayant accepté une version antérieure est considéré non-accepté (revoit l'écran).
router.get('/status', requireAuth, (req, res) => {
    try {
        // `required` vaut false hors instance publique : le gating front ne doit pas
        // imposer le contrat de Venacity aux instances auto-hebergees (cf. contract.js).
        const required = isContractRequired();
        const accepted = hasAcceptedCurrent(req.user.id);
        res.json({
            required,
            accepted,
            version: CONTRACT_VERSION,
            summary: CONTRACT_SUMMARY,
            url: getContractPublicUrl(),
            localUrl: CONTRACT_LOCAL_URL,
        });
    } catch (err) {
        console.error('[Quasar] Erreur GET /api/contract/status:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// POST /api/contract/accept
// Enregistre l'acceptation de la version courante par l'admin authentifié.
// Idempotent : recordAcceptance() fait un INSERT OR IGNORE sur la PK
// (admin_id, contract_version), donc une double soumission ne crée pas de doublon
// et n'est pas une erreur. On renvoie toujours { success, version }.
router.post('/accept', requireAuth, (req, res) => {
    try {
        recordAcceptance(req.user.id);
        console.log(`[Quasar] Contrat de sous-traitance v${CONTRACT_VERSION} accepté par ${req.user.username || req.user.id}`);
        res.json({ success: true, version: CONTRACT_VERSION });
    } catch (err) {
        console.error('[Quasar] Erreur POST /api/contract/accept:', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

module.exports = router;
