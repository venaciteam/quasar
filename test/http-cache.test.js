// Garde-fou de cache HTTP — les réponses authentifiées ne doivent jamais être
// mises en cache.
//
// Raison d'être : `/auth/me` ne posait aucun `Cache-Control` et répondait 200
// même quand l'authentification échouait. En production, le réglage de zone
// Cloudflare « Browser Cache TTL » remplissait ce vide par `max-age=14400` ; le
// navigateur qui avait visité la vitrine avant de se connecter gardait alors le
// `{"authenticated":false}` d'avant login et le resservait à l'appel
// authentifié qui suit le retour d'OAuth. Résultat : dashboard qui éjecte vers
// l'accueil juste après un login réussi, pendant quatre heures, sans une seule
// ligne dans les logs. Ce test rend la régression impossible.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi } = require('../api');

// Mode `bot` : ni vitrine, ni polling du design system, donc aucun appel
// sortant. Le client Discord n'est lu qu'au traitement d'une requête, jamais au
// montage — un objet vide suffit pour ce que l'on teste ici.
const app = createApi({}, 'bot');
let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${path}`, { headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

test('/auth/me interdit toute mise en cache', async () => {
    const res = await get('/auth/me');
    assert.match(res.headers['cache-control'] || '', /no-store/);
    assert.match(res.headers.vary || '', /Authorization/i);
});

test('/auth/me repond 401 sans jeton, en conservant le corps attendu', async () => {
    const res = await get('/auth/me');
    assert.equal(res.status, 401);
    // Le corps reste lisible par les appelants qui testent `authenticated`.
    assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test('/auth/me repond 401 sur un jeton invalide', async () => {
    const res = await get('/auth/me', { Authorization: 'Bearer pas-un-jwt' });
    assert.equal(res.status, 401);
    assert.match(res.headers['cache-control'] || '', /no-store/);
});

test('les routes /api sont couvertes par la meme directive', async () => {
    const res = await get('/api/instance');
    assert.match(res.headers['cache-control'] || '', /no-store/);
});

test('le dashboard statique garde son propre cache', async () => {
    // Contre-épreuve : la directive ne doit pas déborder sur le reste du site,
    // sans quoi chaque asset repartirait à l'origine à chaque navigation.
    const res = await get('/dashboard/index.html');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers['cache-control'] || '', /no-store/);
});
