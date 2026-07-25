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

const { createBot } = require('./bot');
const { createApi } = require('./api');
const { startPeriodicCheck } = require('./api/services/updater');

const PORT = process.env.PORT || 3000;

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

    // Créer et démarrer le bot Discord
    const client = createBot();
    await client.login(process.env.DISCORD_TOKEN);

    // Créer et démarrer l'API + dashboard
    const app = createApi(client);
    app.listen(PORT, HOST, () => {
        console.log(`[Quasar] Dashboard: http://localhost:${PORT}`);

        const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

        if (isLoopback) {
            console.log('[Quasar] Écoute restreinte à cette machine (DASHBOARD_HOST=127.0.0.1).');
            console.log('[Quasar] Pour ouvrir le dashboard au réseau : DASHBOARD_HOST=0.0.0.0 dans le .env.');
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

        // Check de mise à jour en arrière-plan (30s après le boot)
        setTimeout(() => startPeriodicCheck(), 30000);
    });
}

main().catch(err => {
    console.error('[Quasar] Erreur fatale:', err);
    process.exit(1);
});
