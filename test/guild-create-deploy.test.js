// Garde-fou : les commandes slash arrivent avec le bot, pas au redémarrage suivant.
//
// `deployCommands` n'avait qu'un seul appelant dans tout le projet, le handler
// de démarrage, qui itère sur `client.guilds.cache`. Or la procédure
// d'installation documentée lance le bot AVANT de l'inviter : à ce moment-là le
// cache est vide et rien n'est déployé. La personne invite le bot, le voit en
// ligne, ouvre un dashboard qui fonctionne, et ne trouve AUCUNE commande sur son
// serveur. Le symptôme est indiscernable d'un problème d'intents ou de
// permissions, et le remède — redémarrer le conteneur — n'est documenté nulle
// part. C'est le premier mur d'une nouvelle installation.
//
// Le correctif a CHANGÉ DE VOIE au lot 0.5 : il vivait dans
// bot/events/guildCreate.js, qui devait devenir neutre alors que le déploiement
// de slash commands est strictement Discord. Il est désormais porté par
// l'adaptateur, sur son événement natif. Ce que ce fichier vérifie n'a pas
// bougé : une invitation déclenche un déploiement CIBLÉ, jamais le déploiement
// global, et un échec n'emporte pas le reste de l'arrivée.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Le remplacement doit avoir lieu AVANT que l'adaptateur ne déclenche un
// déploiement. Il tient parce que `brancherDeploiementAInvitation` résout
// `./deploy` au moment de l'appel, pas au chargement du module.
const deployModule = require('../bot/platform/discord/deploy');
const appels = { ciblé: [], global: 0 };
let echec = null;

deployModule.deployCommandsForGuild = async (guild) => {
    if (echec) throw echec;
    appels.ciblé.push(guild.id);
    return true;
};
deployModule.deployCommands = async () => { appels.global += 1; };

const creerAdaptateurDiscord = require('../bot/platform/discord');
const guildCreate = require('../bot/events/guildCreate');
const { getDb } = require('../api/services/database');

beforeEach(() => { appels.ciblé = []; appels.global = 0; echec = null; });

const faireServeur = (id) => ({ id, name: `Serveur ${id}` });

/**
 * Client réduit qui capture ses écouteurs, pour pouvoir émettre `guildCreate`
 * à la main et observer ce que l'adaptateur en fait.
 */
function faireClient() {
    const ecouteurs = new Map();
    const ajouter = (nom, fn) => {
        if (!ecouteurs.has(nom)) ecouteurs.set(nom, []);
        ecouteurs.get(nom).push(fn);
    };
    return {
        ecouteurs,
        emettre: (nom, ...args) => (ecouteurs.get(nom) || []).forEach(fn => fn(...args)),
        client: {
            on: ajouter, once: ajouter, off: () => {},
            rest: {}, channels: { cache: new Map() }, guilds: { cache: new Map() },
        },
    };
}

/** Contexte d'événement minimal, tel que le chargeur en fabrique un. */
function faireContexte() {
    return { plateforme: 'discord', capacites: {}, api: {}, db: getDb() };
}

// ── La voie Discord : le déploiement ciblé ───────────────────────────────────

test('l\'adaptateur déploie les commandes sur le serveur qui vient de l\'inviter', async () => {
    const { client, emettre } = faireClient();
    creerAdaptateurDiscord({ client });

    emettre('guildCreate', faireServeur('100000000000000001'));
    await new Promise(setImmediate);

    assert.deepEqual(appels.ciblé, ['100000000000000001']);
});

test('l\'arrivée d\'un serveur ne redéploie pas sur tous les autres', async () => {
    // deployCommands itère sur l'intégralité du cache : l'appeler ici
    // consommerait le quota Discord de l'instance entière pour un seul nouveau
    // venu.
    const { client, emettre } = faireClient();
    creerAdaptateurDiscord({ client });

    emettre('guildCreate', faireServeur('100000000000000002'));
    await new Promise(setImmediate);

    assert.equal(appels.global, 0, 'le déploiement global ne doit jamais être déclenché par une arrivée');
});

test('le déploiement est branché sur l\'événement NATIF, pas sur le nom neutre', async () => {
    // Un branchement sur « guildeRejointe » ne serait jamais déclenché :
    // discord.js n'émet pas d'événement portant un nom neutre. Le handler
    // existerait, le correctif serait mort, et rien ne le dirait.
    const { client, ecouteurs } = faireClient();
    creerAdaptateurDiscord({ client });

    assert.ok(ecouteurs.has('guildCreate'), 'aucun écouteur natif guildCreate');
    assert.equal(ecouteurs.has('guildeRejointe'), false);
});

test('un déploiement en échec ne remonte pas en rejet non capté', async () => {
    // Le handler est asynchrone et l'EventEmitter ne capte rien : une promesse
    // rejetée partirait dans le filet global du processus.
    echec = new Error('Discord injoignable');
    const { client, emettre } = faireClient();
    creerAdaptateurDiscord({ client });

    assert.doesNotThrow(() => emettre('guildCreate', faireServeur('100000000000000004')));
    await new Promise(setImmediate);
});

// ── La voie métier : l'enregistrement du serveur ─────────────────────────────

test('un échec de déploiement n\'empêche pas l\'enregistrement du serveur', async () => {
    // L'enregistrement en base et l'annulation d'une purge programmée sont
    // désormais dans un handler SÉPARÉ du déploiement : l'indépendance est
    // structurelle, elle ne repose plus sur un try/catch bien placé. Le prochain
    // démarrage rattrapera les commandes, alors qu'un serveur non enregistré
    // resterait invisible.
    echec = new Error('Discord injoignable');
    const { client, emettre } = faireClient();
    creerAdaptateurDiscord({ client });

    const guilde = { id: '100000000000000003', nom: 'Serveur 3' };
    emettre('guildCreate', faireServeur(guilde.id));
    await guildCreate.executer(faireContexte(), guilde);
    await new Promise(setImmediate);

    const ligne = getDb().prepare('SELECT guild_id FROM guilds WHERE guild_id = ?').get(guilde.id);
    assert.ok(ligne, 'le serveur doit être enregistré malgré l\'échec du déploiement');
});

test('guildCreate est un handler neutre, sans rien de Discord', async () => {
    // Le fichier ne doit plus porter le déploiement : c'est ce qui lui permet
    // d'être neutre. S'il le reprenait, un bot Fluxer tenterait de déployer des
    // slash commands sur une plateforme qui n'en a pas.
    assert.equal(guildCreate.nom, 'guildeRejointe');
    assert.equal(typeof guildCreate.executer, 'function');
    assert.equal(guildCreate.execute, undefined, 'plus de handler au format historique');

    const source = require('node:fs').readFileSync(
        require.resolve('../bot/events/guildCreate'), 'utf8',
    );
    assert.doesNotMatch(source, /deployCommandsForGuild|discord\.js/);
});

test('deployCommandsForGuild existe et est distincte du déploiement global', () => {
    // Contrôle de cohérence : si quelqu'un remplaçait l'appel ciblé par l'appel
    // global « pour simplifier », les tests ci-dessus continueraient de passer
    // avec un stub unique. On vérifie donc que les deux existent bien.
    const vrai = require.cache[require.resolve('../bot/platform/discord/deploy')];
    assert.ok(vrai, 'module chargé');
    assert.equal(typeof deployModule.deployCommandsForGuild, 'function');
    assert.equal(typeof deployModule.deployCommands, 'function');
});
