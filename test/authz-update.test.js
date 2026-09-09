// Garde-fou d'autorisation : /api/update est réservée au propriétaire, et ne
// répond qu'en POST.
//
// Raison d'être : la route était montée en `GET /api/update` avec le seul
// `requireAuth`. Sur l'instance publique, `/auth/login` délivre un jeton à
// n'importe quel compte Discord, sans qu'il partage le moindre serveur avec le
// bot : n'importe qui pouvait donc déclencher `runUpdate`, c'est-à-dire une
// reconstruction d'image et une recréation de conteneur — plusieurs minutes de
// coupure sur tous les serveurs, répétable en boucle, avec les journaux de build
// renvoyés à l'appelant. Et parce que c'était un GET, un simple préchargement de
// lien suffisait. Ces tests rendent les deux régressions impossibles.
//
// ⚠️ `runUpdate` n'est JAMAIS exécutée ici. Hors conteneur, elle part sur
// `runNativeUpdate` : vrai `git pull` sur le dépôt, puis arrêt du processus (un
// SIGTERM qu'il s'envoie à lui-même), qui emporterait le processus de test. La route l'appelle via l'objet de service
// (`updater.runUpdate(...)`), ce qui permet de la remplacer ci-dessous ; le
// premier test vérifie que cette indirection existe TOUJOURS dans la route, et le
// test du cas propriétaire refuse de partir si ce n'est pas le cas.
//
// QUASAR_DB_PATH, JWT_SECRET et BOT_OWNER_ID doivent être posés AVANT les require.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';
process.env.BOT_OWNER_ID = '424242424242424242';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { generateToken } = require('../api/middleware/auth');
const updater = require('../api/services/updater');
const { createApi } = require('../api');

const SOURCE_ROUTE = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'update.js'), 'utf8'
);
// La route doit appeler le service par son objet. Si un jour elle revient à une
// déstructuration (`const { runUpdate } = require(...)`), le remplacement ci-dessous
// devient sans effet et une vraie mise à jour partirait pendant les tests.
const INDIRECTION_OK = /updater\.runUpdate\s*\(/.test(SOURCE_ROUTE)
    && !/(^|[^.\w])runUpdate\s*\(/m.test(SOURCE_ROUTE.replace(/updater\.runUpdate\s*\(/g, 'X('));

// Remplacement : on n'exécute rien, on note l'appel et on rejoue le protocole
// d'événements attendu par le front.
let appelsRunUpdate = 0;
updater.runUpdate = (onLog) => {
    appelsRunUpdate++;
    onLog('status', 'Mise à jour simulée');
    onLog('done', 'Terminé');
};

// `checkVersion` est également remplacée : la vraie appelle l'API GitHub, ce qui
// rendrait ces tests dépendants du réseau. On garde trace du forçage reçu, qui
// est précisément ce que la route filtre.
let dernierForce = null;
updater.checkVersion = async (force) => {
    dernierForce = force;
    return { local: '0.0.0-test', remote: null, updateAvailable: false };
};

const app = createApi({}, 'bot');
let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function requete(methode, chemin, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${chemin}`, { method: methode, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const jetonProprietaire = generateToken({
    id: process.env.BOT_OWNER_ID, username: 'proprietaire', avatar: null, guilds: [],
});
const jetonTiers = generateToken({
    id: '111111111111111111', username: 'tiers', avatar: null, guilds: [],
});

test('la route appelle bien le service par son objet (protege les tests d une vraie mise a jour)', () => {
    assert.ok(INDIRECTION_OK,
        'api/routes/update.js doit appeler updater.runUpdate(...) pour rester testable sans lancer de mise a jour');
});

test('POST /api/update est refuse a un compte authentifie non proprietaire', async () => {
    const res = await requete('POST', '/api/update', { authorization: `Bearer ${jetonTiers}` });
    assert.equal(res.status, 403);
    assert.equal(appelsRunUpdate, 0, 'aucune mise a jour ne doit avoir ete lancee');
});

test('POST /api/update est refuse sans jeton', async () => {
    const res = await requete('POST', '/api/update');
    assert.equal(res.status, 401);
    assert.equal(appelsRunUpdate, 0);
});

test('GET /api/update ne declenche plus rien, meme pour la proprietaire', async () => {
    // Un préchargement de lien fait un GET : il doit se heurter à un refus de
    // méthode, jamais à une mise à jour.
    const res = await requete('GET', '/api/update', { authorization: `Bearer ${jetonProprietaire}` });
    assert.ok([404, 405].includes(res.status), `attendu 404 ou 405, obtenu ${res.status}`);
    assert.equal(appelsRunUpdate, 0);
});

test('GET /api/update?token=... ne passe plus par la chaine de requete', async () => {
    const res = await requete('GET', `/api/update?token=${jetonProprietaire}`);
    assert.ok([404, 405].includes(res.status), `attendu 404 ou 405, obtenu ${res.status}`);
    assert.equal(appelsRunUpdate, 0);
});

test('POST /api/update est accepte pour la proprietaire et diffuse le flux', async () => {
    // Garde-fou dur : sans l'indirection vérifiée plus haut, ce test lancerait une
    // VRAIE mise à jour. On refuse de partir plutôt que de courir le risque.
    assert.ok(INDIRECTION_OK, 'indirection absente : test interrompu avant tout appel reel');

    const res = await requete('POST', '/api/update', { authorization: `Bearer ${jetonProprietaire}` });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/event-stream/);
    assert.equal(appelsRunUpdate, 1);
    // Format SSE conservé : le front découpe sur la ligne vide et lit « data: ».
    assert.match(res.body, /^data: /m);
    assert.match(res.body, /"type":"done"/);
});

test('GET /api/version reste ouverte a tout compte authentifie', async () => {
    // Contre-épreuve : la barre latérale du dashboard affiche la version pour tout
    // le monde. Verrouiller cette lecture casserait l'affichage sans rien protéger,
    // les releases du dépôt AGPL étant publiques.
    const res = await requete('GET', '/api/version', { authorization: `Bearer ${jetonTiers}` });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).local, 'la version locale doit etre renvoyee');
});

test('le forcage de /api/version est reserve a la proprietaire', async () => {
    // `force=true` court-circuite le cache de 12 h et provoque un appel sortant
    // vers GitHub à chaque requête : ouvert à tous, il permettait d'épuiser le
    // quota anonyme de l'instance, donc d'aveugler la détection des mises à jour.
    dernierForce = null;
    await requete('GET', '/api/version?force=true', { authorization: `Bearer ${jetonTiers}` });
    assert.equal(dernierForce, false, 'le forcage doit etre ignore pour un compte tiers');

    dernierForce = null;
    await requete('GET', '/api/version?force=true', { authorization: `Bearer ${jetonProprietaire}` });
    assert.equal(dernierForce, true, 'le forcage doit rester possible pour la proprietaire');
});
