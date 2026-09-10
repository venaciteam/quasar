// Table des événements neutres et normalisation des payloads.
//
// Raison d'être : les seize handlers de bot/events/ seront migrés sur ce
// contrat aux lots 1 à 5, par cinq agents en parallèle. S'ils ne reçoivent pas
// exactement la même forme de payload, la divergence n'apparaîtra qu'en
// production, événement par événement.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    EVENEMENTS,
    NOMS_EVENEMENTS,
    normaliserMessage,
    normaliserReaction,
    normaliserEtatVocal,
    cleEmoji,
} = require('../bot/platform/discord/events');
const creerAdaptateurDiscord = require('../bot/platform/discord');

// Les dix-sept noms neutres de la DA §4.4, dans l'ordre du document.
const NOMS_DA = [
    'pret', 'messageCree', 'messageModifie', 'messageSupprime', 'reactionAjoutee',
    'reactionRetiree', 'membreRejoint', 'membreParti', 'membreModifie', 'guildeRejointe',
    'guildeQuittee', 'canalCree', 'canalSupprime', 'roleCree', 'roleSupprime',
    'etatVocalModifie', 'sanctionAutomatique',
];

test('la table couvre exactement les événements neutres de la DA', () => {
    assert.deepEqual([...NOMS_EVENEMENTS].sort(), [...NOMS_DA].sort());
});

test('chaque événement neutre pointe sur un événement discord.js réel', () => {
    // Table §7.2. Un nom mal orthographié ici ne lèverait jamais : le handler
    // serait simplement abonné à un événement qui n'arrive pas.
    const ATTENDU = {
        pret: 'clientReady',
        messageCree: 'messageCreate',
        messageModifie: 'messageUpdate',
        messageSupprime: 'messageDelete',
        reactionAjoutee: 'messageReactionAdd',
        reactionRetiree: 'messageReactionRemove',
        membreRejoint: 'guildMemberAdd',
        membreParti: 'guildMemberRemove',
        membreModifie: 'guildMemberUpdate',
        guildeRejointe: 'guildCreate',
        guildeQuittee: 'guildDelete',
        canalCree: 'channelCreate',
        canalSupprime: 'channelDelete',
        roleCree: 'roleCreate',
        roleSupprime: 'roleDelete',
        etatVocalModifie: 'voiceStateUpdate',
        sanctionAutomatique: 'autoModerationActionExecution',
    };
    for (const [neutre, natif] of Object.entries(ATTENDU)) {
        assert.equal(EVENEMENTS[neutre][0], natif, `${neutre} mal câblé`);
    }
});

test('un nom d\'événement inconnu lève, et nomme les noms acceptés', () => {
    const adaptateur = creerAdaptateurDiscord({ client: { once: () => {}, on: () => {}, off: () => {}, rest: {} } });
    assert.throws(() => adaptateur.surEvenement('messageCreate', () => {}), /Événement neutre inconnu/);
    assert.throws(() => adaptateur.surEvenement('messageCree2', () => {}), /messageCree/);
});

test('un handler neutre reçoit un contexte puis le payload normalisé', async () => {
    const abonnements = new Map();
    const client = {
        once: () => {},
        on: (nom, fn) => abonnements.set(nom, fn),
        off: () => {},
        rest: {},
    };
    const adaptateur = creerAdaptateurDiscord({ client });

    let vu = null;
    adaptateur.surEvenement('messageCree', (ctx, message) => { vu = { ctx, message }; });

    abonnements.get('messageCreate')({
        id: '1', channelId: '2', guildId: '3', content: 'coucou',
        author: { id: '4', username: 'leeva', bot: false },
    });
    // Le pont passe par Promise.resolve().then() : c'est ce qui empêche la
    // promesse du handler de partir flotter jusqu'à l'EventEmitter. Le handler
    // n'est donc plus appelé de façon synchrone.
    await new Promise(setImmediate);

    assert.equal(vu.ctx.plateforme, 'discord');
    assert.equal(vu.ctx.capacites.interactions, true);
    assert.equal(typeof vu.ctx.api.envoyerMessage, 'function');
    assert.deepEqual(
        { id: vu.message.id, canalId: vu.message.canalId, guildeId: vu.message.guildeId, contenu: vu.message.contenu },
        { id: '1', canalId: '2', guildeId: '3', contenu: 'coucou' },
    );
    assert.equal(vu.message.auteur.mention, '<@4>');
});

test('un message hors cache est signalé comme partiel', () => {
    // Le cas courant d'une suppression ou d'une réaction sur un message
    // antérieur au démarrage : seuls les identifiants y sont fiables.
    const partiel = normaliserMessage({ id: '1', channelId: '2', partial: true });
    assert.equal(partiel.partiel, true);
    assert.equal(partiel.contenu, null);
    assert.equal(partiel.auteur, null);
});

test('la clé d\'emoji est la forme STOCKÉE EN BASE, pas l\'identifiant', () => {
    // reaction_roles.emoji contient la chaîne saisie par l'administrateur —
    // « 🎫 » ou « <:quasar:55> » — et messageReactionAdd.js reconstruit cette
    // forme pour comparer. Rendre « 55 » ferait échouer toute attribution de
    // rôle par emoji personnalisé, sans erreur ni journal : les unicode
    // continueraient de marcher par coïncidence, et le symptôme serait
    // « certains emojis ne marchent plus ».
    const unicode = normaliserReaction({ message: { id: '1', channelId: '2', guildId: '3' }, emoji: { id: null, name: '🎫' } });
    assert.equal(unicode.emoji.cle, '🎫');

    const perso = normaliserReaction({ message: { id: '1' }, emoji: { id: '55', name: 'quasar' } });
    assert.equal(perso.emoji.cle, '<:quasar:55>');
    assert.equal(perso.emoji.id, '55');
    assert.equal(perso.emoji.anime, false);

    // Sans `anime`, la forme d'un emoji animé serait irreconstructible.
    const anime = normaliserReaction({ message: { id: '1' }, emoji: { id: '77', name: 'boum', animated: true } });
    assert.equal(anime.emoji.cle, '<a:boum:77>');
    assert.equal(anime.emoji.anime, true);
});

test('la clé rendue est exactement celle que reconstruit messageReactionAdd', () => {
    // Contrôle croisé avec le code non migré : la forme doit être identique,
    // sinon la migration du lot 2 cassera l'attribution en silence.
    const reconstruire = (e) => (e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name);
    for (const emoji of [
        { id: null, name: '🎮' },
        { id: '55', name: 'quasar' },
        { id: '77', name: 'boum', animated: true },
    ]) {
        assert.equal(cleEmoji(emoji), reconstruire(emoji));
    }
});

test('un état vocal distingue la coupure serveur de la coupure volontaire', () => {
    // Les fusionner ferait annoncer une sanction là où quelqu'un a simplement
    // coupé son micro.
    const etat = normaliserEtatVocal({
        guild: { id: '1' }, id: '2', channelId: '3',
        serverMute: true, selfMute: false, serverDeaf: false, selfDeaf: true,
    });
    assert.equal(etat.muetServeur, true);
    assert.equal(etat.muetSoi, false);
    assert.equal(etat.sourdServeur, false);
    assert.equal(etat.sourdSoi, true);
    // Les résumés restent disponibles pour qui n'a pas besoin de la nuance.
    assert.equal(etat.muet, true);
    assert.equal(etat.sourd, true);
});
