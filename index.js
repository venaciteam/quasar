// Charger .env manuellement (pas besoin de dotenv)
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) return;
        const key = trimmed.slice(0, eqIndex).trim();
        const val = trimmed.slice(eqIndex + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    });
}

// Le module ./api n'a volontairement aucun effet de bord au require : ses routes
// (et donc la base SQLite et discord.js) ne sont chargées qu'à l'appel de
// createApi(). C'est ce qui permet au mode `site` de démarrer sans base ni token.
const { createApi, createSiteApi } = require('./api');

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
//  Mode de fonctionnement
//
//  bot    — auto-hébergement (défaut) : bot Discord + API + dashboard sur '/'.
//           C'est le mode de toutes les instances auto-hébergées, il ne doit
//           jamais changer de comportement.
//  site   — vitrine seule : aucune connexion à Discord, aucune base, aucune
//           route d'API métier. Sert la vitrine sur '/'. Utilisé par
//           quasar.vena.city tant que l'instance publique est fermée.
//  public — instance publique complète : bot + API + dashboard (sous /dashboard)
//           ET vitrine sur '/'.
// ═══════════════════════════════════════════════════════════════
const MODES = {
    bot: 'auto-hébergement (bot + dashboard)',
    site: 'vitrine seule (ni bot, ni base)',
    public: 'instance publique (bot + dashboard + vitrine)',
};
const DEFAULT_MODE = 'bot';

function resolveMode() {
    const raw = (process.env.QUASAR_MODE || '').trim().toLowerCase();
    if (!raw) return DEFAULT_MODE;
    if (raw in MODES) return raw;

    // Valeur inconnue : on refuse de deviner l'intention, mais on ne plante pas
    // pour autant. Repli explicite et bruyant sur le mode par défaut.
    console.error(`[Quasar] ⚠️  QUASAR_MODE="${process.env.QUASAR_MODE}" est inconnu.`);
    console.error(`[Quasar]     Valeurs acceptées : ${Object.keys(MODES).join(', ')}.`);
    console.error(`[Quasar]     Démarrage en mode "${DEFAULT_MODE}" par défaut.`);
    return DEFAULT_MODE;
}

// Interface d'écoute du dashboard. Défaut volontairement restrictif : le dashboard
// n'est joignable que depuis la machine qui l'héberge. L'ouvrir au réseau est une
// décision délibérée, à prendre en connaissance de cause (le dashboard donne accès
// à la configuration complète du bot et aux données des serveurs).
//
// ⚠️ En conteneur, cette valeur doit rester '0.0.0.0' : elle désigne l'interface
// INTERNE au conteneur, pas son exposition. Le Dockerfile force donc DASHBOARD_HOST=0.0.0.0.
// Ce qui détermine l'exposition réelle, c'est la publication du port côté hôte
// (variable BIND_ADDRESS dans docker-compose.yml, elle aussi sur 127.0.0.1 par défaut).
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';

async function main() {
    const version = require('./package.json').version;

    console.log('╔══════════════════════════════════╗');
    console.log(`║        🌌  Quasar Bot v${version.padEnd(12)}║`);
    console.log('╚══════════════════════════════════╝');

    // Résolu après le bandeau : si la valeur est invalide, l'avertissement
    // apparaît juste au-dessus de la ligne de mode qu'il explique.
    const mode = resolveMode();
    console.log(`[Quasar] Mode : ${mode} — ${MODES[mode]}`);

    let app;

    if (mode === 'site') {
        // Vitrine seule : pas de client Discord, pas de scheduler, pas de base.
        // Les modules correspondants ne sont même pas chargés.
        app = createSiteApi(mode);
    } else {
        // require différé : en mode `site`, discord.js et la chaîne de la base
        // ne doivent jamais être chargés.
        const { createBot } = require('./bot');
        const client = createBot();
        await client.login(process.env.DISCORD_TOKEN);
        app = createApi(client, mode);
    }

    app.listen(PORT, HOST, () => {
        const entryPoint = mode === 'site' ? 'Vitrine' : 'Dashboard';
        console.log(`[Quasar] ${entryPoint}: http://localhost:${PORT}`);

        const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
        // En conteneur, écouter sur 0.0.0.0 ne dit rien de l'exposition réelle :
        // l'adresse désigne les interfaces internes au conteneur, et c'est la
        // publication du port qui décide qui peut joindre le dashboard. Avertir ici
        // serait un faux positif — et pousserait à poser DASHBOARD_HOST=127.0.0.1,
        // ce qui rendrait le conteneur injoignable.
        const inContainer = fs.existsSync('/.dockerenv');

        if (isLoopback) {
            console.log('[Quasar] Écoute restreinte à cette machine (DASHBOARD_HOST=127.0.0.1).');
            console.log('[Quasar] Pour ouvrir le dashboard au réseau : DASHBOARD_HOST=0.0.0.0 dans le .env.');
        } else if (inContainer) {
            console.log(`[Quasar] Écoute sur ${HOST} à l'intérieur du conteneur (normal).`);
            console.log('[Quasar] L\'accès depuis le réseau dépend de la publication du port : voir BIND_ADDRESS.');
        } else {
            // Afficher l'URL réseau local
            const nets = require('os').networkInterfaces();
            for (const iface of Object.values(nets)) {
                for (const addr of iface) {
                    if (addr.family === 'IPv4' && !addr.internal) {
                        console.log(`[Quasar] Réseau local: http://${addr.address}:${PORT}`);
                    }
                }
            }
            console.log(`[Quasar] ⚠️  Écoute sur ${HOST} — le dashboard est joignable au-delà de cette machine.`);
        }

        // Check de mise à jour en arrière-plan (30s après le boot). Sans bot ni
        // dashboard, l'auto-updater n'a rien à mettre à jour : on ne le charge pas.
        if (mode !== 'site') {
            const { startPeriodicCheck } = require('./api/services/updater');
            setTimeout(() => startPeriodicCheck(), 30000);
        }
    });
}

main().catch(err => {
    console.error('[Quasar] Erreur fatale:', err);
    process.exit(1);
});
