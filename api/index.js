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

function createApi(discordClient) {
    const app = express();

    // Middleware
    app.use(express.json());
    app.use(cookieParser());

    // Rendre le client Discord accessible aux routes
    app.set('discordClient', discordClient);

    // Feedback relay → DevPortal (dev.vena.city)
    // Reçoit le multipart/form-data du FAB et le forward tel quel au DevPortal.
    // Pas besoin de parser le body côté Quasar — on pipe les chunks bruts.
    const DEVREPORT_URL = 'https://dev.vena.city';
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
    app.use('/api/guilds', guildRoutes);
    app.use('/api/guilds/:guildId/moderation', moderationRoutes);
    app.use('/api/guilds/:guildId/welcome', welcomeRoutes);
    app.use('/api/guilds/:guildId/reactionroles', reactionrolesRoutes);
    app.use('/api/guilds/:guildId/embeds', embedsRoutes);
    app.use('/api/guilds/:guildId/customcmds', customcmdsRoutes);
    app.use('/api/guilds/:guildId/tempvoice', tempvoiceRoutes);
    app.use('/api/guilds/:guildId/tickets', ticketsRoutes);
    app.use('/api/presence', presenceRoutes);
    app.use('/api', updateRoutes);

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
        res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
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
