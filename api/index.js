const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const assetVersion = require('./services/assetVersion');
const vnctDs = require('./services/vnctDs');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ═══════════════════════════════════════════════════════════════
//  Relais de signalement (bouton flottant du design system VNCT)
//
//  Le FAB du DS a deux chemins d'envoi, et donc deux contrats possibles :
//   1. Sema (chemin nominal) : multipart/form-data à plat (type, service,
//      description, screenshots…), relayé tel quel vers /api/public/report.
//      C'est ce qu'envoie le dashboard, qui embarque sa copie locale du DS.
//   2. Repli webhook Discord : quand Sema est injoignable, le DS distant
//      bascule sur VNCT.config.discordWebhookUrl — qui pointe ici pour la
//      vitrine — avec un corps Discord ({ embeds: [...] } en JSON, ou un
//      multipart payload_json + fileN s'il y a des captures).
//
//  Les deux arrivent sur la même route : on discrimine sur le Content-Type
//  (et, pour le multipart, sur la présence du champ payload_json propre à
//  Discord). Sans ça, un signalement de repli partirait vers Sema qui ne sait
//  pas le lire, et serait perdu.
// ═══════════════════════════════════════════════════════════════

function mountFeedbackRelay(app) {
    // Le domaine dev.vena.city utilisé jusqu'ici n'a jamais existé : tous les
    // signalements partaient dans le vide. Le backend réel est Sema.
    const SEMA_URL = process.env.REPORT_RELAY_URL || 'https://sema.vena.city';
    const WEBHOOK_URL = process.env.FEEDBACK_WEBHOOK_URL;

    // Contrat Discord en JSON. Le corps a déjà été consommé par express.json()
    // en amont : on repart de req.body, pas des chunks bruts.
    function relayToWebhook(req, res) {
        if (!WEBHOOK_URL) return res.status(503).json({ error: 'Feedback non configuré' });
        const { embeds } = req.body || {};
        if (!embeds || !Array.isArray(embeds)) return res.status(400).json({ error: 'Format invalide' });
        return forwardToWebhook(res, { 'Content-Type': 'application/json' },
            JSON.stringify({ embeds: embeds.slice(0, 1) }));
    }

    function forwardToWebhook(res, headers, body) {
        return fetch(WEBHOOK_URL, { method: 'POST', headers, body })
            .then(r => {
                if (r.ok) return res.json({ success: true });
                return r.text().then(t => res.status(r.status).json({ error: t }));
            })
            .catch(() => res.status(500).json({ error: 'Envoi échoué' }));
    }

    // Contrat Sema en multipart. Pas besoin de parser le body côté Quasar :
    // on bufferise les chunks bruts et on les forwarde avec le Content-Type
    // d'origine (la boundary du multipart en fait partie).
    function relayRaw(req, res) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
            const body = Buffer.concat(chunks);
            const contentType = req.headers['content-type'];

            // Repli Discord avec captures : multipart, mais contrat Discord.
            // Le champ payload_json est ajouté en premier par le DS, il tient
            // donc dans les premiers octets — inutile de scanner tout le corps.
            if (WEBHOOK_URL && body.subarray(0, 1024).includes('name="payload_json"')) {
                return forwardToWebhook(res, { 'Content-Type': contentType }, body);
            }

            try {
                const response = await fetch(`${SEMA_URL}/api/public/report`, {
                    method: 'POST',
                    headers: { 'content-type': contentType },
                    body,
                });
                const data = await response.json().catch(() => ({}));
                return res.status(response.ok ? 201 : response.status).json(data);
            } catch (err) {
                console.error('[Quasar] Relais de signalement en échec :', err.message);
                return res.status(502).json({ error: 'Impossible de contacter Sema' });
            }
        });
        req.on('error', () => res.status(500).json({ error: 'Erreur de lecture' }));
    }

    app.post(['/api/feedback', '/api/feedback/vnct'], (req, res) => {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) return relayToWebhook(req, res);
        return relayRaw(req, res);
    });
}

// ═══════════════════════════════════════════════════════════════
//  Vitrine publique (public/) — modes `site` et `public` uniquement
// ═══════════════════════════════════════════════════════════════

function mountVitrine(app, mode) {
    // Le polling de la version du DS ne démarre que si la vitrine est servie :
    // en mode `bot` (auto-hébergement), aucun appel sortant n'est ajouté.
    vnctDs.startVersionPolling();

    app.get('/', (req, res) => vnctDs.send(res, path.join(PUBLIC_DIR, 'index.html'), mode));

    // Garde-fou : toute requête GET/HEAD vers un *.html de public/ passe par le
    // rendu, quelle que soit la route. Empêche express.static de livrer un HTML
    // avec ses placeholders bruts, et protège aussi les pages ajoutées plus tard.
    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (!req.path.endsWith('.html')) return next();
        const filePath = path.join(PUBLIC_DIR, path.normalize(req.path));
        // Traversée de chemin : tout ce qui sort de public/ est refusé au rendu.
        if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath)) return next();
        return vnctDs.send(res, filePath, mode);
    });

    // index:false pour ne pas court-circuiter la route '/' ci-dessus. Les pages
    // HTML sont déjà interceptées par le garde-fou : ici on ne sert que les
    // assets propres à la vitrine (images, favicon…).
    app.use(express.static(PUBLIC_DIR, { index: false }));
}

// ═══════════════════════════════════════════════════════════════
//  Dashboard — modes `bot` et `public`
// ═══════════════════════════════════════════════════════════════

function mountDashboard(app) {
    // Fichiers porteurs de références versionnées : la version y est injectée à la
    // volée depuis package.json (voir services/assetVersion.js). Doit passer AVANT
    // express.static, sinon le fichier brut avec ses __VERSION__ est servi tel quel.
    const VERSIONED_FILES = {
        '/dashboard/index.html': path.join(DASHBOARD_DIR, 'index.html'),
        '/dashboard/app.html': path.join(DASHBOARD_DIR, 'app.html'),
        '/dashboard/sw.js': path.join(DASHBOARD_DIR, 'sw.js'),
    };
    for (const [route, filePath] of Object.entries(VERSIONED_FILES)) {
        app.get(route, (req, res) => assetVersion.send(res, filePath));
    }

    // /dashboard et /dashboard/ tombaient sur express.static, qui servait
    // index.html brut avec ses __VERSION__ non substitués : seul le chemin
    // complet /dashboard/index.html passait par assetVersion. On sert
    // explicitement la page de connexion versionnée sur les trois formes.
    app.get(['/dashboard', '/dashboard/'], (req, res) => {
        assetVersion.send(res, path.join(DASHBOARD_DIR, 'index.html'));
    });

    // Fichiers statiques du dashboard (ETag + no-cache pour les assets mutables).
    // index:false : les pages HTML ne doivent jamais sortir d'ici, elles passent
    // toutes par assetVersion.
    app.use('/dashboard', express.static(DASHBOARD_DIR, {
        index: false,
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
}

// ═══════════════════════════════════════════════════════════════
//  Applications
// ═══════════════════════════════════════════════════════════════

/**
 * App complète : bot + API + dashboard.
 * @param {import('discord.js').Client} discordClient
 * @param {'bot'|'public'} mode — en `public`, '/' sert la vitrine et la page de
 *        connexion du dashboard reste accessible sur /dashboard.
 */
function createApi(discordClient, mode = 'bot') {
    // Les routes sont requises ici, et non en tête de module : leur chargement
    // tire toute la chaîne bot/BDD (better-sqlite3, discord.js). Le mode `site`
    // monte une app qui n'en a aucun besoin — il ne doit pas la payer au simple
    // require('./api').
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

    const app = express();

    // Middleware
    app.use(express.json());
    app.use(cookieParser());

    // Rendre le client Discord accessible aux routes
    app.set('discordClient', discordClient);

    mountFeedbackRelay(app);

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
    app.use('/api/guilds/:guildId/scheduled', scheduledRoutes);
    app.use('/api/presence', presenceRoutes);
    app.use('/api', updateRoutes);
    app.use('/api', instanceRoutes);

    mountDashboard(app);

    // Redirect /callback vers auth
    app.get('/callback', (req, res) => {
        // Passer à la route auth
        const url = `/auth/callback?${new URLSearchParams(req.query)}`;
        res.redirect(url);
    });

    if (mode === 'public') {
        // Instance publique : la vitrine prend la racine, le dashboard vit sous
        // /dashboard (déjà monté ci-dessus).
        mountVitrine(app, mode);
    } else {
        // Auto-hébergement : '/' est la page de connexion du dashboard, la
        // vitrine n'est pas servie du tout.
        app.get('/', (req, res) => {
            assetVersion.send(res, path.join(DASHBOARD_DIR, 'index.html'));
        });
    }

    return app;
}

/**
 * App vitrine seule (mode `site`) : ni bot, ni base, ni dashboard. Sert la
 * vitrine sur '/' et répond une page « bientôt de retour » sur les URLs du
 * dashboard, qui existent dans la nature (liens, favoris, moteurs de recherche).
 */
function createSiteApi(mode) {
    const app = express();

    app.use(express.json());

    // Seule route d'API conservée : le relais de signalement, dont le FAB de la
    // vitrine se sert en repli quand Sema est injoignable. Il ne dépend ni du
    // bot ni de la base — la retirer dégraderait la vitrine telle qu'elle tourne
    // aujourd'hui.
    mountFeedbackRelay(app);

    const SOON_PAGE = path.join(PUBLIC_DIR, 'instance-bientot.html');
    app.use(['/dashboard', '/auth'], (req, res) => {
        // 503 et non 404 : la ressource existe, elle est temporairement fermée.
        // vnctDs.send conserve le statut déjà posé sur la réponse.
        res.status(503);
        vnctDs.send(res, SOON_PAGE, mode);
    });

    mountVitrine(app, mode);

    return app;
}

module.exports = { createApi, createSiteApi };
