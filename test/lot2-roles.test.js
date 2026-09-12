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
const { describeRefusal } = require('../bot/utils/assignableRole');

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
        roleCreate: 'roleCree',
        roleDelete: 'roleSupprime',
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

test('le motif de refus du dashboard est celui du bot, en une phrase', () => {
    // `describeForApi` n'existe plus : c'était un pont qui rattrapait le `name`
    // d'un rôle discord.js, parce que api/routes/reactionroles.js le résolvait
    // dans le cache. Depuis qu'elle lit `api.obtenirRole`, elle reçoit un rôle
    // NORMALISÉ et concatène cause + action elle-même.
    const { cause, action } = describeRefusal('hierarchy', { id: '1', nom: 'Modération' });
    assert.match(`${cause} ${action}`, /« Modération » est au-dessus/);
    assert.match(`${cause} ${action}`, /Remontez le rôle « Quasar »/);
});

// ── 5. Les événements de rôle écrivent l'embed d'avant, au champ près ────────

/** Serveur dont la journalisation « server_role » est active. */
function serveurJournalise(guildeId) {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run(guildeId);
    db.prepare(`
        INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
        ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
    `).run(guildeId, JSON.stringify({ logChannel: 'salon-log', enabledLogs: { server_role: true } }));
}

/** Contexte d'événement qui capture ce qui part vers le salon de journalisation. */
function contexteJournal() {
    const envois = [];
    return {
        envois,
        ctx: {
            plateforme: 'discord',
            capacites: {},
            db: getDb(),
            api: {
                async envoyerMessage(canalId, contenu) { envois.push([canalId, contenu]); },
            },
        },
    };
}

/** Rôle normalisé, tel que l'adaptateur le rend au handler. */
function faireRole(guildeId, spec) {
    const { normaliserRole } = require('../bot/platform/discord/context');
    return normaliserRole({ guildId: guildeId, ...spec });
}

test('un rôle créé produit le MÊME corps d\'embed qu\'avant migration', async () => {
    // Référence relevée sur la v4.10.0 : `.setTitle().setColor().addFields(Nom,
    // Couleur).setTimestamp()`. La couleur est le champ que la migration
    // pouvait perdre — `normaliserRole` ne la portait pas au premier rendu du
    // lot, et un « undefined » y serait passé sans qu'aucun test ne le voie.
    const { rendreEmbed } = require('../bot/platform/discord/render');
    serveurJournalise('guilde-role-1');
    const { ctx, envois } = contexteJournal();

    await require('../bot/events/roleCreate').executer(
        ctx,
        faireRole('guilde-role-1', { id: 'r1', name: 'Modération', color: 0x2ecc71, position: 3 }),
    );

    assert.equal(envois.length, 1);
    const [canalId, contenu] = envois[0];
    assert.equal(canalId, 'salon-log');

    const { timestamp, ...corps } = rendreEmbed(contenu).toJSON();
    assert.deepEqual(corps, {
        title: '🎭 Rôle créé',
        color: 0x2ecc71,
        fields: [
            { name: 'Nom', value: 'Modération', inline: true },
            // Minuscules et « # » en tête : la forme exacte de `hexColor`.
            { name: 'Couleur', value: '#2ecc71', inline: true },
        ],
    });
    assert.ok(Number.isFinite(Date.parse(timestamp)), 'horodatage manquant');
});

test('un rôle supprimé produit le MÊME corps d\'embed qu\'avant migration', async () => {
    const { rendreEmbed } = require('../bot/platform/discord/render');
    serveurJournalise('guilde-role-2');
    const { ctx, envois } = contexteJournal();

    // Rôle sans couleur : `hexColor` valait « #000000 », pas une chaîne vide.
    await require('../bot/events/roleDelete').executer(
        ctx,
        faireRole('guilde-role-2', { id: 'r2', name: 'Ancien', color: 0, position: 1, managed: true }),
    );

    const { timestamp, ...corps } = rendreEmbed(envois[0][1]).toJSON();
    assert.deepEqual(corps, {
        title: '🎭 Rôle supprimé',
        color: 0xe74c3c,
        fields: [
            { name: 'Nom', value: 'Ancien', inline: true },
            { name: 'Couleur', value: '#000000', inline: true },
        ],
    });
    assert.ok(Number.isFinite(Date.parse(timestamp)));
});

test('un rôle géré par une intégration n\'est journalisé qu\'à sa suppression', async () => {
    // Asymétrie d'origine : `roleCreate` écarte les rôles de bots, `roleDelete`
    // non. Les aligner serait une correction, pas une migration.
    serveurJournalise('guilde-role-3');

    const creation = contexteJournal();
    await require('../bot/events/roleCreate').executer(
        creation.ctx,
        faireRole('guilde-role-3', { id: 'r3', name: 'Bot Machin', color: 0, managed: true }),
    );
    assert.deepEqual(creation.envois, []);

    const suppression = contexteJournal();
    await require('../bot/events/roleDelete').executer(
        suppression.ctx,
        faireRole('guilde-role-3', { id: 'r3', name: 'Bot Machin', color: 0, managed: true }),
    );
    assert.equal(suppression.envois.length, 1);
});

test('sans journalisation active, un événement de rôle n\'écrit rien', async () => {
    // La portée est construite à partir de `role.guildeId` : s'il manquait,
    // `sendLog` chercherait la configuration d'un serveur `null` et se tairait —
    // panne silencieuse exacte que le premier rendu du lot ne pouvait pas éviter.
    const { ctx, envois } = contexteJournal();
    await require('../bot/events/roleCreate').executer(
        ctx,
        faireRole('guilde-sans-logs', { id: 'r4', name: 'Rôle', color: 0 }),
    );
    assert.deepEqual(envois, []);
});

// ── 6. Le rafraîchissement ne repose que les réactions manquantes ───────────

/** Contexte de commande minimal pour `/reactionrole add`. */
function contexteAjout(options, reactionsDuMessage) {
    const appels = [];
    return {
        appels,
        ctx: {
            plateforme: 'discord',
            capacites: {},
            guildeId: 'guilde-refresh',
            db: getDb(),
            options: { get: (nom) => options[nom] ?? null },
            async repondre() {},
            async suivre(contenu) { appels.push(['suivre', contenu]); },
            erreurUtilisateur(spec) { appels.push(['erreurUtilisateur', spec.titre]); },
            api: {
                async verifierRoleAttribuable() { return null; },
                async obtenirMessage(canalId, messageId) {
                    const { normaliserMessage } = require('../bot/platform/discord/events');
                    return normaliserMessage({
                        id: messageId,
                        channelId: canalId,
                        guildId: 'guilde-refresh',
                        reactions: reactionsDuMessage,
                    });
                },
                async modifierMessage(...args) { appels.push(['modifierMessage', args[0], args[1]]); },
                async ajouterReaction(...args) { appels.push(['ajouterReaction', ...args]); },
            },
        },
    };
}

const sousCommande = (nom) => require('../bot/commands/reactionrole').sousCommandes.find(s => s.nom === nom);

test('un panneau déjà réagi par le bot n\'émet AUCUN ajouterReaction', async () => {
    // C'est le comportement d'origine (`if (!existing || !existing.me)`), et
    // c'est ce qui évite un PUT par entrée à chaque `/reactionrole add`, sur une
    // route que Discord limite sévèrement en débit.
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run('guilde-refresh');
    const { lastInsertRowid: panelId } = db.prepare(
        'INSERT INTO reaction_panels (guild_id, channel_id, message_id, title, mode) VALUES (?,?,?,?,?)',
    ).run('guilde-refresh', 'salon-refresh', 'msg-refresh', 'Panneau', 'multiple');
    db.prepare('INSERT INTO reaction_roles (panel_id, emoji, role_id) VALUES (?,?,?)')
        .run(panelId, '🎮', 'role-jeux');

    // Le bot a déjà posé « 🎮 » ET l'emoji personnalisé ajouté ci-dessous.
    const { ctx, appels } = contexteAjout(
        { panel_id: panelId, emoji: '<a:boum:77>', role: { id: 'role-boum', nom: 'Boum', mention: '<@&role-boum>' } },
        [
            { emoji: { id: null, name: '🎮' }, count: 1, me: true },
            { emoji: { id: '77', name: 'boum', animated: true }, count: 1, me: true },
        ],
    );

    await sousCommande('add').executer(ctx);

    assert.deepEqual(appels.filter(a => a[0] === 'ajouterReaction'), [],
        'aucune réaction ne doit être reposée quand le bot les a déjà toutes');
    assert.equal(appels.filter(a => a[0] === 'modifierMessage').length, 1, 'le panneau est tout de même réécrit');
});

test('seules les réactions absentes ou posées par un tiers sont reposées', async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)').run('guilde-refresh');
    const { lastInsertRowid: panelId } = db.prepare(
        'INSERT INTO reaction_panels (guild_id, channel_id, message_id, title, mode) VALUES (?,?,?,?,?)',
    ).run('guilde-refresh', 'salon-refresh', 'msg-partiel', 'Panneau', 'multiple');
    db.prepare('INSERT INTO reaction_roles (panel_id, emoji, role_id) VALUES (?,?,?)').run(panelId, '🎮', 'role-jeux');
    db.prepare('INSERT INTO reaction_roles (panel_id, emoji, role_id) VALUES (?,?,?)').run(panelId, '📚', 'role-lecture');

    const { ctx, appels } = contexteAjout(
        { panel_id: panelId, emoji: '<:quasar:55>', role: { id: 'role-q', nom: 'Q', mention: '<@&role-q>' } },
        [
            // Posée par le bot : rien à faire.
            { emoji: { id: null, name: '🎮' }, count: 1, me: true },
            // Présente mais posée par un membre : le bot doit la reposer, sans
            // quoi elle disparaîtrait du panneau le jour où il la retire.
            { emoji: { id: null, name: '📚' }, count: 1, me: false },
            // « <:quasar:55> » n'est pas encore sur le message du tout.
        ],
    );

    await sousCommande('add').executer(ctx);

    assert.deepEqual(
        appels.filter(a => a[0] === 'ajouterReaction').map(a => a[3]),
        ['📚', '<:quasar:55>'],
    );
});
