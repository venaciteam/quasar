// Garde-fou : une requête mal formée n'est pas un incident.
//
// Raison d'être : `errorHandler` répondait TOUJOURS 500, avec un code
// d'incident et une alerte dans le salon Discord. Or `express.json()` produit
// des erreurs qui portent déjà le bon statut, 400 pour du JSON invalide et 413
// pour un corps trop gros. Deux dégâts. Le premier est un mensonge adressé à la
// personne : un 500 dit « le défaut vient de Quasar » pour une requête qui était
// la sienne. Le second est exploitable : /api/feedback est publique et non
// authentifiée, donc n'importe qui pouvait noyer le canal d'alerte en envoyant
// du JSON malformé en boucle. Un canal d'alerte saturé de faux positifs ne sera
// plus lu le jour d'un vrai incident.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { corpsInvalide } = require('../api/middleware/errorHandler');
const { createApi } = require('../api');

const app = createApi({}, 'bot');
let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function post(chemin, corps, contentType = 'application/json') {
    return new Promise((resolve, reject) => {
        const charge = Buffer.from(corps);
        const req = http.request(`${base}${chemin}`, {
            method: 'POST',
            headers: { 'Content-Type': contentType, 'Content-Length': charge.length },
        }, (res) => {
            let texte = '';
            res.on('data', (c) => { texte += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: texte }));
        });
        let repondu = false;
        req.on('response', () => { repondu = true; });
        req.on('error', (err) => { if (!repondu) reject(err); });
        req.end(charge);
    });
}

test('du JSON malforme ressort en 400, sans code d incident', async () => {
    const res = await post('/api/feedback', '{"embeds": [');
    assert.equal(res.status, 400);
    // Le code d'incident est la signature d'une alerte Discord emise.
    assert.equal(res.body.includes('incident'), false, res.body);
});

test('un corps JSON au-dela de la limite ressort en 413', async () => {
    // express.json() plafonne a 100 ko : on passe largement au-dessus.
    const gros = JSON.stringify({ embeds: [{ description: 'x'.repeat(200 * 1024) }] });
    const res = await post('/api/feedback', gros);
    assert.equal(res.status, 413);
    assert.equal(res.body.includes('incident'), false, res.body);
});

test('corpsInvalide ne se declenche que sur les erreurs de body-parser', () => {
    assert.equal(corpsInvalide({ type: 'entity.parse.failed', status: 400 }), true);
    assert.equal(corpsInvalide({ type: 'entity.too.large', status: 413 }), true);
    // Une vraie panne reste une vraie panne, meme si elle porte un status.
    assert.equal(corpsInvalide({ status: 400 }), false);
    assert.equal(corpsInvalide(new Error('boum')), false);
    assert.equal(corpsInvalide({ type: 'entity.parse.failed', status: 500 }), false);
    assert.equal(corpsInvalide(undefined), false);
});
