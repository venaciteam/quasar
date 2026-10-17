// Compléments de contrat du lot 0.4 : ce que la voie neutre avait perdu par
// rapport à la voie historique, côté sécurité des sanctions.
//
// Raison d'être commune : `bot/platform/**` est en lecture seule pour les lots
// parallèles (DA §11.5). Ces quatre pièces — identité du bot, propriétaire du
// serveur, hiérarchie des rôles, codes d'erreur — sont celles sans lesquelles
// une commande migrée protège MOINS qu'avant migration. Un garde absent ne se
// voit pas : il ne produit ni erreur ni journal, il laisse simplement passer.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const creerAdaptateurDiscord = require('../bot/platform/discord');
const { creerContexteCommande } = require('../bot/platform/discord/context');
const { normaliserGuilde } = require('../bot/platform/discord/context');
const { CODES_NEUTRES, codeNeutre, estCodeNeutre } = require('../bot/platform/erreurs');
const { TABLE, marquerErreur } = require('../bot/platform/discord/erreurs');
const { PERMISSION_PAR_SANCTION, SANCTIONS } = require('../bot/platform/discord/api');
const { resoudrePorteeNeutre } = require('../bot/utils/errors');
const { unreachableTarget } = require('../bot/utils/punishments');

const GUILDE = '100000000000000001';
const PROPRIETAIRE = '100000000000000009';
const BOT = '100000000000000007';

const erreurApi = (code) => Object.assign(new Error('erreur simulée'), { code });

/**
 * Client réduit. `membres` décrit ce que la guilde rend, `moiPermissions` ce que
 * le bot a le droit de faire.
 */
function faireClient({ membres = {}, moiPermissions = [], sansMoi = false } = {}) {
    const { BITS } = require('../bot/platform/discord/permissions');
    const me = sansMoi ? null : { permissions: { has: (bit) => moiPermissions.some(n => BITS[n] === bit) } };

    const guilde = {
        id: GUILDE,
        name: 'Serveur de test',
        ownerId: PROPRIETAIRE,
        roles: { cache: new Map(), fetch: async () => null },
        members: {
            me,
            cache: new Map(),
            fetch: async (id) => {
                const decrit = membres[id];
                if (!decrit) throw erreurApi(10007);
                if (decrit.leve) throw erreurApi(decrit.leve);
                return {
                    id,
                    guild: guilde,
                    get manageable() {
                        if (decrit.moiHorsCache) throw new Error('GuildUncachedMe');
                        return decrit.manageable !== false;
                    },
                };
            },
        },
    };

    return {
        guilde,
        client: {
            once() {}, on() {}, off() {},
            rest: {},
            channels: { cache: new Map() },
            guilds: { cache: new Map([[GUILDE, guilde]]), fetch: async () => guilde },
        },
    };
}

function faireContexte(adaptateur, guilde) {
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: guilde, channel: { id: 'C1' }, channelId: 'C1',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        options: { getSubcommand: () => null },
    };
    return creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });
}

// ── 1. ctx.moi ───────────────────────────────────────────────────────────────

test('ctx.moi est lu sur l\'adaptateur À CHAQUE ACCÈS, pas capturé à la création', () => {
    // Un contexte construit avant la connexion figerait un `moi` nul pour
    // toujours — et la garde « le bot ne se sanctionne pas lui-même »
    // disparaîtrait sans que rien ne le signale.
    const { client, guilde } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const ctx = faireContexte(adaptateur, guilde);

    assert.equal(ctx.moi.id, null, 'nul tant que la connexion n\'est pas faite');

    adaptateur.moi.id = BOT;
    adaptateur.moi.nom = 'Quasar#0000';
    assert.equal(ctx.moi.id, BOT, 'le contexte doit voir la connexion survenue après sa création');
    assert.equal(ctx.moi.nom, 'Quasar#0000');
});

test('une portée construite depuis ctx porte l\'identité du bot', () => {
    // C'est `resoudrePorteeNeutre` (bot/utils/errors.js) qui lit `moi.id` : sans
    // `ctx.moi`, `applyPunishments({ portee: ctx })` obtenait moiId=null, donc
    // ni garde anti-auto-sanction ni pré-contrôle BAN_MEMBERS.
    const { client, guilde } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    adaptateur.moi.id = BOT;

    const portee = resoudrePorteeNeutre(faireContexte(adaptateur, guilde));
    assert.equal(portee.moiId, BOT);
    assert.equal(unreachableTarget(portee, BOT), 'Je ne me sanctionne pas moi-même.');
});

// ── 2. verifierMembreSanctionnable ───────────────────────────────────────────

test('les trois actions de sanction exigent chacune leur permission', () => {
    assert.deepEqual({ ...PERMISSION_PAR_SANCTION }, {
        timeout: 'MODERATE_MEMBERS',
        kick: 'KICK_MEMBERS',
        ban: 'BAN_MEMBERS',
    });
    assert.deepEqual([...SANCTIONS], ['timeout', 'kick', 'ban']);
});

test('un membre plus haut dans la hiérarchie rend « hierarchie », pas « permission »', async () => {
    // Les deux causes n'appellent pas la même correction : remonter le rôle du
    // bot, ou lui cocher une permission. Un message unique envoie chercher au
    // mauvais endroit une fois sur deux.
    const { client } = faireClient({
        membres: { M1: { manageable: false } },
        moiPermissions: ['BAN_MEMBERS', 'KICK_MEMBERS', 'MODERATE_MEMBERS'],
    });
    const { api } = creerAdaptateurDiscord({ client });
    for (const action of SANCTIONS) {
        assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', action), 'hierarchie', action);
    }
});

test('une permission manquante rend « permission », action par action', async () => {
    const { client } = faireClient({
        membres: { M1: { manageable: true } },
        moiPermissions: ['KICK_MEMBERS'],
    });
    const { api } = creerAdaptateurDiscord({ client });
    assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', 'kick'), null);
    assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', 'ban'), 'permission');
    assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', 'timeout'), 'permission');
});

test('rien ne s\'oppose à la sanction quand hiérarchie et permission sont acquises', async () => {
    const { client } = faireClient({
        membres: { M1: { manageable: true } },
        moiPermissions: ['BAN_MEMBERS', 'KICK_MEMBERS', 'MODERATE_MEMBERS'],
    });
    const { api } = creerAdaptateurDiscord({ client });
    for (const action of SANCTIONS) {
        assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', action), null, action);
    }
});

test('un pré-contrôle indéterminable ne bloque jamais', async () => {
    // Membre parti, API injoignable, identité du bot hors cache : dans les trois
    // cas la sanction elle-même échouera avec un code exact. Inventer un refus
    // ici empêcherait une sanction légitime sur un simple défaut de cache.
    const cas = [
        ['membre parti', { membres: {}, moiPermissions: ['BAN_MEMBERS'] }],
        ['API injoignable', { membres: { M1: { leve: 'ECONNRESET' } }, moiPermissions: ['BAN_MEMBERS'] }],
        ['identité du bot hors cache', { membres: { M1: { moiHorsCache: true } }, moiPermissions: ['BAN_MEMBERS'] }],
        ['members.me absent', { membres: { M1: { manageable: true } }, sansMoi: true }],
    ];
    for (const [libelle, options] of cas) {
        const { api } = creerAdaptateurDiscord({ client: faireClient(options).client });
        assert.equal(await api.verifierMembreSanctionnable(GUILDE, 'M1', 'ban'), null, libelle);
    }
});

test('une action de sanction inconnue lève, en nommant les valeurs acceptées', async () => {
    // Faute de frappe dans un lot parallèle : « timeouts » rendrait sinon
    // silencieusement `null`, et le pré-contrôle disparaîtrait.
    const { api } = creerAdaptateurDiscord({ client: faireClient().client });
    await assert.rejects(
        () => api.verifierMembreSanctionnable(GUILDE, 'M1', 'timeouts'),
        /action « timeouts » inconnue.*timeout, kick, ban/s,
    );
});

// ── 3. proprietaireId ────────────────────────────────────────────────────────

test('une guilde normalisée porte son propriétaire', () => {
    assert.deepEqual(
        { ...normaliserGuilde({ id: GUILDE, name: 'S', ownerId: PROPRIETAIRE }) },
        {
            id: GUILDE, nom: 'S', proprietaireId: PROPRIETAIRE, disponible: true,
            membreCount: null, roleParDefautId: GUILDE,
        },
    );
    // Réponse REST brute : snake_case.
    assert.equal(normaliserGuilde({ id: GUILDE, name: 'S', owner_id: PROPRIETAIRE }).proprietaireId, PROPRIETAIRE);
    assert.equal(normaliserGuilde({ id: GUILDE, name: 'S' }).proprietaireId, null);
});

test('obtenirGuilde rend le propriétaire, et le contexte le remonte', async () => {
    const { client, guilde } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });

    assert.equal((await adaptateur.api.obtenirGuilde(GUILDE)).proprietaireId, PROPRIETAIRE);

    const ctx = faireContexte(adaptateur, guilde);
    assert.equal(ctx.guilde.proprietaireId, PROPRIETAIRE);
    // Remonté au premier niveau : c'est là que `resoudrePorteeNeutre` le lit.
    assert.equal(ctx.proprietaireId, PROPRIETAIRE);

    const portee = resoudrePorteeNeutre(ctx);
    assert.equal(portee.proprietaireId, PROPRIETAIRE);
    assert.equal(
        unreachableTarget(portee, PROPRIETAIRE),
        'Le propriétaire du serveur ne peut pas être sanctionné.',
    );
});

// ── 4. Codes d'erreur neutres ────────────────────────────────────────────────

test('la table traduit les codes Discord que le code métier testait en dur', () => {
    // Ces numéros vivaient dans describeError et dans le balayeur de bans, des
    // fichiers censés devenir neutres : ils ne veulent rien dire sur Fluxer.
    const attendu = {
        50013: 'permission',
        50001: 'permission',
        10003: 'introuvable', 10007: 'introuvable', 10008: 'introuvable',
        10011: 'introuvable', 10013: 'introuvable',
        10026: 'deja_fait',
        10004: 'guilde_inconnue',
    };
    assert.deepEqual({ ...TABLE }, attendu);
    for (const code of Object.values(attendu)) assert.ok(estCodeNeutre(code), code);
});

test('toute erreur traversant api.* ressort marquée, sans que err.code soit touché', async () => {
    // `err.code` reste lu par le code pas encore migré (voie historique de
    // punishments.js) : l'écraser casserait la moitié du dépôt d'un coup.
    const rejets = {};
    const client = {
        once() {}, on() {}, off() {}, channels: { cache: new Map() },
        guilds: { cache: new Map() },
        rest: {
            delete: async () => { throw rejets.courant; },
            put: async () => { throw rejets.courant; },
        },
    };
    const { api } = creerAdaptateurDiscord({ client });

    for (const [code, neutre] of [[50013, 'permission'], [10026, 'deja_fait'], [10008, 'introuvable']]) {
        rejets.courant = erreurApi(code);
        await assert.rejects(() => api.supprimerMessage('C1', 'M1'), (err) => {
            assert.equal(err.codeNeutre, neutre);
            assert.equal(err.code, code, 'le code natif doit rester intact');
            return true;
        });
    }

    // Une erreur sans code connu, et une erreur qui n'a jamais vu l'API.
    rejets.courant = erreurApi('ECONNRESET');
    await assert.rejects(() => api.ajouterRole('G', 'M', 'R'), (err) => {
        assert.equal(err.codeNeutre, 'inconnu');
        return true;
    });
    assert.equal(codeNeutre(new Error('erreur de base de données')), CODES_NEUTRES.inconnu);
});

test('le marquage est idempotent et survit à une erreur non extensible', () => {
    const err = erreurApi(50013);
    marquerErreur(err);
    err.code = 10004; // le natif peut changer, le marqueur posé ne bouge plus
    marquerErreur(err);
    assert.equal(err.codeNeutre, 'permission');

    // Une erreur gelée ne doit pas faire échouer le marquage : ce serait
    // masquer l'erreur d'origine, la seule qui compte.
    const gelee = Object.freeze(erreurApi(50013));
    assert.doesNotThrow(() => marquerErreur(gelee));
    assert.equal(codeNeutre(gelee), 'inconnu');
    // Valeurs non-objets lancées par une bibliothèque tierce.
    assert.equal(marquerErreur('chaîne'), 'chaîne');
    assert.equal(marquerErreur(null), null);
});

// ── 5. Absence contre panne ──────────────────────────────────────────────────

test('obtenirGuilde distingue « bot retiré » d\'une panne réseau', async () => {
    // Le balayage des bannissements temporaires en déduit s'il doit OUBLIER une
    // échéance. Les confondre transformerait un bannissement temporaire en
    // bannissement définitif, silencieusement, à la première coupure.
    const client = {
        once() {}, on() {}, off() {}, rest: {}, channels: { cache: new Map() },
        guilds: { cache: new Map(), fetch: async (id) => { throw erreurApi(id === 'PARTI' ? 10004 : 'ECONNRESET'); } },
    };
    const { api } = creerAdaptateurDiscord({ client });

    assert.equal(await api.obtenirGuilde('PARTI'), null, 'bot retiré : absence, donc null');
    await assert.rejects(() => api.obtenirGuilde('RESEAU'), (err) => {
        assert.equal(err.codeNeutre, 'inconnu');
        return true;
    }, 'une panne réseau doit LEVER, jamais rendre null');
});

test('les autres lecteurs appliquent la même règle', async () => {
    const rejets = {};
    const guilde = {
        id: GUILDE, name: 'S', ownerId: PROPRIETAIRE,
        roles: { cache: new Map(), fetch: async () => { throw rejets.courant; } },
        members: { cache: new Map(), fetch: async () => { throw rejets.courant; } },
    };
    const client = {
        once() {}, on() {}, off() {}, rest: {},
        channels: { cache: new Map(), fetch: async () => { throw rejets.courant; } },
        guilds: { cache: new Map([[GUILDE, guilde]]) },
    };
    const { api } = creerAdaptateurDiscord({ client });

    client.rest.get = async () => { throw rejets.courant; };

    const lectures = [
        ['obtenirMembre', () => api.obtenirMembre(GUILDE, 'M1'), 10007],
        ['obtenirCanal', () => api.obtenirCanal('C1'), 10003],
        ['obtenirRole', () => api.obtenirRole(GUILDE, 'R1'), 10011],
        ['obtenirMessage', () => api.obtenirMessage('C1', 'M1'), 10008],
    ];
    for (const [nom, appel, codeAbsence] of lectures) {
        rejets.courant = erreurApi(codeAbsence);
        assert.equal(await appel(), null, `${nom} : une absence doit rendre null`);

        rejets.courant = erreurApi('ETIMEDOUT');
        await assert.rejects(appel, (err) => {
            assert.equal(err.codeNeutre, 'inconnu');
            return true;
        }, `${nom} : une panne doit lever`);
    }
});
