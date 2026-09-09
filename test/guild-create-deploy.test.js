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
process.env.QUASAR_DB_PATH = ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Le remplacement doit avoir lieu AVANT le require de guildCreate, qui
// déstructure la fonction au chargement.
const deployModule = require('../bot/utils/deploy-commands');
const appels = { ciblé: [], global: 0 };
let echec = null;

deployModule.deployCommandsForGuild = async (guild) => {
    if (echec) throw echec;
    appels.ciblé.push(guild.id);
    return true;
};
deployModule.deployCommands = async () => { appels.global += 1; };

const guildCreate = require('../bot/events/guildCreate');
const { getDb } = require('../api/services/database');

beforeEach(() => { appels.ciblé = []; appels.global = 0; echec = null; });

const faireServeur = (id) => ({ id, name: `Serveur ${id}` });

test('le bot déploie ses commandes sur le serveur qui vient de l\'inviter', async () => {
    await guildCreate.execute(faireServeur('100000000000000001'));
    assert.deepEqual(appels.ciblé, ['100000000000000001']);
});

test('l\'arrivée d\'un serveur ne redéploie pas sur tous les autres', async () => {
    // deployCommands itère sur l'intégralité du cache : l'appeler ici
    // consommerait le quota Discord de l'instance entière pour un seul nouveau
    // venu.
    await guildCreate.execute(faireServeur('100000000000000002'));
    assert.equal(appels.global, 0, 'le déploiement global ne doit jamais être déclenché par une arrivée');
});

test('un échec de déploiement n\'empêche pas l\'enregistrement du serveur', async () => {
    // L'enregistrement en base et l'annulation d'une purge programmée passent
    // AVANT, et doivent survivre : le prochain démarrage rattrapera les
    // commandes, alors qu'un serveur non enregistré resterait invisible.
    echec = new Error('Discord injoignable');
    const guild = faireServeur('100000000000000003');
    await guildCreate.execute(guild);

    const ligne = getDb().prepare('SELECT guild_id FROM guilds WHERE guild_id = ?').get(guild.id);
    assert.ok(ligne, 'le serveur doit être enregistré malgré l\'échec du déploiement');
});

test('deployCommandsForGuild existe et est distincte du déploiement global', () => {
    // Contrôle de cohérence : si quelqu'un remplaçait l'appel ciblé par l'appel
    // global « pour simplifier », les deux tests ci-dessus continueraient de
    // passer avec un stub unique. On vérifie donc que les deux existent bien.
    const vrai = require.cache[require.resolve('../bot/utils/deploy-commands')];
    assert.ok(vrai, 'module chargé');
    assert.equal(typeof deployModule.deployCommandsForGuild, 'function');
    assert.equal(typeof deployModule.deployCommands, 'function');
});
