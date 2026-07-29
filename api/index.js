const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bot');
const guildRoutes = require('./routes/guilds');
const moderationRoutes = require('./routes/moderation');
const welcomeRoutes = require('./routes/welcome');
const reactionrolesRoutes = require('./routes/reactionroles');
const embedsRoutes = require('./routes/embeds');
const customcmdsRoutes = require('./routes/customcmds');
const tempvoiceRoutes = require('./routes/tempvoice');
const ticketsRoutes = require('./routes/tickets');
const presenceRoutes = require('./routes/presence');
const updateRoutes = require('./routes/update');
const scheduledRoutes = require('./routes/scheduled');
const instanceRoutes = require('./routes/instance');
const contractRoutes = require('./routes/contract');
const breachRoutes = require('./routes/breach');
const ownerRoutes = require('./routes/owner');
const erasureRoutes = require('./routes/erasure');
const { isSuspended } = require('../bot/utils/suspension');
const assetVersion = require('./services/assetVersion');

function createApi(discordClient) {
    const app = express();

    // Middleware
    app.use(express.json());
    app.use(cookieParser());

    // Rendre le client Discord accessible aux routes
    app.set('discordClient', discordClient);

    // Feedback relay → Sema (sema.vena.city)
    // Reçoit le multipart/form-data du FAB et le forward tel quel.
    // Pas besoin de parser le body côté Quasar — on pipe les chunks bruts.
    //
    // Le domaine dev.vena.city utilisé jusqu'ici n'a jamais existé : tous les
    // signalements partaient dans le vide. Le backend réel est Sema.
    const DEVREPORT_URL = process.env.REPORT_RELAY_URL || 'https://sema.vena.city';
    app.post(['/api/feedback', '/api/feedback/vnct'], (req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const body = Buffer.concat(chunks);
                const response = await fetch(`${DEVREPORT_URL}/api/public/report`, {
                    method: 'POST',
                    headers: { 'content-type': req.headers['content-type'] },
                    body,
                });
                const data = await response.json().catch(() => ({}));
                if (response.ok) {
                    res.status(201).json(data);
                } else {
                    res.status(response.status).json(data);
                }
            } catch (err) {
                console.error('[Quasar] DevReport relay error:', err.message);
                res.status(502).json({ error: 'Impossible de contacter le DevPortal' });
            }
        });
        req.on('error', () => res.status(500).json({ error: 'Erreur de lecture' }));
    });

    // API routes
    app.use('/auth', authRoutes);
    app.use('/api/bot', botRoutes);

    // Enforcement de la suspension (coupure ciblée, sous-lot E) : refuse toute
    // ÉCRITURE de configuration sur un serveur suspendu par la propriétaire.
    // Monté AVANT TOUS les routers guild-scoped — y compris guildRoutes, qui porte
    // PUT /:guildId/modules et PUT /:guildId/settings — pour les couvrir tous, avec
    // leurs sous-routes internes. La liste GET /api/guilds n'a pas de segment
    // :guildId : elle n'est jamais interceptée. Les demandes de suppression (droit
    // des personnes, obligation légale) NE sont PAS bloquées par une suspension :
    // seule la configuration l'est.
    app.use('/api/guilds/:guildId', (req, res, next) => {
        const isErasure = req.path.includes('/erasure');
        if (!isErasure && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && isSuspended(req.params.guildId)) {
            return res.status(403).json({ error: 'Serveur suspendu par la proprietaire : configuration en lecture seule.' });
        }
        next();
    });

    app.use('/api/guilds', guildRoutes);
    app.use('/api/guilds/:guildId/moderation', moderationRoutes);
    app.use('/api/guilds/:guildId/welcome', welcomeRoutes);
    app.use('/api/guilds/:guildId/reactionroles', reactionrolesRoutes);
    app.use('/api/guilds/:guildId/embeds', embedsRoutes);
    app.use('/api/guilds/:guildId/customcmds', customcmdsRoutes);
    app.use('/api/guilds/:guildId/tempvoice', tempvoiceRoutes);
    app.use('/api/guilds/:guildId/tickets', ticketsRoutes);
    app.use('/api/guilds/:guildId/scheduled', scheduledRoutes);
    app.use('/api/guilds/:guildId/erasure', erasureRoutes);
    app.use('/api/presence', presenceRoutes);
    app.use('/api/contract', contractRoutes);
    app.use('/api/breach', breachRoutes);
    app.use('/api/owner', ownerRoutes);
    app.use('/api', updateRoutes);
    app.use('/api', instanceRoutes);

    // Fichiers porteurs de références versionnées : la version y est injectée à la
    // volée depuis package.json (voir services/assetVersion.js). Doit passer AVANT
    // express.static, sinon le fichier brut avec ses __VERSION__ est servi tel quel.
    const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
    const VERSIONED_FILES = {
        '/dashboard/index.html': path.join(DASHBOARD_DIR, 'index.html'),
        '/dashboard/app.html': path.join(DASHBOARD_DIR, 'app.html'),
        '/dashboard/sw.js': path.join(DASHBOARD_DIR, 'sw.js'),
    };
    for (const [route, filePath] of Object.entries(VERSIONED_FILES)) {
        app.get(route, (req, res) => assetVersion.send(res, filePath));
    }

    // Dashboard static files (ETag + no-cache for mutable assets)
    app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard'), {
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
            if (filePath.match(/\.(html|js|css)$/)) {
                res.setHeader('Cache-Control', 'no-cache');
            } else if (filePath.match(/\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$/)) {
                res.setHeader('Cache-Control', 'public, max-age=604800');
            }
        }
    }));

    // Page d'accueil (landing)
    app.get('/', (req, res) => {
        assetVersion.send(res, path.join(DASHBOARD_DIR, 'index.html'));
    });

    // Redirect /callback vers auth
    app.get('/callback', (req, res) => {
        // Passer à la route auth
        const url = `/auth/callback?${new URLSearchParams(req.query)}`;
        res.redirect(url);
    });

    return app;
}

module.exports = { createApi };
