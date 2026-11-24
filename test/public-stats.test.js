// Compteur public de l'instance — GET /api/public/stats
//
// Ce que ces tests verrouillent :
//  - la réponse ne porte QU'UN entier (aucun nom, aucun identifiant de serveur
//    ne doit pouvoir fuiter par cette route publique) ;
//  - le chiffre vient du robot de CE processus, et la route n'existe qu'en mode
//    `public` : ni la vitrine seule (`site`), ni une instance auto-hébergée
//    (`bot`) ne l'exposent ;
//  - un robot pas encore connecté donne un 503 non mis en cache, jamais un 0 ;
//  - le chiffre est mis en cache cinq minutes, côté serveur et navigateur ;
//  - v5 : le chiffre passe par le contrat de l'adaptateur (`nombreServeurs`),
//    et le même compteur sert une instance Fluxer.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi, createSiteApi } = require('../api');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const creerAdaptateurFluxer = require('../bot/platform/fluxer');

/**
 * Faux client natif : `isReady()` et `guilds.cache` sont les seules lectures de
 * `nombreServeurs`, le reste ne sert qu'à laisser l'adaptateur se construire.
 * Les deux clients natifs (discord.js et celui de bot/platform/fluxer/client.js)
 * exposent cette même forme.
 */
function fauxClient(ids, pret = true) {
    const client = {
        pret,
        isReady() { return this.pret; },
        on() {}, once() {}, off() {},
        rest: {}, channels: { cache: new Map() },
        guilds: { cache: new Map(ids.map((id) => [id, { id, name: `Serveur ${id}` }])) },
    };
    return client;
}

const clientPret = fauxClient(['111', '222', '333']);
const clientDemarrage = fauxClient([], false);
const clientFluxer = fauxClient(['555', '666']);
const discord = (client) => creerAdaptateurDiscord({ client });

const apps = {};
const bases = {};

function ecouter(app) {
    return new Promise((resolve) => {
        const serveur = app.listen(0, () => resolve(serveur));
    });
}

before(async () => {
    apps.public = await ecouter(createApi(discord(clientPret), 'public'));
    apps.demarrage = await ecouter(createApi(discord(clientDemarrage), 'public'));
    apps.bot = await ecouter(createApi(discord(fauxClient(['111'])), 'bot'));
    apps.fluxer = await ecouter(createApi(creerAdaptateurFluxer({ client: clientFluxer }), 'public'));
    apps.site = await ecouter(createSiteApi('site'));
    for (const [nom, serveur] of Object.entries(apps)) {
        bases[nom] = `http://127.0.0.1:${serveur.address().port}`;
    }
});

after(() => Object.values(apps).forEach((s) => s.close()));

function get(base, chemin = '/api/public/stats') {
    return new Promise((resolve, reject) => {
        http.get(`${base}${chemin}`, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

test('mode public : renvoie le nombre de serveurs, et rien d\'autre', async () => {
    const res = await get(bases.public);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { servers: 3 });
    // Garde contre une évolution future qui ajouterait un détail : aucun
    // identifiant ni nom de serveur ne doit apparaître dans le corps.
    assert.doesNotMatch(res.body, /111|Serveur/);
});

test('mode public : cache public de cinq minutes', async () => {
    const res = await get(bases.public);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
});

test('mode public : le chiffre est figé côté serveur pendant la durée du cache', async () => {
    await get(bases.public);
    clientPret.guilds.cache.set('444', { id: '444' });
    try {
        const res = await get(bases.public);
        assert.deepEqual(JSON.parse(res.body), { servers: 3 });
    } finally {
        clientPret.guilds.cache.delete('444');
    }
});

test('robot pas encore connecté : 503 non mis en cache, jamais un zéro', async () => {
    const res = await get(bases.demarrage);
    assert.equal(res.status, 503);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.equal(JSON.parse(res.body).servers, undefined);

    // L'échec n'est pas mémorisé : dès que le robot est prêt, le chiffre sort.
    clientDemarrage.pret = true;
    try {
        const ok = await get(bases.demarrage);
        assert.equal(ok.status, 200);
        assert.deepEqual(JSON.parse(ok.body), { servers: 0 });
    } finally {
        clientDemarrage.pret = false;
    }
});

test('instance Fluxer : le même compteur, lu par le contrat de l\'adaptateur', async () => {
    const res = await get(bases.fluxer);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { servers: 2 });
    assert.doesNotMatch(res.body, /555|Serveur/);
});

test('auto-hébergement (mode bot) : la route n\'existe pas', async () => {
    const res = await get(bases.bot);
    assert.equal(res.status, 404);
});

test('vitrine seule (mode site) : aucun compteur servi', async () => {
    // Pas de 404 ici : le routeur admin des nouveautés, monté sur /api avec la
    // vitrine, intercepte l'adresse (503 sans clé d'admin). Ce qui compte, c'est
    // qu'aucun chiffre ne sorte — la vitrine masque alors la ligne.
    const res = await get(bases.site);
    assert.notEqual(res.status, 200);
    assert.doesNotMatch(res.body, /servers/);
});
