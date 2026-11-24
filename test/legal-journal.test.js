// Tests du journal de conservation LCEN (VNCT-Conservation-LCEN-DA.md, « Tests
// attendus » et section « Quasar »).
//
// Base jetable en mémoire, routeurs du dashboard montés seuls sur une
// application Express (comme test/authz-tempvoice.test.js) sur un faux
// adaptateur, commandes et boutons du robot appelés avec un faux contexte
// neutre — une fois en Discord, une fois en Fluxer. Le test lit la table directement : le
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

// ── Faux adaptateur (le strict nécessaire aux routes qui postent) ──
//
// v5 : les routes ne lisent plus le client discord.js, elles passent par
// api/services/plateforme.js et le contrat neutre de l'adaptateur. Le même
// faux sert une instance « discord » et une instance « fluxer » : seul le nom
// change, exactement comme entre les deux déploiements réels.

function fauxAdaptateur(nom) {
    const canaux = new Map([[CHANNEL, { id: CHANNEL, nom: 'general', type: 'texte', guildeId: GUILD, parentId: null }]]);
    const message = (id) => ({ id, canalId: CHANNEL, guildeId: GUILD, reactions: [] });
    return {
        nom,
        capacites: { interactions: nom === 'discord', ephemere: nom === 'discord' },
        moi: { id: '990000000000000001', nom: 'Quasar' },
        api: {
            async obtenirCanal(id) { return canaux.get(String(id)) || null; },
            async obtenirRole(guildeId, roleId) {
                return String(roleId) === ROLE && String(guildeId) === GUILD
                    ? { id: ROLE, nom: 'Joueurs', position: 1, gere: false, guildeId: GUILD }
                    : null;
            },
            async verifierRoleAttribuable() { return null; },
            async envoyerMessage() { return message('950000000000000001'); },
            async obtenirMessage(canalId, id) { return message(String(id)); },
            async modifierMessage(canalId, id) { return message(String(id)); },
            async supprimerMessage() {},
            async ajouterReaction() {},
            async retirerReaction() {},
            async listerGuildes() { return [GUILD]; },
            async obtenirGuilde(id) { return { id: String(id), nom: 'Serveur de test', proprietaireId: null, membreCount: 3, disponible: true }; },
            async permissionsSurCanal() { return { aPermission: () => true }; },
        },
        async poserPanneau() { return message('950000000000000002'); },
    };
}

function monterApp(adaptateur) {
    const app = express();
    app.use(express.json());
    // trust proxy à true : req.ip vaut alors X-Forwarded-For, que le journal doit ignorer.
    app.set('trust proxy', true);
    app.set('plateforme', adaptateur);
    for (const [segment, file] of [
        ['embeds', 'embeds'], ['customcmds', 'customcmds'], ['welcome', 'welcome'],
        ['scheduled', 'scheduled'], ['reactionroles', 'reactionroles'], ['tickets', 'tickets'],
    ]) {
        app.use(`/api/guilds/:guildId/${segment}`, require(`../api/routes/${file}`));
    }
    return app;
}

const app = monterApp(fauxAdaptateur('discord'));

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

// Faux contexte NEUTRE (bot/platform/, DA multiplateforme §5) : c'est la seule
// chose qu'une commande ou un bouton voit, sur Discord comme sur Fluxer. Les
// mêmes scénarios sont donc joués une fois par plateforme, avec des
// identifiants d'auteur distincts — chaque instance a sa base et ses propres
// identifiants, le journal doit consigner ceux de SA plateforme.
const AUTEURS = {
    discord: { admin: ADMIN, membre: MEMBER },
    fluxer: { admin: '1300000000000000001', membre: '1400000000000000001' },
};

function faireCtx({ plateforme, sub = null, options = {}, user, canalId = CHANNEL, canalVocalId = null, reponses = null }) {
    const replies = [];
    const membre = {
        id: user, nom: 'Sam', mention: `<@${user}>`, roles: [], estAdmin: true, canalVocalId,
        aPermission: () => true, avatar: () => 'https://cdn.example/avatar.png',
    };
    const message = (id) => ({ id, canalId, guildeId: GUILD, reactions: [] });
    const api = new Proxy({
        async obtenirCanal(id) { return { id: String(id), nom: 'salon', type: 'texte', guildeId: GUILD, parentId: null }; },
        async envoyerMessage() { return message('960000000000000099'); },
        async permissionsSurCanal() { return { aPermission: () => true }; },
        async verifierRoleAttribuable() { return null; },
    }, {
        // Toute autre méthode du client REST : succès neutre. Le journal ne
        // dépend d'aucune d'elles, seules les écritures en base comptent ici.
        get: (cible, nom) => (nom in cible ? cible[nom] : async () => message('960000000000000098')),
    });
    return {
        plateforme,
        capacites: { interactions: plateforme === 'discord', ephemere: plateforme === 'discord' },
        guildeId: GUILD,
        canalId,
        auteur: { id: user, nom: 'Sam', mention: `<@${user}>`, etiquette: 'sam' },
        membre,
        guilde: { id: GUILD, nom: 'Serveur de test', membreCount: 3 },
        moi: { id: '990000000000000001', nom: 'Quasar' },
        options: { sousCommande: sub, get: (k) => options[k] ?? null },
        db,
        api,
        replies,
        async repondre(p) { replies.push(p); },
        async suivre(p) { replies.push(p); },
        async erreurUtilisateur(spec) { replies.push({ erreur: spec }); },
        async prompt() { return reponses; },
        async modifierPanneau(p) { replies.push(p); },
        async poserPanneau() { return message('960000000000000097'); },
        deployerCommandeServeur: async () => true,
        retirerCommandeServeur: async () => true,
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

// ── Commandes et boutons du robot : auteur = ctx.auteur, pas de connexion ──

test('legal.fromCtx : auteur = ctx.auteur.id, jamais d\'ip ni de protocole', () => {
    assert.deepEqual(legal.fromCtx({ auteur: { id: ADMIN }, membre: { id: 'autre' } }),
        { ip: null, protocol: null, authorId: ADMIN });
    // Un identifiant numérique est rangé en texte, comme les snowflakes partout ailleurs.
    assert.equal(legal.fromCtx({ auteur: { id: 1300000000000000 } }).authorId, '1300000000000000');
    // Pas d'auteur : la ligne s'écrit quand même, sans identifiant (jamais d'exception).
    assert.deepEqual(legal.fromCtx({}), { ip: null, protocol: null, authorId: null });
    assert.deepEqual(legal.fromCtx(null), { ip: null, protocol: null, authorId: null });
    assert.equal(legal.fromInteraction, undefined, 'plus de voie discord.js dans le journal');
});

for (const plateforme of ['discord', 'fluxer']) {
    const { admin, membre } = AUTEURS[plateforme];
    const sansConnexion = (l, authorId = admin) => {
        assert.equal(l.ip, null);
        assert.equal(l.protocol, null);
        assert.equal(l.author_id, authorId);
    };

    test(`[${plateforme}] /embed create puis delete : lignes sans ip, auteur = identifiant ${plateforme}`, async () => {
        const embedCmd = require('../bot/commands/embed');
        const nom = `annonce-${plateforme}`;
        const n = count();
        await embedCmd.executer(faireCtx({ plateforme, sub: 'create', options: { nom, titre: 'Annonce' }, user: admin }));
        await embedCmd.executer(faireCtx({ plateforme, sub: 'create', options: { nom, titre: 'Annonce' }, user: admin })); // identique : rien
        await embedCmd.executer(faireCtx({ plateforme, sub: 'delete', options: { nom }, user: admin }));
        const lines = since(n);
        assert.deepEqual(lines.map(l => l.operation), ['create', 'delete']);
        for (const l of lines) {
            assert.equal(l.content_type, 'embed');
            sansConnexion(l);
        }
        assert.equal(lines[0].content_id, lines[1].content_id);
    });

    test(`[${plateforme}] /cmd create, edit (renommage), delete : auteur = identifiant ${plateforme}`, async () => {
        const cmd = require('../bot/commands/customcmd');
        const nom = `regle-${plateforme}`;
        const n = count();
        await cmd.executer(faireCtx({ plateforme, sub: 'create', options: { nom, reponse: 'Soyez sympas.' }, user: admin }));
        await cmd.executer(faireCtx({ plateforme, sub: 'edit', options: { nom, nouveau_nom: `${nom}s` }, user: admin }));
        await cmd.executer(faireCtx({ plateforme, sub: 'delete', options: { nom: `${nom}s` }, user: admin }));
        const lines = since(n);
        assert.deepEqual(lines.map(l => [l.operation, l.content_id]),
            [['create', `${GUILD}:${nom}`], ['update', `${GUILD}:${nom}s`], ['delete', `${GUILD}:${nom}s`]]);
        for (const l of lines) {
            assert.equal(l.content_type, 'custom_command');
            sansConnexion(l);
        }
    });

    test(`[${plateforme}] /welcome message : ligne welcome_message, auteur = identifiant ${plateforme}`, async () => {
        const welcomeCmd = require('../bot/commands/welcome');
        const n = count();
        await welcomeCmd.executer(faireCtx({ plateforme, sub: 'message', options: { texte: `Coucou {user} (${plateforme})` }, user: admin }));
        const lines = since(n);
        assert.equal(lines.length, 1);
        assertLine(lines[0], { contentId: GUILD, contentType: 'welcome_message', operation: 'update', ip: null, protocol: null, authorId: admin });
    });

    test(`[${plateforme}] /reactionrole create, add, remove, delete : une ligne par changement du panneau`, async () => {
        const descripteur = require('../bot/commands/reactionrole');
        const rr = { executer: (ctx) => descripteur.sousCommandes.find(x => x.nom === ctx.options.sousCommande).executer(ctx) };
        const role = { id: ROLE, nom: 'Joueurs', mention: `<@&${ROLE}>`, position: 1, gere: false, guildeId: GUILD };
        const n = count();
        await rr.executer(faireCtx({ plateforme, sub: 'create', options: { channel: { id: CHANNEL }, titre: `Jeux ${plateforme}` }, user: admin }));
        const panelId = db.prepare('SELECT id FROM reaction_panels WHERE title = ?').get(`Jeux ${plateforme}`).id;
        await rr.executer(faireCtx({ plateforme, sub: 'add', options: { panel_id: panelId, emoji: '🎮', role }, user: admin }));
        await rr.executer(faireCtx({ plateforme, sub: 'remove', options: { panel_id: panelId, emoji: '🎮' }, user: admin }));
        await rr.executer(faireCtx({ plateforme, sub: 'delete', options: { panel_id: panelId }, user: admin }));
        const lines = since(n);
        assert.deepEqual(lines.map(l => l.operation), ['create', 'update', 'update', 'delete']);
        for (const l of lines) {
            assert.equal(l.content_type, 'reaction_panel');
            assert.equal(l.content_id, `${GUILD}:${panelId}`);
            sansConnexion(l);
        }
    });

    test(`[${plateforme}] /ticket setup : ligne ticket_texts seulement si le message d\'accueil change`, async () => {
        const descripteur = require('../bot/commands/ticket');
        const ticket = { executer: (ctx) => descripteur.sousCommandes.find(x => x.nom === ctx.options.sousCommande).executer(ctx) };
        const options = (message) => ({ salon: { id: CHANNEL, nom: 'support', guildeId: GUILD }, staff: { id: ROLE, nom: 'Staff', guildeId: GUILD }, message });
        const n = count();
        await ticket.executer(faireCtx({ plateforme, sub: 'setup', options: options(`Accueil ${plateforme}`), user: admin }));
        await ticket.executer(faireCtx({ plateforme, sub: 'setup', options: options(`Accueil ${plateforme}`), user: admin })); // identique : rien
        const lines = since(n);
        assert.deepEqual(lines.map(l => l.operation), ['update']);
        assert.equal(lines[0].content_type, 'ticket_texts');
        sansConnexion(lines[0]);
    });

    test(`[${plateforme}] nom de salon vocal : /voice et boutons du panneau, auteur = le membre ${plateforme}`, async () => {
        const voiceCmd = require('../bot/commands/voice');
        const { handlerPanneauTempVoice } = require('../bot/interactions/tempvoice');
        const salon = plateforme === 'discord' ? '960000000000000001' : '1600000000000000001';
        const categorie = `cat-${plateforme}`;
        db.prepare('INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
            .run(salon, GUILD, membre, categorie);
        const voix = (sub, options = {}) => voiceCmd.executer(faireCtx({ plateforme, sub, options, user: membre, canalVocalId: salon }));
        // Bouton du panneau : contexte de panneau, l'auteur est la personne qui CLIQUE.
        const bouton = (cle, reponses = null) => handlerPanneauTempVoice(
            faireCtx({ plateforme, user: membre, canalId: salon, canalVocalId: salon, reponses }), cle);
        const contentId = `${GUILD}:${categorie}:${membre}`;

        const n = count();
        await voix('name', { nom: 'Le salon de Sam' });
        await voix('name', { nom: 'Le salon de Sam' });   // identique : rien
        await voix('limit', { places: 5 });               // réglage technique : rien
        await bouton('limit', { limit: '7' });            // idem, par le bouton : rien
        await bouton('rename', { name: 'Soirée jeux' });  // update, par le bouton
        await bouton('rename', null);                     // formulaire abandonné : rien
        await bouton('reset');                            // delete, par le bouton
        await voix('name', { nom: 'Retour' });            // create
        await voix('reset');                              // delete
        const lines = since(n);
        assert.deepEqual(lines.map(l => l.operation), ['create', 'update', 'delete', 'create', 'delete']);
        for (const l of lines) {
            assertLine(l, { contentId, contentType: 'tempvoice_name', operation: l.operation, ip: null, protocol: null, authorId: membre });
        }
    });
}

test('[fluxer] dashboard : même règle (IP Cloudflare, auteur = identifiant Fluxer de l\'admin)', async () => {
    const fluxer = monterApp(fauxAdaptateur('fluxer')).listen(0);
    await new Promise((r) => fluxer.once('listening', r));
    try {
        const admin = AUTEURS.fluxer.admin;
        const jeton = generateToken({ id: admin, username: 'admin-fluxer', avatar: null, guilds: [{ id: GUILD, permissions: '8' }] });
        const n = count();
        const res = await fetch(`http://127.0.0.1:${fluxer.address().port}/api/guilds/${GUILD}/embeds`, {
            method: 'POST',
            headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json', ...CF },
            body: JSON.stringify({ name: 'regles-fluxer', data: { titre: 'Règles' } }),
        });
        const corps = await res.text();
        assert.ok(res.status < 400, `POST /embeds → ${res.status} ${corps}`);
        const lines = since(n);
        assert.equal(lines.length, 1);
        assertLine(lines[0], { contentId: `${GUILD}:${JSON.parse(corps).id}`, contentType: 'embed', operation: 'create', authorId: admin });
    } finally {
        fluxer.close();
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
    const run = (args, env = {}) => new Promise((resolve) => {
        const base = { ...process.env, QUASAR_DB_PATH: file };
        delete base.QUASAR_PLATFORM;
        execFile(process.execPath, [path.join(ROOT, 'scripts/legal-export.js'), ...args],
            { env: { ...base, ...env } },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    try {
        const byGuild = await run(['--guild-id', GUILD]);
        assert.equal(byGuild.code, 0, byGuild.stderr);
        const out = JSON.parse(byGuild.stdout);
        assert.equal(out.service, 'quasar');
        assert.equal(out.platform, 'discord', 'QUASAR_PLATFORM absent : instance Discord');
        assert.ok(out.count > 0);
        assert.ok(out.entries.every(e => e.content_id === GUILD || e.content_id.startsWith(`${GUILD}:`)));

        const byMember = JSON.parse((await run(['--author-id', MEMBER])).stdout);
        assert.ok(byMember.count >= 4);
        assert.ok(byMember.entries.every(e => e.author_id === MEMBER && e.ip === null));

        const today = new Date().toISOString().slice(0, 10);
        const byContent = JSON.parse((await run(['--content-id', `${GUILD}:faq`, '--from', today, '--to', today])).stdout);
        assert.deepEqual(byContent.entries.map(e => e.operation), ['update', 'delete']);
        assert.equal(JSON.parse((await run(['--to', '2020-01-01'])).stdout).count, 0);

        // Instance Fluxer : l'export le dit, pour qu'une autorité sache à quel
        // service rattacher les identifiants. Une valeur inconnue arrête tout.
        const surFluxer = await run(['--author-id', AUTEURS.fluxer.admin], { QUASAR_PLATFORM: 'fluxer' });
        assert.equal(surFluxer.code, 0, surFluxer.stderr);
        const fluxerOut = JSON.parse(surFluxer.stdout);
        assert.equal(fluxerOut.platform, 'fluxer');
        assert.ok(fluxerOut.count >= 4 && fluxerOut.entries.every(e => e.author_id === AUTEURS.fluxer.admin));
        const inconnue = await run(['--guild-id', GUILD], { QUASAR_PLATFORM: 'myspace' });
        assert.equal(inconnue.code, 2);
        assert.equal(inconnue.stdout, '');

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
