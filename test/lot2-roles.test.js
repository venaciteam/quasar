// Lot 2 — rôles et structure de guilde, migrés au contrat neutre.
//
// Deux choses à prouver, et une seule compte vraiment en production :
//
//  1. Le JSON déployé à Discord n'a pas bougé d'un octet. Une différence, même
//     sur un champ « cosmétique », se paie en re-déploiement silencieux à chaque
//     démarrage — et sur un sélecteur de salon, un `channel_types` perdu
//     laisserait choisir un salon textuel pour un rôle vocal.
//  2. L'attribution de rôle par réaction compare toujours la MÊME chaîne. C'est
//     le point le plus fragile du lot : `reaction_roles.emoji` contient la
//     saisie de l'administrateur, et si la clé rendue par l'adaptateur en
//     différait, les emojis personnalisés cesseraient d'attribuer leur rôle sans
//     erreur ni journal. Les unicode, eux, continueraient de marcher — d'où un
//     symptôme (« certains emojis ne marchent plus ») qui ne désigne pas sa cause.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { construireSlashCommand } = require('../bot/platform/discord/commands');
const { getDb } = require('../api/services/database');
const { describeRefusal, describeForApi } = require('../bot/utils/assignableRole');

/**
 * Corps RÉELLEMENT envoyé à Discord : la sérialisation retire les champs restés
 * à `undefined`, et c'est elle qui décide de ce qui part sur le fil.
 */
const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

// ── 1. JSON figé, relevé sur la v4.10.0 AVANT migration ─────────────────────

test('/voicerole produit le JSON de son SlashCommandBuilder d\'origine', () => {
    // Référence écrite en dur : la recalculer depuis le code testé ne prouverait
    // rien. Relevée sur `git show dev:bot/commands/voicerole.js`.
    const REFERENCE = {
        options: [
            {
                type: 1,
                name: 'set',
                description: 'Définir un rôle pour un salon vocal',
                options: [
                    // 2 = GuildVoice, 13 = GuildStageVoice : le filtre du
                    // sélecteur, déclaré en noms canoniques côté descripteur.
                    { channel_types: [2, 13], name: 'salon', description: 'Le salon vocal', required: true, type: 7 },
                    { name: 'role', description: 'Le rôle à attribuer', required: true, type: 8 },
                ],
            },
            {
                type: 1,
                name: 'remove',
                description: 'Retirer le rôle vocal d\'un salon',
                options: [
                    { channel_types: [2, 13], name: 'salon', description: 'Le salon vocal', required: true, type: 7 },
                ],
            },
            { type: 1, name: 'list', description: 'Voir les rôles vocaux configurés', options: [] },
        ],
        name: 'voicerole',
        description: 'Gérer les rôles vocaux (attribués en vocal, retirés à la déconnexion)',
        // ManageRoles, sérialisée en CHAÎNE par l'API.
        default_member_permissions: '268435456',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/voicerole'))), REFERENCE);
});

test('/reactionrole produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [
            {
                type: 1,
                name: 'create',
                description: 'Créer un panel de reaction roles',
                options: [
                    // 0 = GuildText : le panneau ne peut être posté que dans un
                    // salon textuel.
                    { channel_types: [0], name: 'channel', description: 'Channel où poster le panel', required: true, type: 7 },
                    { type: 3, name: 'titre', description: 'Titre du panel', required: true },
                    { type: 3, name: 'description', description: 'Description du panel', required: false },
                    {
                        type: 3,
                        choices: [
                            { name: 'Multiple (cumul)', value: 'multiple' },
                            { name: 'Unique (exclusif)', value: 'unique' },
                        ],
                        name: 'mode',
                        description: 'unique = un seul rôle, multiple = cumul',
                        required: false,
                    },
                ],
            },
            {
                type: 1,
                name: 'add',
                description: 'Ajouter un emoji → rôle à un panel',
                options: [
                    { type: 4, name: 'panel_id', description: 'ID du panel', required: true },
                    { type: 3, name: 'emoji', description: 'L\'emoji à utiliser', required: true },
                    { name: 'role', description: 'Le rôle associé', required: true, type: 8 },
                    { type: 3, name: 'description', description: 'Description optionnelle', required: false },
                ],
            },
            {
                type: 1,
                name: 'remove',
                description: 'Retirer un emoji d\'un panel',
                options: [
                    { type: 4, name: 'panel_id', description: 'ID du panel', required: true },
                    { type: 3, name: 'emoji', description: 'L\'emoji à retirer', required: true },
                ],
            },
            {
                type: 1,
                name: 'delete',
                description: 'Supprimer un panel entier',
                options: [
                    { type: 4, name: 'panel_id', description: 'ID du panel', required: true },
                ],
            },
            { type: 1, name: 'list', description: 'Lister les panels de reaction roles', options: [] },
        ],
        name: 'reactionrole',
        description: 'Gérer les panels de reaction roles',
        default_member_permissions: '268435456',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/reactionrole'))), REFERENCE);
});

test('les trois commandes de rôles déclarent les permissions du BOT', () => {
    // Sans cette déclaration, une commande migrée sort du balayage
    // `PermissionFlagsBits` et le garde-fou du lien d'invitation devient un faux
    // témoin : il continuerait de passer en ne voyant plus rien.
    const attendu = {
        autorole: ['MANAGE_ROLES'],
        voicerole: ['MANAGE_ROLES'],
        // ADD_REACTIONS et MANAGE_MESSAGES ne se consomment qu'APRÈS la
        // commande, dans l'événement de réaction — qui n'a nulle part où les
        // déclarer. C'est ici qu'elles restent rattachées à un usage.
        reactionrole: ['MANAGE_ROLES', 'ADD_REACTIONS', 'MANAGE_MESSAGES'],
    };
    for (const [nom, permissions] of Object.entries(attendu)) {
        assert.deepEqual(require(`../bot/commands/${nom}`).permissionsBot, permissions);
    }
});

// ── 2. Les événements migrés nomment un événement du contrat ────────────────

test('les événements du lot 2 sont branchés sur le bon nom neutre', () => {
    // Un handler migré sous un nom hors table ne serait jamais appelé :
    // discord.js n'émet pas d'événement portant un nom neutre, et rien ne le
    // signalerait.
    const attendu = {
        channelCreate: 'canalCree',
        channelDelete: 'canalSupprime',
        messageReactionAdd: 'reactionAjoutee',
        messageReactionRemove: 'reactionRetiree',
    };
    for (const [fichier, nomNeutre] of Object.entries(attendu)) {
        const mod = require(`../bot/events/${fichier}`);
        assert.equal(mod.nom, nomNeutre, `${fichier} : nom neutre inattendu`);
        assert.equal(typeof mod.executer, 'function');
        assert.equal(mod.execute, undefined, `${fichier} : migration à moitié faite`);
    }
});

// ── 3. Le cœur du lot : la clé d'emoji traverse la migration intacte ─────────

/** Contexte d'événement minimal, avec capture des appels au client REST. */
function faireContexte() {
    const appels = [];
    return {
        appels,
        ctx: {
            plateforme: 'discord',
            capacites: {},
            db: getDb(),
            api: {
                async obtenirMembre(guildeId, membreId) {
                    // @everyone en tête, comme le rend `normaliserMembre`.
                    return { id: membreId, roles: [guildeId, 'role-deja-la'] };
                },
                async retirerReaction(...args) { appels.push(['retirerReaction', ...args]); },
                async ajouterRole(...args) { appels.push(['ajouterRole', ...args]); },
                async retirerRole(...args) { appels.push(['retirerRole', ...args]); },
            },
        },
    };
}

/** Panneau + entrées, posés comme `/reactionrole create` puis `add` les écrivent. */
function poserPanneau(messageId, mode, entrees) {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run('guilde-lot2');
    const { lastInsertRowid: panelId } = db.prepare(
        'INSERT INTO reaction_panels (guild_id, channel_id, message_id, title, mode) VALUES (?,?,?,?,?)',
    ).run('guilde-lot2', 'salon-lot2', messageId, 'Panneau', mode);
    for (const [emoji, roleId] of entrees) {
        db.prepare('INSERT INTO reaction_roles (panel_id, emoji, role_id) VALUES (?,?,?)').run(panelId, emoji, roleId);
    }
    return panelId;
}

/** Réaction normalisée, telle que la rend `normaliserReaction` de l'adaptateur. */
function faireReaction(messageId, emoji) {
    const { normaliserReaction } = require('../bot/platform/discord/events');
    return normaliserReaction({
        message: { id: messageId, channelId: 'salon-lot2', guildId: 'guilde-lot2' },
        emoji,
    });
}

test('un emoji personnalisé ANIMÉ attribue toujours son rôle', () => {
    // Le cas exact que la migration pouvait casser en silence : la base porte
    // « <a:boum:77> », et rendre l'identifiant « 77 » n'aurait trouvé aucune
    // entrée. Aucune erreur, aucun journal, le rôle n'arrive jamais.
    poserPanneau('msg-anime', 'multiple', [['<a:boum:77>', 'role-a-donner']]);
    const { ctx, appels } = faireContexte();

    return require('../bot/events/messageReactionAdd').executer(
        ctx,
        faireReaction('msg-anime', { id: '77', name: 'boum', animated: true }),
        { id: 'membre-1', estBot: false },
    ).then(() => {
        // La réaction est retirée (accusé de réception), puis le rôle attribué.
        assert.deepEqual(appels, [
            ['retirerReaction', 'salon-lot2', 'msg-anime', '<a:boum:77>', 'membre-1'],
            ['ajouterRole', 'guilde-lot2', 'membre-1', 'role-a-donner'],
        ]);
    });
});

test('un emoji unicode bascule le rôle quand le membre l\'a déjà', async () => {
    poserPanneau('msg-unicode', 'multiple', [['🎮', 'role-deja-la']]);
    const { ctx, appels } = faireContexte();

    await require('../bot/events/messageReactionAdd').executer(
        ctx,
        faireReaction('msg-unicode', { id: null, name: '🎮' }),
        { id: 'membre-1', estBot: false },
    );

    assert.deepEqual(appels.map(a => a[0]), ['retirerReaction', 'retirerRole']);
    assert.equal(appels[1][3], 'role-deja-la');
});

test('le mode unique retire les autres rôles du panneau avant d\'attribuer', async () => {
    poserPanneau('msg-unique', 'unique', [['🅰️', 'role-a-donner'], ['🅱️', 'role-deja-la']]);
    const { ctx, appels } = faireContexte();

    await require('../bot/events/messageReactionAdd').executer(
        ctx,
        faireReaction('msg-unique', { id: null, name: '🅰️' }),
        { id: 'membre-1', estBot: false },
    );

    // Le rôle concurrent QUE LE MEMBRE PORTE est retiré, l'autre n'est pas touché.
    assert.deepEqual(appels, [
        ['retirerReaction', 'salon-lot2', 'msg-unique', '🅰️', 'membre-1'],
        ['retirerRole', 'guilde-lot2', 'membre-1', 'role-deja-la'],
        ['ajouterRole', 'guilde-lot2', 'membre-1', 'role-a-donner'],
    ]);
});

test('le bot et les réactions hors panneau ne déclenchent rien', async () => {
    poserPanneau('msg-inerte', 'multiple', [['🎮', 'role-a-donner']]);
    const executer = require('../bot/events/messageReactionAdd').executer;

    // Le bot pose lui-même les réactions du panneau : sans cette garde, chaque
    // panneau se déclencherait tout seul à sa création.
    const bot = faireContexte();
    await executer(bot.ctx, faireReaction('msg-inerte', { id: null, name: '🎮' }), { id: 'bot', estBot: true });
    assert.deepEqual(bot.appels, []);

    // Emoji absent du panneau : rien non plus, et surtout pas de réaction retirée.
    const inconnu = faireContexte();
    await executer(inconnu.ctx, faireReaction('msg-inerte', { id: null, name: '🚫' }), { id: 'membre-1', estBot: false });
    assert.deepEqual(inconnu.appels, []);

    // Message qui n'est pas un panneau.
    const horsPanneau = faireContexte();
    await executer(horsPanneau.ctx, faireReaction('msg-quelconque', { id: null, name: '🎮' }), { id: 'membre-1', estBot: false });
    assert.deepEqual(horsPanneau.appels, []);
});

// ── 4. Le motif de refus lit le rôle NORMALISÉ ──────────────────────────────

test('describeRefusal nomme le rôle depuis le format neutre', () => {
    // Elle lisait `role.name`, que le contrat neutre n'expose plus : le message
    // « trop haut dans la hiérarchie » serait devenu « « undefined » est
    // au-dessus… », le seul renseignement qu'il apporte.
    const { cause } = describeRefusal('hierarchy', { id: '1', nom: 'Modération', mention: '<@&1>' });
    assert.match(cause, /« Modération » est au-dessus/);

    // Les autres motifs ne citent pas le rôle : ils doivent rester intacts.
    assert.equal(describeRefusal('managed').title, 'Ce rôle ne peut pas être attribué');
    assert.equal(describeRefusal('missing').title, 'Ce rôle est introuvable');
});

test('describeForApi accepte encore le rôle discord.js de l\'API du dashboard', () => {
    // TRANSITION : api/routes/reactionroles.js résout ses rôles dans le cache
    // discord.js et passe l'objet natif, qui porte `name`. Le pont vit dans
    // `describeForApi` et disparaîtra au lot 7 — sans lui, le dashboard
    // afficherait « « undefined » est au-dessus… ».
    assert.match(describeForApi('hierarchy', { id: '1', name: 'Modération' }), /« Modération » est au-dessus/);
    assert.match(describeForApi('hierarchy', { id: '1', nom: 'Modération' }), /« Modération » est au-dessus/);
});
