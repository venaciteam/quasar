// Garde-fou : le contrat de sous-traitance est imposé par le serveur, pas
// seulement par le navigateur.
//
// Raison d'être : `hasAcceptedCurrent()` n'avait qu'un seul appelant dans tout le
// dépôt, GET /api/contract/status, que seul l'écran d'acceptation consulte. Aucun
// middleware n'interposait l'acceptation devant /api/guilds/:guildId/*. Une
// personne qui refusait le contrat — ou n'importe quel script muni d'un JWT —
// configurait et lisait tout par l'API directe, pendant que l'article 2.3 du
// contrat et la politique de confidentialité affirmaient un blocage inexistant.
//
// Le middleware est testé sur une application minimale, montée comme il l'est
// dans api/index.js : c'est le seul moyen de vérifier son comportement de
// montage (chemin exempté, route sans segment :guildId) indépendamment du reste.
//
// QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');

const { generateToken, requireAuth } = require('../api/middleware/auth');
const { requireContract } = require('../api/middleware/requireContract');
const { recordAcceptance } = require('../api/services/contract');

const app = express();
// Comme dans api/index.js, l'analyse des cookies précède les routes : une session
// posée en cookie doit être vue par le middleware, sans quoi elle contournerait
// le contrat.
app.use(cookieParser());
// Montage identique à celui d'api/index.js : devant TOUS les routeurs portant un
// segment :guildId, et donc jamais devant la liste /api/guilds, qui n'en a pas.
app.use('/api/guilds/:guildId', requireContract);
app.get('/api/guilds', requireAuth, (req, res) => res.json({ liste: true }));
app.get('/api/guilds/:guildId/settings', requireAuth, (req, res) => res.json({ lu: true }));
app.post('/api/guilds/:guildId/erasure/requests', requireAuth, (req, res) => res.json({ recu: true }));

let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.close();
    delete process.env.QUASAR_MODE;
});

function requete(methode, chemin, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${chemin}`, { method: methode, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const REFUSANT = '200000000000000001';
const ACCEPTANT = '200000000000000002';
const AUTOHEBERGE = '200000000000000003';

const jetonRefusant = generateToken({ id: REFUSANT, username: 'refus', avatar: null, guilds: [] });
const jetonAcceptant = generateToken({ id: ACCEPTANT, username: 'accord', avatar: null, guilds: [] });
const jetonAutoheberge = generateToken({ id: AUTOHEBERGE, username: 'auto', avatar: null, guilds: [] });

test('sans acceptation, la configuration d un serveur est refusee en 403', async () => {
    process.env.QUASAR_MODE = 'public';
    const res = await requete('GET', '/api/guilds/123/settings', { authorization: `Bearer ${jetonRefusant}` });
    assert.equal(res.status, 403);
    const corps = JSON.parse(res.body);
    // Code stable : le front doit pouvoir rouvrir l'écran d'acceptation plutôt que
    // d'afficher un refus générique qui ne dirait pas quoi faire.
    assert.equal(corps.code, 'CONTRACT_REQUIRED');
    assert.ok(corps.contractVersion, 'la version attendue doit etre annoncee');
});

test('les demandes d effacement ne sont JAMAIS entravees', async () => {
    // Une obligation légale ne se suspend pas parce qu'un contrat n'est pas signé.
    process.env.QUASAR_MODE = 'public';
    const res = await requete('POST', '/api/guilds/123/erasure/requests', { authorization: `Bearer ${jetonRefusant}` });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { recu: true });
});

test('apres acceptation, la configuration repasse', async () => {
    process.env.QUASAR_MODE = 'public';
    recordAcceptance(ACCEPTANT);
    const res = await requete('GET', '/api/guilds/123/settings', { authorization: `Bearer ${jetonAcceptant}` });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { lu: true });
});

test('une instance auto-hebergee n est jamais bloquee', async () => {
    // Le contrat nomme Venacity comme sous-traitant : hors instance publique, il
    // n'a pas lieu d'être imposé, l'opérateur étant quelqu'un d'autre.
    process.env.QUASAR_MODE = 'bot';
    const res = await requete('GET', '/api/guilds/123/settings', { authorization: `Bearer ${jetonAutoheberge}` });
    assert.equal(res.status, 200);
});

test('sans jeton, c est l authentification qui repond, pas le contrat', async () => {
    // Un 403 « contrat non accepté » sur une requête anonyme enverrait le front
    // vers l'écran d'acceptation alors que la seule chose à faire est de se
    // reconnecter.
    process.env.QUASAR_MODE = 'public';
    const res = await requete('GET', '/api/guilds/123/settings');
    assert.equal(res.status, 401);
});

test('la liste des serveurs, sans segment :guildId, n est pas interceptee', async () => {
    process.env.QUASAR_MODE = 'public';
    const res = await requete('GET', '/api/guilds', { authorization: `Bearer ${jetonRefusant}` });
    assert.equal(res.status, 200);
});

test('le jeton en cookie est reconnu comme celui de l en-tete', async () => {
    // requireAuth accepte les deux ; le middleware doit lire le même jeton, sans
    // quoi une session par cookie contournerait le contrat.
    process.env.QUASAR_MODE = 'public';
    const res = await requete('GET', '/api/guilds/123/settings', { cookie: `token=${jetonRefusant}` });
    assert.equal(res.status, 403);
});
