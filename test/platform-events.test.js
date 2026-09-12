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
const { normaliserRole } = require('../bot/platform/discord/context');
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

// ── Payload d'un rôle (lot 0.6) ──────────────────────────────────────────────

test('un rôle porte sa couleur et son serveur', () => {
    // Sans `couleur`, l'embed de roleCreate / roleDelete perd la pastille qu'il
    // affichait ; sans `guildeId`, le handler ne sait pas dans quel serveur
    // écrire son journal — le payload neutre ne porte que le rôle, exactement
    // comme GUILD_ROLE_CREATE côté Fluxer porte `guild_id` à côté du rôle.
    const natif = normaliserRole({ id: '1', name: 'Membre', position: 2, hexColor: '#C8A86E', guildId: 'G1' });
    assert.equal(natif.couleur, '#c8a86e', 'normalisée en minuscules');
    assert.equal(natif.guildeId, 'G1');

    // Réponse REST brute : couleur entière et guild_id.
    const rest = normaliserRole({ id: '1', name: 'R', position: 2, color: 0xc8a86e, guild_id: 'G2' });
    assert.equal(rest.couleur, '#c8a86e');
    assert.equal(rest.guildeId, 'G2');

    // Objet discord.js complet : la guilde est imbriquée.
    assert.equal(normaliserRole({ id: '1', name: 'R', guild: { id: 'G3' } }).guildeId, 'G3');

    // Rôle sans couleur : Discord y met 0, ce qui se rend « #000000 » — la
    // valeur qu'affichaient déjà les embeds avant migration.
    assert.equal(normaliserRole({ id: '1', name: 'R' }).couleur, '#000000');
    assert.equal(normaliserRole({ id: '1', name: 'R', color: 0 }).couleur, '#000000');
    assert.equal(normaliserRole({ id: '1', name: 'R' }).guildeId, null);
});

test('les champs existants du rôle n\'ont pas bougé', () => {
    // Six agents lisent ce contrat : l'ajout doit être strictement additif.
    // `parDefaut` est arrivé au lot 0.8 — sans lui, le sélecteur de rôles du
    // dashboard devait reconstruire lui-même « @everyone porte l'identifiant du
    // serveur », une connaissance de plateforme qui n'a rien à y faire.
    const role = normaliserRole({ id: '1', name: 'Membre', position: 4, managed: true, guildId: 'G1' });
    assert.deepEqual(
        Object.keys(role).sort(),
        ['couleur', 'gere', 'guildeId', 'id', 'mention', 'nom', 'parDefaut', 'position'],
    );
    assert.equal(role.parDefaut, false, 'un rôle ordinaire n\'est pas @everyone');
    assert.equal(role.mention, '<@&1>');
    assert.equal(role.gere, true);
    assert.equal(role.position, 4);
});

// ── Réactions d'un message (lot 0.6) ─────────────────────────────────────────

test('un message porte ses réactions, cache discord.js comme tableau REST', () => {
    // `parMoi` est la raison d'être du champ : sans lui, un panneau de rôles
    // repose chaque emoji à chaque modification, faute de pouvoir constater
    // qu'il est déjà là — un PUT par entrée au lieu de zéro, sur une route
    // limitée en débit.
    const cache = new Map([
        ['a', { emoji: { id: null, name: '🎮' }, count: 3, me: true }],
        ['b', { emoji: { id: '55', name: 'quasar', animated: true }, count: 1, me: false }],
    ]);
    const depuisCache = normaliserMessage({ id: '1', channelId: '2', reactions: { cache } }).reactions;

    assert.deepEqual(depuisCache, [
        { emoji: { id: null, nom: '🎮', anime: false, cle: '🎮' }, nombre: 3, parMoi: true },
        { emoji: { id: '55', nom: 'quasar', anime: true, cle: '<a:quasar:55>' }, nombre: 1, parMoi: false },
    ]);

    // Réponse REST brute : un tableau, pas un gestionnaire.
    const depuisRest = normaliserMessage({
        id: '1', channel_id: '2',
        reactions: [{ count: 2, me: true, emoji: { id: '77', name: 'boum', animated: false } }],
    }).reactions;
    assert.deepEqual(depuisRest, [
        { emoji: { id: '77', nom: 'boum', anime: false, cle: '<:boum:77>' }, nombre: 2, parMoi: true },
    ]);

    // Aucune réaction, et message partiel : un tableau vide, jamais undefined.
    assert.deepEqual(normaliserMessage({ id: '1', channelId: '2' }).reactions, []);
    assert.deepEqual(normaliserMessage({ id: '1', partial: true }).reactions, []);
});

test('la clé de réaction d\'un message est la même que celle d\'un événement', () => {
    // Les deux voies doivent indexer à l'identique : `reaction_roles.emoji`
    // contient cette chaîne, et une divergence ferait échouer la comparaison
    // sur les emojis personnalisés — donc plus aucune attribution de rôle.
    for (const emoji of [{ id: null, name: '🎮' }, { id: '55', name: 'quasar' }, { id: '77', name: 'b', animated: true }]) {
        const surMessage = normaliserMessage({ id: '1', reactions: [{ emoji, count: 1, me: false }] }).reactions[0];
        const surEvenement = normaliserReaction({ message: { id: '1' }, emoji });
        assert.equal(surMessage.emoji.cle, surEvenement.emoji.cle);
        assert.equal(surMessage.emoji.cle, cleEmoji(emoji));
    }
});
