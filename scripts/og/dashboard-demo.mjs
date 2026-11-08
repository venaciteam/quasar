// Dashboard de démonstration pour la capture de l'image de partage.
//
// Sert dashboard/ tel quel et répond aux appels /api et /auth avec des données
// inventées (serveur « Le Repaire », compte « nova ») : aucune donnée réelle ne
// peut finir dans une image publique. Les animations d'apparition sont coupées,
// sinon une capture headless sort avec le titre et les cartes à opacité 0.
//
// Usage : node scripts/og/dashboard-demo.mjs [port]   (depuis la racine du dépôt)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dashboardDir = path.join(root, 'dashboard');
const port = Number(process.argv[2] || 4789);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const guild = { id: '100000000000000001', name: 'Le Repaire', icon: null };
const json = {
  '/auth/me': { authenticated: true, user: { id: '200000000000000002', username: 'nova', avatar: null } },
  '/api/contract/status': { required: false },
  '/api/breach/banner': [],
  '/api/guilds': [guild, { id: '100000000000000003', name: 'Atelier Pixel', icon: null }],
  [`/api/guilds/${guild.id}/modules`]: {
    moderation: { enabled: true }, welcome: { enabled: true }, reactionroles: { enabled: true },
    embeds: { enabled: true }, customcmds: { enabled: false }, tempvoice: { enabled: true },
    tickets: { enabled: true }, scheduled: { enabled: false },
  },
  '/api/presence': { isOwner: true, status: 'online', activity_type: 3, activity_text: 'quasar.vena.city' },
  '/api/version': { current: version, latest: version, updateAvailable: false },
  '/api/instance': {},
  '/api/nouveautes': { entries: [] },
};
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.svg': 'image/svg+xml' };
const noAnimation = '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head>';

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p in json) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(json[p])); }
  if (p.startsWith('/api/') || p.startsWith('/auth/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
  if (p.startsWith('/dashboard/')) {
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(dashboardDir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    if (ext === '.html' || ext === '.js') body = body.toString('utf8').replaceAll('__VERSION__', version);
    if (ext === '.html') body = body.replace('</head>', noAnimation);
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    return res.end(body);
  }
  res.writeHead(302, { location: '/dashboard/app.html?token=demo' });
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`Dashboard de démonstration : http://127.0.0.1:${port}/dashboard/app.html?token=demo (v${version})`));
