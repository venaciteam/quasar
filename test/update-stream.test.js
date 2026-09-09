// Le flux de mise à jour, du serveur jusqu'au rendu.
//
// GET /api/update est devenu POST réservé au propriétaire, ce qui a obligé à
// remplacer l'EventSource du front — incapable de poser un en-tête — par un
// fetch et un lecteur de flux. Ce dépôt n'a aucun test navigateur, et l'instance
// Venacity ne peut même pas déclencher une mise à jour, Coolify ne montant pas
// la socket Docker : ce chemin ne sert donc QU'aux personnes qui auto-hébergent,
// c'est-à-dire exactement celles qui n'ont aucun moyen de diagnostiquer une
// panne. D'où ce test.
//
// Il fait consommer au VRAI code du front un VRAI flux produit par le serveur,
// découpé à des frontières hostiles : au milieu d'un événement, au milieu du
// séparateur de blocs, au milieu d'un caractère multi-octets. C'est là qu'un
// lecteur naïf perd des lignes ou en fabrique.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';
process.env.BOT_OWNER_ID = '4242';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Remplacer runUpdate AVANT le montage des routes : hors conteneur, la vraie
// fonction part sur la mise à jour native, qui fait un git pull puis un
// process.exit(0). Elle ne doit jamais s'exécuter ici.
const updater = require('../api/services/updater');
updater.runUpdate = (onLog) => {
    // La séquence exacte que produit une instance dont la socket Docker n'est
    // pas montée : c'est le cas de la preview, et de toute installation sans
    // l'auto-updater.
    onLog('error', 'Configuration Docker incomplète.');
    onLog('error', 'Docker socket non monté (/var/run/docker.sock)');
    onLog('fail', 'Impossible de lancer la mise à jour.');
};

const { generateToken } = require('../api/middleware/auth');
const { createApi } = require('../api');

let server;
let base;

before(async () => {
    await new Promise((resolve) => { server = createApi({}, 'bot').listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** POST /api/update et renvoie les octets bruts du flux. */
function capturerFlux(jeton) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/update`, {
            method: 'POST', headers: { Authorization: `Bearer ${jeton}` },
        }, (res) => {
            const morceaux = [];
            res.on('data', (c) => morceaux.push(c));
            res.on('end', () => resolve({ status: res.statusCode, octets: Buffer.concat(morceaux) }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Charge le vrai front dans un bac à sable, avec un document minimal. */
function chargerFront(reponseFetch) {
    const elements = {};
    const creer = () => ({
        style: {}, className: '', textContent: '', children: [],
        appendChild(e) { this.children.push(e); return e; },
        scrollTop: 0, scrollHeight: 0,
    });
    for (const id of ['update-action', 'update-output', 'update-log', 'update-status-title']) {
        elements[id] = creer();
    }

    const sandbox = {
        document: { getElementById: (id) => elements[id] || creer(), createElement: creer },
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, TextDecoder,
        // update.js déclare sa propre waitForRestart au niveau global, qui écrase
        // toute doublure posée ici : c'est donc la vraie qui tourne. Elle sonde
        // le serveur en boucle — on neutralise la minuterie plutôt que la
        // fonction, ce qui a le mérite de laisser s'exécuter le code réel.
        setInterval: () => 0,
        clearInterval: () => {},
        fetch: async () => reponseFetch,
        getToken: () => 'jeton',
        escapeHtml: (s) => String(s),
        API: { get: async () => ({}) },
        loadUpdate: async () => {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'pages', 'update.js'), 'utf8'), sandbox);
    return { sandbox, elements };
}

/** Réponse fetch minimale qui débite les octets par tranches de `taille`. */
function reponseDecoupee(octets, taille) {
    let i = 0;
    return {
        ok: true, status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (i >= octets.length) return { done: true, value: undefined };
                    const tranche = octets.subarray(i, i + taille);
                    i += taille;
                    return { done: false, value: new Uint8Array(tranche) };
                },
                cancel: async () => {},
            }),
        },
        json: async () => ({}),
    };
}

test('le serveur refuse la mise à jour à un compte qui n\'est pas propriétaire', async () => {
    const intrus = generateToken({ id: '9999', username: 'intrus', avatar: null, guilds: [] });
    const { status } = await capturerFlux(intrus);
    assert.equal(status, 403);
});

test('le front rend chaque ligne du flux, quelle que soit la découpe des octets', async () => {
    const proprietaire = generateToken({ id: '4242', username: 'proprio', avatar: null, guilds: [] });
    const { status, octets } = await capturerFlux(proprietaire);
    assert.equal(status, 200, 'la propriétaire doit obtenir le flux');
    assert.ok(octets.length > 0, 'le flux ne doit pas être vide');

    // 1 octet : chaque événement, chaque séparateur « \n\n » et chaque caractère
    // accentué arrivent coupés en morceaux. 7 et 13 : des frontières
    // quelconques. La taille totale : tout d'un coup.
    for (const taille of [1, 7, 13, octets.length]) {
        const { sandbox, elements } = chargerFront(reponseDecoupee(octets, taille));
        await sandbox.startUpdate();

        const rendu = elements['update-log'].children.map((e) => e.textContent);
        assert.deepEqual(rendu, [
            'Configuration Docker incomplète.',
            'Docker socket non monté (/var/run/docker.sock)',
            '\n✗ Impossible de lancer la mise à jour.',
        ], `découpe par ${taille} octet(s) : rendu inattendu`);

        // L'échec doit être annoncé, et surtout PAS confondu avec une perte de
        // connexion — c'était le piège de la réécriture.
        assert.equal(elements['update-status-title'].textContent, 'Impossible de lancer la mise à jour.',
            `découpe par ${taille} octet(s) : titre inattendu`);
        assert.ok(!rendu.some((l) => l.includes('Connexion perdue')),
            `découpe par ${taille} octet(s) : la fin annoncée par le serveur ne doit pas passer pour une coupure`);
    }
});

test('un refus avant le flux affiche le motif du serveur, pas une erreur de connexion', async () => {
    // 403 pour un compte non propriétaire : le corps JSON porte la raison. Sans
    // ce traitement, le front tombait dans la branche « connexion perdue » et
    // lançait une attente de redémarrage pour rien.
    const { sandbox, elements } = chargerFront({
        ok: false, status: 403, body: null,
        json: async () => ({ error: 'Réservé au propriétaire du bot' }),
    });
    await sandbox.startUpdate();

    const rendu = elements['update-log'].children.map((e) => e.textContent);
    assert.deepEqual(rendu, ['✗ Réservé au propriétaire du bot']);
    assert.equal(elements['update-status-title'].textContent, 'Mise à jour refusée');
});

test('une coupure AVANT la fin annoncée est bien signalée comme telle', async () => {
    // Cas inverse du précédent : le conteneur redémarre au milieu du flux. Là,
    // « connexion perdue » est la bonne réponse.
    const partiel = Buffer.from('data: {"type":"status","message":"Mise à jour du code source..."}\n\n');
    const { sandbox, elements } = chargerFront(reponseDecoupee(partiel, 5));
    await sandbox.startUpdate();

    const rendu = elements['update-log'].children.map((e) => e.textContent);
    assert.equal(rendu[0], '▸ Mise à jour du code source...');
    assert.ok(rendu.some((l) => l.includes('Connexion perdue')), 'une coupure non annoncée doit être signalée');
});
