const express = require('express');
const { requireAuth, allowTokenInQuery } = require('../middleware/auth');
const { checkVersion, runUpdate, isUpdating, getEnvironment } = require('../services/updater');

const router = express.Router();

// ═══ GET /api/version ═══
router.get('/version', requireAuth, async (req, res) => {
    try {
        const force = req.query.force === 'true';
        const result = await checkVersion(force);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Impossible de vérifier la version' });
    }
});

// ═══ GET /api/update — SSE stream ═══
// Seule route du projet à tolérer le jeton dans la chaîne de requête : le front
// consomme ce flux avec `EventSource`, qui ne sait pas poser d'en-tête.
router.get('/update', allowTokenInQuery, requireAuth, (req, res) => {
    if (isUpdating()) {
        return res.status(409).json({ error: 'Une mise à jour est déjà en cours' });
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // désactive le buffering nginx/proxy
    });
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    function sendEvent(type, message) {
        if (closed) return;
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    }

    runUpdate((type, message) => {
        sendEvent(type, message);

        // Fermer le stream SSE après done/fail
        if (type === 'done' || type === 'fail') {
            setTimeout(() => {
                if (!closed) res.end();
            }, 500);
        }
    });
});

module.exports = router;
