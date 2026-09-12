// Lot 4 — vocal : ce qui est migré, et ce qui est gelé en attendant.
//
// Deux natures de test, et la distinction compte pour la consolidation :
//
//  1. RÉFÉRENCES JSON. Le corps déployé à Discord ne doit pas bouger d'un
//     octet — une différence, même « cosmétique », se paie en re-déploiement
//     silencieux à chaque démarrage. Les références sont relevées sur `dev`,
//     AVANT migration, et écrites en dur : les recalculer depuis le code testé
//     ne prouverait rien.
//
//     Elles sont figées ici pour les commandes migrées (/tempvoice, /music)
//     COMME pour celles qui ne le sont pas encore (/voice, /play et les sept
//     contrôles musique). Ces dernières sont bloquées par des manques du
//     contrat neutre, détaillés dans le compte-rendu du lot ; geler leur JSON
//     maintenant évite d'avoir à refaire ce relevé quand le contrat sera
//     complété, et attrape au passage toute dérive d'ici là.
//
//  2. COMPORTEMENT. Les deux commandes migrées ne touchent qu'à la base et à
//     leurs propres réponses : leurs parcours sont donc entièrement vérifiables
//     sans client ni jeton, avec un contexte neutre de doublure.
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

test('/voice garde son JSON en attendant que le contrat permette sa migration', () => {
    // Référence relevée sur `dev`. /voice reste au format historique : ses sept
    // sous-commandes passent toutes par « la personne est-elle connectée au
    // salon qu'elle possède ? », et le contrat neutre n'expose l'état vocal d'un
    // membre nulle part (cf. compte-rendu du lot 4). Ce test est son filet en
    // attendant, et la référence toute prête de sa migration.
    //
    // /play et les sept contrôles musique ne peuvent pas être gelés ici : ils
    // chargent `@discordjs/voice`, qui n'est plus une dépendance du projet
    // depuis la coupure du module musique (2026-06-18). Les requérir ferait
    // échouer ce fichier sur un MODULE_NOT_FOUND. Leur JSON de référence est au
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
        const mod = require(`../bot/commands/${fichier}`);
        assert.deepEqual(JSON.parse(JSON.stringify(mod.data.toJSON())), reference, `/${fichier}`);
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
