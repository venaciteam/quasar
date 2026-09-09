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

// Filet de dernier recours, posé AVANT tout le reste : le bot Discord et l'API
// du dashboard partagent ce processus, et une promesse rejetée sans gestionnaire
// l'arrêterait — déconnectant le bot de tous les serveurs pour une erreur qui ne
// concernait qu'une requête HTTP. Express 5 couvre les handlers de routes ; ce
// filet couvre ce qui lui échappe (callbacks d'EventEmitter, événements du bot,
// minuteries). Détail du raisonnement et de ses limites : api/services/incidents.js.
require('./api/services/incidents').installProcessGuard();

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

// ═══════════════════════════════════════════════════════════════
//  Garde de configuration
//
//  Quasar démarrait quelle que soit sa configuration, et chaque variable
//  manquante se payait plus tard, ailleurs, sous une forme qui ne la désignait
//  jamais :
//    DISCORD_TOKEN         → TokenInvalid et pile d'appel, conteneur en boucle
//                            de redémarrage ;
//    DISCORD_CLIENT_ID     → bot en ligne, mais /auth/login part avec
//                            client_id=undefined et Discord répond par une page
//                            d'erreur opaque ;
//    DISCORD_CLIENT_SECRET → le retour OAuth échoue en invalid_client ;
//    CALLBACK_URL          → « Invalid OAuth2 redirect_uri » ;
//    JWT_SECRET            → RIEN DU TOUT, et c'est le pire cas. Le middleware
//                            d'authentification retombait sur une constante
//                            écrite dans le code d'un dépôt PUBLIC : n'importe
//                            qui pouvait forger un jeton accepté par requireAuth,
//                            requireGuildAdmin et requireOwner — l'identifiant
//                            Discord de la propriétaire étant lui aussi public.
//                            Administration complète de l'instance, sans une
//                            ligne dans les journaux.
//
//  Le vrai sujet n'était donc pas la valeur de repli, mais l'absence de garde au
//  démarrage : mieux vaut ne pas démarrer que démarrer ouvert.
// ═══════════════════════════════════════════════════════════════

// Longueur minimale du secret de signature. 32 caractères, soit la sortie de
// `openssl rand -hex 32` coupée en deux : en dessous, une valeur « choisie à la
// main » est à portée d'attaque hors ligne sur un jeton intercepté.
const JWT_SECRET_MIN = 32;

// Valeurs publiées dans .env.example, dans setup.sh ou dans l'historique du
// dépôt. Elles sont présentes sur GitHub : les laisser en place revient à ne pas
// avoir de secret. « quasar-secret » est l'ancienne valeur de repli du
// middleware d'authentification, elle reste listée pour les instances qui
// l'auraient recopiée dans leur .env.
const VALEURS_EXEMPLE = new Set([
    'your_bot_token_here',
    'your_client_id_here',
    'your_client_secret_here',
    'change_this_to_a_random_string',
    'quasar-secret',
]);

// Ce que chaque variable rend possible. Ce texte part dans le message d'erreur :
// une variable manquante doit se lire comme une conséquence, pas comme un nom.
const ROLE_VARIABLE = {
    DISCORD_TOKEN: 'C\'est avec elle que je me connecte à Discord : sans elle, Discord refuse la connexion et le processus redémarre en boucle.',
    DISCORD_CLIENT_ID: 'Elle identifie l\'application Discord dans le lien de connexion du dashboard et dans le lien d\'invitation du bot.',
    DISCORD_CLIENT_SECRET: 'Elle sert à échanger le code OAuth2 contre un jeton : sans elle, toute connexion au dashboard échoue en invalid_client.',
    CALLBACK_URL: 'C\'est l\'adresse de retour d\'OAuth2, et elle doit être déclarée à l\'identique dans le Developer Portal (OAuth2 → Redirects).',
    JWT_SECRET: 'Elle signe les sessions du dashboard. Une valeur connue publiquement laisse forger des jetons d\'administration.',
};

// Variables exigées selon le mode. La liste est déduite de ce que chaque mode
// démarre RÉELLEMENT (cf. resolveMode et main juste en dessous) :
//   site   → createSiteApi ne monte ni /auth, ni les routes du dashboard, ne
//            charge ni discord.js ni la base. Aucune de ces variables n'y est
//            lue, et en exiger une casserait la vitrine — qui est justement le
//            mode dans lequel tourne quasar.vena.city.
//   bot    → client.login + createApi : bot Discord, OAuth2 du dashboard, et
//            sessions signées.
//   public → strictement le même démarrage que `bot`, plus la vitrine.
const VARIABLES_REQUISES = {
    site: [],
    bot: ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'CALLBACK_URL', 'JWT_SECRET'],
};
VARIABLES_REQUISES.public = VARIABLES_REQUISES.bot;

/**
 * Contrôle la configuration pour un mode donné. Ne journalise rien et ne sort
 * pas : elle rend la liste COMPLÈTE des problèmes, pour qu'une seule relance
 * suffise à tous les corriger.
 *
 * @param {string} mode
 * @param {Record<string, string|undefined>} [env] injectable pour les tests
 * @returns {{ ok: boolean, problemes: Array<{variable: string, motif: string, cause: string}> }}
 */
function verifierConfig(mode, env = process.env) {
    const requises = VARIABLES_REQUISES[mode] || VARIABLES_REQUISES[DEFAULT_MODE];
    const problemes = [];

    for (const nom of requises) {
        const brut = env[nom];
        const valeur = typeof brut === 'string' ? brut.trim() : '';
        const role = ROLE_VARIABLE[nom] || '';

        if (!valeur) {
            problemes.push({ variable: nom, motif: 'absente', cause: `absente ou vide. ${role}` });
            continue;
        }

        if (VALEURS_EXEMPLE.has(valeur)) {
            problemes.push({
                variable: nom,
                motif: 'exemple',
                cause: `laissée sur la valeur d'exemple « ${valeur} », publiée dans le dépôt public : elle ne protège rien. ${role}`,
            });
            continue;
        }

        if (nom === 'JWT_SECRET' && valeur.length < JWT_SECRET_MIN) {
            problemes.push({
                variable: nom,
                motif: 'trop courte',
                cause: `trop courte : ${valeur.length} caractère(s) pour ${JWT_SECRET_MIN} au minimum. ${role}`,
            });
        }
    }

    return { ok: problemes.length === 0, problemes };
}

/**
 * Met en forme le refus de démarrage. Séparée de la vérification pour que les
 * tests puissent contrôler la liste sans lire des lignes de console.
 * @returns {string[]} lignes à écrire telles quelles
 */
function formaterProblemes(problemes, mode) {
    const lignes = [
        '',
        `[Quasar] ❌ Configuration incomplète : je ne peux pas démarrer en mode « ${mode} ».`,
        '',
    ];
    for (const p of problemes) {
        lignes.push(`[Quasar]   • ${p.variable} — ${p.cause}`);
    }
    lignes.push('');
    lignes.push('[Quasar] Renseignez ces variables dans le fichier .env, puis relancez Quasar.');
    if (problemes.some(p => p.variable === 'JWT_SECRET')) {
        lignes.push('[Quasar] Pour JWT_SECRET, générez une valeur aléatoire avec :');
        lignes.push('[Quasar]     openssl rand -hex 32');
    }
    lignes.push('[Quasar] Je préfère refuser de démarrer plutôt que de tourner sans protection.');
    lignes.push('');
    return lignes;
}

// ═══════════════════════════════════════════════════════════════
//  Arrêt propre
//
//  Le seul gestionnaire de signaux du projet vivait dans api/services/database.js
//  et sortait par un process.exit(0) immédiat. Sur cette instance, un SIGTERM
//  n'a rien d'exceptionnel : Coolify en envoie un à CHAQUE redéploiement. Le
//  processus était donc coupé régulièrement au milieu de ce qui était en vol,
//  serveur HTTP jamais fermé, client Discord jamais détruit, boucles des modules
//  jamais arrêtées.
//
//  Le cas qui a décidé de ce chantier : la notification de violation de données
//  envoie le message privé PUIS marque la ligne en base. Coupé entre les deux,
//  la ligne reste `pending` et la personne reçoit une SECONDE fois la
//  notification d'une violation de ses données. Un rappel programmé se
//  republie de la même manière, @everyone compris.
// ═══════════════════════════════════════════════════════════════

// Délai dur du drainage : assez long pour laisser partir une requête en cours et
// une déconnexion Discord propre, borné pour ne pas attendre indéfiniment.
//
// ⚠️ À connaître : Docker n'accorde que 10 s entre son SIGTERM et son SIGKILL
// (`docker stop`), et docker-compose.yml ne déclare aucun `stop_grace_period`.
// Un drainage qui irait jusqu'au bout de ces 15 s serait donc tué avant de
// finir. Ce n'est pas une contradiction : le cas nominal se termine en quelques
// dizaines de millisecondes (mesuré), ces 15 s ne servent qu'aux étapes qui
// pendent, et il vaut mieux borner haut ici et relever `stop_grace_period` côté
// déploiement que de couper un drainage encore utile.
const ARRET_DELAI_MS = 15000;

// Modules dont la boucle doit être arrêtée. Ils sont désignés par leur chemin et
// jamais chargés ici : `require` n'est appelé que s'ils sont DÉJÀ dans le cache,
// autrement dit seulement si le bot les a démarrés. Sans cette précaution, le
// drainage du mode `site` chargerait discord.js et la base — précisément ce que
// ce mode existe pour éviter.
// [libellé, chemin, nom de la fonction d'arrêt]. La plupart des modules
// exposent `stop()` ; les deux balayages vivent dans des fichiers qui portent
// bien d'autres choses, leur fonction d'arrêt est donc nommée explicitement.
const MODULES_A_ARRETER = [
    ['planificateur', './bot/modules/scheduler', 'stop'],
    ['rétention', './bot/modules/retention', 'stop'],
    ['notification de violation', './bot/modules/breach', 'stop'],
    ['effacement', './bot/modules/erasure', 'stop'],
    ['balayage des bannissements temporaires', './bot/utils/punishments', 'stopTempBanSweeper'],
    ['balayage des modes panique', './bot/modules/antiraid/panic', 'stopPanicSweeper'],
];

function moduleDejaCharge(chemin) {
    try {
        return Boolean(require.cache[require.resolve(chemin)]);
    } catch {
        return false;
    }
}

/**
 * Arrête les boucles des modules du bot. Chaque module a son propre try/catch :
 * un module qui échoue à s'arrêter ne doit pas empêcher les suivants de le
 * faire, ni retarder la fermeture de la base.
 */
function arreterModulesBot(journal = console) {
    for (const [libelle, chemin, nomArret] of MODULES_A_ARRETER) {
        if (!moduleDejaCharge(chemin)) continue;
        try {
            const mod = require(chemin);
            if (typeof mod[nomArret] === 'function') mod[nomArret]();
        } catch (err) {
            journal.error(`[Quasar] Arrêt : le module ${libelle} n'a pas pu être arrêté — ${err?.message || err}`);
        }
    }
}

/** Ferme la base, et seulement si la chaîne base de données a été chargée. */
function fermerBaseSiChargee(journal = console) {
    if (!moduleDejaCharge('./api/services/database')) return;
    try {
        require('./api/services/database').fermerBase();
    } catch (err) {
        journal.error(`[Quasar] Arrêt : fermeture de la base impossible — ${err?.message || err}`);
    }
}

function fermerServeurHttp(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
        // closeIdleConnections avant close : sans lui, une connexion persistante
        // (keep-alive) inactive retient le serveur ouvert jusqu'à son expiration,
        // et le drainage part au délai dur pour rien. Les requêtes en cours, elles,
        // sont laissées finir.
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        server.close(() => resolve());
    });
}

/**
 * Fabrique la séquence d'arrêt. Les dépendances sont passées en paramètre plutôt
 * que lues dans le module : c'est ce qui permet aux tests d'observer l'ordre réel
 * du drainage sans démarrer un bot ni une base.
 *
 * @returns {(raison: string, code?: number) => Promise<void>} fonction idempotente
 */
function creerArret({
    fermerServeur,
    arreterModules,
    detruireClient,
    fermerBase,
    sortir = (code) => process.exit(code),
    delaiMs = ARRET_DELAI_MS,
    journal = console,
} = {}) {
    let enCours = false;

    return async function arreter(raison, code = 0) {
        // Idempotence : Ctrl+C impatient, ou SIGTERM suivi d'un SIGINT, ne doivent
        // pas lancer deux drainages en parallèle — deux fermetures concurrentes de
        // la base valent mieux que rien, mais deux passages sur les modules
        // rejoueraient des arrêts déjà faits.
        if (enCours) {
            journal.log(`[Quasar] ${raison} : un arrêt est déjà en cours, je le laisse se terminer.`);
            return;
        }
        enCours = true;

        journal.log(`[Quasar] ${raison} : arrêt en cours (${Math.round(delaiMs / 1000)} s au maximum).`);

        // Filet de sortie. Une étape qui pend — connexion persistante, websocket
        // Discord qui ne répond plus — ne doit pas retenir le processus jusqu'au
        // SIGKILL du superviseur.
        const minuterie = setTimeout(() => {
            journal.error('[Quasar] ⚠️  Arrêt : délai dépassé, je sors sans avoir terminé le drainage.');
            sortir(code);
        }, delaiMs);

        // L'ORDRE compte, du plus extérieur au plus intérieur :
        //   1. le serveur HTTP, pour cesser de faire ENTRER du travail ;
        //   2. les boucles des modules, pour cesser d'en PRODUIRE ;
        //   3. le client Discord, une fois que plus personne ne lui écrit ;
        //   4. la base en dernier, parce qu'elle est la dernière à être écrite.
        // Fermer la base avant les modules ferait échouer, en pleine écriture, les
        // ticks encore en vol : c'était exactement le défaut de l'ancien
        // gestionnaire.
        const etapes = [
            ['serveur HTTP', fermerServeur],
            ['boucles des modules', arreterModules],
            ['client Discord', detruireClient],
            ['base de données', fermerBase],
        ];

        for (const [libelle, etape] of etapes) {
            if (typeof etape !== 'function') continue;
            try {
                await etape();
                journal.log(`[Quasar] Arrêt : ${libelle} — fermé.`);
            } catch (err) {
                journal.error(`[Quasar] Arrêt : ${libelle} — échec (${err?.message || err}). Je poursuis le drainage.`);
            }
        }

        clearTimeout(minuterie);
        journal.log('[Quasar] Arrêt terminé.');
        sortir(code);
    };
}

/**
 * Met le serveur en écoute, et sépare explicitement « en écoute » de « échec
 * d'écoute ».
 *
 * ⚠️ Piège de version, vérifié à l'exécution sur express 5.2.1 : le troisième
 * argument de app.listen sert DEUX fois. express l'enregistre comme écouteur de
 * 'listening' (appelé sans argument) et, en plus, comme écouteur unique de
 * 'error' — `app.listen = function () { … server.once('error', done); … }`. Un
 * seul et même callback reçoit donc les deux issues, distinguées par la seule
 * présence de son premier argument. C'est propre à express 5 (express 4 ne le
 * faisait pas), ce n'est pas le comportement de server.listen, et rien ne le
 * garantit à la version suivante.
 *
 * D'où la séparation ici : un écouteur 'listening' pour la bannière, un écouteur
 * 'error' pour l'échec. Elle ne dépend d'aucune particularité d'express, et elle
 * couvre les erreurs qui surviennent APRÈS le démarrage — que le callback de
 * listen, appelé une seule fois, laisserait remonter en exception non capturée.
 * Le callback ne doit surtout pas être passé à app.listen en plus : express le
 * déclencherait aussi sur l'erreur, et la bannière de démarrage s'afficherait
 * juste avant le message d'échec.
 */
function ecouter(app, {
    port = PORT,
    host = HOST,
    onListening,
    journal = console,
    sortir = (code) => process.exit(code),
} = {}) {
    const server = app.listen(port, host);

    server.on('listening', () => {
        if (typeof onListening === 'function') onListening(server);
    });

    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            journal.error(`[Quasar] ❌ Impossible d'écouter sur ${host}:${port} : le port est déjà utilisé.`);
            journal.error('[Quasar]    Une autre instance de Quasar tourne peut-être déjà, ou une autre application occupe ce port.');
            journal.error('[Quasar]    Changez PORT dans le fichier .env, ou libérez le port, puis relancez Quasar.');
        } else if (err && err.code === 'EACCES') {
            journal.error(`[Quasar] ❌ Impossible d'écouter sur ${host}:${port} : permission refusée.`);
            journal.error('[Quasar]    En dessous de 1024, un port exige des privilèges particuliers. Choisissez un port plus haut,');
            journal.error('[Quasar]    ou placez un reverse proxy devant Quasar.');
        } else if (err && err.code === 'EADDRNOTAVAIL') {
            journal.error(`[Quasar] ❌ Impossible d'écouter sur ${host}:${port} : cette adresse n'existe pas sur cette machine.`);
            journal.error('[Quasar]    Vérifiez DASHBOARD_HOST : 127.0.0.1 pour un accès local, 0.0.0.0 pour toutes les interfaces.');
        } else {
            journal.error(`[Quasar] ❌ Impossible d'écouter sur ${host}:${port} — ${err?.message || err}`);
        }
        sortir(1);
    });

    return server;
}

async function main() {
    const version = require('./package.json').version;

    console.log('╔══════════════════════════════════╗');
    console.log(`║        🌌  Quasar Bot v${version.padEnd(12)}║`);
    console.log('╚══════════════════════════════════╝');

    // Résolu après le bandeau : si la valeur est invalide, l'avertissement
    // apparaît juste au-dessus de la ligne de mode qu'il explique.
    const mode = resolveMode();
    console.log(`[Quasar] Mode : ${mode} — ${MODES[mode]}`);

    // Garde de configuration AVANT le moindre démarrage : rien ne sert de se
    // connecter à Discord pour découvrir dix secondes plus tard que les sessions
    // du dashboard ne sont pas signées. Toutes les variables manquantes sont
    // annoncées d'un coup, pour qu'une seule relance suffise.
    const { problemes } = verifierConfig(mode);
    if (problemes.length > 0) {
        for (const ligne of formaterProblemes(problemes, mode)) console.error(ligne);
        process.exit(1);
    }

    let app;
    let client = null;

    if (mode === 'site') {
        // Vitrine seule : pas de client Discord, pas de scheduler, pas de base.
        // Les modules correspondants ne sont même pas chargés.
        app = createSiteApi(mode);
    } else {
        // require différé : en mode `site`, discord.js et la chaîne de la base
        // ne doivent jamais être chargés.
        const { createBot } = require('./bot');
        client = createBot();
        await client.login(process.env.DISCORD_TOKEN);
        app = createApi(client, mode);
    }

    const server = ecouter(app, {
        port: PORT,
        host: HOST,
        onListening: () => {
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
        },
    });

    // Le drainage a besoin des références réelles : le serveur HTTP (que ce
    // fichier ne gardait même pas) et le client Discord, dont destroy() n'était
    // appelé nulle part dans le projet.
    const arreter = creerArret({
        fermerServeur: () => fermerServeurHttp(server),
        arreterModules: () => arreterModulesBot(),
        detruireClient: () => (client ? client.destroy() : undefined),
        fermerBase: () => fermerBaseSiChargee(),
    });

    // SIGTERM : ce que Docker, systemd et Coolify envoient à chaque
    // redéploiement. SIGINT : Ctrl+C en console. Les deux sortent en 0, un arrêt
    // demandé n'étant pas une panne.
    // L'auto-updater emprunte ce même chemin en s'envoyant un SIGTERM : c'est le
    // seul moyen pour lui de profiter du drainage sans dupliquer cet ordre.
    process.on('SIGTERM', () => { arreter('Signal SIGTERM reçu'); });
    process.on('SIGINT', () => { arreter('Signal SIGINT reçu'); });
}

// require.main : ce fichier est le point d'entrée en production, mais les tests
// l'importent pour contrôler le garde de configuration et l'ordre du drainage
// sans démarrer ni bot, ni serveur, ni base.
if (require.main === module) {
    main().catch(err => {
        console.error('[Quasar] Erreur fatale:', err);
        process.exit(1);
    });
}

module.exports = {
    resolveMode,
    verifierConfig,
    formaterProblemes,
    creerArret,
    ecouter,
    arreterModulesBot,
    fermerServeurHttp,
    MODES,
    DEFAULT_MODE,
    VARIABLES_REQUISES,
    JWT_SECRET_MIN,
    ARRET_DELAI_MS,
};
