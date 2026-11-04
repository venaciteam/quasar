// ═══════════════════════════════════════════════════════════════
//  Lot 7 — l'API et le dashboard passent par l'adaptateur
//
//  Ce que ces tests tiennent, et qui ne se voit nulle part ailleurs :
//
//   1. `GET /api/plateforme` dit ce que la plateforme sait faire. C'est la
//      SEULE source du masquage côté dashboard : si elle ment, le front propose
//      des boutons qui échouent.
//   2. Un module que la plateforme n'a pas répond 404, et pas 401 : le refus ne
//      dépend pas de qui demande.
//   3. Le mode panique distingue « indisponible sur cette plateforme » d'une
//      requête mal formée. Un 400 nu ferait chercher une faute de saisie qui
//      n'existe pas.
//   4. Le panneau de tickets posé par le dashboard porte le nom que la commande
//      DÉCLARE. C'est le contrôle le plus important du fichier : un nom qui
//      diverge produit un panneau parfaitement affiché dont le bouton n'est
//      jamais routé — aucune erreur, aucun journal.
//   5. Les deux modules RGPD (rétention, effacement) passent par le client REST
//      normalisé, et la rétention refuse d'agir sur une liste de serveurs
//      INDÉTERMINABLE.
//
//  QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
// ═══════════════════════════════════════════════════════════════

process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi } = require('../api');
const { generateToken } = require('../api/middleware/auth');
const { getDb } = require('../api/services/database');
const plateformeService = require('../api/services/plateforme');

const GUILDE = '700000000000000001';
const ADMIN = '710000000000000001';

// ─── Adaptateurs de test ────────────────────────────────────────────────────
//
// Réduits à ce que `api/` lit : un nom, des capacités, une identité, un client
// REST normalisé. Pas de `client` natif — c'est précisément ce que le lot 7
// cesse d'exiger.

function faireAdaptateur({ nom = 'discord', capacites = {}, prefixe = null, api = {} } = {}) {
    const adaptateur = {
        nom,
        capacites: {
            interactions: true, ephemere: true, automod: true, audioBot: true,
            timeout: true, bulkDelete: true, fils: true, pauseInvitations: true,
            ...capacites,
        },
        moi: { id: '790000000000000000', nom: 'Quasar#0000' },
        api: { async envoyerMessage() { return { id: 'm1' }; }, ...api },
    };
    if (prefixe) Object.defineProperty(adaptateur, 'prefixe', { value: prefixe, enumerable: false });
    return adaptateur;
}

const CAPACITES_FLUXER = {
    interactions: false, ephemere: false, automod: false, audioBot: false,
    timeout: true, bulkDelete: true, fils: false, pauseInvitations: false,
};

let serveurs = [];

function monter(adaptateur) {
    return new Promise((resolve) => {
        const app = createApi(adaptateur, 'bot');
        const serveur = app.listen(0, '127.0.0.1', () => {
            serveurs.push(serveur);
            resolve(`http://127.0.0.1:${serveur.address().port}`);
        });
    });
}

function requete(base, chemin, { methode = 'GET', jeton = null } = {}) {
    return new Promise((resolve, reject) => {
        const headers = jeton ? { Authorization: `Bearer ${jeton}` } : {};
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
        req.end();
    });
}

const jetonAdmin = generateToken({
    id: ADMIN, username: 'admin', avatar: null,
    guilds: [{ id: GUILDE, name: 'Serveur de test', icon: null, permissions: '8' }],
});

before(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Serveur de test');
    // Contrat de sous-traitance accepté : sans lui, `requireContract` répond 403
    // sur tous les routeurs guild-scoped et on n'atteindrait jamais les gardes
    // qu'on veut éprouver.
    require('../api/services/contract').recordAcceptance(ADMIN);
});

after(() => { for (const s of serveurs) s.close(); });

// ─── 1. GET /api/plateforme ─────────────────────────────────────────────────

test('GET /api/plateforme — côté Discord : tout est possible, aucun préfixe', async () => {
    const base = await monter(faireAdaptateur());
    const res = await requete(base, '/api/plateforme');

    assert.equal(res.status, 200);
    assert.equal(res.json.nom, 'discord');
    assert.equal(res.json.capacites.interactions, true);
    assert.equal(res.json.capacites.automod, true);
    assert.equal(res.json.capacites.pauseInvitations, true);
    // `null` et non `'/'` : le préfixe est ce qui précède une commande TEXTE.
    // Là où il y a des commandes d'application, la question n'a pas d'objet.
    assert.equal(res.json.prefixe, null);
});

test('GET /api/plateforme — côté Fluxer : les capacités absentes et le préfixe réel', async () => {
    const base = await monter(faireAdaptateur({ nom: 'fluxer', capacites: CAPACITES_FLUXER, prefixe: '!' }));
    const res = await requete(base, '/api/plateforme');

    assert.equal(res.status, 200);
    assert.equal(res.json.nom, 'fluxer');
    assert.deepEqual(res.json.capacites, CAPACITES_FLUXER);
    assert.equal(res.json.prefixe, '!');
});

test('GET /api/plateforme — sans authentification : la page de connexion en a besoin avant d\'avoir un jeton', async () => {
    const base = await monter(faireAdaptateur());
    const res = await requete(base, '/api/plateforme');
    assert.equal(res.status, 200);
});

test('GET /api/plateforme — API montée sans bot : toutes capacités à faux, jamais une exception', async () => {
    // C'est ce que passent les tests qui montent l'API sans démarrer de bot.
    // Le défaut doit être le plus restrictif : le dashboard masquera plutôt que
    // de proposer un bouton qui échoue.
    const base = await monter({});
    const res = await requete(base, '/api/plateforme');

    assert.equal(res.status, 200);
    assert.equal(res.json.nom, null);
    assert.equal(Object.values(res.json.capacites).some(Boolean), false);
});

// ─── 2. Un module absent répond 404, pas 401 ────────────────────────────────

test('AutoMod — sans la capacité, la route répond 404 AVANT toute question d\'identité', async () => {
    const base = await monter(faireAdaptateur({ nom: 'fluxer', capacites: CAPACITES_FLUXER, prefixe: '!' }));
    const res = await requete(base, `/api/guilds/${GUILDE}/automod`);

    assert.equal(res.status, 404, 'la fonctionnalité n\'existe pas ici — ce n\'est pas un refus d\'accès');
    assert.match(res.json.error, /modération automatique native/);
    // Le message dit aussi ce qui RESTE disponible : sans cette phrase, on
    // croirait que toute la page de modération automatique a disparu.
    assert.match(res.json.hint, /anti-raid/);
});

test('AutoMod — avec la capacité, le garde laisse passer et l\'authentification reprend la main', async () => {
    const base = await monter(faireAdaptateur());
    const res = await requete(base, `/api/guilds/${GUILDE}/automod`);
    assert.equal(res.status, 401);
});

test('le require de api/routes/automod ne charge pas discord.js', () => {
    // `automodSync` est le miroir de l'AutoMod natif : il importe discord.js, et
    // l'importer en tête de la route le faisait charger au démarrage, y compris
    // dans un processus Fluxer qui n'en a aucun usage.
    const { execFileSync } = require('node:child_process');
    const script = `
        process.env.QUASAR_DB_PATH = ':memory:';
        require('./api/routes/automod');
        const charge = Object.keys(require.cache)
            .filter(f => f.includes(require('path').join('node_modules', 'discord.js')));
        process.stdout.write(String(charge.length));
    `;
    const sortie = execFileSync(process.execPath, ['-e', script], {
        cwd: require('path').join(__dirname, '..'), encoding: 'utf8',
    });
    assert.equal(sortie, '0');
});

// ─── 3. Mode panique : indisponible n'est pas invalide ──────────────────────

test('mode panique — plateforme sans suspension d\'invitations : 501 qui NOMME la cause', async () => {
    const base = await monter(faireAdaptateur({
        nom: 'fluxer',
        capacites: CAPACITES_FLUXER,
        prefixe: '!',
        api: {
            async obtenirEtatInvitations() { return { enPauseJusqua: null, desactiveesEnDur: false }; },
            async obtenirMembre() { return { id: '790000000000000000', aPermission: () => true }; },
            async mettreInvitationsEnPause() { throw new Error('ne devrait jamais être appelé'); },
        },
    }));

    const res = await requete(base, `/api/guilds/${GUILDE}/antiraid/panic`, { methode: 'POST', jeton: jetonAdmin });

    assert.equal(res.status, 501, 'ni 400 (requête valide) ni 502 (rien n\'a été tenté)');
    assert.match(res.json.error, /ne sait pas suspendre les invitations/);
});

test('mode panique — le bot non connecté reste un 503, pas un 501', async () => {
    // Deux causes différentes, deux réponses différentes : « je ne vois pas ce
    // serveur » se corrige en réinvitant le bot, « cette plateforme ne sait pas
    // le faire » ne se corrige pas du tout.
    const base = await monter({});
    const res = await requete(base, `/api/guilds/${GUILDE}/antiraid/panic`, { methode: 'POST', jeton: jetonAdmin });
    assert.equal(res.status, 503);
});

// ─── 4. Le panneau de tickets du dashboard porte le nom de la commande ──────

test('tickets — le dashboard pose le MÊME panneau que /ticket setup', () => {
    // Sans ce contrôle, un panneau posé depuis le dashboard s'affiche
    // parfaitement et son bouton n'est jamais routé : `routerPanneau` ne
    // reconnaît que les noms DÉCLARÉS par un descripteur. Aucune erreur, aucun
    // journal — c'est exactement le défaut que la consolidation a corrigé pour
    // les panneaux posés avant migration.
    const route = require('../api/routes/tickets');
    const commande = require('../bot/commands/ticket');

    assert.ok(
        Object.prototype.hasOwnProperty.call(commande.panneaux || {}, route.PANNEAU),
        `la commande /ticket ne déclare pas de panneau « ${route.PANNEAU} »`,
    );
    // La clé du choix est la moitié droite de l'identifiant `panneau:cle`. Elle
    // n'est pas lisible depuis le descripteur — c'est le handler qui la teste —
    // d'où ce contrôle de forme : sans « : » et non vide, sinon le routage ne
    // sait plus où couper.
    assert.equal(typeof route.CHOIX_OUVRIR.cle, 'string');
    assert.ok(route.CHOIX_OUVRIR.cle && !route.CHOIX_OUVRIR.cle.includes(':'));
});

// ─── 5. Rétention et effacement passent par le contrat ─────────────────────

test('rétention — une liste de serveurs INDÉTERMINABLE ne programme aucune purge', async () => {
    const { reconcileGuilds } = require('../bot/modules/retention');
    const db = getDb();
    db.prepare('DELETE FROM pending_guild_purges').run();

    // `null` = la connexion n'est pas établie. Programmer une purge ici
    // reviendrait à supprimer les données de serveurs parfaitement actifs.
    const resultat = await reconcileGuilds({ api: { async listerGuildes() { return null; } } });

    assert.deepEqual(resultat, { scheduled: 0, cancelled: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_guild_purges').get().n, 0);
});

test('rétention — un serveur connu mais absent de la liste voit sa purge programmée', async () => {
    const { reconcileGuilds } = require('../bot/modules/retention');
    const db = getDb();
    db.prepare('DELETE FROM pending_guild_purges').run();

    // `[]` est une RÉPONSE : le bot est connecté et n'est sur aucun serveur.
    const resultat = await reconcileGuilds({ api: { async listerGuildes() { return []; } } });

    assert.equal(resultat.scheduled, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_guild_purges WHERE guild_id = ?').get(GUILDE).n, 1);
    db.prepare('DELETE FROM pending_guild_purges').run();
});

test('rétention — le bot de retour sur un serveur annule sa purge programmée', async () => {
    const { reconcileGuilds } = require('../bot/modules/retention');
    const db = getDb();
    db.prepare('DELETE FROM pending_guild_purges').run();
    const maintenant = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO pending_guild_purges (guild_id, left_at, purge_after) VALUES (?, ?, ?)')
        .run(GUILDE, maintenant, maintenant + 86400);

    const resultat = await reconcileGuilds({ api: { async listerGuildes() { return [GUILDE]; } } });

    assert.equal(resultat.cancelled, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending_guild_purges').get().n, 0);
});

test('rétention — un bannissement INDÉTERMINABLE conserve la sanction', async () => {
    const { purgeGuildSanctions } = require('../bot/modules/retention/sanctions');
    const db = getDb();
    db.prepare('DELETE FROM sanctions WHERE guild_id = ?').run(GUILDE);
    db.prepare(`
        INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, created_at)
        VALUES (?, ?, ?, 'ban', 'vieux ban', datetime('now', '-24 months'))
    `).run(GUILDE, '730000000000000001', ADMIN);

    // Lecture impossible (permission manquante, API injoignable) : on ne peut
    // pas conclure « la personne n'est plus bannie », donc on conserve.
    const illisible = await purgeGuildSanctions(GUILDE, {
        async obtenirBannissement() { throw new Error('permission manquante'); },
    });
    assert.deepEqual(illisible, { deleted: 0, keptActiveBans: 1, skipped: null });

    // Bannissement levé : la trace peut partir.
    const leve = await purgeGuildSanctions(GUILDE, { async obtenirBannissement() { return null; } });
    assert.equal(leve.deleted, 1);
    assert.equal(leve.keptActiveBans, 0);
});

test('effacement — la relance part par ouvrirMessagePrive puis envoyerMessage', async () => {
    const { notifyOwner } = require('../bot/modules/erasure');
    const original = process.env.BOT_OWNER_ID;
    process.env.BOT_OWNER_ID = '740000000000000001';

    const appels = [];
    const adaptateur = {
        api: {
            async ouvrirMessagePrive(id) { appels.push(['ouvrirMessagePrive', id]); return 'mp-1'; },
            async envoyerMessage(canalId, contenu) { appels.push(['envoyerMessage', canalId, contenu]); return { id: 'm1' }; },
        },
    };

    try {
        await notifyOwner(adaptateur, [{ id: 4, guild_id: GUILDE, due_at: 1757000000, overdue: true }]);
    } finally {
        if (original === undefined) delete process.env.BOT_OWNER_ID;
        else process.env.BOT_OWNER_ID = original;
    }

    assert.deepEqual(appels[0], ['ouvrirMessagePrive', '740000000000000001']);
    assert.equal(appels[1][0], 'envoyerMessage');
    assert.equal(appels[1][1], 'mp-1');
    assert.match(appels[1][2], /Demandes d'effacement en attente/);
    // Pas de `subject_id` dans le message : c'est une donnée nominative, et la
    // relance n'a pas besoin d'elle pour dire ce qu'il y a à faire.
    assert.equal(appels[1][2].includes('subject'), false);
});

// ─── Le seau : api/ ne connaît plus le client natif ────────────────────────

test('api/services/plateforme — sans adaptateur, tout dégrade au lieu de lever', async () => {
    const req = { app: { get: () => null } };

    assert.equal(plateformeService.adaptateur(req), null);
    assert.equal(plateformeService.api(req), null);
    assert.equal(plateformeService.nom(req), null);
    assert.equal(plateformeService.prefixe(req), null);
    assert.equal(plateformeService.portee(req, GUILDE), null);
    assert.deepEqual(await plateformeService.listerCanaux(req, GUILDE), []);
    assert.deepEqual(await plateformeService.listerRoles(req, GUILDE), []);
    assert.deepEqual(await plateformeService.listerEmojis(req, GUILDE), []);
    assert.deepEqual(await plateformeService.listerMembres(req, GUILDE), { joignable: false, membres: [] });
});

test('api/services/plateforme — la portée est celle que bot/utils/errors.js reconnaît', () => {
    const { resoudrePorteeNeutre } = require('../bot/utils/errors');
    const adaptateur = faireAdaptateur();
    const req = { app: { get: () => adaptateur } };

    const portee = plateformeService.portee(req, GUILDE);
    const reconnue = resoudrePorteeNeutre(portee);

    assert.ok(reconnue, 'une portée non reconnue ferait taire tous les journaux de modération');
    assert.equal(reconnue.guildeId, GUILDE);
    assert.equal(reconnue.moiId, adaptateur.moi.id);
});

// ─── Non-régression des sélecteurs du dashboard ────────────────────────────
//
// Les trois listes que consomment une douzaine de pages (salons, rôles, emojis)
// gardent LEUR FORME D'ORIGINE — `name`, `color`, `type`, `identifier`.
//
// Elles étaient servies par un REPLI qui lisait le cache discord.js, et qui
// rendait une liste vide sur toute autre plateforme : les sélecteurs étaient
// muets côté Fluxer. Le contrat publie désormais `api.listerCanaux`,
// `listerRoles` et `listerEmojis` (lot 0.8), et c'est le VRAI adaptateur qu'on
// éprouve ici — pas une doublure de son repli. Les assertions, elles, n'ont pas
// bougé d'un caractère : c'est tout l'intérêt.

/** Adaptateur Discord RÉEL, sur un client discord.js réduit à ce qu'il lit. */
function faireAdaptateurAvecInventaires() {
    const guilde = {
        id: GUILDE,
        channels: {
            cache: new Map([
                ['750000000000000001', { id: '750000000000000001', name: 'general', type: 0, position: 1, parentId: null, guildId: GUILDE }],
                ['750000000000000002', { id: '750000000000000002', name: 'vocal', type: 2, position: 0, parentId: null, guildId: GUILDE }],
                // Type hors sélecteur (forum) : il ne doit pas remonter.
                ['750000000000000003', { id: '750000000000000003', name: 'forum', type: 15, position: 2, parentId: null, guildId: GUILDE }],
            ]),
        },
        roles: {
            cache: new Map([
                // @everyone porte l'identifiant du SERVEUR : c'est ce que
                // `normaliserRole` lit pour poser `parDefaut`, et c'est ce qui
                // l'exclut du sélecteur.
                [GUILDE, { id: GUILDE, name: '@everyone', hexColor: '#000000', position: 0, managed: false, guild: { id: GUILDE } }],
                ['760000000000000001', { id: '760000000000000001', name: 'Modération', hexColor: '#ff0000', position: 5, managed: false, guild: { id: GUILDE } }],
                ['760000000000000002', { id: '760000000000000002', name: 'Bot intégré', hexColor: '#00ff00', position: 3, managed: true, guild: { id: GUILDE } }],
            ]),
        },
        emojis: {
            cache: new Map([
                ['770000000000000001', {
                    id: '770000000000000001', name: 'quasar', animated: false,
                    imageURL: () => 'https://cdn.discordapp.com/emojis/770000000000000001.png',
                }],
            ]),
        },
    };

    const creerAdaptateurDiscord = require('../bot/platform/discord');
    return creerAdaptateurDiscord({
        client: {
            on() {}, once() {}, off() {}, rest: {},
            channels: { cache: new Map() },
            guilds: { cache: new Map([[GUILDE, guilde]]) },
        },
        env: {},
    });
}

test('sélecteurs — les salons gardent la forme que le front consomme', async () => {
    const base = await monter(faireAdaptateurAvecInventaires());
    const res = await requete(base, `/api/guilds/${GUILDE}/channels`, { jeton: jetonAdmin });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [
        { id: '750000000000000002', name: 'vocal', position: 0, type: 2 },
        { id: '750000000000000001', name: 'general', position: 1, type: 0 },
    ], 'triés par position, et le forum écarté comme avant migration');
});

test('sélecteurs — les rôles excluent @everyone et les rôles gérés', async () => {
    const base = await monter(faireAdaptateurAvecInventaires());
    const res = await requete(base, `/api/guilds/${GUILDE}/roles`, { jeton: jetonAdmin });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [
        { id: '760000000000000001', name: 'Modération', color: '#ff0000', position: 5 },
    ]);
});

test('sélecteurs — les emojis gardent leur identifiant prêt à coller', async () => {
    const base = await monter(faireAdaptateurAvecInventaires());
    const res = await requete(base, `/api/guilds/${GUILDE}/emojis`, { jeton: jetonAdmin });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [{
        id: '770000000000000001',
        name: 'quasar',
        animated: false,
        identifier: '<:quasar:770000000000000001>',
        url: 'https://cdn.discordapp.com/emojis/770000000000000001.png',
    }]);
});

test('sélecteurs — un bot non connecté rend une liste vide, jamais une erreur', async () => {
    const base = await monter({});
    for (const chemin of ['channels', 'roles', 'emojis']) {
        const res = await requete(base, `/api/guilds/${GUILDE}/${chemin}`, { jeton: jetonAdmin });
        assert.equal(res.status, 200, chemin);
        assert.deepEqual(res.json, [], chemin);
    }
});
