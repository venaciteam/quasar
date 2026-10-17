// ═══════════════════════════════════════════════════════════════
//  Lot 6 — Événements et client REST
//
//  Deux sujets, une seule raison de les tester ensemble : ce sont les deux
//  endroits où l'adaptateur Fluxer doit RECONSTRUIRE ce que discord.js donnait
//  gratuitement. Trois événements ne livrent que le nouvel état, un membre ne
//  porte pas ses permissions, et deux lectures n'ont aucune route REST.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const { creerEtat, creerRest, appliquerAEtat, ErreurApiFluxer } = require('../bot/platform/fluxer/client');
const { creerApi, requeteMessage, corpsMessage, encoderEmoji, rangMembre, comparerRangs } = require('../bot/platform/fluxer/api');
const { EVENEMENTS, cleEmoji, normaliserMessage, normaliserEtatVocal } = require('../bot/platform/fluxer/events');
const { codeNeutrePour, TABLE } = require('../bot/platform/fluxer/erreurs');
const { CODES_NEUTRES, codeNeutre } = require('../bot/platform/erreurs');
const { embed } = require('../bot/platform/embed');
const { masqueMembre, masqueSurCanal, BITS } = require('../bot/platform/fluxer/permissions');
const { versTypesFluxer, versNomCanonique } = require('../bot/platform/fluxer/channels');

const GUILDE = '900000000000000000';
const SALON = '300000000000000000';
const MEMBRE = '400000000000000000';

function etatPret({ roles = [], canaux = [] } = {}) {
    const etat = creerEtat();
    etat.poserGuilde({
        id: GUILDE,
        properties: { id: GUILDE, name: 'Venacity', owner_id: 'proprio' },
        roles: [{ id: GUILDE, name: '@everyone', position: 0, permissions: '0' }, ...roles],
        channels: canaux,
        members: [],
        voice_states: [],
    });
    return etat;
}

/** Applique un événement comme le fait la boucle de distribution. */
function jouer(etat, type, d) {
    appliquerAEtat(etat, type, d);
    const entree = Object.values(EVENEMENTS).find(([natif]) => natif === type);
    return entree[1](d, { etat });
}

// ─── Les trois événements sans « avant » ─────────────────────────────────────

test('messageModifie reconstruit l\'AVANT depuis l\'état local', () => {
    const etat = etatPret();
    jouer(etat, 'MESSAGE_CREATE', {
        id: '5', channel_id: SALON, guild_id: GUILDE, type: 0, content: 'version 1',
        author: { id: MEMBRE, username: 'ada' }, attachments: [], embeds: [],
    });

    const [avant, apres] = jouer(etat, 'MESSAGE_UPDATE', {
        id: '5', channel_id: SALON, guild_id: GUILDE, type: 0, content: 'version 2',
        author: { id: MEMBRE, username: 'ada' }, attachments: [], embeds: [],
    });
    assert.equal(avant.contenu, 'version 1', 'sans l\'état local, aucun journal de modification n\'est possible');
    assert.equal(apres.contenu, 'version 2');
});

test('messageModifie hors cache rend un AVANT partiel, jamais null', () => {
    const etat = etatPret();
    const [avant, apres] = jouer(etat, 'MESSAGE_UPDATE', {
        id: '9', channel_id: SALON, guild_id: GUILDE, type: 0, content: 'inconnu',
        author: { id: MEMBRE }, attachments: [], embeds: [],
    });
    assert.ok(avant, 'un handler qui lit avant.contenu ne doit pas exploser');
    assert.equal(avant.partiel, true);
    assert.equal(avant.id, '9');
    assert.equal(apres.contenu, 'inconnu');
});

test('membreModifie porte (avant, apres, serveur) — les trois arguments du contrat', () => {
    const ROLE = '780000000000000000';
    const etat = etatPret({ roles: [{ id: ROLE, name: 'Modo', position: 2, permissions: '0' }] });
    jouer(etat, 'GUILD_MEMBER_ADD', {
        guild_id: GUILDE, user: { id: MEMBRE, username: 'ada' }, roles: [], joined_at: '2026-01-01T00:00:00.000Z',
    });

    const [avant, apres, guilde] = jouer(etat, 'GUILD_MEMBER_UPDATE', {
        guild_id: GUILDE, user: { id: MEMBRE, username: 'ada' }, roles: [ROLE], joined_at: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual(avant.roles, [], 'c\'est cette comparaison qui détecte un changement de rôle');
    assert.deepEqual(apres.roles, [ROLE]);
    assert.equal(guilde.nom, 'Venacity', 'sans le serveur, le handler ne sait pas où journaliser');
});

test('etatVocalModifie reconstruit l\'AVANT, et une arrivée part d\'un état vide', () => {
    const etat = etatPret();
    const VOCAL = '700000000000000000';

    // Arrivée : personne n'était en vocal.
    const [avantArrivee, apresArrivee] = jouer(etat, 'VOICE_STATE_UPDATE', {
        guild_id: GUILDE, user_id: MEMBRE, channel_id: VOCAL,
        mute: false, deaf: false, self_mute: false, self_deaf: false, member: null,
    });
    assert.equal(avantArrivee.canalId, null, 'l\'avant d\'une arrivée est un état vide, pas null');
    assert.equal(apresArrivee.canalId, VOCAL);

    // Départ.
    const [avantDepart, apresDepart] = jouer(etat, 'VOICE_STATE_UPDATE', {
        guild_id: GUILDE, user_id: MEMBRE, channel_id: null,
        mute: false, deaf: false, self_mute: false, self_deaf: false, member: null,
    });
    assert.equal(avantDepart.canalId, VOCAL);
    assert.equal(apresDepart.canalId, null);
    assert.equal(etat.etatVocal(GUILDE, MEMBRE), null, 'le salon ne doit pas rester occupé par un fantôme');
});

test('les quatre drapeaux vocaux restent distincts, et « muet » n\'en est que le résumé', () => {
    const etat = normaliserEtatVocal({
        guild_id: GUILDE, user_id: MEMBRE, channel_id: '7',
        mute: true, self_mute: false, deaf: false, self_deaf: true, member: null,
    });
    assert.equal(etat.muetServeur, true, 'rendu muet par un modérateur');
    assert.equal(etat.muetSoi, false);
    assert.equal(etat.sourdServeur, false);
    assert.equal(etat.sourdSoi, true, 's\'est mis en sourdine');
    assert.equal(etat.muet, true);
    assert.equal(etat.sourd, true);
});

// ─── Les payloads pauvres de Fluxer ──────────────────────────────────────────

test('membreParti retrouve l\'identité de la personne dans l\'état local', () => {
    const etat = etatPret();
    jouer(etat, 'GUILD_MEMBER_ADD', {
        guild_id: GUILDE, user: { id: MEMBRE, username: 'ada', global_name: 'Ada' },
        roles: [], joined_at: '2026-01-01T00:00:00.000Z',
    });

    // « The object has id alone. No other account field is sent. »
    const [membre, guilde] = jouer(etat, 'GUILD_MEMBER_REMOVE', {
        guild_id: GUILDE, user: { id: MEMBRE },
    });
    assert.equal(membre.nomUtilisateur, 'ada', 'un message d\'au revoir sans nom est un message cassé');
    assert.equal(membre.nom, 'Ada');
    assert.equal(guilde.nom, 'Venacity');
});

test('membreRejoint porte le nom du serveur sans payer un appel REST', () => {
    // Le piège rencontré en avril 2026 : GUILD_MEMBER_ADD ne porte pas le nom de
    // la guilde. Il vient de l'état local, alimenté par la rafale de GUILD_CREATE.
    const etat = etatPret();
    const [membre, guilde] = jouer(etat, 'GUILD_MEMBER_ADD', {
        guild_id: GUILDE, user: { id: MEMBRE, username: 'ada' }, roles: [], joined_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(membre.id, MEMBRE);
    assert.equal(guilde.nom, 'Venacity');
    assert.equal(guilde.id, GUILDE);
});

test('roleSupprime rend le rôle COMPLET, lu avant son retrait de l\'état', () => {
    const ROLE = '780000000000000000';
    const etat = etatPret({ roles: [{ id: ROLE, name: 'Modo', position: 4, color: 3447003, permissions: '0' }] });
    const [role] = jouer(etat, 'GUILD_ROLE_DELETE', { guild_id: GUILDE, role_id: ROLE });
    assert.equal(role.nom, 'Modo', 'sinon le journal n\'aurait qu\'un identifiant à afficher');
    assert.equal(role.couleur, '#3498db');
    assert.equal(role.guildeId, GUILDE);
});

test('messageSupprime combine le payload et le cache', () => {
    const etat = etatPret();
    jouer(etat, 'MESSAGE_CREATE', {
        id: '5', channel_id: SALON, guild_id: GUILDE, type: 0, content: 'à effacer',
        author: { id: MEMBRE, username: 'ada' }, attachments: [{ id: 'a', filename: 'preuve.png', size: 12 }], embeds: [],
    });
    const [message] = jouer(etat, 'MESSAGE_DELETE', { id: '5', channel_id: SALON, guild_id: GUILDE });
    assert.equal(message.contenu, 'à effacer');
    assert.equal(message.piecesJointes[0].nom, 'preuve.png', 'le fichier disparaît, la trace reste');
});

test('guildeQuittee distingue le départ de l\'indisponibilité', () => {
    const etat = etatPret();
    const [partie] = jouer(etat, 'GUILD_DELETE', { id: GUILDE, unavailable: undefined });
    assert.equal(partie.disponible, true, 'départ réel : la purge des données peut suivre');

    const etat2 = etatPret();
    const [indispo] = jouer(etat2, 'GUILD_DELETE', { id: GUILDE, unavailable: true });
    assert.equal(indispo.disponible, false, 'panne : surtout ne rien purger');
    assert.ok(etat2.guilde(GUILDE), 'le serveur est conservé en attente de son retour');
});

// ─── Emojis ──────────────────────────────────────────────────────────────────

test('cleEmoji rend la forme STOCKÉE EN BASE, pas l\'identifiant', () => {
    assert.equal(cleEmoji({ name: '🎮' }), '🎮');
    assert.equal(cleEmoji({ id: '55', name: 'quasar' }), '<:quasar:55>');
    assert.equal(cleEmoji({ id: '55', name: 'quasar', animated: true }), '<a:quasar:55>');
});

test('l\'animation d\'un emoji est retrouvée quand le payload l\'omet', () => {
    // Piège propre à Fluxer : « animated » n'est présent que sur la PREMIÈRE
    // réaction d'un emoji donné. Sans rattrapage, un rôle-réaction sur un emoji
    // animé fonctionnerait pour la première personne et personne d'autre.
    const etat = creerEtat();
    etat.poserGuilde({
        id: GUILDE,
        properties: { id: GUILDE, name: 'V', owner_id: 'x', emojis: [{ id: '55', name: 'quasar', animated: true }] },
        roles: [], channels: [], members: [], voice_states: [],
    });

    const [premiere] = jouer(etat, 'MESSAGE_REACTION_ADD', {
        user_id: MEMBRE, channel_id: SALON, message_id: '5', guild_id: GUILDE,
        emoji: { id: '55', name: 'quasar', animated: true },
    });
    const [suivante] = jouer(etat, 'MESSAGE_REACTION_ADD', {
        user_id: 'autre', channel_id: SALON, message_id: '5', guild_id: GUILDE,
        emoji: { id: '55', name: 'quasar' },   // `animated` omis par la plateforme
    });
    assert.equal(premiere.emoji.cle, '<a:quasar:55>');
    assert.equal(suivante.emoji.cle, '<a:quasar:55>', 'la clé doit rester la même, sinon le rôle n\'est plus attribué');
});

test('encoderEmoji suit la règle du chemin de réaction', () => {
    assert.equal(decodeURIComponent(encoderEmoji('🎮')), '🎮');
    assert.equal(decodeURIComponent(encoderEmoji('<:quasar:55>')), 'quasar:55');
    assert.equal(decodeURIComponent(encoderEmoji('<a:quasar:55>')), 'quasar:55');
});

// ─── Permissions calculées ───────────────────────────────────────────────────

test('le masque d\'un membre est l\'union de @everyone et de ses rôles', () => {
    const roles = new Map([
        [GUILDE, { id: GUILDE, position: 0, permissions: String(BITS.SEND_MESSAGES) }],
        ['r1', { id: 'r1', position: 1, permissions: String(BITS.KICK_MEMBERS) }],
        ['r2', { id: 'r2', position: 2, permissions: String(BITS.BAN_MEMBERS) }],
    ]);
    const masque = masqueMembre({ membreId: MEMBRE, rolesMembre: ['r1', 'r2'], roles, guildeId: GUILDE });
    assert.equal((masque & BITS.SEND_MESSAGES) > 0n, true, '@everyone est inclus, il n\'est jamais dans member.roles');
    assert.equal((masque & BITS.KICK_MEMBERS) > 0n, true);
    assert.equal((masque & BITS.BAN_MEMBERS) > 0n, true);
});

test('ADMINISTRATOR rend le masque complet, et le propriétaire aussi', () => {
    const roles = new Map([
        [GUILDE, { id: GUILDE, position: 0, permissions: '0' }],
        ['admin', { id: 'admin', position: 1, permissions: String(BITS.ADMINISTRATOR) }],
    ]);
    const admin = masqueMembre({ membreId: MEMBRE, rolesMembre: ['admin'], roles, guildeId: GUILDE });
    assert.equal((admin & BITS.MANAGE_WEBHOOKS) > 0n, true, 'ADMINISTRATOR emporte tout');

    const proprio = masqueMembre({ membreId: MEMBRE, rolesMembre: [], roles, guildeId: GUILDE, proprietaireId: MEMBRE });
    assert.equal((proprio & BITS.BAN_MEMBERS) > 0n, true, '« The guild owner receives the complete 64-bit mask »');
});

test('les overwrites de salon s\'appliquent dans l\'ordre de la documentation', () => {
    const base = BITS.VIEW_CHANNEL | BITS.SEND_MESSAGES;
    // 1. @everyone refuse ; 2. un rôle du membre autorise ; l'allow l'emporte.
    const masque = masqueSurCanal(base, [
        { id: GUILDE, type: 0, allow: '0', deny: String(BITS.SEND_MESSAGES) },
        { id: 'r1', type: 0, allow: String(BITS.SEND_MESSAGES), deny: '0' },
    ], { membreId: MEMBRE, rolesMembre: ['r1'], guildeId: GUILDE });
    assert.equal((masque & BITS.SEND_MESSAGES) > 0n, true,
        '« An allow on any one of the member\'s roles defeats a deny on another »');

    // 3. l'overwrite du MEMBRE passe en dernier et peut tout reprendre.
    const refuse = masqueSurCanal(base, [
        { id: 'r1', type: 0, allow: String(BITS.SEND_MESSAGES), deny: '0' },
        { id: MEMBRE, type: 1, allow: '0', deny: String(BITS.SEND_MESSAGES) },
    ], { membreId: MEMBRE, rolesMembre: ['r1'], guildeId: GUILDE });
    assert.equal((refuse & BITS.SEND_MESSAGES) > 0n, false);

    // ADMINISTRATOR ignore tout refus de salon.
    const admin = masqueSurCanal(BITS.ADMINISTRATOR, [
        { id: GUILDE, type: 0, allow: '0', deny: String(BITS.SEND_MESSAGES) },
    ], { membreId: MEMBRE, rolesMembre: [], guildeId: GUILDE });
    assert.equal((admin & BITS.SEND_MESSAGES) > 0n, true);
});

test('la hiérarchie départage par position, puis par snowflake croissant', () => {
    const roles = new Map([
        ['10', { id: '10', position: 3 }],
        ['20', { id: '20', position: 3 }],
        ['30', { id: '30', position: 5 }],
    ]);
    assert.equal(rangMembre(['10', '20'], roles).id, 10n, '« the lower snowflake ranks first »');
    assert.equal(rangMembre(['10', '30'], roles).position, 5);
    assert.equal(rangMembre([], roles), null, '« a member with no assigned role ranks below every role »');
    assert.ok(comparerRangs({ position: 5, id: 1n }, { position: 3, id: 1n }) > 0);
    assert.ok(comparerRangs(null, { position: 1, id: 1n }) < 0);
});

// ─── Types de salon ──────────────────────────────────────────────────────────

test('les types de salon connus se traduisent, la conférence est refusée EXPLICITEMENT', () => {
    assert.deepEqual(versTypesFluxer(['texte', 'vocal', 'categorie']), [0, 2, 4]);
    assert.equal(versNomCanonique(0), 'texte');
    assert.equal(versNomCanonique(2), 'vocal');
    assert.equal(versNomCanonique(998), null, 'un salon-lien n\'a pas de nom canonique');
    // Fluxer n'a pas de salon de conférence : on le DIT, on ne replie pas sur
    // « vocal », ce qui créerait un salon ordinaire sans un mot.
    assert.throws(() => versTypesFluxer(['conference']), /n'a pas de salon/);
});

// ─── Codes d'erreur ──────────────────────────────────────────────────────────

test('les codes d\'erreur Fluxer se traduisent en codes neutres', () => {
    const cas = {
        MISSING_PERMISSIONS: CODES_NEUTRES.permission,
        MISSING_ACCESS: CODES_NEUTRES.permission,
        FORBIDDEN: CODES_NEUTRES.permission,
        UNKNOWN_MEMBER: CODES_NEUTRES.introuvable,
        UNKNOWN_MESSAGE: CODES_NEUTRES.introuvable,
        UNKNOWN_CHANNEL: CODES_NEUTRES.introuvable,
        UNKNOWN_ROLE: CODES_NEUTRES.introuvable,
        NOT_FOUND: CODES_NEUTRES.introuvable,
        USER_IS_NOT_BANNED: CODES_NEUTRES.deja_fait,
        UNKNOWN_GUILD: CODES_NEUTRES.guilde_inconnue,
    };
    for (const [natif, neutre] of Object.entries(cas)) {
        assert.equal(codeNeutrePour({ code: natif }), neutre, natif);
    }
    assert.equal(codeNeutrePour({ code: 'UNE_PANNE_QUELCONQUE' }), CODES_NEUTRES.inconnu);
    // Un code NUMÉRIQUE ne peut pas venir de Fluxer : il ressort en 'inconnu',
    // ce qui est exact — et surtout, il ne doit pas percuter la table par hasard.
    assert.equal(codeNeutrePour({ code: 50013 }), CODES_NEUTRES.inconnu);
});

test('toute erreur qui traverse api.* ressort marquée, sans que err.code soit touché', async () => {
    const client = { etat: creerEtat(), user: null, isReady: () => true };
    client.rest = {
        async post() { throw new ErreurApiFluxer('refusé', { code: 'MISSING_PERMISSIONS', status: 403 }); },
        async get() { throw new ErreurApiFluxer('absent', { code: 'UNKNOWN_MESSAGE', status: 404 }); },
    };
    const api = creerApi(client);

    await assert.rejects(() => api.envoyerMessage(SALON, 'x'), (err) => {
        assert.equal(err.code, 'MISSING_PERMISSIONS', 'le code natif n\'est jamais écrasé');
        assert.equal(codeNeutre(err), CODES_NEUTRES.permission);
        return true;
    });

    // Un lecteur rend `null` sur une absence, au lieu de lever.
    assert.equal(await api.obtenirMessage(SALON, '5'), null);
});

test('une panne ne se confond pas avec une absence', async () => {
    const client = { etat: creerEtat(), user: null, isReady: () => true };
    client.rest = { async get() { throw new ErreurApiFluxer('coupure', { code: null, status: 503 }); } };
    const api = creerApi(client);
    // C'est LE point : rendre null ici ferait oublier une échéance de
    // bannissement temporaire, qui deviendrait définitif.
    await assert.rejects(() => api.obtenirMessage(SALON, '5'));
});

// ─── Corps de message et pièces jointes ──────────────────────────────────────

test('le corps REST est en snake_case, et une clé sans correspondance LÈVE', () => {
    const corps = corpsMessage({
        contenu: 'hello',
        embeds: [embed({ titre: 'T', couleur: 0xc8a86e, champs: [{ nom: 'n', valeur: 'v', enLigne: true }] })],
        mentionsAutorisees: { parse: [], roles: ['7'], users: [] },
    });
    assert.equal(corps.content, 'hello');
    assert.equal(corps.embeds[0].title, 'T');
    assert.equal(corps.embeds[0].color, 0xc8a86e);
    assert.deepEqual(corps.embeds[0].fields, [{ name: 'n', value: 'v', inline: true }]);
    assert.deepEqual(corps.allowed_mentions, { parse: [], roles: ['7'], users: [] },
        'en camelCase, le verrou de mentions disparaîtrait en silence');
});

test('une pièce jointe est DÉCLARÉE dans le corps, pas seulement envoyée', () => {
    // Différence de fond avec Discord : chez Fluxer, « Attachment IDs in a direct
    // multipart request identify the matching zero-based files[N] field ». Sans
    // la métadonnée `attachments`, le fichier ne se rattache à rien.
    const requete = requeteMessage({
        contenu: 'transcript',
        fichiers: [{ nom: 'ticket-12.txt', donnees: Buffer.from('bonjour'), description: 'Transcript' }],
    });
    assert.equal(requete.files.length, 1);
    assert.equal(requete.files[0].name, 'ticket-12.txt');
    assert.deepEqual(requete.body.attachments, [
        { id: 0, filename: 'ticket-12.txt', description: 'Transcript' },
    ]);
});

test('un message sans pièce jointe ne déclare aucun attachment', () => {
    const requete = requeteMessage('simple');
    assert.equal(requete.files, undefined);
    assert.equal(requete.body.attachments, undefined);
});

test('un embed au format Discord est refusé, pas rendu à moitié', () => {
    assert.throws(() => corpsMessage({ title: 'T', color: 1 }), /format Discord/);
});

// ─── Suppression en lot ──────────────────────────────────────────────────────

test('la suppression en lot n\'applique AUCUNE borne d\'âge', async () => {
    // « The operation applies no age boundary, so a message of any age can be
    // selected. » — l'inverse de Discord, et c'est ce qui permet à /clear de
    // faire ce que la plateforme sait faire.
    const lots = [];
    const client = { etat: creerEtat(), user: null, isReady: () => true };
    client.rest = { async post(chemin, options) { lots.push(options.body.message_ids); return null; } };
    const api = creerApi(client);

    // Deux messages : un récent, un vieux de plusieurs années.
    const recent = String((BigInt(Date.now() - 1420070400000) << 22n));
    const vieux = String((BigInt(Date.now() - 1420070400000 - 400 * 86400000) << 22n));
    const resultat = await api.supprimerMessagesEnLot(SALON, [recent, vieux]);

    assert.deepEqual(lots, [[recent, vieux]], 'les deux partent');
    assert.equal(resultat.supprimes, 2);
    assert.equal(resultat.ignores, 0);
});

test('la suppression en lot découpe par 100 et dédoublonne', async () => {
    const lots = [];
    const client = { etat: creerEtat(), user: null, isReady: () => true };
    client.rest = { async post(chemin, options) { lots.push(options.body.message_ids.length); return null; } };
    const api = creerApi(client);

    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    await api.supprimerMessagesEnLot(SALON, [...ids, ids[0]]);
    assert.deepEqual(lots, [100, 50]);
});

// ─── Ce que Fluxer ne sait pas faire ─────────────────────────────────────────

test('mettreInvitationsEnPause LÈVE, et dit quoi tester à la place', async () => {
    const client = { etat: creerEtat(), user: null, isReady: () => true, rest: {} };
    const api = creerApi(client);
    await assert.rejects(
        () => api.mettreInvitationsEnPause(GUILDE, Date.now() + 1000, 'raid'),
        /pauseInvitations/,
        'un appel ne doit jamais être silencieux : le mode panique croirait le serveur fermé',
    );
});

test('obtenirEtatInvitations LIT le drapeau, même sans pouvoir le poser', async () => {
    const etat = etatPret();
    etat.majProprietes({ id: GUILDE, features: ['INVITES_DISABLED'] });
    const client = { etat, user: null, isReady: () => true, rest: {} };
    const api = creerApi(client);
    const invitations = await api.obtenirEtatInvitations(GUILDE);
    assert.equal(invitations.desactiveesEnDur, true);
    assert.equal(invitations.enPauseJusqua, null, 'Fluxer n\'a pas d\'échéance à lire');
});

test('listerGuildes distingue « aucun serveur » de « je ne sais pas encore »', async () => {
    const froid = { etat: creerEtat(), user: null, isReady: () => false, rest: {} };
    assert.equal(await creerApi(froid).listerGuildes(), null, 'avant READY : indéterminable');

    const chaud = { etat: etatPret(), user: { id: 'bot' }, isReady: () => true, rest: {} };
    assert.deepEqual(await creerApi(chaud).listerGuildes(), [GUILDE]);
});

test('listerMembresVocal lit l\'état, seule source des occupants', async () => {
    const VOCAL = '700000000000000000';
    const etat = etatPret({ canaux: [{ id: VOCAL, name: 'Vocal', type: 2, guild_id: GUILDE }] });
    etat.poserEtatVocal({
        guild_id: GUILDE, user_id: MEMBRE, channel_id: VOCAL,
        member: { user: { id: MEMBRE, username: 'ada' }, roles: [], guild_id: GUILDE },
    });
    const api = creerApi({ etat, user: null, isReady: () => true, rest: {} });

    const occupants = await api.listerMembresVocal(VOCAL);
    assert.equal(occupants.length, 1);
    assert.equal(occupants[0].id, MEMBRE);

    // Un salon texte n'a pas d'occupants vocaux : `null`, pas `[]`.
    assert.equal(await api.listerMembresVocal(SALON), null);
});

// ─── Client REST ─────────────────────────────────────────────────────────────

test('le client REST authentifie en « Bot », pose le motif d\'audit et tronque', async () => {
    let vu = null;
    const rest = creerRest({
        base: 'https://api.fluxer.app/v1', jeton: '123.secret',
        fetch: async (url, options) => { vu = { url, options }; return { status: 204, ok: true }; },
    });
    await rest.delete('/guilds/1/members/2', { raison: 'x'.repeat(600) });

    assert.equal(vu.url, 'https://api.fluxer.app/v1/guilds/1/members/2');
    assert.equal(vu.options.headers.Authorization, 'Bot 123.secret');
    assert.equal(vu.options.headers['X-Audit-Log-Reason'].length, 512, 'un motif trop long est discardé par l\'API');
});

test('le client REST traduit une erreur en ErreurApiFluxer avec son code CHAÎNE', async () => {
    const rest = creerRest({
        base: 'https://api.fluxer.app/v1', jeton: 'x',
        fetch: async () => ({
            status: 403, ok: false,
            text: async () => JSON.stringify({ code: 'MISSING_PERMISSIONS', message: 'refusé' }),
            headers: { get: () => null },
        }),
    });
    await assert.rejects(() => rest.get('/x'), (err) => {
        assert.equal(err.code, 'MISSING_PERMISSIONS');
        assert.equal(err.status, 403);
        assert.equal(err.message, 'refusé');
        return true;
    });
});

test('un 204 rend null, et une réponse JSON rend son corps', async () => {
    const rest = creerRest({
        base: 'https://api.fluxer.app/v1', jeton: 'x',
        fetch: async (url) => (url.endsWith('/vide')
            ? { status: 204, ok: true }
            : { status: 200, ok: true, text: async () => '{"id":"5"}', headers: { get: () => null } }),
    });
    assert.equal(await rest.get('/vide'), null);
    assert.deepEqual(await rest.get('/plein'), { id: '5' });
});

test('la table des codes d\'erreur ne contient que des codes neutres connus', () => {
    for (const [natif, neutre] of Object.entries(TABLE)) {
        assert.ok(Object.values(CODES_NEUTRES).includes(neutre), `${natif} -> ${neutre} inconnu`);
    }
});
