const express = require('express');
const router = express.Router();

// Dépôt de référence. Un auto-hébergeur qui modifie le code doit pointer SON dépôt
// via INSTANCE_SOURCE_URL : l'AGPL-3.0 (article 13) impose de proposer le code source
// de la version réellement exécutée aux personnes qui utilisent le dashboard à distance.
const DEFAULT_SOURCE_URL = 'https://github.com/venaciteam/quasar-discord';

// N'accepter que des URL http(s) : évite qu'une valeur mal saisie (ou un `javascript:`)
// se retrouve dans un href du dashboard.
function sanitizeUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.href;
    } catch {
        return null;
    }
}

function cleanName(value) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 120);
}

// GET /api/instance
// Identité de l'opérateur de cette instance. Volontairement public et sans auth :
// savoir qui héberge le service est une information que tout visiteur doit pouvoir
// obtenir, y compris avant de se connecter.
router.get('/instance', (req, res) => {
    res.json({
        operatorName: cleanName(process.env.INSTANCE_OPERATOR_NAME),
        legalUrl: sanitizeUrl(process.env.INSTANCE_LEGAL_URL),
        sourceUrl: sanitizeUrl(process.env.INSTANCE_SOURCE_URL) || DEFAULT_SOURCE_URL,
    });
});

module.exports = router;
