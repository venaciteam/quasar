// Garde-fou : l'accusé de réception d'un incident RGPD n'est pas ouvert à tout
// compte authentifié.
//
// Raison d'être : POST /api/breach/banner/:incidentId/ack ne posait que
// `requireAuth`, alors que le GET /banner juste au-dessus vérifie que l'appelant
// est admin d'au moins un serveur connecté. Sur l'instance publique, où
// /auth/login délivre un jeton à n'importe quel compte Discord, la différence
// entre 404 et 200 sur des identifiants séquentiels permettait de dénombrer les
// violations de données déclarées. Aucun contenu ne fuyait, mais « combien
// d'incidents cette instance a-t-elle déclarés » n'a pas à être public.
//
// QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { generateToken } = require('../api/middleware/auth');
const { getDb } = require('../api/services/database');
const breachRoutes = require('../api/routes/breach');

const GUILD_CONNECTE = '800000000000000001';
const PROPRIETAIRE = '810000000000000000';

const app = express();
app.use(express.json());
app.use('/api/breach', breachRoutes);

let server;
let base;
let incidentId;

before(async () => {
    const db = getDb();
    db.prepare('INSERT INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD_CONNECTE, 'Serveur de test');
    const info = db.prepare(
        'INSERT INTO breach_incidents (title, status, created_at, created_by) VALUES (?, ?, ?, ?)'
    ).run('Incident de test', 'open', Math.floor(Date.now() / 1000), PROPRIETAIRE);
    incidentId = info.lastInsertRowid;

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function poster(chemin, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${chemin}`, { method: 'POST', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

// Compte Discord quelconque : authentifié, mais admin de rien qui soit connecté.
const jetonTiers = generateToken({ id: '820000000000000000', username: 'tiers', avatar: null, guilds: [] });
// Admin d'un serveur qui n'a pas invité le bot : authentifié, toujours pas destinataire.
const jetonAdminAilleurs = generateToken({
    id: '820000000000000001', username: 'ailleurs', avatar: null,
    guilds: [{ id: '899999999999999999', permissions: '8' }],
});
// Admin du serveur connecté : destinataire légitime de la notification.
const jetonAdminConnecte = generateToken({
    id: '820000000000000002', username: 'admin', avatar: null,
    guilds: [{ id: GUILD_CONNECTE, permissions: '8' }],
});

test('un compte sans serveur connecte ne peut pas accuser reception', async () => {
    const res = await poster(`/api/breach/banner/${incidentId}/ack`, { authorization: `Bearer ${jetonTiers}` });
    assert.equal(res.status, 403);
});

test('le refus ne distingue pas un incident existant d un incident inexistant', async () => {
    // C'est tout l'objet du correctif : sans cette garde, 404 et 200 se
    // répondaient différemment et donnaient le compte des incidents déclarés.
    const existant = await poster(`/api/breach/banner/${incidentId}/ack`, { authorization: `Bearer ${jetonAdminAilleurs}` });
    const inexistant = await poster('/api/breach/banner/999999/ack', { authorization: `Bearer ${jetonAdminAilleurs}` });
    assert.equal(existant.status, 403);
    assert.equal(inexistant.status, 403);
});

test('un admin d un serveur connecte accuse bien reception', async () => {
    const res = await poster(`/api/breach/banner/${incidentId}/ack`, { authorization: `Bearer ${jetonAdminConnecte}` });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { success: true });

    const trace = getDb().prepare(
        'SELECT 1 FROM breach_banner_ack WHERE incident_id = ? AND admin_id = ?'
    ).get(incidentId, '820000000000000002');
    assert.ok(trace, 'l accuse de reception doit rester trace');
});

test('sans jeton, la route repond 401', async () => {
    const res = await poster(`/api/breach/banner/${incidentId}/ack`);
    assert.equal(res.status, 401);
});
