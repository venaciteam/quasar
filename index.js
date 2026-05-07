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
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Quasar] Dashboard: http://localhost:${PORT}`);

        // Afficher l'URL réseau local
        const nets = require('os').networkInterfaces();
        for (const iface of Object.values(nets)) {
            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    console.log(`[Quasar] Réseau local: http://${addr.address}:${PORT}`);
                }
            }
        }

        // Check de mise à jour en arrière-plan (30s après le boot)
        setTimeout(() => startPeriodicCheck(), 30000);
    });
}

main().catch(err => {
    console.error('[Quasar] Erreur fatale:', err);
    process.exit(1);
});
