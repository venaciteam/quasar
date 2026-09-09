// Garde-fou de cloisonnement : une suppression TempVoice ne traverse pas les
// serveurs.
//
// Raison d'être : DELETE /api/guilds/:guildId/tempvoice/active/:channelId
// exécutait `DELETE FROM tempvoice_active WHERE channel_id = ?`, sans
// `AND guild_id = ?`. Comme `channel_id` est la clé primaire de la table,
// l'identifiant d'un salon appartenant à un AUTRE serveur suffisait à en
// supprimer la ligne, depuis n'importe quel serveur où l'appelant est admin.
// C'était le seul écart de cloisonnement du projet : les autres routeurs
// guild-scoped portent tous leur `guild_id` en clause.
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
const tempvoiceRoutes = require('../api/routes/tempvoice');

const GUILD_A = '900000000000000001';
const GUILD_B = '900000000000000002';
const SALON_DE_B = '910000000000000002';

const app = express();
app.use(express.json());
// Le client Discord n'est lu que pour supprimer le vrai salon : ici il n'en
// connaît aucun, la route se contente donc de la ligne en base — exactement le
// chemin que l'on veut éprouver.
app.set('discordClient', { guilds: { cache: { get: () => null } } });
app.use('/api/guilds/:guildId/tempvoice', tempvoiceRoutes);

let server;
let base;

before(async () => {
    const db = getDb();
    db.prepare(
        'INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)'
    ).run(SALON_DE_B, GUILD_B, '920000000000000000', '');

    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function supprimer(chemin, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}${chemin}`, { method: 'DELETE', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function ligneExiste(channelId) {
    return !!getDb().prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(channelId);
}

// Permission ADMINISTRATOR (0x8) sur le serveur A uniquement.
const jetonAdminDeA = generateToken({
    id: '930000000000000000',
    username: 'admin-a',
    avatar: null,
    guilds: [{ id: GUILD_A, permissions: '8' }],
});
const jetonAdminDeB = generateToken({
    id: '930000000000000001',
    username: 'admin-b',
    avatar: null,
    guilds: [{ id: GUILD_B, permissions: '8' }],
});

test('un admin du serveur A ne supprime pas le salon actif du serveur B', async () => {
    assert.ok(ligneExiste(SALON_DE_B), 'la ligne de depart doit exister');
    const res = await supprimer(`/api/guilds/${GUILD_A}/tempvoice/active/${SALON_DE_B}`, {
        authorization: `Bearer ${jetonAdminDeA}`,
    });
    assert.equal(res.status, 200); // rien à supprimer ici : la route reste idempotente
    assert.ok(ligneExiste(SALON_DE_B), 'la ligne du serveur B doit avoir survecu');
});

test('un admin du serveur B supprime bien le salon actif de son serveur', async () => {
    const res = await supprimer(`/api/guilds/${GUILD_B}/tempvoice/active/${SALON_DE_B}`, {
        authorization: `Bearer ${jetonAdminDeB}`,
    });
    assert.equal(res.status, 200);
    assert.equal(ligneExiste(SALON_DE_B), false, 'la suppression legitime doit aboutir');
});

test('un compte sans droit d administration est refuse', async () => {
    const jetonSimple = generateToken({
        id: '930000000000000002', username: 'membre', avatar: null,
        guilds: [{ id: GUILD_B, permissions: '0' }],
    });
    const res = await supprimer(`/api/guilds/${GUILD_B}/tempvoice/active/${SALON_DE_B}`, {
        authorization: `Bearer ${jetonSimple}`,
    });
    assert.equal(res.status, 403);
});

test('toutes les requetes du routeur TempVoice portent leur guild_id', () => {
    // Balayage du source : une requête SQL de ce fichier qui toucherait une table
    // tempvoice_* sans clause `guild_id` rouvrirait exactement la même faille sur
    // une autre route. Les tests fonctionnels ne couvrent qu'un chemin ; ceci les
    // couvre tous.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'tempvoice.js'), 'utf8');
    const fautives = [];
    // Chaque littéral passé à db.prepare() est lu entier, quel que soit son
    // délimiteur (guillemets simples ou gabarit multiligne).
    for (const [, , sql] of source.matchAll(/db\.prepare\(\s*(['"`])([\s\S]*?)\1/g)) {
        if (!/tempvoice_/.test(sql)) continue;
        if (!/guild_id/.test(sql)) fautives.push(sql.replace(/\s+/g, ' ').trim());
    }
    assert.deepEqual(fautives, [], `requete(s) sans cloisonnement guild_id : ${fautives.join(' | ')}`);
});
