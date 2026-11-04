// Tests du journal de conservation LCEN (VNCT-Conservation-LCEN-DA.md, « Tests
// attendus » et section « Quasar »).
//
// Base jetable en mémoire, routeurs du dashboard montés seuls sur une
// application Express (comme test/authz-tempvoice.test.js), commandes du robot
// appelées avec de fausses interactions. Le test lit la table directement : le
// service, lui, n'a aucune voie de lecture du journal.
//
// QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');

const { generateToken } = require('../api/middleware/auth');
const { getDb } = require('../api/services/database');
const legal = require('../api/services/legalJournal');
const { purgeGuildData } = require('../bot/modules/retention/purge');
const { executeErasure } = require('../api/routes/erasure');

const ROOT = path.join(__dirname, '..');
const GUILD = '900000000000000001';
const ADMIN = '930000000000000001';
const MEMBER = '940000000000000001';
const CHANNEL = '910000000000000001';
const ROLE = '920000000000000001';
const DAY = 24 * 60 * 60 * 1000;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// ── Faux Discord (le strict nécessaire aux routes qui postent) ──

function fakeMessage(id) {
    return {
        id,
        edit: async () => {},
        delete: async () => {},
        react: async () => {},
        reactions: { cache: { find: () => null } },
    };
}
const fakeChannel = {
    id: CHANNEL,
    send: async () => fakeMessage('950000000000000001'),
    messages: { fetch: async () => fakeMessage('950000000000000001') },
};
const fakeGuild = {
    id: GUILD,
    channels: { cache: new Map([[CHANNEL, fakeChannel]]) },
    roles: { cache: new Map([[ROLE, { id: ROLE, managed: false, position: 1 }]]) },
    members: { me: null },
};

const app = express();
app.use(express.json());
// trust proxy à true : req.ip vaut alors X-Forwarded-For, que le journal doit ignorer.
app.set('trust proxy', true);
app.set('discordClient', { guilds: { cache: new Map([[GUILD, fakeGuild]]) } });
for (const [segment, file] of [
    ['embeds', 'embeds'], ['customcmds', 'customcmds'], ['welcome', 'welcome'],
    ['scheduled', 'scheduled'], ['reactionroles', 'reactionroles'], ['tickets', 'tickets'],
]) {
    app.use(`/api/guilds/:guildId/${segment}`, require(`../api/routes/${file}`));
}

const token = generateToken({
    id: ADMIN, username: 'admin', avatar: null, guilds: [{ id: GUILD, permissions: '8' }],
});

let server, base, db;

before(async () => {
    db = getDb();
    db.prepare('INSERT INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/api/guilds/${GUILD}`;
});

after(() => server.close());

// ── Utilitaires ──

const rows = () => db.prepare('SELECT * FROM legal_journal ORDER BY id').all();
const count = () => db.prepare('SELECT COUNT(*) AS n FROM legal_journal').get().n;
const since = (n) => rows().slice(n);

const CF = { 'cf-connecting-ip': '198.51.100.7', 'cf-visitor': '{"scheme":"https"}' };

async function call(method, route, body, headers = CF) {
    const res = await fetch(`${base}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
}

// Effectue l'appel et renvoie les lignes écrites par lui seul.
async function written(method, route, body, headers) {
    const n = count();
    const res = await call(method, route, body, headers);
    assert.ok(res.status < 400, `${method} ${route} → ${res.status} ${res.text}`);
    return { res, lines: since(n) };
}

function assertLine(line, { contentId, contentType, operation, ip = '198.51.100.7', protocol = 'https', authorId = ADMIN }) {
    assert.equal(line.content_id, contentId);
    assert.equal(line.content_type, contentType);
    assert.equal(line.operation, operation);
    assert.equal(line.ip, ip);
    assert.equal(line.protocol, protocol);
    assert.equal(line.author_id, authorId);
    assert.match(line.occurred_at, ISO_SECOND);
    assert.ok(Math.abs(Date.parse(line.occurred_at) - Date.now()) < 60_000, 'horodatage UTC du moment');
}

// Fausse interaction Discord : options lues dans un objet simple.
function interaction({ sub, options = {}, user = ADMIN, voiceChannel = null }) {
    const replies = [];
    return {
        user: { id: user, displayAvatarURL: () => 'https://cdn.example/avatar.png' },
        guild: { id: GUILD, name: 'Serveur de test' },
        member: {
            voice: { channel: voiceChannel }, user: { id: user, username: 'sam' }, displayName: 'Sam',
            guild: { name: 'Serveur de test', memberCount: 3 }, toString: () => `<@${user}>`,
        },
        options: {
            getSubcommand: () => sub,
            getString: (k) => options[k] ?? null,
            getInteger: (k) => options[k] ?? null,
        },
        replied: false,
        deferred: false,
        reply: async (p) => { replies.push(p); },
        followUp: async (p) => { replies.push(p); },
        replies,
    };
}

// ── Contexte de connexion ──

test('ip = CF-Connecting-IP seul ; absent, invalide ou multiple → vide, même avec X-Forwarded-For', () => {
    const req = (headers) => ({ headers, ip: '203.0.113.9' });
    assert.equal(legal.connectionIp(req({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
    assert.equal(legal.connectionIp(req({ 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
    assert.equal(legal.connectionIp(req({ 'x-forwarded-for': '203.0.113.9' })), null);
    for (const v of ['pas-une-ip', '198.51.100.7, 198.51.100.8', '']) {
        assert.equal(legal.connectionIp(req({ 'cf-connecting-ip': v })), null, `« ${v} »`);
    }
});

test('protocol = schéma de CF-Visitor seul, vide si absent ou invalide', () => {
    const req = (v) => ({ headers: v === undefined ? {} : { 'cf-visitor': v }, protocol: 'https' });
    assert.equal(legal.connectionProtocol(req('{"scheme":"https"}')), 'https');
    assert.equal(legal.connectionProtocol(req('{"scheme":"http"}')), 'http');
    for (const v of ['{"scheme":"ftp"}', 'pas du json', undefined]) {
        assert.equal(legal.connectionProtocol(req(v)), null, `« ${v} »`);
    }
});

// ── Dashboard ──

test('embed : création, modification, sauvegarde identique (rien), suppression ; consultation : rien', async () => {
    const created = await written('POST', '/embeds', { name: 'regles', data: { titre: 'Règles' } });
    const id = created.res.json.id;
    assert.equal(created.lines.length, 1);
    assertLine(created.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'embed', operation: 'create' });
    assert.deepEqual(Object.keys(created.lines[0]).sort(),
        ['author_id', 'content_id', 'content_type', 'id', 'ip', 'occurred_at', 'operation', 'protocol']);

    const updated = await written('POST', '/embeds', { name: 'regles', data: { titre: 'Règles v2' } });
    assert.equal(updated.lines.length, 1);
    assertLine(updated.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'embed', operation: 'update' });

    assert.equal((await written('POST', '/embeds', { name: 'regles', data: { titre: 'Règles v2' } })).lines.length, 0);
    assert.equal((await written('GET', '/embeds')).lines.length, 0);

    const deleted = await written('DELETE', `/embeds/${id}`);
    assert.equal(deleted.lines.length, 1);
    assertLine(deleted.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'embed', operation: 'delete' });
    assert.equal((await written('DELETE', `/embeds/${id}`)).lines.length, 0, 'suppression sans effet : rien');

    // La ligne de création survit à la suppression du contenu.
    assert.equal(rows().filter(r => r.content_id === `${GUILD}:${id}`).length, 3);
});

test('sans CF-Connecting-IP ni CF-Visitor : ip et protocol vides malgré X-Forwarded-For', async () => {
    const { lines } = await written('POST', '/embeds', { name: 'sans-cf', data: { titre: 'x' } },
        { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ip, null);
    assert.equal(lines[0].protocol, null);
    assert.equal(lines[0].author_id, ADMIN);
});

test('commande personnalisée : création, renommage, accès seul (rien), suppression', async () => {
    const created = await written('POST', '/customcmds', { name: 'aide', response: 'Bonjour' });
    assert.equal(created.lines.length, 1);
    assertLine(created.lines[0], { contentId: `${GUILD}:aide`, contentType: 'custom_command', operation: 'create' });

    const renamed = await written('PUT', '/customcmds/aide', { response: 'Bonjour', new_name: 'faq' });
    assert.equal(renamed.lines.length, 1);
    assertLine(renamed.lines[0], { contentId: `${GUILD}:faq`, contentType: 'custom_command', operation: 'update' });

    const access = await written('PUT', '/customcmds/faq', { response: 'Bonjour', access_mode: 'admins' });
    assert.equal(access.lines.length, 0, 'un changement d\'accès n\'est pas une contribution');

    const deleted = await written('DELETE', '/customcmds/faq');
    assert.equal(deleted.lines.length, 1);
    assertLine(deleted.lines[0], { contentId: `${GUILD}:faq`, contentType: 'custom_command', operation: 'delete' });
});

test('bienvenue et départ : une ligne par texte qui change, aucune pour le salon ou l\'interrupteur', async () => {
    const both = await written('PUT', '/welcome/config', { welcome_message: 'Salut {user}', leave_message: 'Au revoir' });
    assert.deepEqual(both.lines.map(l => [l.content_type, l.operation]),
        [['welcome_message', 'create'], ['leave_message', 'create']]);
    assertLine(both.lines[0], { contentId: GUILD, contentType: 'welcome_message', operation: 'create' });

    const technical = await written('PUT', '/welcome/config', {
        welcome_message: 'Salut {user}', leave_message: 'Au revoir', welcome_channel: CHANNEL, welcome_enabled: true,
    });
    assert.equal(technical.lines.length, 0);

    const embed = await written('PUT', '/welcome/config', {
        welcome_message: 'Salut {user}', welcome_embed: { title: 'Bienvenue' }, welcome_channel: CHANNEL,
    });
    assert.deepEqual(embed.lines.map(l => [l.content_type, l.operation]),
        [['welcome_message', 'update'], ['leave_message', 'delete']]);
});

test('message programmé : création, contenu modifié, horaire seul (rien), activation (rien), suppression', async () => {
    const body = { name: 'rappel', channel_id: CHANNEL, content_type: 'text', content_text: 'Réunion', schedule_type: 'daily', schedule_time: '09:00' };
    const created = await written('POST', '/scheduled', body);
    const id = created.res.json.id;
    assert.equal(created.lines.length, 1);
    assertLine(created.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'scheduled_message', operation: 'create' });

    assert.equal((await written('PUT', `/scheduled/${id}`, { ...body, schedule_time: '10:00' })).lines.length, 0);
    assert.equal((await written('POST', `/scheduled/${id}/toggle`)).lines.length, 0);

    const updated = await written('PUT', `/scheduled/${id}`, { ...body, content_text: 'Réunion déplacée' });
    assert.equal(updated.lines.length, 1);
    assertLine(updated.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'scheduled_message', operation: 'update' });

    const deleted = await written('DELETE', `/scheduled/${id}`);
    assertLine(deleted.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'scheduled_message', operation: 'delete' });
});

test('panneau de rôles : création, entrée ajoutée puis retirée (update), repost (rien), suppression', async () => {
    const created = await written('POST', '/reactionroles/panels', { channel_id: CHANNEL, title: 'Jeux' });
    const id = created.res.json.id;
    assert.equal(created.lines.length, 1);
    assertLine(created.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'reaction_panel', operation: 'create' });

    const added = await written('POST', `/reactionroles/panels/${id}/entries`, { emoji: '🎮', role_id: ROLE });
    assert.equal(added.lines.length, 1);
    assertLine(added.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'reaction_panel', operation: 'update' });

    assert.equal((await written('POST', `/reactionroles/panels/${id}/repost`)).lines.length, 0);

    const removed = await written('DELETE', `/reactionroles/panels/${id}/entries/${encodeURIComponent('🎮')}`);
    assert.equal(removed.lines.length, 1);
    assert.equal(removed.lines[0].operation, 'update');

    const deleted = await written('DELETE', `/reactionroles/panels/${id}`);
    assert.equal(deleted.lines.length, 1);
    assertLine(deleted.lines[0], { contentId: `${GUILD}:${id}`, contentType: 'reaction_panel', operation: 'delete' });

    // Réglages techniques (autorôles) : rien.
    assert.equal((await written('POST', '/reactionroles/autoroles', { role_id: ROLE })).lines.length, 0);
});

test('tickets : textes par défaut (rien), message d\'accueil créé puis modifié, rôle seul (rien)', async () => {
    const setupBody = { channel_id: CHANNEL, staff_role_id: ROLE };
    assert.equal((await written('POST', '/tickets/setup', setupBody)).lines.length, 0,
        'les textes par défaut de Quasar ne sont pas un contenu de tiers');

    const withText = await written('POST', '/tickets/setup', { ...setupBody, welcome_message: 'Décrivez votre souci' });
    assert.equal(withText.lines.length, 1);
    assertLine(withText.lines[0], { contentId: GUILD, contentType: 'ticket_texts', operation: 'create' });

    const panel = await written('PUT', '/tickets', { panel_title: 'Support' });
    assertLine(panel.lines[0], { contentId: GUILD, contentType: 'ticket_texts', operation: 'update' });

    assert.equal((await written('PUT', '/tickets', { staff_role_id: ROLE, enabled: false })).lines.length, 0);
    assert.equal((await written('GET', '/tickets')).lines.length, 0);
});

// ── Commandes du robot : auteur = identifiant Discord, pas de connexion ──

test('/embed create puis delete : lignes sans ip, auteur = identifiant Discord', async () => {
    const embedCmd = require('../bot/commands/embed');
    const n = count();
    await embedCmd.execute(interaction({ sub: 'create', options: { nom: 'annonce', titre: 'Annonce' } }));
    await embedCmd.execute(interaction({ sub: 'delete', options: { nom: 'annonce' } }));
    const lines = since(n);
    assert.deepEqual(lines.map(l => l.operation), ['create', 'delete']);
    for (const l of lines) {
        assert.equal(l.content_type, 'embed');
        assert.equal(l.ip, null);
        assert.equal(l.protocol, null);
        assert.equal(l.author_id, ADMIN);
    }
    assert.equal(lines[0].content_id, lines[1].content_id);
});

test('/welcome message : ligne welcome_message, auteur = identifiant Discord', async () => {
    const welcomeCmd = require('../bot/commands/welcome');
    const n = count();
    await welcomeCmd.execute(interaction({ sub: 'message', options: { texte: 'Coucou {user}' } }));
    const lines = since(n);
    assert.equal(lines.length, 1);
    assertLine(lines[0], { contentId: GUILD, contentType: 'welcome_message', operation: 'update', ip: null, protocol: null });
});

test('nom de salon vocal choisi par un membre : création, modification, réinitialisation', async () => {
    const voiceCmd = require('../bot/commands/voice');
    const voiceChannel = { id: '960000000000000001', setName: async () => {}, setUserLimit: async () => {} };
    db.prepare('INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
        .run(voiceChannel.id, GUILD, MEMBER, 'cat1');
    const run = (sub, options = {}) => voiceCmd.execute(interaction({ sub, options, user: MEMBER, voiceChannel }));
    const contentId = `${GUILD}:cat1:${MEMBER}`;

    const n = count();
    await run('name', { nom: 'Le salon de Sam' });
    await run('name', { nom: 'Le salon de Sam' }); // identique : rien
    await run('limit', { places: 5 });              // réglage technique : rien
    await run('name', { nom: 'Soirée jeux' });
    await run('reset');
    const lines = since(n);
    assert.deepEqual(lines.map(l => l.operation), ['create', 'update', 'delete']);
    for (const l of lines) {
        assertLine(l, { contentId, contentType: 'tempvoice_name', operation: l.operation, ip: null, protocol: null, authorId: MEMBER });
    }
});

test('effacement art. 17 d\'un membre : delete_cascade sans ip ; ses lignes survivent', () => {
    db.prepare(`INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name) VALUES (?, ?, ?, ?)`)
        .run(GUILD, MEMBER, 'cat2', 'Mon salon');
    db.prepare(`INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, user_limit) VALUES (?, ?, ?, ?)`)
        .run(GUILD, MEMBER, 'cat3', 4); // limite seule, aucun nom : rien
    const before = rows().filter(r => r.author_id === MEMBER).length;
    const n = count();
    db.transaction(() => executeErasure(db, GUILD, MEMBER, 'non_moderation'))();
    const lines = since(n);
    assert.equal(lines.length, 1);
    assertLine(lines[0], {
        contentId: `${GUILD}:cat2:${MEMBER}`, contentType: 'tempvoice_name', operation: 'delete_cascade',
        ip: null, protocol: null, authorId: MEMBER,
    });
    assert.equal(rows().filter(r => r.author_id === MEMBER).length, before + 1);
});

test('purge d\'un serveur quitté : aucune ligne écrite, aucune effacée', () => {
    const n = count();
    purgeGuildData(GUILD);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embeds WHERE guild_id = ?').get(GUILD).n, 0, 'le serveur est bien purgé');
    assert.equal(count(), n);
});

// ── Purge, cloisonnement, export ──

test('purge : 366 jours retirée, 364 jours gardée', () => {
    const ref = Date.parse('2027-06-01T12:00:00Z');
    const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const ins = db.prepare(`INSERT INTO legal_journal (content_id, content_type, operation, occurred_at)
        VALUES (?, 'embed', 'update', ?)`);
    db.exec('BEGIN');
    try {
        ins.run('purge-366', iso(ref - 366 * DAY));
        ins.run('purge-364', iso(ref - 364 * DAY));
        legal.purgeLegalJournal(db, ref);
        const ids = db.prepare(`SELECT content_id FROM legal_journal WHERE content_id LIKE 'purge-%'`).all().map(r => r.content_id);
        assert.deepEqual(ids, ['purge-364']);
    } finally {
        db.exec('ROLLBACK');
    }
});

test('aucun code applicatif ne lit le journal', () => {
    const files = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    };
    walk(path.join(ROOT, 'api'));
    walk(path.join(ROOT, 'bot'));
    files.push(path.join(ROOT, 'index.js'));
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const reads = src.match(/(?<!DELETE\s)FROM\s+legal_journal/gi) || [];
        assert.equal(reads.length, 0, `${path.relative(ROOT, f)} lit le journal`);
    }
});

test('export : filtres, JSON sur la sortie standard, refus sans filtre', async () => {
    // Le script ouvre un fichier : la base en mémoire est copiée sur disque.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-lcen-'));
    const file = path.join(tmp, 'quasar.db');
    await db.backup(file);
    const run = (args) => new Promise((resolve) => {
        execFile(process.execPath, [path.join(ROOT, 'scripts/legal-export.js'), ...args],
            { env: { ...process.env, QUASAR_DB_PATH: file } },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    try {
        const byGuild = await run(['--guild-id', GUILD]);
        assert.equal(byGuild.code, 0, byGuild.stderr);
        const out = JSON.parse(byGuild.stdout);
        assert.equal(out.service, 'quasar');
        assert.ok(out.count > 0);
        assert.ok(out.entries.every(e => e.content_id === GUILD || e.content_id.startsWith(`${GUILD}:`)));

        const byMember = JSON.parse((await run(['--author-id', MEMBER])).stdout);
        assert.ok(byMember.count >= 4);
        assert.ok(byMember.entries.every(e => e.author_id === MEMBER && e.ip === null));

        const today = new Date().toISOString().slice(0, 10);
        const byContent = JSON.parse((await run(['--content-id', `${GUILD}:faq`, '--from', today, '--to', today])).stdout);
        assert.deepEqual(byContent.entries.map(e => e.operation), ['update', 'delete']);
        assert.equal(JSON.parse((await run(['--to', '2020-01-01'])).stdout).count, 0);

        const none = await run([]);
        assert.equal(none.code, 2);
        assert.equal(none.stdout, '');
        assert.equal((await run(['--from', 'pas-une-date'])).code, 2);
        assert.equal((await run(['--guild-id', '9%'])).code, 2, 'aucun joker LIKE');

        // Lecture seule : la base n'a pas bougé.
        const check = new Database(file, { readonly: true });
        assert.equal(check.prepare('SELECT COUNT(*) AS n FROM legal_journal').get().n, count());
        check.close();
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
