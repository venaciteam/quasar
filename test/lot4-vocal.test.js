// Lot 4 — le vocal au contrat neutre.
//
// Périmètre couvert : /tempvoice et son panneau, /voice, l'événement
// `etatVocalModifie`, et /music. Trois natures de test, et la troisième est
// celle qui compte le plus en production :
//
//  1. RÉFÉRENCES JSON. Le corps déployé à Discord ne doit pas bouger d'un
//     octet — une différence, même « cosmétique », se paie en re-déploiement
//     silencieux à chaque démarrage. Les références sont relevées sur `dev`,
//     AVANT migration, et écrites en dur : les recalculer depuis le code testé
//     ne prouverait rien.
//
//  2. COMPORTEMENT. Réponses, messages, écritures en base et appels au client
//     REST, vérifiés avec un contexte neutre de doublure — sans client ni jeton.
//
//  3. OVERWRITES. Le piège du lot : `permissionOverwrites.edit()` modifiait UNE
//     entrée, et sa traduction naïve `modifierCanal({ permissions })` remplace
//     le jeu ENTIER du salon. La section 4 fait tourner le VRAI client REST
//     contre un salon simulé et compare le jeu résultant entrée par entrée.
//
// /play et les sept contrôles musique restent hors périmètre : la famille est
// coupée depuis le 2026-06-18 et `@discordjs/voice` n'est plus une dépendance
// du projet — les requérir ferait échouer ce fichier sur un MODULE_NOT_FOUND.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { construireSlashCommand } = require('../bot/platform/discord/commands');
const { getDb } = require('../api/services/database');

/**
 * Corps RÉELLEMENT envoyé à Discord : la sérialisation retire les champs restés
 * à `undefined`, et c'est elle qui décide de ce qui part sur le fil.
 */
const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

/** La sous-commande visée d'un descripteur migré. */
function sous(descripteur, nom) {
    const trouvee = descripteur.sousCommandes.find(s => s.nom === nom);
    assert.ok(trouvee, `sous-commande « ${nom} » absente du descripteur`);
    return trouvee;
}

/**
 * Contexte neutre de doublure : capture ce qui est répondu, sert les options
 * déclarées, et laisse le test décider de ce que rend `obtenirCanal`.
 */
function faireCtx({ guildeId = 'guilde-lot4', options = {}, canaux = {} } = {}) {
    const reponses = [];
    const erreurs = [];
    return {
        reponses,
        erreurs,
        ctx: {
            plateforme: 'discord',
            capacites: {},
            guildeId,
            db: getDb(),
            options: { get: (nom) => options[nom] },
            api: {
                async obtenirCanal(canalId) { return canaux[canalId] ?? null; },
            },
            async repondre(contenu, opts = {}) { reponses.push([contenu, opts]); },
            async erreurUtilisateur(spec) { erreurs.push(spec); },
        },
    };
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Références JSON
// ═════════════════════════════════════════════════════════════════════════════

test('/tempvoice produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [
            {
                type: 1,
                name: 'setup',
                description: 'Ajouter un salon trigger (Join to Create)',
                options: [
                    // 2 = GuildVoice : le filtre du sélecteur, déclaré côté
                    // descripteur en nom canonique (`typesCanal: ['vocal']`).
                    { channel_types: [2], name: 'salon', description: 'Le salon vocal trigger', required: true, type: 7 },
                ],
            },
            {
                type: 1,
                name: 'remove',
                description: 'Retirer un salon trigger',
                options: [
                    { channel_types: [2], name: 'salon', description: 'Le salon vocal trigger à retirer', required: true, type: 7 },
                ],
            },
            { type: 1, name: 'disable', description: 'Désactiver tous les vocaux temporaires', options: [] },
            { type: 1, name: 'enable', description: 'Réactiver tous les vocaux temporaires', options: [] },
            { type: 1, name: 'info', description: 'Afficher la configuration actuelle', options: [] },
        ],
        name: 'tempvoice',
        description: 'Configurer les salons vocaux temporaires',
        // ManageGuild, sérialisée en CHAÎNE par l'API.
        default_member_permissions: '32',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/tempvoice'))), REFERENCE);
});

test('/music produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [
            {
                type: 1,
                name: 'setchannel',
                description: 'Restreindre les commandes musique à un salon',
                options: [
                    // 0 = GuildText : la restriction ne vise qu'un salon textuel.
                    { channel_types: [0], name: 'channel', description: 'Le salon musique', required: true, type: 7 },
                ],
            },
            { type: 1, name: 'removechannel', description: 'Retirer la restriction de salon (commandes partout)', options: [] },
            { type: 1, name: 'status', description: 'Voir la configuration musique actuelle', options: [] },
        ],
        name: 'music',
        description: 'Configurer le module musique',
        // Administrator, sérialisée en CHAÎNE par l'API.
        default_member_permissions: '8',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/musicconfig'))), REFERENCE);
});

test('la famille musique est déclarée Discord seulement', () => {
    // Fluxer fait sa voix en LiveKit et ne publie aucune signalisation :
    // `@discordjs/voice` y est inutilisable (DA §1.2). Sans cette déclaration,
    // la commande serait déployée sur une plateforme où elle ne peut rien
    // faire, puis refusée à l'exécution — une commande morte au sélecteur.
    assert.deepEqual(require('../bot/commands/musicconfig').plateformes, ['discord']);
});

test('/voice produit le JSON de son SlashCommandBuilder d\'origine', () => {
    // Référence relevée sur `dev`, AVANT migration. Le point sensible de cette
    // commande-ci est l'absence de `default_member_permissions` : elle est
    // ouverte à tout le monde, chacun n'y pilotant que le salon dont il est
    // propriétaire. Le registre exige que cette ouverture soit DÉCLARÉE
    // (`accesParDefaut: true`) et non déduite d'un champ absent — mais elle ne
    // doit rien ajouter au JSON déployé, sans quoi la commande serait
    // redéployée à chaque démarrage.
    //
    // /play et les sept contrôles musique ne sont pas gelés ici : ils chargent
    // `@discordjs/voice`, qui n'est plus une dépendance du projet depuis la
    // coupure du module musique (2026-06-18). Les requérir ferait échouer ce
    // fichier sur un MODULE_NOT_FOUND. Leur JSON de référence est au
    // compte-rendu du lot.
    const REFERENCES = {
        voice: {
            options: [
                {
                    type: 1,
                    name: 'name',
                    description: 'Renommer votre salon',
                    options: [
                        { type: 3, name: 'nom', description: 'Nouveau nom du salon', required: true, max_length: 100 },
                    ],
                },
                {
                    type: 1,
                    name: 'limit',
                    description: 'Limiter le nombre de places',
                    options: [
                        { max_value: 99, min_value: 0, type: 4, name: 'places', description: 'Nombre de places (0 = illimité)', required: true },
                    ],
                },
                { type: 1, name: 'lock', description: 'Verrouiller votre salon (personne ne peut rejoindre)', options: [] },
                { type: 1, name: 'unlock', description: 'Déverrouiller votre salon', options: [] },
                {
                    type: 1,
                    name: 'permit',
                    description: 'Autoriser quelqu\'un à rejoindre (si verrouillé)',
                    options: [
                        { name: 'utilisateur', description: 'L\'utilisateur à autoriser', required: true, type: 6 },
                    ],
                },
                {
                    type: 1,
                    name: 'kick',
                    description: 'Expulser quelqu\'un de votre salon',
                    options: [
                        { name: 'utilisateur', description: 'L\'utilisateur à expulser', required: true, type: 6 },
                    ],
                },
                { type: 1, name: 'reset', description: 'Réinitialiser vos préférences mémorisées', options: [] },
            ],
            name: 'voice',
            description: 'Personnaliser votre salon vocal temporaire',
            type: 1,
        },
    };

    for (const [fichier, reference] of Object.entries(REFERENCES)) {
        const descripteur = require(`../bot/commands/${fichier}`);
        assert.deepEqual(corpsEnvoye(construireSlashCommand(descripteur)), reference, `/${fichier}`);
        assert.equal(reference.default_member_permissions, undefined,
            '/voice n\'a jamais porté de restriction d\'accès : accesParDefaut ne doit rien poser');
    }
});

test('la famille musique reste désactivée : /music n\'est ni chargée ni déployée', () => {
    // Contexte indispensable à la lecture du lot : les trois fichiers musique
    // sont coupés depuis le 2026-06-18 et ne sont chargés NI par le bot NI par
    // le déploiement. La migration de musicconfig.js est donc sans effet
    // observable tant que la coupure tient — et c'est aussi pourquoi son JSON
    // n'apparaît dans aucune requête de déploiement.
    const { DISABLED_COMMAND_FILES } = require('../bot/utils/disabledCommands');
    assert.deepEqual(DISABLED_COMMAND_FILES, ['play.js', 'musicconfig.js', 'musiccontrols.js']);
});

test('les commandes migrées du lot 4 déclarent les permissions du BOT', () => {
    // Sans cette déclaration, une commande migrée sort du balayage
    // `PermissionFlagsBits` et le garde-fou du lien d'invitation devient un faux
    // témoin : il continuerait de passer en ne voyant plus rien.
    //
    // /tempvoice ne consomme aucune des deux pour elle-même : elles servent à ce
    // qu'elle configure, dans `voiceStateUpdate`, qui n'a nulle part où les
    // déclarer. C'est ici qu'elles restent rattachées à un usage.
    assert.deepEqual(require('../bot/commands/tempvoice').permissionsBot, ['MANAGE_CHANNELS', 'MOVE_MEMBERS']);
    assert.deepEqual(require('../bot/commands/voice').permissionsBot, ['MANAGE_CHANNELS', 'MOVE_MEMBERS']);
    assert.deepEqual(require('../bot/commands/musicconfig').permissionsBot, []);
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. Comportement — /tempvoice
// ═════════════════════════════════════════════════════════════════════════════

const tempvoice = require('../bot/commands/tempvoice');

test('/tempvoice setup enregistre le trigger et annonce la catégorie', async () => {
    const { ctx, reponses } = faireCtx({
        guildeId: 'g-setup',
        options: { salon: { id: 'trigger-1', parentId: 'cat-1', nom: 'Créer', mention: '<#trigger-1>' } },
    });
    await sous(tempvoice, 'setup').executer(ctx);

    const ligne = getDb().prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ?').get('g-setup');
    assert.equal(ligne.channel_id, 'trigger-1');
    assert.equal(ligne.category_id, 'cat-1');
    assert.equal(ligne.enabled, 1);

    // La description reprend une MENTION construite à la main, comme avant
    // migration : le salon peut avoir été renommé entre-temps, et une mention
    // reste juste là où un nom recopié serait périmé.
    assert.equal(reponses.length, 1);
    assert.equal(reponses[0][0].titre, '🎧 Trigger ajouté');
    assert.equal(reponses[0][0].couleur, 0xc86e8e);
    assert.match(reponses[0][0].description, /^<#trigger-1> est maintenant un salon "Join to Create"\./);
    assert.deepEqual(reponses[0][1], {}, 'l\'annonce reste publique');
});

test('/tempvoice setup refuse un second trigger dans la même catégorie', async () => {
    getDb().prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run('g-collision', 'deja-la', 'cat-2');

    // Le salon déjà configuré existe encore : pas de mention « (supprimé) ».
    const present = faireCtx({
        guildeId: 'g-collision',
        options: { salon: { id: 'autre', parentId: 'cat-2' } },
        canaux: { 'deja-la': { id: 'deja-la', nom: 'Créer' } },
    });
    await sous(tempvoice, 'setup').executer(present.ctx);
    assert.deepEqual(present.reponses[0], [
        '❌ Il y a déjà un trigger dans cette catégorie : <#deja-la>. Retirez-le d\'abord avec `/tempvoice remove`.',
        { ephemere: true },
    ]);

    // Salon disparu : `obtenirCanal` rend null, et la mention le dit.
    const absent = faireCtx({
        guildeId: 'g-collision',
        options: { salon: { id: 'autre', parentId: 'cat-2' } },
    });
    await sous(tempvoice, 'setup').executer(absent.ctx);
    assert.match(absent.reponses[0][0], /<#deja-la> \(supprimé\)\./);

    // Rien n'a été écrit : le refus est bien un refus.
    const lignes = getDb().prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ?').all('g-collision');
    assert.deepEqual(lignes.map(l => l.channel_id), ['deja-la']);
});

test('/tempvoice setup réactive le trigger déjà posé sur le même salon', async () => {
    // Le conflit ne se déclenche que pour un AUTRE salon de la catégorie :
    // reposer le même trigger le réactive, sans message d'erreur.
    getDb().prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,0)')
        .run('g-reactive', 'trigger-3', 'cat-3');

    const { ctx, reponses } = faireCtx({
        guildeId: 'g-reactive',
        options: { salon: { id: 'trigger-3', parentId: 'cat-3' } },
    });
    await sous(tempvoice, 'setup').executer(ctx);

    assert.equal(reponses[0][0].titre, '🎧 Trigger ajouté');
    assert.equal(
        getDb().prepare('SELECT enabled FROM tempvoice_triggers WHERE channel_id = ?').get('trigger-3').enabled,
        1,
    );
});

test('/tempvoice remove sur un salon non configuré est une erreur d\'USAGE', async () => {
    // Pas un incident : rien n'est journalisé, aucun code d'incident n'est
    // affiché. C'est `ctx.erreurUtilisateur` et non une exception.
    const { ctx, erreurs, reponses } = faireCtx({
        guildeId: 'g-vide',
        options: { salon: { id: 'inconnu' } },
    });
    await sous(tempvoice, 'remove').executer(ctx);

    assert.equal(reponses.length, 0);
    assert.deepEqual(erreurs, [{
        titre: 'Ce salon n\'est pas un salon d\'accueil',
        cause: 'Ce salon vocal ne déclenche pas la création de salons temporaires.',
        action: 'Consultez les salons d\'accueil configurés avec `/tempvoice list`.',
    }]);
});

test('/tempvoice disable et enable basculent tous les triggers du serveur', async () => {
    const db = getDb();
    db.prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run('g-bascule', 'a', 'cat-a');
    db.prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run('g-bascule', 'b', 'cat-b');

    const eteint = faireCtx({ guildeId: 'g-bascule' });
    await sous(tempvoice, 'disable').executer(eteint.ctx);
    assert.equal(eteint.reponses[0][0].titre, '🎧 Vocaux temporaires désactivés');
    assert.deepEqual(
        db.prepare('SELECT enabled FROM tempvoice_triggers WHERE guild_id = ?').all('g-bascule').map(l => l.enabled),
        [0, 0],
    );

    const rallume = faireCtx({ guildeId: 'g-bascule' });
    await sous(tempvoice, 'enable').executer(rallume.ctx);
    assert.equal(rallume.reponses[0][0].titre, '🎧 Vocaux temporaires réactivés');
    assert.deepEqual(
        db.prepare('SELECT enabled FROM tempvoice_triggers WHERE guild_id = ?').all('g-bascule').map(l => l.enabled),
        [1, 1],
    );

    // Serveur sans aucun trigger : erreur d'usage, pas de bascule silencieuse.
    const sansRien = faireCtx({ guildeId: 'g-neant' });
    await sous(tempvoice, 'disable').executer(sansRien.ctx);
    assert.equal(sansRien.reponses.length, 0);
    assert.equal(sansRien.erreurs[0].titre, 'Aucun salon d\'accueil configuré');
});

test('/tempvoice info résout le nom des catégories par le client REST', async () => {
    const db = getDb();
    db.prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run('g-info', 'tv-on', 'cat-connue');
    db.prepare('INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,0)')
        .run('g-info', 'tv-off', '');
    db.prepare('INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?,?,?,?)')
        .run('salon-actif', 'g-info', 'membre-1', 'cat-connue');
    db.prepare('INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name) VALUES (?,?,?,?)')
        .run('g-info', 'membre-1', 'cat-connue', 'Mon salon');

    const { ctx, reponses } = faireCtx({
        guildeId: 'g-info',
        canaux: { 'cat-connue': { id: 'cat-connue', nom: 'Vocaux' } },
    });
    await sous(tempvoice, 'info').executer(ctx);

    const [contenu, options] = reponses[0];
    assert.deepEqual(options, {}, 'la config est publique quand elle existe');
    assert.equal(contenu.titre, '🎧 Vocaux temporaires — Config');

    // L'ordre des lignes suit celui du `SELECT *`, sans ORDER BY, exactement
    // comme avant migration : on vérifie le CONTENU de chaque ligne, pas un
    // ordre que la requête ne garantit pas.
    const [triggers, ...compteurs] = contenu.champs;
    assert.equal(triggers.nom, 'Triggers');
    assert.deepEqual(triggers.valeur.split('\n').sort(), [
        // Une catégorie vide reste « Sans catégorie », sans aucun appel REST.
        '❌ <#tv-off> → Sans catégorie',
        '✅ <#tv-on> → Vocaux',
    ].sort());
    assert.deepEqual(compteurs, [
        { nom: 'Vocaux actifs', valeur: '1', enLigne: true },
        { nom: 'Préférences sauvées', valeur: '1', enLigne: true },
    ]);
});

test('/tempvoice info sans trigger répond en éphémère, sans embed', async () => {
    const { ctx, reponses } = faireCtx({ guildeId: 'g-aucun' });
    await sous(tempvoice, 'info').executer(ctx);
    assert.deepEqual(reponses, [[
        '🎧 Aucun trigger configuré. Utilisez `/tempvoice setup` pour commencer.',
        { ephemere: true },
    ]]);
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. Comportement — /music
// ═════════════════════════════════════════════════════════════════════════════

const musicconfig = require('../bot/commands/musicconfig');

test('/music setchannel, status et removechannel forment un aller-retour complet', async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run('g-music');

    const pose = faireCtx({
        guildeId: 'g-music',
        options: { channel: { id: 'salon-musique', mention: '<#salon-musique>' } },
    });
    await sous(musicconfig, 'setchannel').executer(pose.ctx);
    assert.equal(pose.reponses[0][0].titre, '🎵 Salon musique configuré');
    assert.equal(pose.reponses[0][0].description, 'Les commandes musique ne seront acceptées que dans <#salon-musique>.');
    assert.equal(
        db.prepare('SELECT allowed_channel FROM music_config WHERE guild_id = ?').get('g-music').allowed_channel,
        'salon-musique',
    );

    // `status` est la seule des trois à répondre en éphémère.
    const etat = faireCtx({ guildeId: 'g-music' });
    await sous(musicconfig, 'status').executer(etat.ctx);
    assert.deepEqual(etat.reponses[0][1], { ephemere: true });
    assert.equal(etat.reponses[0][0].description, 'Commandes musique restreintes à <#salon-musique>.');

    const retire = faireCtx({ guildeId: 'g-music' });
    await sous(musicconfig, 'removechannel').executer(retire.ctx);
    assert.equal(retire.reponses[0][0].titre, '🎵 Restriction retirée');
    assert.equal(
        db.prepare('SELECT allowed_channel FROM music_config WHERE guild_id = ?').get('g-music').allowed_channel,
        null,
    );

    const apres = faireCtx({ guildeId: 'g-music' });
    await sous(musicconfig, 'status').executer(apres.ctx);
    assert.equal(apres.reponses[0][0].description, 'Commandes musique acceptées dans tous les salons.');
});

test('/music status sur un serveur jamais configuré ne lève pas', async () => {
    // La ligne `music_config` n'existe pas : la commande doit répondre
    // « aucune restriction », et non échouer sur un `undefined`.
    const { ctx, reponses } = faireCtx({ guildeId: 'g-music-vierge' });
    await sous(musicconfig, 'status').executer(ctx);
    assert.equal(reponses[0][0].description, 'Commandes musique acceptées dans tous les salons.');
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. Overwrites : le piège du lot
// ═════════════════════════════════════════════════════════════════════════════
//
// `permissionOverwrites.edit()` modifiait UNE entrée. Sa traduction naïve,
// `modifierCanal({ permissions })`, remplace le jeu ENTIER : le propriétaire du
// salon perdrait à chaque verrouillage les droits que la création lui a donnés,
// et les autorisations accordées par « Autoriser » disparaîtraient avec. Les
// tests ci-dessous font tourner le VRAI client REST contre un salon simulé et
// comparent le jeu d'overwrites résultant, entrée par entrée.

const { Routes } = require('discord.js');
const { BITS } = require('../bot/platform/discord/permissions');
const { creerApi } = require('../bot/platform/discord/api');

const GUILDE = '900000000000000010';
const SALON = '900000000000000011';
const PROPRIO = '900000000000000012';
const INVITE = '900000000000000013';

/** Droits que la création du salon donne à son propriétaire. */
const DROITS_PROPRIO = BITS.MANAGE_CHANNELS | BITS.MOVE_MEMBERS | BITS.MUTE_MEMBERS | BITS.DEAFEN_MEMBERS;

/** Jeu d'overwrites de départ : @everyone neutre, le propriétaire, un invité. */
const JEU_DEPART = Object.freeze([
    { id: GUILDE, type: 0, allow: '0', deny: '0' },
    { id: PROPRIO, type: 1, allow: String(DROITS_PROPRIO), deny: '0' },
    { id: INVITE, type: 1, allow: String(BITS.CONNECT | BITS.VIEW_CHANNEL), deny: '0' },
]);

/** Client REST simulé : cache vide (donc lecture REST), écritures capturées. */
function faireApi(overwrites) {
    const ecritures = [];
    const client = {
        channels: { cache: new Map() },
        rest: {
            async get(route) {
                assert.equal(route, Routes.channel(SALON), 'lecture inattendue');
                return { id: SALON, permission_overwrites: overwrites.map(o => ({ ...o })) };
            },
            async put(route, options) { ecritures.push({ verbe: 'PUT', route, body: options.body }); return {}; },
            async patch(route, options) { ecritures.push({ verbe: 'PATCH', route, body: options.body }); return { id: SALON }; },
            async delete(route) { ecritures.push({ verbe: 'DELETE', route }); return {}; },
        },
    };
    return { api: creerApi(client), ecritures };
}

/** Rejoue les écritures sur le jeu de départ, pour obtenir le jeu résultant. */
function jeuApres(depart, ecritures) {
    const resultat = depart.map(o => ({ ...o }));
    for (const ecriture of ecritures) {
        if (ecriture.verbe !== 'PUT') continue;
        const cibleId = ecriture.route.split('/').pop();
        const existant = resultat.find(o => o.id === cibleId);
        if (existant) Object.assign(existant, ecriture.body);
        else resultat.push({ id: cibleId, ...ecriture.body });
    }
    return resultat;
}

test('verrouiller ne touche QUE l\'entrée @everyone', async () => {
    const { api, ecritures } = faireApi(JEU_DEPART);
    await api.definirOverwrite(SALON, GUILDE, { CONNECT: false }, { type: 'role' });

    // Une seule écriture, et c'est un PUT ciblé : jamais un PATCH de salon.
    assert.equal(ecritures.length, 1);
    assert.equal(ecritures[0].verbe, 'PUT');
    assert.equal(ecritures[0].route, Routes.channelPermission(SALON, GUILDE));
    assert.deepEqual(ecritures[0].body, { type: 0, allow: '0', deny: String(BITS.CONNECT) });

    // Le jeu résultant : @everyone refuse CONNECT, TOUT le reste est intact.
    assert.deepEqual(jeuApres(JEU_DEPART, ecritures), [
        { id: GUILDE, type: 0, allow: '0', deny: String(BITS.CONNECT) },
        { id: PROPRIO, type: 1, allow: String(DROITS_PROPRIO), deny: '0' },
        { id: INVITE, type: 1, allow: String(BITS.CONNECT | BITS.VIEW_CHANNEL), deny: '0' },
    ]);
});

test('déverrouiller rend la permission à l\'héritage, sur les deux masques', async () => {
    const verrouille = [
        { id: GUILDE, type: 0, allow: '0', deny: String(BITS.CONNECT) },
        ...JEU_DEPART.slice(1).map(o => ({ ...o })),
    ];
    const { api, ecritures } = faireApi(verrouille);
    await api.definirOverwrite(SALON, GUILDE, { CONNECT: null }, { type: 'role' });

    // `null` et non `false` : un refus gravé empêcherait de rejoindre pour
    // toujours, et le salon paraîtrait déverrouillé.
    assert.deepEqual(ecritures[0].body, { type: 0, allow: '0', deny: '0' });
    assert.deepEqual(jeuApres(verrouille, ecritures), JEU_DEPART.map(o => ({ ...o })));
});

test('autoriser quelqu\'un crée SON entrée sans réécrire les autres', async () => {
    const NOUVEAU = '900000000000000014';
    const { api, ecritures } = faireApi(JEU_DEPART);
    await api.definirOverwrite(SALON, NOUVEAU, { CONNECT: true, VIEW_CHANNEL: true }, { type: 'membre' });

    assert.equal(ecritures.length, 1);
    assert.equal(ecritures[0].route, Routes.channelPermission(SALON, NOUVEAU));
    assert.deepEqual(ecritures[0].body, {
        type: 1,
        allow: String(BITS.CONNECT | BITS.VIEW_CHANNEL),
        deny: '0',
    });
    // Les trois entrées de départ sont rendues telles quelles, la nouvelle s'ajoute.
    assert.deepEqual(jeuApres(JEU_DEPART, ecritures).slice(0, 3), JEU_DEPART.map(o => ({ ...o })));
});

test('les droits du propriétaire sont posés en overwrite unitaire à la création', async () => {
    // Le salon vient d'être créé et n'a que l'héritage de sa catégorie : aucun
    // overwrite propre. `definirOverwrite` doit donc CRÉER l'entrée, d'où le
    // `type` obligatoire — l'API ne le devine pas.
    const { api, ecritures } = faireApi([]);
    await api.definirOverwrite(SALON, PROPRIO, {
        MANAGE_CHANNELS: true, MOVE_MEMBERS: true, MUTE_MEMBERS: true, DEAFEN_MEMBERS: true,
    }, { type: 'membre' });

    assert.deepEqual(ecritures[0].body, { type: 1, allow: String(DROITS_PROPRIO), deny: '0' });
});

test('aucun fichier du lot ne passe « permissions » à modifierCanal', () => {
    // Contre-épreuve textuelle du piège : `modifierCanal({ permissions })`
    // remplace le jeu entier. Les tests ci-dessus prouvent que la bonne
    // primitive fait la bonne chose ; celui-ci prouve qu'on n'appelle pas
    // l'autre.
    const fs = require('node:fs');
    const path = require('node:path');
    const fichiers = [
        'bot/commands/voice.js',
        'bot/commands/tempvoice.js',
        'bot/interactions/tempvoice.js',
        'bot/events/voiceStateUpdate.js',
    ];
    for (const relatif of fichiers) {
        const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
        for (const appel of source.matchAll(/modifierCanal\(([^;]*?)\)\s*;/gs)) {
            assert.ok(!/permissions\s*:/.test(appel[1]),
                `${relatif} : modifierCanal({ permissions }) remplacerait TOUS les overwrites du salon. `
                + 'Utilisez definirOverwrite.');
        }
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  5. Comportement — /voice, le panneau, l'événement
// ═════════════════════════════════════════════════════════════════════════════

const voice = require('../bot/commands/voice');
const { PANNEAU, BOUTONS_PANNEAU, handlerPanneauTempVoice } = require('../bot/interactions/tempvoice');
const evenementVocal = require('../bot/events/voiceStateUpdate');

/**
 * Contexte neutre de doublure, version vocale : porte `guilde`, `membre` (avec
 * son salon vocal) et les méthodes d'API que le vocal consomme. Tous les appels
 * sont capturés dans l'ordre — c'est l'ordre qui prouve qu'on verrouille AVANT
 * de renommer, comme avant migration.
 */
function faireCtxVocal({
    guildeId = 'g-vocal', auteurId = 'proprio', canalVocalId = null,
    sousCommande = null, options = {}, canaux = {}, membres = {}, vocaux = {},
    saisies = [], selections = [],
} = {}) {
    const appels = [];
    const reponses = [];
    const erreurs = [];
    const panneaux = [];
    const poses = [];

    const ctx = {
        plateforme: 'discord',
        capacites: { interactions: true },
        guildeId,
        canalId: canalVocalId,
        guilde: { id: guildeId, nom: 'Serveur', roleParDefautId: guildeId },
        auteur: { id: auteurId, nom: 'Proprio', mention: `<@${auteurId}>` },
        membre: { id: auteurId, nom: 'Proprio', mention: `<@${auteurId}>`, canalVocalId },
        db: getDb(),
        options: { get: (nom) => options[nom], sousCommande },
        api: {
            async obtenirCanal(id) { return canaux[id] ?? null; },
            async obtenirMembre(_g, id) { return membres[id] ?? null; },
            async listerMembresVocal(id) { return vocaux[id] ?? null; },
            async modifierCanal(...a) { appels.push(['modifierCanal', ...a]); },
            async definirOverwrite(...a) { appels.push(['definirOverwrite', ...a]); },
            async modifierMembre(...a) { appels.push(['modifierMembre', ...a]); },
        },
        async repondre(contenu, opts = {}) { reponses.push([contenu, opts]); },
        async erreurUtilisateur(spec) { erreurs.push(spec); },
        async modifierPanneau(payload) { panneaux.push(payload); },
        async prompt(questions, opts) { poses.push(['prompt', questions, opts]); return saisies.shift(); },
        async choisirMembre(message, opts) { poses.push(['choisirMembre', message, opts]); return selections.shift(); },
    };
    return { ctx, appels, reponses, erreurs, panneaux, poses };
}

/** Inscrit un salon temporaire actif en base. */
function poserSalonActif(canalId, guildeId, ownerId, categorieId = '') {
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?,?,?,?)')
        .run(canalId, guildeId, ownerId, categorieId);
}

// ── /voice : le contrôle de propriété ───────────────────────────────────────

test('/voice refuse hors d\'un salon vocal, et hors d\'un salon possédé', async () => {
    // Les DEUX conditions comptent. La base dit qui possède quoi ; seul
    // `ctx.membre.canalVocalId` dit où la personne est CONNECTÉE, et sans lui on
    // piloterait son salon à distance — ce que la commande n'a jamais permis.
    const dehors = faireCtxVocal({ sousCommande: 'lock', canalVocalId: null });
    await voice.executer(dehors.ctx);
    assert.equal(dehors.erreurs[0].titre, 'Vous n\'êtes pas dans un salon vocal temporaire');
    assert.deepEqual(dehors.appels, [], 'rien ne doit être écrit');

    // Connecté·e, mais à un salon qui n'est pas le sien.
    poserSalonActif('salon-autrui', 'g-vocal', 'quelqu-un-dautre');
    const autrui = faireCtxVocal({ sousCommande: 'lock', canalVocalId: 'salon-autrui' });
    await voice.executer(autrui.ctx);
    assert.equal(autrui.erreurs[0].titre, 'Vous n\'êtes pas dans un salon vocal temporaire');
    assert.deepEqual(autrui.appels, []);
});

// ── /voice : verrouillage ───────────────────────────────────────────────────

test('/voice lock verrouille par overwrite unitaire, PUIS renomme', async () => {
    poserSalonActif('salon-lock', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels, reponses } = faireCtxVocal({
        sousCommande: 'lock',
        canalVocalId: 'salon-lock',
        canaux: { 'salon-lock': { id: 'salon-lock', nom: 'Mon salon' } },
    });
    await voice.executer(ctx);

    assert.deepEqual(appels, [
        // La cible est le rôle par défaut du contrat, jamais `guilde.id` écrit
        // en dur : c'est ce qui rend le verrouillage portable.
        ['definirOverwrite', 'salon-lock', 'g-vocal', { CONNECT: false }, { type: 'role' }],
        ['modifierCanal', 'salon-lock', { nom: 'Mon salon 🔒' }],
    ]);
    assert.deepEqual(reponses, [['🔒 Salon verrouillé — plus personne ne peut rejoindre.', { ephemere: true }]]);
});

test('/voice lock ne double pas le cadenas d\'un salon déjà verrouillé', async () => {
    poserSalonActif('salon-relock', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels } = faireCtxVocal({
        sousCommande: 'lock',
        canalVocalId: 'salon-relock',
        canaux: { 'salon-relock': { id: 'salon-relock', nom: 'Mon salon 🔒' } },
    });
    await voice.executer(ctx);
    assert.deepEqual(appels[1], ['modifierCanal', 'salon-relock', { nom: 'Mon salon 🔒' }]);
});

test('/voice unlock rend CONNECT à l\'héritage et retire le cadenas', async () => {
    poserSalonActif('salon-unlock', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels, reponses } = faireCtxVocal({
        sousCommande: 'unlock',
        canalVocalId: 'salon-unlock',
        canaux: { 'salon-unlock': { id: 'salon-unlock', nom: 'Mon salon 🔒' } },
    });
    await voice.executer(ctx);

    // `null`, surtout pas `false` : un refus gravé laisserait le salon fermé
    // tout en l'affichant déverrouillé.
    assert.deepEqual(appels, [
        ['definirOverwrite', 'salon-unlock', 'g-vocal', { CONNECT: null }, { type: 'role' }],
        ['modifierCanal', 'salon-unlock', { nom: 'Mon salon' }],
    ]);
    assert.deepEqual(reponses, [['🔓 Salon déverrouillé.', { ephemere: true }]]);
});

test('/voice unlock ne renomme pas un salon qui n\'a pas de cadenas', async () => {
    poserSalonActif('salon-libre', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels } = faireCtxVocal({
        sousCommande: 'unlock',
        canalVocalId: 'salon-libre',
        canaux: { 'salon-libre': { id: 'salon-libre', nom: 'Mon salon' } },
    });
    await voice.executer(ctx);
    assert.deepEqual(appels.map(a => a[0]), ['definirOverwrite'], 'aucun renommage inutile');
});

// ── /voice : autoriser et expulser ──────────────────────────────────────────

test('/voice permit ouvre le salon à une personne, sans toucher aux autres', async () => {
    poserSalonActif('salon-permit', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels, reponses } = faireCtxVocal({
        sousCommande: 'permit',
        canalVocalId: 'salon-permit',
        options: { utilisateur: { id: 'invite', mention: '<@invite>' } },
    });
    await voice.executer(ctx);

    assert.deepEqual(appels, [
        ['definirOverwrite', 'salon-permit', 'invite', { CONNECT: true, VIEW_CHANNEL: true }, { type: 'membre' }],
    ]);
    assert.deepEqual(reponses, [['✅ <@invite> peut maintenant rejoindre votre salon.', { ephemere: true }]]);
});

test('/voice kick refuse une personne absente du salon, et le propriétaire lui-même', async () => {
    poserSalonActif('salon-kick', 'g-vocal', 'proprio', 'cat');

    const ailleurs = faireCtxVocal({
        sousCommande: 'kick',
        canalVocalId: 'salon-kick',
        options: { utilisateur: { id: 'passant', mention: '<@passant>' } },
        membres: { passant: { id: 'passant', canalVocalId: 'un-autre-salon' } },
    });
    await voice.executer(ailleurs.ctx);
    assert.equal(ailleurs.erreurs[0].titre, 'Cette personne n\'est pas dans votre salon');
    assert.deepEqual(ailleurs.appels, []);

    // Membre parti du serveur : même refus, et surtout pas une exception.
    const parti = faireCtxVocal({
        sousCommande: 'kick',
        canalVocalId: 'salon-kick',
        options: { utilisateur: { id: 'fantome', mention: '<@fantome>' } },
    });
    await voice.executer(parti.ctx);
    assert.equal(parti.erreurs[0].titre, 'Cette personne n\'est pas dans votre salon');

    // Le propriétaire est bien DANS son salon : le contrôle qui l'arrête est le
    // second, pas le premier. L'ordre des deux gardes compte.
    const soiMeme = faireCtxVocal({
        sousCommande: 'kick',
        canalVocalId: 'salon-kick',
        options: { utilisateur: { id: 'proprio', mention: '<@proprio>' } },
        membres: { proprio: { id: 'proprio', canalVocalId: 'salon-kick' } },
    });
    await voice.executer(soiMeme.ctx);
    assert.equal(soiMeme.erreurs[0].titre, 'Vous ne pouvez pas vous expulser vous-même');
    assert.deepEqual(soiMeme.appels, []);
});

test('/voice kick déconnecte en déplaçant vers « aucun salon », avec motif', async () => {
    poserSalonActif('salon-kick2', 'g-vocal', 'proprio', 'cat');
    const { ctx, appels, reponses } = faireCtxVocal({
        sousCommande: 'kick',
        canalVocalId: 'salon-kick2',
        options: { utilisateur: { id: 'genant', mention: '<@genant>' } },
        membres: { genant: { id: 'genant', canalVocalId: 'salon-kick2' } },
    });
    await voice.executer(ctx);

    assert.deepEqual(appels, [
        ['modifierMembre', 'g-vocal', 'genant', { canalVocalId: null }, 'Expulsé par le propriétaire du vocal'],
    ]);
    assert.deepEqual(reponses, [['✅ <@genant> a été expulsé du salon.', { ephemere: true }]]);
});

// ── /voice : préférences mémorisées ─────────────────────────────────────────

test('/voice name et limit renomment et mémorisent, /voice reset oublie', async () => {
    poserSalonActif('salon-prefs', 'g-prefs', 'proprio', 'cat-prefs');
    const db = getDb();

    const renommage = faireCtxVocal({
        guildeId: 'g-prefs', sousCommande: 'name', canalVocalId: 'salon-prefs',
        options: { nom: 'Le repaire' },
    });
    await voice.executer(renommage.ctx);
    assert.deepEqual(renommage.appels, [['modifierCanal', 'salon-prefs', { nom: 'Le repaire' }]]);
    assert.deepEqual(renommage.reponses, [['✅ Salon renommé en **Le repaire**', { ephemere: true }]]);

    const limite = faireCtxVocal({
        guildeId: 'g-prefs', sousCommande: 'limit', canalVocalId: 'salon-prefs',
        options: { places: 4 },
    });
    await voice.executer(limite.ctx);
    assert.deepEqual(limite.appels, [['modifierCanal', 'salon-prefs', { limiteUtilisateurs: 4 }]]);
    assert.deepEqual(limite.reponses, [['✅ Limite fixée à **4** places', { ephemere: true }]]);

    // Les deux préférences cohabitent sur la MÊME ligne : l'upsert vise
    // (serveur, personne, catégorie), et écraser l'une en posant l'autre
    // perdrait un réglage sans rien dire.
    const prefs = db.prepare('SELECT * FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
        .get('g-prefs', 'proprio', 'cat-prefs');
    assert.equal(prefs.channel_name, 'Le repaire');
    assert.equal(prefs.user_limit, 4);

    // Zéro place = illimité, et le message le dit autrement.
    const illimite = faireCtxVocal({
        guildeId: 'g-prefs', sousCommande: 'limit', canalVocalId: 'salon-prefs',
        options: { places: 0 },
    });
    await voice.executer(illimite.ctx);
    assert.deepEqual(illimite.reponses, [['✅ Limite retirée (illimité)', { ephemere: true }]]);

    const remise = faireCtxVocal({ guildeId: 'g-prefs', sousCommande: 'reset', canalVocalId: 'salon-prefs' });
    await voice.executer(remise.ctx);
    assert.deepEqual(remise.reponses, [['✅ Vos préférences pour cette catégorie ont été réinitialisées.', { ephemere: true }]]);
    assert.equal(
        db.prepare('SELECT * FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
            .get('g-prefs', 'proprio', 'cat-prefs'),
        undefined,
    );
});

// ── Le panneau : déclaration, boutons, routage ──────────────────────────────

test('le panneau est déclaré par /tempvoice sous le nom que l\'événement pose', () => {
    // Le contrat veut LE MÊME MOT à trois endroits. Ils sont ici comparés à la
    // source unique : trois littéraux séparés finiraient par diverger d'une
    // lettre, et un panneau posé que personne ne route ne produit AUCUNE erreur.
    assert.equal(PANNEAU, 'tempvoice');
    assert.deepEqual(Object.keys(require('../bot/commands/tempvoice').panneaux), [PANNEAU]);
    assert.equal(require('../bot/commands/tempvoice').panneaux[PANNEAU], handlerPanneauTempVoice);
    assert.equal(evenementVocal.PANNEAU, PANNEAU, 'l\'événement pose bien le panneau déclaré');
});

test('les boutons du panneau sont ceux d\'avant migration, dans le même ordre', () => {
    // Référence relevée sur `dev` : libellé, emoji et style de chaque bouton.
    // 1 = Primary, 2 = Secondary, 3 = Success, 4 = Danger.
    const REFERENCE = [
        { label: 'Renommer', emoji: '✏️', style: 1, custom_id: 'tempvoice:rename' },
        { label: 'Limite', emoji: '👥', style: 1, custom_id: 'tempvoice:limit' },
        { label: 'Verrouiller', emoji: '🔒', style: 2, custom_id: 'tempvoice:lock' },
        { label: 'Déverrouiller', emoji: '🔓', style: 2, custom_id: 'tempvoice:unlock' },
        { label: 'Autoriser', emoji: '✅', style: 3, custom_id: 'tempvoice:permit' },
        { label: 'Expulser', emoji: '👋', style: 4, custom_id: 'tempvoice:kick' },
        { label: 'Reset préfs', emoji: '🗑️', style: 4, custom_id: 'tempvoice:reset' },
    ];

    const { rendreChoix } = require('../bot/platform/discord/render');
    const rangees = rendreChoix(BOUTONS_PANNEAU, PANNEAU).map(r => r.toJSON());
    const boutons = rangees.flatMap(r => r.components);

    assert.deepEqual(
        boutons.map(b => ({ label: b.label, emoji: b.emoji.name, style: b.style, custom_id: b.custom_id })),
        REFERENCE,
    );

    // ⚠️ SEULE différence visible du panneau : le découpage en rangées. Le
    // panneau historique était écrit 4 + 3 ; `rendreChoix` remplit cinq boutons
    // par rangée, d'où 5 + 2. Assertion volontaire : cette bascule doit être
    // un choix relu, pas une dérive constatée en production.
    assert.deepEqual(rangees.map(r => r.components.length), [5, 2]);

    // Chaque bouton a un handler, et chaque handler un bouton.
    assert.deepEqual(
        BOUTONS_PANNEAU.map(b => b.cle).sort(),
        ['kick', 'limit', 'lock', 'permit', 'rename', 'reset', 'unlock'],
    );
});

// ── Le panneau : comportement ───────────────────────────────────────────────

test('le panneau refuse qui n\'est pas propriétaire, et un salon disparu', async () => {
    // Le salon visé n'est plus porté par l'identifiant du composant mais par
    // `ctx.canalId` : un clic vient forcément du salon où le panneau est posté.
    const intrus = faireCtxVocal({ canalVocalId: 'salon-panneau' });
    await handlerPanneauTempVoice(intrus.ctx, 'lock');
    assert.equal(intrus.erreurs[0].titre, 'Vous n\'êtes pas propriétaire de ce salon');
    assert.deepEqual(intrus.appels, []);

    poserSalonActif('salon-panneau', 'g-vocal', 'proprio', 'cat');
    const disparu = faireCtxVocal({ canalVocalId: 'salon-panneau' }); // aucun canal servi
    await handlerPanneauTempVoice(disparu.ctx, 'lock');
    assert.equal(disparu.erreurs[0].titre, 'Ce salon n\'existe plus');
    assert.deepEqual(disparu.appels, []);
});

test('le panneau verrouille et déverrouille exactement comme /voice', async () => {
    poserSalonActif('salon-pv', 'g-vocal', 'proprio', 'cat');

    const verrou = faireCtxVocal({
        canalVocalId: 'salon-pv',
        canaux: { 'salon-pv': { id: 'salon-pv', nom: 'Chez moi' } },
    });
    await handlerPanneauTempVoice(verrou.ctx, 'lock');
    assert.deepEqual(verrou.appels, [
        ['definirOverwrite', 'salon-pv', 'g-vocal', { CONNECT: false }, { type: 'role' }],
        ['modifierCanal', 'salon-pv', { nom: 'Chez moi 🔒' }],
    ]);
    assert.deepEqual(verrou.reponses, [['🔒 Salon verrouillé — plus personne ne peut rejoindre.', { ephemere: true }]]);

    const ouvert = faireCtxVocal({
        canalVocalId: 'salon-pv',
        canaux: { 'salon-pv': { id: 'salon-pv', nom: 'Chez moi 🔒' } },
    });
    await handlerPanneauTempVoice(ouvert.ctx, 'unlock');
    assert.deepEqual(ouvert.appels, [
        ['definirOverwrite', 'salon-pv', 'g-vocal', { CONNECT: null }, { type: 'role' }],
        ['modifierCanal', 'salon-pv', { nom: 'Chez moi' }],
    ]);
});

test('le panneau renomme par formulaire, et se tait si la fenêtre est fermée', async () => {
    poserSalonActif('salon-pr', 'g-pr', 'proprio', 'cat-pr');

    const rempli = faireCtxVocal({
        guildeId: 'g-pr', canalVocalId: 'salon-pr',
        canaux: { 'salon-pr': { id: 'salon-pr', nom: 'Avant' } },
        saisies: [{ name: 'Après' }],
    });
    await handlerPanneauTempVoice(rempli.ctx, 'rename');

    // Le formulaire reprend le champ, le libellé, la longueur et l'exemple
    // d'origine : c'est la même fenêtre pour qui l'utilise.
    assert.deepEqual(rempli.poses[0][1], [{
        cle: 'name', libelle: 'Nouveau nom', style: 'ligne', max: 100, requis: true, exemple: 'Mon salon cool',
    }]);
    assert.deepEqual(rempli.poses[0][2], { titre: 'Renommer le salon' });
    assert.deepEqual(rempli.appels, [['modifierCanal', 'salon-pr', { nom: 'Après' }]]);
    assert.equal(
        getDb().prepare('SELECT channel_name FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
            .get('g-pr', 'proprio', 'cat-pr').channel_name,
        'Après',
    );

    // Fenêtre fermée ou expirée : `prompt` rend null. Ce n'est pas une panne,
    // et surtout il ne faut RIEN répondre — l'interaction n'existe plus.
    const abandonne = faireCtxVocal({
        guildeId: 'g-pr', canalVocalId: 'salon-pr',
        canaux: { 'salon-pr': { id: 'salon-pr', nom: 'Avant' } },
        saisies: [null],
    });
    await handlerPanneauTempVoice(abandonne.ctx, 'rename');
    assert.deepEqual(abandonne.appels, []);
    assert.deepEqual(abandonne.reponses, []);
    assert.deepEqual(abandonne.erreurs, []);
});

test('le panneau refuse une limite hors bornes sans toucher au salon', async () => {
    poserSalonActif('salon-pl', 'g-pl', 'proprio', 'cat-pl');
    for (const saisie of ['abc', '-1', '100']) {
        const { ctx, appels, erreurs } = faireCtxVocal({
            guildeId: 'g-pl', canalVocalId: 'salon-pl',
            canaux: { 'salon-pl': { id: 'salon-pl', nom: 'S' } },
            saisies: [{ limit: saisie }],
        });
        await handlerPanneauTempVoice(ctx, 'limit');
        assert.equal(erreurs[0]?.titre, 'Nombre de places invalide', `saisie « ${saisie} » acceptée à tort`);
        assert.deepEqual(appels, []);
    }

    const { ctx, appels } = faireCtxVocal({
        guildeId: 'g-pl', canalVocalId: 'salon-pl',
        canaux: { 'salon-pl': { id: 'salon-pl', nom: 'S' } },
        saisies: [{ limit: '12' }],
    });
    await handlerPanneauTempVoice(ctx, 'limit');
    assert.deepEqual(appels, [['modifierCanal', 'salon-pl', { limiteUtilisateurs: 12 }]]);
});

test('le panneau désigne une personne par sélecteur, jamais par saisie d\'identifiant', async () => {
    poserSalonActif('salon-ps', 'g-ps', 'proprio', 'cat');

    // Autoriser : périmètre « serveur », parce qu'on ouvre le salon à quelqu'un
    // qui n'y est justement PAS encore. C'est aussi le sélecteur natif d'avant
    // migration, à l'identique.
    const autorise = faireCtxVocal({
        guildeId: 'g-ps', canalVocalId: 'salon-ps',
        canaux: { 'salon-ps': { id: 'salon-ps', nom: 'S' } },
        membres: { arrivant: { id: 'arrivant', canalVocalId: null } },
        selections: [{ id: 'arrivant', nom: 'Arrivant', mention: '<@arrivant>' }],
    });
    await handlerPanneauTempVoice(autorise.ctx, 'permit');

    assert.equal(autorise.poses[0][1], '✅ Qui voulez-vous autoriser ?');
    assert.equal(autorise.poses[0][2].parmi, 'serveur');
    assert.equal(autorise.poses[0][2].ephemere, true);
    assert.deepEqual(autorise.appels, [
        ['definirOverwrite', 'salon-ps', 'arrivant', { CONNECT: true, VIEW_CHANNEL: true }, { type: 'membre' }],
    ]);
    // Le message du sélecteur est RÉÉCRIT, et ses composants retirés — c'est le
    // `interaction.update({ components: [] })` d'avant migration.
    assert.deepEqual(autorise.panneaux, [{
        contenu: '✅ <@arrivant> peut maintenant rejoindre votre salon.',
        composants: [],
    }]);
});

test('le panneau n\'ouvre pas de sélecteur d\'expulsion dans un salon vide', async () => {
    poserSalonActif('salon-pk', 'g-pk', 'proprio', 'cat');
    const seul = faireCtxVocal({
        guildeId: 'g-pk', canalVocalId: 'salon-pk',
        canaux: { 'salon-pk': { id: 'salon-pk', nom: 'S' } },
        vocaux: { 'salon-pk': [{ id: 'proprio', nom: 'Proprio', estBot: false }] },
    });
    await handlerPanneauTempVoice(seul.ctx, 'kick');
    assert.equal(seul.erreurs[0].titre, 'Personne d\'autre dans le salon');
    assert.deepEqual(seul.poses, [], 'aucun sélecteur ne doit s\'ouvrir');

    // Quelqu'un d'autre est là : le sélecteur s'ouvre, et la personne choisie
    // est recontrôlée — elle a pu partir entre l'ouverture et le choix.
    const partie = faireCtxVocal({
        guildeId: 'g-pk', canalVocalId: 'salon-pk',
        canaux: { 'salon-pk': { id: 'salon-pk', nom: 'S' } },
        vocaux: { 'salon-pk': [{ id: 'proprio' }, { id: 'genant' }] },
        membres: { genant: { id: 'genant', canalVocalId: null } },
        selections: [{ id: 'genant', nom: 'Gênant', mention: '<@genant>' }],
    });
    await handlerPanneauTempVoice(partie.ctx, 'kick');
    assert.deepEqual(partie.appels, []);
    assert.match(partie.panneaux[0].contenu, /n'est pas dans votre salon/);

    const expulsee = faireCtxVocal({
        guildeId: 'g-pk', canalVocalId: 'salon-pk',
        canaux: { 'salon-pk': { id: 'salon-pk', nom: 'S' } },
        vocaux: { 'salon-pk': [{ id: 'proprio' }, { id: 'genant' }] },
        membres: { genant: { id: 'genant', canalVocalId: 'salon-pk' } },
        selections: [{ id: 'genant', nom: 'Gênant', mention: '<@genant>' }],
    });
    await handlerPanneauTempVoice(expulsee.ctx, 'kick');
    assert.deepEqual(expulsee.appels, [
        ['modifierMembre', 'g-pk', 'genant', { canalVocalId: null }, 'Expulsé par le propriétaire du vocal'],
    ]);
    assert.deepEqual(expulsee.panneaux, [{ contenu: '✅ <@genant> a été expulsé.', composants: [] }]);
});

test('le panneau oublie les préférences de la catégorie du salon', async () => {
    poserSalonActif('salon-pz', 'g-pz', 'proprio', 'cat-pz');
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name) VALUES (?,?,?,?)')
        .run('g-pz', 'proprio', 'cat-pz', 'Mémorisé');

    const { ctx, reponses } = faireCtxVocal({
        guildeId: 'g-pz', canalVocalId: 'salon-pz',
        canaux: { 'salon-pz': { id: 'salon-pz', nom: 'S' } },
    });
    await handlerPanneauTempVoice(ctx, 'reset');

    assert.deepEqual(reponses, [['✅ Vos préférences pour cette catégorie ont été réinitialisées.', { ephemere: true }]]);
    assert.equal(
        getDb().prepare('SELECT * FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
            .get('g-pz', 'proprio', 'cat-pz'),
        undefined,
    );
});

// ── L'événement : création et suppression du salon temporaire ───────────────

const { normaliserEtatVocal } = require('../bot/platform/discord/events');

// Identifiants numériques : `normaliserMembre` déduit la date de création du
// compte du snowflake, et `BigInt('proprio')` lèverait.
const G = '800000000000000001';
const TRIGGER = '800000000000000002';
const CAT = '800000000000000003';
const NOUVEAU = '800000000000000009';

/** État vocal normalisé par la VRAIE fonction de l'adaptateur. */
function etatVocal(canalId, membreId, nom = 'Alix') {
    return normaliserEtatVocal({
        guild: { id: G },
        channelId: canalId,
        id: membreId,
        member: {
            id: membreId,
            displayName: nom,
            user: { id: membreId, username: nom.toLowerCase(), tag: `${nom.toLowerCase()}#0`, bot: false },
        },
    });
}

/** Contexte d'événement de doublure : api, db et poserPanneau, rien d'autre. */
function faireCtxEvenement({ canaux = {}, vocaux = {} } = {}) {
    const appels = [];
    const ctx = {
        plateforme: 'discord',
        capacites: {},
        moi: { id: '800000000000000000' },
        db: getDb(),
        api: {
            async obtenirCanal(id) { return canaux[id] ?? null; },
            async obtenirMembre(_g, id) { return canaux[`membre:${id}`] ?? null; },
            async listerMembresVocal(id) { return vocaux[id] ?? null; },
            async creerCanal(guildeId, spec) {
                appels.push(['creerCanal', guildeId, spec]);
                canaux[NOUVEAU] = { id: NOUVEAU, nom: spec.nom, parentId: spec.parentId };
                return canaux[NOUVEAU];
            },
            async definirOverwrite(...a) { appels.push(['definirOverwrite', ...a]); },
            async modifierMembre(...a) { appels.push(['modifierMembre', ...a]); },
            async supprimerCanal(...a) { appels.push(['supprimerCanal', ...a]); },
            async ajouterRole(...a) { appels.push(['ajouterRole', ...a]); },
            async retirerRole(...a) { appels.push(['retirerRole', ...a]); },
            async envoyerMessage(...a) { appels.push(['envoyerMessage', ...a]); return { id: 'msg' }; },
        },
        async poserPanneau(canalId, contenu, choix, options) {
            appels.push(['poserPanneau', canalId, contenu, choix, options]);
            return { canalId, messageId: 'msg' };
        },
    };
    return { ctx, appels };
}

test('l\'événement vocal est branché sur le nom neutre, et garde ses exports annexes', () => {
    // `nom: 'voiceStateUpdate'` passerait la validation de format et ne serait
    // JAMAIS appelé : discord.js n'émet pas d'événement portant un nom neutre.
    assert.equal(evenementVocal.nom, 'etatVocalModifie');
    assert.equal(typeof evenementVocal.executer, 'function');
    assert.equal(evenementVocal.execute, undefined, 'migration à moitié faite');

    // Le bug de la v4.7.0 : les exports annexes posés AVANT l'affectation de
    // module.exports étaient écrasés par elle, bot/index.js les lisait
    // `undefined`, et le rechargement des salons au démarrage échouait en
    // silence. `definirEvenement` rend un objet : la règle vaut toujours.
    assert.ok(evenementVocal.tempvoiceChannelIds instanceof Set);
    assert.equal(typeof evenementVocal.isTempVoiceCreating, 'function');
    assert.equal(evenementVocal.isTempVoiceCreating(), false);
});

test('l\'événement ignore un changement qui n\'est pas un déplacement, et les bots', async () => {
    // Couper son micro émet le même événement. Sans ce filtre, chaque
    // mute/unmute relancerait toute la chaîne TempVoice.
    const memeSalon = faireCtxEvenement();
    await evenementVocal.executer(memeSalon.ctx, etatVocal(TRIGGER, '800000000000000021'), etatVocal(TRIGGER, '800000000000000021'));
    assert.deepEqual(memeSalon.appels, []);

    const bot = faireCtxEvenement();
    const etatBot = normaliserEtatVocal({
        guild: { id: G }, channelId: TRIGGER, id: '800000000000000022',
        member: { id: '800000000000000022', displayName: 'Quasar', user: { id: '800000000000000022', username: 'quasar', tag: 'quasar#0', bot: true } },
    });
    await evenementVocal.executer(bot.ctx, etatVocal(null, '800000000000000022'), etatBot);
    assert.deepEqual(bot.appels, []);
});

test('rejoindre le salon d\'accueil crée le salon, ses droits, et pose son panneau', async () => {
    const MEMBRE = '800000000000000031';
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run(G, TRIGGER, CAT);

    const { ctx, appels } = faireCtxEvenement({
        canaux: { [TRIGGER]: { id: TRIGGER, nom: 'Créer un salon', parentId: CAT } },
    });
    await evenementVocal.executer(ctx, etatVocal(null, MEMBRE), etatVocal(TRIGGER, MEMBRE, 'Alix'));

    // Le salon hérite de la catégorie du SALON D'ACCUEIL, pas de celle
    // enregistrée : c'était déjà `triggerChannel.parentId` avant migration, et
    // les deux diffèrent si le trigger a été déplacé depuis sa configuration.
    assert.deepEqual(appels[0], ['creerCanal', G, {
        nom: '🎧 Salon de Alix', type: 'vocal', parentId: CAT, limiteUtilisateurs: 0,
    }]);

    // Droits du propriétaire en overwrite UNITAIRE : un remplacement du jeu
    // entier effacerait ce que le salon hérite de sa catégorie.
    assert.deepEqual(appels[1], ['definirOverwrite', NOUVEAU, MEMBRE, {
        MANAGE_CHANNELS: true, MOVE_MEMBERS: true, MUTE_MEMBERS: true, DEAFEN_MEMBERS: true,
    }, { type: 'membre' }]);

    assert.deepEqual(appels[2], ['modifierMembre', G, MEMBRE, { canalVocalId: NOUVEAU }]);

    // La ligne n'est écrite qu'APRÈS le déplacement, comme avant migration.
    const actif = getDb().prepare('SELECT * FROM tempvoice_active WHERE channel_id = ?').get(NOUVEAU);
    assert.equal(actif.owner_id, MEMBRE);
    assert.equal(actif.category_id, CAT);

    // Le panneau est posé DANS le salon créé, sous le nom que /tempvoice
    // déclare — c'est ce qui rend ses clics routables après un redémarrage.
    const pose = appels.find(a => a[0] === 'poserPanneau');
    assert.equal(pose[1], NOUVEAU);
    assert.equal(pose[2].titre, '🎧 C\'est votre salon, Alix !');
    assert.equal(pose[2].pied.texte, 'Ce salon sera supprimé quand tout le monde sera parti.');
    assert.equal(pose[3], BOUTONS_PANNEAU);
    assert.deepEqual(pose[4], { panneau: PANNEAU });

    assert.ok(evenementVocal.tempvoiceChannelIds.has(NOUVEAU), 'le salon doit être suivi pour channelCreate/Delete');
    assert.equal(evenementVocal.isTempVoiceCreating(), false, 'le drapeau doit retomber');
});

test('un second salon dans la même catégorie ramène la personne dans le sien', async () => {
    const MEMBRE = '800000000000000041';
    const DEJA = '800000000000000042';
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run(G, TRIGGER, CAT);
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?,?,?,?)')
        .run(DEJA, G, MEMBRE, CAT);

    const { ctx, appels } = faireCtxEvenement({
        canaux: {
            [TRIGGER]: { id: TRIGGER, nom: 'Créer', parentId: CAT },
            [DEJA]: { id: DEJA, nom: 'Déjà là', parentId: CAT },
        },
    });
    await evenementVocal.executer(ctx, etatVocal(null, MEMBRE), etatVocal(TRIGGER, MEMBRE));

    assert.deepEqual(appels, [['modifierMembre', G, MEMBRE, { canalVocalId: DEJA }]]);
});

test('une seconde création dans les dix secondes est refusée, la personne est déconnectée', async () => {
    const MEMBRE = '800000000000000051';
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled) VALUES (?,?,?,1)')
        .run(G, TRIGGER, CAT);

    const premier = faireCtxEvenement({ canaux: { [TRIGGER]: { id: TRIGGER, nom: 'Créer', parentId: CAT } } });
    await evenementVocal.executer(premier.ctx, etatVocal(null, MEMBRE), etatVocal(TRIGGER, MEMBRE));
    assert.equal(premier.appels[0][0], 'creerCanal');

    // Le salon créé est nettoyé pour que la seconde tentative ne retombe pas sur
    // la branche « vous en avez déjà un ».
    getDb().prepare('DELETE FROM tempvoice_active WHERE owner_id = ?').run(MEMBRE);

    const second = faireCtxEvenement({ canaux: { [TRIGGER]: { id: TRIGGER, nom: 'Créer', parentId: CAT } } });
    await evenementVocal.executer(second.ctx, etatVocal(null, MEMBRE), etatVocal(TRIGGER, MEMBRE));
    assert.deepEqual(second.appels, [
        ['modifierMembre', G, MEMBRE, { canalVocalId: null }, 'Création trop rapide'],
    ]);
});

test('le dernier parti fait supprimer le salon, et seulement s\'il est vide', async () => {
    const MEMBRE = '800000000000000061';
    const SALON_TEMP = '800000000000000062';

    // Encore quelqu'un dedans : on ne touche à rien.
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?,?,?,?)')
        .run(SALON_TEMP, G, MEMBRE, CAT);
    const occupe = faireCtxEvenement({
        canaux: { [SALON_TEMP]: { id: SALON_TEMP, nom: 'Salon d\'Alix' } },
        vocaux: { [SALON_TEMP]: [{ id: '800000000000000063' }] },
    });
    await evenementVocal.executer(occupe.ctx, etatVocal(SALON_TEMP, MEMBRE), etatVocal(null, MEMBRE));
    assert.deepEqual(occupe.appels, []);
    assert.ok(getDb().prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(SALON_TEMP));

    // Vide : suppression du salon ET de sa ligne.
    const vide = faireCtxEvenement({
        canaux: { [SALON_TEMP]: { id: SALON_TEMP, nom: 'Salon d\'Alix' } },
        vocaux: { [SALON_TEMP]: [] },
    });
    await evenementVocal.executer(vide.ctx, etatVocal(SALON_TEMP, MEMBRE), etatVocal(null, MEMBRE));
    assert.deepEqual(vide.appels, [['supprimerCanal', SALON_TEMP]]);
    assert.equal(getDb().prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(SALON_TEMP), undefined);
});

test('un salon déjà disparu ne relance pas de suppression', async () => {
    // `listerMembresVocal` rend `null` quand le salon n'existe plus : c'est le
    // `!oldChannel` d'avant migration, et il ne faut ni supprimer ni journaliser.
    const MEMBRE = '800000000000000071';
    const FANTOME = '800000000000000072';
    getDb().prepare('INSERT OR REPLACE INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?,?,?,?)')
        .run(FANTOME, G, MEMBRE, CAT);

    const { ctx, appels } = faireCtxEvenement({ vocaux: { [FANTOME]: null } });
    await evenementVocal.executer(ctx, etatVocal(FANTOME, MEMBRE), etatVocal(null, MEMBRE));
    assert.deepEqual(appels, []);
    // La ligne survit : c'est le nettoyage au démarrage qui s'en charge, comme avant.
    assert.ok(getDb().prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(FANTOME));
});

test('les rôles vocaux suivent les déplacements', async () => {
    const MEMBRE = '800000000000000081';
    const SALON_A = '800000000000000082';
    const SALON_B = '800000000000000083';
    const ROLE = '800000000000000084';
    try {
        getDb().prepare('INSERT OR REPLACE INTO voice_roles (guild_id, channel_id, role_id) VALUES (?,?,?)')
            .run(G, SALON_B, ROLE);
    } catch {
        return; // table absente sur ce schéma : le handler l'ignore aussi
    }

    const { ctx, appels } = faireCtxEvenement({
        canaux: { [SALON_A]: { id: SALON_A, nom: 'A' }, [SALON_B]: { id: SALON_B, nom: 'B' } },
        vocaux: { [SALON_A]: [{ id: '800000000000000085' }] },
    });
    await evenementVocal.executer(ctx, etatVocal(SALON_A, MEMBRE), etatVocal(SALON_B, MEMBRE));

    assert.deepEqual(appels, [['ajouterRole', G, MEMBRE, ROLE]]);
});

// ── Le pont vers le routage historique ──────────────────────────────────────

test('le préfixe historique tv_ garde un point d\'entrée, sans discord.js', () => {
    // `bot/index.js` déstructure `handleTempVoiceInteraction` au chargement :
    // supprimer l'export ferait échouer le DÉMARRAGE du bot, pas seulement le
    // panneau. Ce fichier est interdit au lot, le routage `tv_` y reste jusqu'à
    // la consolidation, et cette fonction doit donc exister d'ici là.
    const mod = require('../bot/interactions/tempvoice');
    assert.equal(typeof mod.handleTempVoiceInteraction, 'function');

    // Et elle n'a plus le droit de construire quoi que ce soit : plus un seul
    // composant discord.js dans ce fichier.
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot', 'interactions', 'tempvoice.js'), 'utf8');
    assert.equal(/require\(['"]discord\.js['"]\)/.test(source), false);
    for (const constructeur of ['ModalBuilder', 'ActionRowBuilder', 'UserSelectMenuBuilder', 'ButtonBuilder']) {
        assert.equal(source.includes(constructeur), false, `${constructeur} subsiste`);
    }
});

test('aucun fichier du lot n\'importe discord.js ni ne lit « .brut »', () => {
    // `.brut` est l'échappatoire la plus tentante : une seule occurrence, et le
    // fichier redevient Discord-only sans qu'aucun test ne s'en aperçoive.
    // `test/platform-contrat.test.js` balaie déjà tout bot/ ; ce contrôle-ci
    // nomme les quatre fichiers du lot, pour que l'échec désigne son coupable.
    const fs = require('node:fs');
    const path = require('node:path');
    for (const relatif of [
        'bot/commands/voice.js', 'bot/commands/tempvoice.js', 'bot/commands/musicconfig.js',
        'bot/interactions/tempvoice.js', 'bot/events/voiceStateUpdate.js',
    ]) {
        const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
        assert.equal(/require\(['"]discord\.js['"]\)/.test(source), false, `${relatif} importe discord.js`);
        assert.equal(/\w\.brut\b/.test(source), false, `${relatif} lit .brut`);
        // Une capacité se teste, jamais un nom de plateforme.
        assert.equal(/plateforme\s*[=!]==\s*['"]/.test(source), false, `${relatif} compare un nom de plateforme`);
    }
});
