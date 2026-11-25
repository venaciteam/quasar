// ═══════════════════════════════════════════════════════════════
//  Cloisonnement par serveur : une route ne résout que ce qui est à elle
//
//  ⚠️ FAILLE RÉELLE, corrigée ici. Jusqu'en v4.10.0, une route résolvait ses
//  salons dans le cache du SERVEUR : `guild.channels.cache.get(id)`. Le
//  cloisonnement n'était donc écrit nulle part — il était PORTÉ par la forme de
//  l'appel, et un identifiant étranger rendait `undefined`.
//
//  Le client REST normalisé du chantier multiplateforme est global à l'instance.
//  `api.obtenirCanal(id)` résout n'importe quel salon de n'importe quel serveur
//  où le bot est présent, et la migration a emporté ce contrôle d'accès sans que
//  rien ne le signale. Conséquence mesurée : administratrice du serveur A,
//  j'appelais `DELETE /api/guilds/A/tempvoice/active/<salon de B>` et le salon
//  de B était DÉTRUIT, avec un `200 {"success":true}` en retour.
//
//  Trois autres routes fuyaient par la même cause, en lecture : le nom d'un
//  salon privé d'un autre serveur, les permissions du bot dedans, le nom d'une
//  catégorie étrangère.
//
//  Ce fichier tient les deux moitiés de la correction :
//
//   1. le CONTRÔLE STATIQUE — aucune route n'a le droit d'appeler
//      `api.obtenir(Canal|Role|Membre|Message)` directement. C'est lui qui
//      empêche la récidive : la règle ne dépend plus de la mémoire de qui code.
//   2. les SCÉNARIOS A → B — un identifiant du serveur B présenté sur une URL du
//      serveur A ne doit ni détruire, ni révéler, ni s'enregistrer.
//
//  ⚠️ La doublure de ce fichier rend un salon d'un AUTRE serveur. C'est le cas
//  qui manquait : `test/authz-tempvoice.test.js` passait avec un
//  `obtenirCanal: () => null`, qui n'emprunte jamais la voie fautive.
//
//  QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
// ═══════════════════════════════════════════════════════════════

process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createApi } = require('../api');
const { generateToken } = require('../api/middleware/auth');
const { getDb } = require('../api/services/database');

const RACINE = path.join(__dirname, '..');

// ─── 1. Contrôle statique ───────────────────────────────────────────────────

/** Retire les commentaires, et eux seuls (même procédé que platform-etancheite). */
function codeSeul(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function fichiersDeRoutes() {
    const dossier = path.join(RACINE, 'api', 'routes');
    return fs.readdirSync(dossier)
        .filter(f => f.endsWith('.js'))
        .map(f => path.join('api/routes', f))
        .sort();
}

test('aucune route ne résout un canal, un rôle, un membre ou un message par elle-même', () => {
    // Les quatre lecteurs par identifiant du client REST normalisé. Ils sont
    // GLOBAUX à l'instance : appelés depuis une route, ils traversent le
    // cloisonnement par serveur. `plateforme.canalDuServeur`,
    // `roleDuServeur` et `messageDuServeur` les enveloppent en comparant
    // l'entité résolue à `req.params.guildId`.
    const motif = /\.obtenir(Canal|Role|Membre|Message)\s*\(/;
    const fautifs = [];

    for (const relatif of fichiersDeRoutes()) {
        const code = codeSeul(fs.readFileSync(path.join(RACINE, relatif), 'utf8'));
        const trouve = motif.exec(code);
        if (trouve) fautifs.push(`${relatif} (${trouve[0]})`);
    }

    assert.deepEqual(
        fautifs, [],
        'Passez par api/services/plateforme.js : canalDuServeur, roleDuServeur ou messageDuServeur. '
        + 'Le client REST est global à l\'instance — une résolution par identifiant faite dans une route '
        + 'atteint les salons, rôles et messages des AUTRES serveurs où le bot est présent.',
    );
});

test('le helper scellé refuse aussi une requête sans serveur dans l\'URL', async () => {
    // Fail CLOSED. Un routeur monté hors d'un chemin `/:guildId` n'a par
    // construction aucun serveur auquel sceller, et « pas de serveur » ne peut
    // pas valoir « tous les serveurs ».
    const plateforme = require('../api/services/plateforme');
    const req = {
        params: {},
        app: { get: () => ({ api: { async envoyerMessage() {}, async obtenirCanal() { return { id: 'X', guildeId: 'Y' }; } } }) },
    };
    assert.equal(plateforme.guildeDeLUrl(req), null);
    assert.equal(await plateforme.canalDuServeur(req, 'X'), null);
    assert.equal(await plateforme.roleDuServeur(req, 'X'), null);
    assert.equal(await plateforme.messageDuServeur(req, 'X', 'M'), null);
});

// ─── 2. Scénarios A → B ─────────────────────────────────────────────────────

const SERVEUR_A = '600000000000000001';
const SERVEUR_B = '600000000000000002';
const SALON_DE_B = '610000000000000002';
const CATEGORIE_DE_B = '610000000000000012';
const ROLE_DE_B = '620000000000000002';
const ADMIN_DE_A = '630000000000000001';

// Administratrice du SEUL serveur A. C'est la position de l'attaquante : un
// compte parfaitement légitime, sur un serveur parfaitement légitime.
const jetonAdminDeA = generateToken({
    id: ADMIN_DE_A, username: 'admin-de-a', avatar: null,
    guilds: [{ id: SERVEUR_A, name: 'Serveur A', icon: null, permissions: '8' }],
});

/**
 * Adaptateur dont le client REST voit les DEUX serveurs — la situation normale
 * d'un bot public. C'est exactement ce que la doublure `() => null` de
 * `authz-tempvoice` ne reproduisait pas.
 */
function faireAdaptateurDeuxServeurs() {
    const appels = [];
    const canaux = new Map([
        ['610000000000000001', { id: '610000000000000001', nom: 'general-de-a', type: 'texte', guildeId: SERVEUR_A, parentId: null }],
        [SALON_DE_B, { id: SALON_DE_B, nom: 'salon-prive-de-b', type: 'vocal', guildeId: SERVEUR_B, parentId: null }],
        [CATEGORIE_DE_B, { id: CATEGORIE_DE_B, nom: 'categorie-de-b', type: 'categorie', guildeId: SERVEUR_B, parentId: null }],
    ]);

    return {
        appels,
        nom: 'discord',
        capacites: {
            interactions: true, ephemere: true, automod: true, audioBot: true,
            timeout: true, bulkDelete: true, fils: true, pauseInvitations: true,
        },
        moi: { id: '690000000000000000', nom: 'Quasar#0000' },
        api: {
            async envoyerMessage(canalId, contenu) { appels.push(['envoyerMessage', canalId]); return { id: 'm1', reactions: [] }; },
            async obtenirCanal(id) { appels.push(['obtenirCanal', id]); return canaux.get(String(id)) || null; },
            async obtenirRole(guildeId, roleId) {
                appels.push(['obtenirRole', guildeId, roleId]);
                // Fidèle au contrat : le rôle est cherché DANS ce serveur.
                if (String(roleId) === ROLE_DE_B && String(guildeId) !== SERVEUR_B) return null;
                return { id: String(roleId), nom: 'Role', position: 2, gere: false, guildeId: String(guildeId) };
            },
            async obtenirMessage(canalId, messageId) { appels.push(['obtenirMessage', canalId, messageId]); return { id: String(messageId), reactions: [] }; },
            async supprimerCanal(id) { appels.push(['supprimerCanal', id]); },
            async supprimerMessage(canalId, id) { appels.push(['supprimerMessage', canalId, id]); },
            async listerMembresVocal() { return []; },
            async listerGuildes() { return [SERVEUR_A, SERVEUR_B]; },
            async obtenirGuilde(id) { return { id: String(id), nom: 'Serveur', proprietaireId: null, membreCount: 1, disponible: true }; },
            async permissionsSurCanal() { appels.push(['permissionsSurCanal']); return { aPermission: () => false }; },
            async verifierRoleAttribuable() { return null; },
        },
    };
}

let serveurHttp;
let base;
let adaptateur;

before(async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(SERVEUR_A, 'Serveur A');
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(SERVEUR_B, 'Serveur B');
    require('../api/services/contract').recordAcceptance(ADMIN_DE_A);

    // Ligne TempVoice appartenant à B : c'est elle que l'attaque visait.
    db.prepare('INSERT OR IGNORE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
        .run(SALON_DE_B, SERVEUR_B, '640000000000000000', '');

    // Configuration du salon piège de A, mais pointant un salon de B : l'état
    // exact qu'une version antérieure du `PUT` laissait écrire.
    db.prepare(`INSERT INTO honeypot_config (guild_id, channel_id, enabled, punishments)
                VALUES (?, ?, 0, '')
                ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id`)
        .run(SERVEUR_A, SALON_DE_B);

    // Idem pour la catégorie de tickets.
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, enabled)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(guild_id) DO UPDATE SET category_id = excluded.category_id`)
        .run(SERVEUR_A, '610000000000000001', CATEGORIE_DE_B, '620000000000000001');

    adaptateur = faireAdaptateurDeuxServeurs();
    const app = createApi(adaptateur, 'bot');
    serveurHttp = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => serveurHttp.once('listening', resolve));
    base = `http://127.0.0.1:${serveurHttp.address().port}`;
});

after(() => serveurHttp.close());

function appeler(chemin, { methode = 'GET', corps = null } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { Authorization: `Bearer ${jetonAdminDeA}` };
        const charge = corps === null ? null : JSON.stringify(corps);
        if (charge !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(charge);
        }
        const req = http.request(`${base}${chemin}`, { method: methode, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch { /* corps non JSON */ }
                resolve({ status: res.statusCode, body, json });
            });
        });
        req.on('error', reject);
        if (charge !== null) req.write(charge);
        req.end();
    });
}

const aAppele = (nom) => adaptateur.appels.some(a => a[0] === nom);

test('BLOQUANT — supprimer un salon TempVoice d\'un AUTRE serveur : rien n\'est détruit', async () => {
    adaptateur.appels.length = 0;

    const res = await appeler(`/api/guilds/${SERVEUR_A}/tempvoice/active/${SALON_DE_B}`, { methode: 'DELETE' });

    // La réponse reste un succès — il n'y a rien à supprimer côté A, et refuser
    // en 404 confirmerait l'existence du salon de B. Ce qui compte est ailleurs.
    assert.equal(res.status, 200);
    assert.equal(
        aAppele('supprimerCanal'), false,
        'le salon d\'un autre serveur a été envoyé à la destruction : c\'est LA faille',
    );

    // Et la ligne de B est toujours là.
    const restante = getDb().prepare('SELECT guild_id FROM tempvoice_active WHERE channel_id = ?').get(SALON_DE_B);
    assert.equal(restante?.guild_id, SERVEUR_B);
});

test('un salon du serveur courant, lui, est bien supprimé', async () => {
    // Le contre-test : sans lui, un helper qui refuserait TOUT passerait le test
    // précédent sans rien protéger.
    const db = getDb();
    const salonDeA = '610000000000000001';
    db.prepare('INSERT OR IGNORE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
        .run(salonDeA, SERVEUR_A, '640000000000000001', '');
    adaptateur.appels.length = 0;

    const res = await appeler(`/api/guilds/${SERVEUR_A}/tempvoice/active/${salonDeA}`, { methode: 'DELETE' });

    assert.equal(res.status, 200);
    assert.deepEqual(adaptateur.appels.filter(a => a[0] === 'supprimerCanal'), [['supprimerCanal', salonDeA]]);
    assert.equal(db.prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(salonDeA), undefined);
});

test('salon piège — le GET ne révèle ni le nom d\'un salon d\'un autre serveur, ni les droits du bot dedans', async () => {
    adaptateur.appels.length = 0;

    const res = await appeler(`/api/guilds/${SERVEUR_A}/honeypot`);

    assert.equal(res.status, 200);
    const avertissements = (res.json.warnings || []).join(' ');
    assert.equal(
        avertissements.includes('salon-prive-de-b'), false,
        'le nom d\'un salon d\'un autre serveur a fui dans les avertissements',
    );
    // Un salon qui n'est pas à ce serveur est traité comme un salon disparu, et
    // on ne demande PAS les permissions du bot dedans.
    assert.match(avertissements, /n'existe plus sur ce serveur/);
    assert.equal(aAppele('permissionsSurCanal'), false);
});

test('tickets — le GET ne nomme pas une catégorie d\'un autre serveur', async () => {
    const res = await appeler(`/api/guilds/${SERVEUR_A}/tickets`);

    assert.equal(res.status, 200);
    assert.equal(res.json.category_name, null, 'le nom d\'une catégorie étrangère a fui');
    // L'identifiant stocké est renvoyé tel quel, comme avant : il est déjà connu
    // de qui l'a écrit, et le masquer empêcherait de le corriger.
    assert.equal(res.json.category_id, CATEGORIE_DE_B);
});

// ─── 3. Refus à l'écriture ─────────────────────────────────────────────────

test('salon piège — un salon d\'un autre serveur est REFUSÉ, pas stocké', async () => {
    const res = await appeler(`/api/guilds/${SERVEUR_A}/honeypot`, {
        methode: 'PUT',
        corps: { enabled: false, channel_id: '610000000000000001', punishments: '', log_channel: SALON_DE_B },
    });

    assert.equal(res.status, 400);
    assert.match(res.json.error, /salon des journaux/i);
    assert.match(res.json.error, /n'existe pas sur ce serveur/);

    const ligne = getDb().prepare('SELECT log_channel FROM honeypot_config WHERE guild_id = ?').get(SERVEUR_A);
    assert.notEqual(ligne.log_channel, SALON_DE_B, 'un identifiant refusé a quand même été écrit');
});

test('TempVoice — un déclencheur dans un salon d\'un autre serveur est REFUSÉ', async () => {
    const res = await appeler(`/api/guilds/${SERVEUR_A}/tempvoice/triggers`, {
        methode: 'POST',
        corps: { channel_id: SALON_DE_B },
    });

    assert.equal(res.status, 400);
    assert.match(res.json.error, /déclencheur/i);
    assert.equal(
        getDb().prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ?')
            .get(SERVEUR_A, SALON_DE_B),
        undefined,
    );
});

test('tickets — une catégorie et un rôle d\'un autre serveur sont REFUSÉS', async () => {
    const categorie = await appeler(`/api/guilds/${SERVEUR_A}/tickets`, {
        methode: 'PUT',
        corps: { category_id: SALON_DE_B },
    });
    assert.equal(categorie.status, 400);
    // `SALON_DE_B` est vocal ET étranger : les deux refus se lisent pareil, et
    // c'est voulu — distinguer confirmerait son existence.
    assert.match(categorie.json.error, /catégorie/i);

    const role = await appeler(`/api/guilds/${SERVEUR_A}/tickets`, {
        methode: 'PUT',
        corps: { staff_role_id: ROLE_DE_B },
    });
    assert.equal(role.status, 400);
    assert.match(role.json.error, /rôle staff/i);
});

test('une valeur INCHANGÉE passe, même si elle est illisible', async () => {
    // Le dashboard renvoie le formulaire entier à chaque enregistrement.
    // Refuser une valeur déjà en base rendrait la configuration insauvegardable
    // dès qu'un salon devient illisible — et rien de NOUVEAU n'entre pour
    // autant, ce qui est l'invariant qui compte.
    const res = await appeler(`/api/guilds/${SERVEUR_A}/honeypot`, {
        methode: 'PUT',
        corps: { enabled: false, channel_id: SALON_DE_B, punishments: '' },
    });

    assert.equal(res.status, 200, res.body);
    const ligne = getDb().prepare('SELECT channel_id FROM honeypot_config WHERE guild_id = ?').get(SERVEUR_A);
    assert.equal(ligne.channel_id, SALON_DE_B, 'la valeur déjà en base devait être conservée telle quelle');
});

test('un salon du serveur courant est ACCEPTÉ à l\'écriture', async () => {
    const res = await appeler(`/api/guilds/${SERVEUR_A}/honeypot`, {
        methode: 'PUT',
        corps: { enabled: true, channel_id: '610000000000000001', punishments: '', log_channel: '610000000000000001' },
    });

    assert.equal(res.status, 200, res.body);
    const ligne = getDb().prepare('SELECT channel_id, log_channel FROM honeypot_config WHERE guild_id = ?').get(SERVEUR_A);
    assert.equal(ligne.channel_id, '610000000000000001');
    assert.equal(ligne.log_channel, '610000000000000001');
});

// ─── 4. Présence : un réglage inapplicable se refuse, il ne se range pas ────

test('présence — sans méthode sur la plateforme : 501, et rien en base', async () => {
    const proprietaire = process.env.BOT_OWNER_ID;
    process.env.BOT_OWNER_ID = ADMIN_DE_A;
    const db = getDb();
    db.prepare('DELETE FROM bot_presence WHERE id = 1').run();

    try {
        const res = await appeler('/api/presence', {
            methode: 'PUT',
            corps: { status: 'dnd', activity_type: 3, activity_text: 'quelque chose' },
        });

        assert.equal(res.status, 501);
        assert.match(res.json.error, /ne sait pas définir la présence/);
        assert.equal(
            db.prepare('SELECT 1 FROM bot_presence WHERE id = 1').get(), undefined,
            'un réglage refusé a quand même été enregistré',
        );
    } finally {
        if (proprietaire === undefined) delete process.env.BOT_OWNER_ID;
        else process.env.BOT_OWNER_ID = proprietaire;
    }
});
