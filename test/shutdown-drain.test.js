// Garde-fou d'arrêt — le drainage, son ordre, et son idempotence.
//
// Raison d'être : le seul gestionnaire de signaux du projet vivait dans
// api/services/database.js et sortait par un process.exit(0) immédiat. Sur
// l'instance publique, un SIGTERM n'a rien d'exceptionnel — Coolify en envoie un
// à CHAQUE redéploiement — et le processus était donc coupé régulièrement au
// milieu de ce qui était en vol : serveur HTTP jamais fermé, client Discord
// jamais détruit, boucles des modules jamais arrêtées.
//
// Le prix concret, et c'est lui qui a décidé du chantier : la notification de
// violation de données envoie le message privé PUIS marque la ligne en base.
// Coupé entre les deux, la ligne reste `pending` et la personne reçoit une
// SECONDE fois la notification d'une violation de ses données.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { creerArret, fermerServeurHttp, arreterModulesBot } = require('../index.js');

const silence = { log: () => {}, error: () => {} };

// ── Ordre du drainage ────────────────────────────────────────────────────────

test('le drainage suit l\'ordre : serveur HTTP, modules, client Discord, base', async () => {
    // L'ordre n'est pas cosmétique. On coupe d'abord ce qui fait ENTRER du
    // travail, puis ce qui en PRODUIT, puis le lien Discord, et la base en
    // dernier : elle est la dernière à être écrite. Fermer la base avant les
    // modules ferait échouer les ticks encore en vol, en pleine écriture.
    const ordre = [];
    const codes = [];
    const arreter = creerArret({
        fermerServeur: async () => { ordre.push('serveur'); },
        arreterModules: async () => { ordre.push('modules'); },
        detruireClient: async () => { ordre.push('client'); },
        fermerBase: async () => { ordre.push('base'); },
        sortir: (code) => codes.push(code),
        journal: silence,
    });

    await arreter('Signal SIGTERM reçu');

    assert.deepEqual(ordre, ['serveur', 'modules', 'client', 'base']);
    assert.deepEqual(codes, [0]);
});

test('chaque étape attend la précédente', async () => {
    // Une étape asynchrone lente ne doit pas laisser la suivante démarrer : sans
    // await, fermer la base pendant qu'un module écrit encore reviendrait à
    // l'ancien comportement.
    const ordre = [];
    const lent = (nom, ms) => () => new Promise((resolve) => setTimeout(() => {
        ordre.push(nom);
        resolve();
    }, ms));

    const arreter = creerArret({
        fermerServeur: lent('serveur', 30),
        arreterModules: lent('modules', 20),
        detruireClient: lent('client', 10),
        fermerBase: lent('base', 1),
        sortir: () => {},
        journal: silence,
    });

    await arreter('Signal SIGTERM reçu');
    assert.deepEqual(ordre, ['serveur', 'modules', 'client', 'base']);
});

test('une étape qui échoue ne fait pas sauter les suivantes', async () => {
    // Un client Discord déjà tombé ne doit pas empêcher la fermeture de la base :
    // c'est elle qui garde les données.
    const ordre = [];
    const codes = [];
    const arreter = creerArret({
        fermerServeur: () => { ordre.push('serveur'); },
        arreterModules: () => { throw new Error('module récalcitrant'); },
        detruireClient: () => Promise.reject(new Error('websocket déjà fermé')),
        fermerBase: () => { ordre.push('base'); },
        sortir: (code) => codes.push(code),
        journal: silence,
    });

    await arreter('Signal SIGTERM reçu');
    assert.deepEqual(ordre, ['serveur', 'base']);
    assert.deepEqual(codes, [0]);
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test('deux signaux rapprochés ne lancent qu\'un seul drainage', async () => {
    // SIGTERM puis un Ctrl+C impatient, ou l'inverse : deux drainages en
    // parallèle rejoueraient des arrêts déjà faits.
    let passages = 0;
    const codes = [];
    const arreter = creerArret({
        fermerServeur: () => new Promise((resolve) => setTimeout(resolve, 20)),
        arreterModules: () => { passages += 1; },
        detruireClient: () => {},
        fermerBase: () => {},
        sortir: (code) => codes.push(code),
        journal: silence,
    });

    const premier = arreter('Signal SIGTERM reçu');
    await arreter('Signal SIGINT reçu'); // rend la main tout de suite
    await premier;

    assert.equal(passages, 1);
    assert.deepEqual(codes, [0]);
});

test('le second signal est annoncé, pas avalé en silence', async () => {
    const lignes = [];
    const arreter = creerArret({
        fermerServeur: () => new Promise((resolve) => setTimeout(resolve, 20)),
        sortir: () => {},
        journal: { log: (l) => lignes.push(l), error: (l) => lignes.push(l) },
    });

    const premier = arreter('Signal SIGTERM reçu');
    await arreter('Signal SIGINT reçu');
    await premier;

    assert.ok(lignes.some(l => /SIGINT.*déjà en cours/.test(l)), lignes.join('\n'));
});

// ── Délai dur ────────────────────────────────────────────────────────────────

test('une étape qui pend ne retient pas le processus au-delà du délai', async () => {
    // Sans ce filet, une connexion persistante ou un websocket muet ferait
    // attendre le superviseur jusqu'à son SIGKILL — c'est à dire jusqu'à l'arrêt
    // brutal que ce chantier existe pour éviter.
    const codes = [];
    const arreter = creerArret({
        fermerServeur: () => new Promise(() => {}), // ne se résout jamais
        sortir: (code) => codes.push(code),
        delaiMs: 30,
        journal: silence,
    });

    arreter('Signal SIGTERM reçu');
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(codes, [0]);
});

// ── Fermeture réelle du serveur HTTP ─────────────────────────────────────────

test('le serveur HTTP est réellement fermé, connexions persistantes comprises', async () => {
    const app = express();
    app.get('/', (req, res) => res.send('ok'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;

    // Requête avec keep-alive : c'est le cas qui faisait pendre server.close(),
    // et donc partir le drainage au délai dur pour rien.
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
            res.resume();
            res.on('end', resolve);
        }).on('error', reject);
    });

    await fermerServeurHttp(server);
    assert.equal(server.listening, false);
    agent.destroy();
});

test('fermer un serveur absent ne lève pas', async () => {
    await fermerServeurHttp(null);
    await fermerServeurHttp(undefined);
});

// ── Modules non chargés ──────────────────────────────────────────────────────

test('l\'arrêt des modules ne charge rien de ce que le mode site évite', () => {
    // En mode site, ni discord.js ni la base ne sont chargés. Le drainage ne doit
    // surtout pas les charger pour les arrêter : il ne touche qu'aux modules déjà
    // présents dans le cache de require.
    const chemins = [
        require.resolve('../bot/modules/scheduler'),
        require.resolve('../bot/modules/retention'),
        require.resolve('../bot/modules/breach'),
        require.resolve('../bot/modules/erasure'),
    ];
    const avant = chemins.map(c => Boolean(require.cache[c]));

    arreterModulesBot(silence);

    const apres = chemins.map(c => Boolean(require.cache[c]));
    assert.deepEqual(apres, avant);
});

test('les stop() des modules déjà chargés sont bien appelés, tous', () => {
    // Ces stop() existaient et n'étaient appelés NULLE PART : du code mort qui
    // attendait. Le cache de require est peuplé à la main pour vérifier l'appel
    // sans démarrer les vraies boucles — et pour couvrir les deux cas tordus : un
    // module sans stop(), et un stop() qui lève.
    const chemins = {
        scheduler: require.resolve('../bot/modules/scheduler'),
        retention: require.resolve('../bot/modules/retention'),
        breach: require.resolve('../bot/modules/breach'),
        erasure: require.resolve('../bot/modules/erasure'),
    };
    const sauvegarde = Object.fromEntries(
        Object.entries(chemins).map(([nom, c]) => [nom, require.cache[c]]),
    );
    const appels = [];
    const faux = (exports, filename) => ({ id: filename, filename, loaded: true, exports });

    try {
        require.cache[chemins.scheduler] = faux({ stop: () => appels.push('scheduler') }, chemins.scheduler);
        require.cache[chemins.retention] = faux({ /* aucun stop exposé */ }, chemins.retention);
        require.cache[chemins.breach] = faux({ stop: () => { throw new Error('boucle récalcitrante'); } }, chemins.breach);
        require.cache[chemins.erasure] = faux({ stop: () => appels.push('erasure') }, chemins.erasure);

        arreterModulesBot(silence);

        // erasure est arrêté malgré l'absence de stop sur retention et la levée de
        // breach : un module fautif ne prive pas les suivants de leur arrêt.
        assert.deepEqual(appels, ['scheduler', 'erasure']);
    } finally {
        for (const [nom, c] of Object.entries(chemins)) {
            if (sauvegarde[nom] === undefined) delete require.cache[c];
            else require.cache[c] = sauvegarde[nom];
        }
    }
});

// ── La base se ferme sans passer par un signal ───────────────────────────────

test('fermerBase est idempotente et n\'installe aucun gestionnaire de signal', () => {
    const avantTerm = process.listenerCount('SIGTERM');
    const avantInt = process.listenerCount('SIGINT');

    const { getDb, fermerBase } = require('../api/services/database');
    const db = getDb();
    assert.equal(db.open, true);

    assert.equal(fermerBase(), true);
    assert.equal(db.open, false);
    // Deuxième appel : rien à faire, et surtout pas de levée.
    assert.equal(fermerBase(), false);

    // La gestion des signaux appartient à index.js, et à lui seul.
    assert.equal(process.listenerCount('SIGTERM'), avantTerm);
    assert.equal(process.listenerCount('SIGINT'), avantInt);
});

// ── Balayages du bot ─────────────────────────────────────────────────────────

test('le drainage arrête aussi les deux balayages du bot', () => {
    // Ces deux timers sont `unref()`, donc ils ne retenaient pas le processus :
    // le risque n'était pas qu'il refuse de mourir, mais qu'un tour parte
    // PENDANT le drainage, après la fermeture de la base. Cela tenait par
    // chance — l'erreur était avalée et le processus sortait juste après.
    //
    // Observation indirecte, les modules gardant leur poignée privée : les deux
    // fonctions de démarrage sont idempotentes et n'annoncent leur démarrage
    // qu'à la première prise. Un second message après le drainage prouve donc
    // que la poignée a bien été libérée.
    const punitions = require('../bot/utils/punishments');
    const panique = require('../bot/modules/antiraid/panic');
    const client = { guilds: { cache: new Map() } };

    const messages = [];
    const vraiLog = console.log;
    console.log = (...args) => messages.push(args.join(' '));

    try {
        punitions.startTempBanSweeper(client);
        panique.startPanicSweeper(client);
        const apresDemarrage = messages.length;
        assert.equal(apresDemarrage, 2, 'les deux balayages doivent annoncer leur démarrage');

        // Sans arrêt, un second démarrage ne fait rien : c'est la garde
        // d'idempotence, et c'est ce qui rend l'observation fiable.
        punitions.startTempBanSweeper(client);
        panique.startPanicSweeper(client);
        assert.equal(messages.length, apresDemarrage, 'un second démarrage ne doit rien relancer');

        arreterModulesBot(silence);

        punitions.startTempBanSweeper(client);
        panique.startPanicSweeper(client);
        assert.equal(messages.length, apresDemarrage + 2,
            'après le drainage, les balayages doivent pouvoir repartir : leurs poignées ont donc bien été libérées');
    } finally {
        console.log = vraiLog;
        punitions.stopTempBanSweeper();
        panique.stopPanicSweeper();
    }
});
