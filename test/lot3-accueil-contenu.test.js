// Lot 3 — accueil et contenu : non-régression de la migration au contrat neutre.
//
// Trois commandes migrées (`/help`, `/embed`, `/cmd`) sur une instance en
// PRODUCTION. Ce fichier fige ce qui ne doit pas bouger :
//
//   1. le JSON déployé à Discord, relevé AVANT migration et écrit en dur — le
//      recalculer depuis le code testé ne prouverait rien ;
//   2. le CONTENU des embeds de réponse, champ par champ et dans l'ordre ;
//   3. la liste des noms réservés, qui décide si une commande personnalisée
//      homonyme peut être créée.
//
// QUASAR_DB_PATH avant tout require : le chargeur de commandes ouvre la base.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { construireSlashCommand } = require('../bot/platform/discord/commands');
const { rendreEmbed } = require('../bot/platform/discord/render');

const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

// ── 1. JSON déployé ──────────────────────────────────────────────────────────

test('/help produit le JSON de son builder d\'origine', () => {
    const REFERENCE = {
        options: [],
        name: 'help',
        description: 'Afficher l\'aide de Quasar et savoir comment signaler un problème',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/help'))), REFERENCE);
});

test('/embed produit le JSON de son builder d\'origine', () => {
    // Six sous-commandes, quatre options en autocomplétion et deux sélecteurs de
    // salon filtrés sur le texte (channel_types: [0]).
    const REFERENCE = {
        options: [
            {
                type: 1, name: 'create', description: 'Créer un nouvel embed',
                options: [
                    { type: 3, name: 'nom', description: 'Nom pour retrouver l\'embed', required: true },
                    { type: 3, name: 'titre', description: 'Titre de l\'embed', required: false },
                    { type: 3, name: 'description', description: 'Description (contenu principal)', required: false },
                    { type: 3, name: 'couleur', description: 'Couleur hex (ex: #c86e8e)', required: false },
                    { type: 3, name: 'footer', description: 'Texte en pied de page', required: false },
                    { type: 3, name: 'image', description: 'URL d\'une image (grande, en bas)', required: false },
                    { type: 3, name: 'thumbnail', description: 'URL d\'une miniature (petit, en haut à droite)', required: false },
                ],
            },
            {
                type: 1, name: 'send', description: 'Envoyer un embed sauvegardé dans un channel',
                options: [
                    { autocomplete: true, type: 3, name: 'nom', description: 'Nom de l\'embed', required: true },
                    { channel_types: [0], name: 'channel', description: 'Channel de destination', required: true, type: 7 },
                ],
            },
            {
                type: 1, name: 'edit', description: 'Modifier un embed déjà envoyé (via l\'ID du message)',
                options: [
                    { type: 3, name: 'message_id', description: 'ID du message à modifier', required: true },
                    { autocomplete: true, type: 3, name: 'nom', description: 'Nom de l\'embed à utiliser', required: true },
                    { channel_types: [0], name: 'channel', description: 'Channel du message', required: false, type: 7 },
                ],
            },
            { type: 1, name: 'list', description: 'Voir les embeds sauvegardés', options: [] },
            {
                type: 1, name: 'delete', description: 'Supprimer un embed sauvegardé',
                options: [{ autocomplete: true, type: 3, name: 'nom', description: 'Nom de l\'embed', required: true }],
            },
            {
                type: 1, name: 'preview', description: 'Prévisualiser un embed (en éphémère)',
                options: [{ autocomplete: true, type: 3, name: 'nom', description: 'Nom de l\'embed', required: true }],
            },
        ],
        name: 'embed',
        description: 'Créer et gérer des embeds personnalisés',
        // ManageMessages, sérialisée en CHAÎNE par l'API.
        default_member_permissions: '8192',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/embed'))), REFERENCE);
});

test('/cmd produit le JSON de son builder d\'origine', () => {
    // Le fichier s'appelle customcmd.js mais la commande s'appelle `cmd` : le
    // nom déployé est celui du descripteur, pas celui du fichier.
    const ACCES = [
        { name: 'Tout le monde', value: 'everyone' },
        { name: 'Administrateurs uniquement', value: 'admins' },
        { name: 'Un rôle précis', value: 'role' },
    ];
    const REFERENCE = {
        options: [
            {
                type: 1, name: 'create', description: 'Créer une commande personnalisée',
                options: [
                    { type: 3, name: 'nom', description: 'Nom de la commande (sans /)', required: true },
                    { type: 3, name: 'reponse', description: 'Texte de la réponse', required: false },
                    { type: 3, name: 'embed', description: 'Nom d\'un embed sauvegardé (prioritaire sur le texte)', required: false },
                    { type: 3, choices: ACCES, name: 'acces', description: 'Qui peut utiliser la commande (par défaut : tout le monde)', required: false },
                    { name: 'role', description: 'Rôle autorisé (uniquement si accès = un rôle précis)', required: false, type: 8 },
                ],
            },
            {
                type: 1, name: 'edit', description: 'Modifier une commande existante',
                options: [
                    { type: 3, name: 'nom', description: 'Nom de la commande', required: true },
                    { type: 3, name: 'nouveau_nom', description: 'Renommer la commande (sans /)', required: false },
                    { type: 3, name: 'reponse', description: 'Nouveau texte', required: false },
                    { type: 3, name: 'embed', description: 'Nouvel embed (nom)', required: false },
                    { type: 3, choices: ACCES, name: 'acces', description: 'Qui peut utiliser la commande', required: false },
                    { name: 'role', description: 'Rôle autorisé (uniquement si accès = un rôle précis)', required: false, type: 8 },
                ],
            },
            {
                type: 1, name: 'delete', description: 'Supprimer une commande personnalisée',
                options: [{ type: 3, name: 'nom', description: 'Nom de la commande', required: true }],
            },
            { type: 1, name: 'list', description: 'Lister toutes les commandes personnalisées', options: [] },
        ],
        name: 'cmd',
        description: 'Gérer les commandes personnalisées',
        // ManageGuild.
        default_member_permissions: '32',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(require('../bot/commands/customcmd'))), REFERENCE);
});

test('les trois commandes migrées déclarent leurs permissions de bot', () => {
    // Sans cette déclaration, une commande migrée sort du balayage
    // `PermissionFlagsBits` et le garde-fou du lien d'invitation devient muet.
    // Un tableau vide est une réponse valable, `undefined` non.
    for (const fichier of ['help', 'embed', 'customcmd']) {
        assert.ok(
            Array.isArray(require(`../bot/commands/${fichier}`).permissionsBot),
            `${fichier} : « permissionsBot » manquant`,
        );
    }
});

// ── 2. Contenu des embeds ────────────────────────────────────────────────────

/** Champs rendus, débarrassés du `inline` que le rendu neutre pose partout. */
function champsSansInline(rendu) {
    return (rendu.fields || []).map(({ name, value }) => ({ name, value }));
}

test('/help rend le même embed qu\'avant migration, section par section', async () => {
    const help = require('../bot/commands/help');

    /** Contexte minimal : /help ne lit que les permissions et ne fait que répondre. */
    const contexte = (permissions) => {
        const vu = {};
        return {
            vu,
            membre: permissions === null ? null : { aPermission: (nom) => permissions.includes(nom) },
            repondre(contenu, options) { vu.contenu = contenu; vu.options = options; },
        };
    };

    // Membre ordinaire : deux sections, plus le bloc de signalement.
    const ordinaire = contexte([]);
    await help.executer(ordinaire);
    const rendu = corpsEnvoye(rendreEmbed(ordinaire.vu.contenu));

    assert.equal(rendu.title, '🌌 Quasar — Aide');
    assert.equal(rendu.color, 0xDE3163);
    assert.equal(
        rendu.description,
        'Quasar gère la modération, les tickets, les rôles et les salons vocaux temporaires de ce serveur.',
    );
    assert.deepEqual(rendu.footer, { text: 'Quasar — logiciel libre sous licence AGPL-3.0' });
    assert.deepEqual(
        champsSansInline(rendu).map(c => c.name),
        ['📌 Pour tout le monde', '🔊 Vocal', '🚨 Un problème avec le bot ?'],
    );
    // Le format d'une entrée : commande, retour à la ligne, flèche, description.
    assert.ok(champsSansInline(rendu)[0].value.startsWith('`/help`\n↳ Afficher cette aide\n'));
    // L'aide est éphémère, comme avant : elle encombrerait sinon le salon.
    assert.deepEqual(ordinaire.vu.options, { ephemere: true });

    // Modération et administration : chacune ajoute sa section, dans cet ordre.
    const modo = contexte(['MODERATE_MEMBERS']);
    await help.executer(modo);
    assert.deepEqual(
        champsSansInline(corpsEnvoye(rendreEmbed(modo.vu.contenu))).map(c => c.name),
        ['📌 Pour tout le monde', '🔊 Vocal', '🛡️ Modération', '🚨 Un problème avec le bot ?'],
    );

    const admin = contexte(['BAN_MEMBERS', 'MANAGE_GUILD']);
    await help.executer(admin);
    assert.deepEqual(
        champsSansInline(corpsEnvoye(rendreEmbed(admin.vu.contenu))).map(c => c.name),
        ['📌 Pour tout le monde', '🔊 Vocal', '🛡️ Modération', '⚙️ Configuration', '🚨 Un problème avec le bot ?'],
    );

    // En message privé, il n'y a pas de membre : les sections réservées
    // disparaissent au lieu de faire lever la commande.
    const prive = contexte(null);
    await help.executer(prive);
    assert.equal(champsSansInline(corpsEnvoye(rendreEmbed(prive.vu.contenu))).length, 3);
});

test('un embed enregistré est rendu à l\'identique de l\'ancien buildDiscordEmbed', () => {
    const { construireEmbedEnregistre, buildDiscordEmbed } = require('../bot/commands/embed');

    // Référence relevée sur l'implémentation d'origine (EmbedBuilder monté à la
    // main), pour une ligne `embeds.data` complète.
    const DATA = {
        couleur: '#c86e8e',
        titre: 'Titre',
        description: 'Description',
        footer: 'Pied de page',
        image: 'https://exemple.test/grande.png',
        thumbnail: 'https://exemple.test/petite.png',
    };
    const REFERENCE = {
        color: 0xc86e8e,
        title: 'Titre',
        description: 'Description',
        footer: { text: 'Pied de page' },
        image: { url: 'https://exemple.test/grande.png' },
        thumbnail: { url: 'https://exemple.test/petite.png' },
    };

    assert.deepEqual(corpsEnvoye(rendreEmbed(construireEmbedEnregistre(DATA))), REFERENCE);
    // Le pont gardé pour bot/index.js et le scheduler rend exactement la même
    // chose : une seule source de vérité pour la forme d'un embed enregistré.
    assert.deepEqual(corpsEnvoye(buildDiscordEmbed(DATA)), REFERENCE);

    // Champs absents : aucune clé posée. Un `title: null` ferait échouer l'API.
    assert.deepEqual(corpsEnvoye(rendreEmbed(construireEmbedEnregistre({ description: 'Seule' }))), {
        description: 'Seule',
    });
    // Couleur illisible : ignorée, comme le `try { setColor } catch {}` d'avant.
    assert.deepEqual(corpsEnvoye(rendreEmbed(construireEmbedEnregistre({ titre: 'T', couleur: 'pas une couleur' }))), {
        title: 'T',
    });
});

// ── 3. Noms réservés ─────────────────────────────────────────────────────────

test('reservedCommandNames lit le nom NEUTRE, et garde le repli historique', () => {
    // Le pont `data.name` posé par `definirCommande` n'existait que pour cette
    // fonction. Elle lit désormais `mod.nom` en premier : le pont peut être
    // retiré quand la dernière commande sera migrée.
    const { reservedCommandNames } = require('../bot/commands/customcmd');
    const noms = reservedCommandNames();

    for (const nom of ['help', 'embed', 'cmd', 'ping', 'autorole']) {
        assert.ok(noms.has(nom), `/${nom} doit rester un nom réservé`);
    }
    // Le nom du FICHIER n'est pas le nom de la commande : /cmd est réservée,
    // « customcmd » ne l'est pas — et ne l'était pas non plus avant.
    assert.equal(noms.has('customcmd'), false);
    // Le repli reste en place tant que des commandes portent encore `data.name`.
    assert.ok(noms.size >= 20, 'la liste ne doit pas s\'être vidée');
});

// ═══ Reprise du lot 3 : accueil, départ, salon piège, anti-raid ═════════════
//
// Le contrat porte désormais `avatar()`, `nomUtilisateur`, `compteCreeLe`,
// `membreCount`, `estSysteme`, `estWebhook`, `estFil` et `lien`. Ce qui suit
// prouve que les six fichiers qui les attendaient rendent bien la même chose
// qu'avant — et, pour le salon piège, que chaque garde-fou tient toujours.

const { normaliserMembre, normaliserGuilde } = require('../bot/platform/discord/context');
const { EVENEMENTS } = require('../bot/platform/discord/events');
const { getDb } = require('../api/services/database');

const GUILDE_ID = '111111111111111111';

/** Guilde discord.js réduite à ce que les normaliseurs en lisent. */
const guildeDiscord = (patch = {}) => ({
    id: GUILDE_ID, name: 'Serveur Test', ownerId: '999999999999999999',
    memberCount: 1337, roles: { everyone: { id: GUILDE_ID } }, ...patch,
});

/** Membre discord.js, normalisé par le VRAI normaliseur du contrat. */
function membreNormalise(patch = {}) {
    const guild = guildeDiscord(patch.guilde);
    return normaliserMembre({
        id: 'U1', displayName: 'Leeva Affichée', guild, roles: { cache: new Map() },
        user: {
            id: 'U1', username: 'leeva', globalName: 'Leeva Affichée', bot: false,
            discriminator: '0', createdTimestamp: Date.UTC(2020, 0, 1),
        },
        displayAvatarURL: ({ size }) => `https://cdn.test/avatar.png?size=${size}`,
        ...patch.membre,
    });
}

const guildeNormalisee = (patch) => normaliserGuilde(guildeDiscord(patch));

// ── /welcome et /leave : JSON déployé ───────────────────────────────────────

/** Les deux commandes ne diffèrent que par six chaînes : la référence aussi. */
function referenceAccueil({ nom, description, quoi, couleurDefaut }) {
    return {
        options: [
            {
                type: 1, name: 'channel', description: `Définir le channel de ${quoi}`,
                options: [{ channel_types: [0], name: 'channel', description: 'Le channel', required: true, type: 7 }],
            },
            {
                type: 1, name: 'message', description: `Définir le message de ${quoi}`,
                options: [{ type: 3, name: 'texte', description: 'Variables : {user} {username} {server} {membercount}', required: true }],
            },
            { type: 1, name: 'test', description: `Prévisualiser le message de ${quoi}`, options: [] },
            {
                type: 1, name: 'embed', description: `Activer un embed de ${quoi} (avec avatar de l'utilisateur)`,
                options: [
                    { type: 3, name: 'titre', description: 'Titre. Variables : {username} {server}', required: false },
                    { type: 3, name: 'description', description: 'Description. Variables : {user} {username} {server} {membercount}', required: false },
                    { type: 3, name: 'couleur', description: `Couleur hex (ex: ${couleurDefaut})`, required: false },
                ],
            },
            { type: 1, name: 'embedoff', description: `Retirer l'embed de ${quoi}`, options: [] },
            { type: 1, name: 'off', description: `Désactiver les messages de ${quoi}`, options: [] },
        ],
        name: nom,
        description,
        default_member_permissions: '32', // ManageGuild
        type: 1,
    };
}

test('/welcome et /leave produisent le JSON de leur builder d\'origine', () => {
    assert.deepEqual(
        corpsEnvoye(construireSlashCommand(require('../bot/commands/welcome'))),
        referenceAccueil({
            nom: 'welcome', description: 'Configurer les messages de bienvenue',
            quoi: 'bienvenue', couleurDefaut: '#c86e8e',
        }),
    );
    assert.deepEqual(
        corpsEnvoye(construireSlashCommand(require('../bot/commands/leave'))),
        referenceAccueil({
            nom: 'leave', description: 'Configurer les messages de départ',
            quoi: 'départ', couleurDefaut: '#6e8ec8',
        }),
    );
});

// ── Gabarits d'accueil ──────────────────────────────────────────────────────

test('les quatre variables du gabarit rendent la même chose qu\'avant', () => {
    const { resolveVariables, buildEmbed } = require('../bot/utils/welcomeMessage');
    const membre = membreNormalise();
    const guilde = guildeNormalisee();

    // {username} est le pseudonyme BRUT, pas le nom affiché : les confondre
    // changerait le texte de tous les messages d'accueil déjà configurés.
    assert.notEqual(membre.nomUtilisateur, membre.nom);
    assert.equal(
        resolveVariables('{user} alias {username} sur {server} ({membercount})', membre, guilde),
        '<@U1> alias leeva sur Serveur Test (1337)',
    );
    assert.equal(resolveVariables(null, membre, guilde), null, 'un gabarit vide reste vide');

    // `thumbnail: 'avatar'` suit la personne qui arrive, à 128 px comme avant.
    const rendu = corpsEnvoye(rendreEmbed(buildEmbed(
        JSON.stringify({ title: 'Bienvenue {username}', description: '{membercount}e membre', color: '#c86e8e', thumbnail: 'avatar' }),
        membre, guilde,
    )));
    assert.deepEqual(rendu, {
        title: 'Bienvenue leeva',
        description: '1337e membre',
        color: 0xc86e8e,
        thumbnail: { url: 'https://cdn.test/avatar.png?size=128' },
    });

    assert.equal(buildEmbed(null, membre, guilde), null, 'aucun embed configuré = aucun embed');
});

// ── Arrivée et départ d'un membre ───────────────────────────────────────────

/** Contexte d'événement minimal, avec capture de tout ce qui part. */
function contexteEvenement() {
    const envois = [];
    const roles = [];
    return {
        envois, roles,
        ctx: {
            moi: { id: 'BOT' },
            get db() { return getDb(); },
            api: {
                async envoyerMessage(canalId, corps) { envois.push({ canalId, corps }); return { id: 'm1' }; },
                async ajouterRole(g, m, r) { roles.push(r); },
                async obtenirGuilde() { return guildeNormalisee(); },
                async obtenirMembre() { return membreNormalise(); },
                async obtenirCanal(id) { return { id, nom: 'piege' }; },
            },
        },
    };
}

function configurerAccueil(db, patch = {}) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE_ID, 'Serveur Test');
    db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(GUILDE_ID);
    const valeurs = {
        welcome_enabled: 1, welcome_channel: 'ACCUEIL', welcome_message: null, welcome_embed: null,
        leave_enabled: 1, leave_channel: 'DEPART', leave_message: null, leave_embed: null, ...patch,
    };
    db.prepare(`UPDATE welcome_config SET
        welcome_enabled = @welcome_enabled, welcome_channel = @welcome_channel,
        welcome_message = @welcome_message, welcome_embed = @welcome_embed,
        leave_enabled = @leave_enabled, leave_channel = @leave_channel,
        leave_message = @leave_message, leave_embed = @leave_embed
        WHERE guild_id = @guild_id`).run({ guild_id: GUILDE_ID, ...valeurs });
    // Journalisation d'arrivée et de départ activée : elle est désactivée par
    // défaut, et c'est justement le log qu'on veut observer.
    db.prepare(`INSERT INTO modules (guild_id, module_name, config) VALUES (?, ?, ?)
        ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config`)
        .run(GUILDE_ID, 'moderation', JSON.stringify({
            logChannel: 'LOGS', enabledLogs: { member_join: true, member_leave: true },
        }));
}

test('l\'arrivée d\'un membre journalise, accueille et pose les autorôles', async () => {
    const db = getDb();
    configurerAccueil(db, { welcome_message: 'Bienvenue {user} ({username}) !' });
    db.prepare('INSERT OR IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)').run(GUILDE_ID, 'R42');

    const { ctx, envois, roles } = contexteEvenement();
    await require('../bot/events/guildMemberAdd').executer(ctx, membreNormalise(), guildeNormalisee());

    // 1. Le journal, avec les trois champs d'avant — étiquette, création du
    //    COMPTE (et non l'arrivée), effectif du serveur.
    const journal = corpsEnvoye(rendreEmbed(envois[0].corps));
    assert.equal(envois[0].canalId, 'LOGS');
    assert.equal(journal.title, '📥 Membre rejoint');
    assert.deepEqual(journal.thumbnail, { url: 'https://cdn.test/avatar.png?size=64' });
    assert.deepEqual(journal.fields.map(c => [c.name, c.value]), [
        ['Membre', '<@U1> (leeva)'],
        ['Compte créé', `<t:${Math.floor(Date.UTC(2020, 0, 1) / 1000)}:R>`],
        ['Membres', '1337'],
    ]);

    // 2. Le message d'accueil, variables résolues, dans le salon configuré.
    //    Sans embed configuré il part en contenu NU, la forme qu'envoyait déjà
    //    `channel.send({ content })`.
    assert.equal(envois[1].canalId, 'ACCUEIL');
    assert.equal(envois[1].corps, 'Bienvenue <@U1> (leeva) !');

    // 3. Les autorôles, qui ne dépendent PAS de la configuration d'accueil.
    assert.deepEqual(roles, ['R42']);
});

test('un compte retiré par l\'anti-raid n\'est ni accueilli ni autorôlé', async () => {
    // C'est l'ordre qui empêche le salon d'accueil de devenir l'amplificateur
    // d'un raid. L'anti-raid RÉEL est mis en jeu : le simuler ne prouverait rien
    // du câblage, l'événement capturant sa référence au chargement du module.
    const antiraid = require('../bot/modules/antiraid');
    const db = getDb();
    configurerAccueil(db, { welcome_message: 'coucou' });
    db.prepare('INSERT OR IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)').run(GUILDE_ID, 'R42');
    // Seuil à DEUX arrivées : c'est le minimum accepté par la configuration
    // (« N arrivées en X secondes » ne décrit plus une vague à partir de 1).
    db.prepare(`INSERT INTO antiraid_config
        (guild_id, enabled, join_count, join_window_seconds, min_account_age_hours, punishments, panic_duration_seconds, log_channel)
        VALUES (?, 1, 2, 10, 0, 'kick', 0, 'LOGS')
        ON CONFLICT(guild_id) DO UPDATE SET enabled = 1, join_count = 2, join_window_seconds = 10,
            min_account_age_hours = 0, punishments = 'kick', panic_duration_seconds = 0, log_channel = 'LOGS'`)
        .run(GUILDE_ID);
    antiraid.invalidateConfig();

    const { ctx, envois, roles } = contexteEvenement();
    const exclus = [];
    ctx.api.exclureMembre = async (guildeId, membreId) => { exclus.push(membreId); };
    const arrivant = (id) => membreNormalise({ membre: { id, user: { id, username: 'u', bot: false, discriminator: '0', createdTimestamp: Date.UTC(2020, 0, 1) } } });

    try {
        // Première arrivée : sous le seuil, accueil normal.
        await require('../bot/events/guildMemberAdd').executer(ctx, arrivant('U1'), guildeNormalisee());
        assert.ok(envois.some(e => e.canalId === 'ACCUEIL'), 'la première arrivée est accueillie');

        // Seconde arrivée : le seuil est franchi, la vague emporte les deux.
        envois.length = 0;
        roles.length = 0;
        await require('../bot/events/guildMemberAdd').executer(ctx, arrivant('U2'), guildeNormalisee());

        assert.deepEqual(exclus, ['U1', 'U2'], 'toute la fenêtre est sanctionnée, pas seulement le dernier');
        // Tout ce qui suit l'anti-raid est court-circuité pour l'arrivant : ni
        // message d'accueil, ni journal d'arrivée, ni autorôle.
        assert.deepEqual(envois.filter(e => e.canalId === 'ACCUEIL'), []);
        assert.deepEqual(roles, [], 'aucun autorôle posé sur un compte expulsé');
    } finally {
        // La configuration anti-raid est partagée avec les tests suivants.
        db.prepare('DELETE FROM antiraid_config WHERE guild_id = ?').run(GUILDE_ID);
        antiraid.invalidateConfig();
    }
});

test('le départ d\'un membre journalise et poste le message de départ', async () => {
    configurerAccueil(getDb(), { leave_message: 'Au revoir {username}, il reste {membercount} membres.' });

    const { ctx, envois } = contexteEvenement();
    await require('../bot/events/guildMemberRemove').executer(ctx, membreNormalise(), guildeNormalisee());

    const journal = corpsEnvoye(rendreEmbed(envois[0].corps));
    assert.equal(journal.title, '📤 Membre parti');
    assert.deepEqual(journal.thumbnail, { url: 'https://cdn.test/avatar.png?size=64' });
    assert.deepEqual(journal.fields.map(c => [c.name, c.value]), [
        ['Membre', 'leeva'],
        ['Membres', '1337'],
    ]);
    assert.equal(envois[1].canalId, 'DEPART');
    assert.equal(envois[1].corps, 'Au revoir leeva, il reste 1337 membres.');
});

// ── Salon piège ─────────────────────────────────────────────────────────────

test('le salon piège garde ses quatre garde-fous après migration', async () => {
    const honeypot = require('../bot/events/messageCreate');
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE_ID, 'Serveur Test');
    db.prepare(`INSERT INTO honeypot_config (guild_id, enabled, channel_id, punishments, log_channel)
        VALUES (?, 1, 'PIEGE', '', 'LOGS')
        ON CONFLICT(guild_id) DO UPDATE SET enabled = 1, channel_id = 'PIEGE', punishments = '', log_channel = 'LOGS'`)
        .run(GUILDE_ID);
    honeypot.invalidateConfig();

    let compteur = 0;
    /** Message normalisé par le vrai normaliseur, auteur unique à chaque appel. */
    const message = (patch = {}) => {
        compteur += 1;
        return EVENEMENTS.messageCree[1]({
            id: `90000000000000000${compteur}`, channelId: 'PIEGE', guildId: GUILDE_ID, type: 0,
            author: { id: patch.auteurId || `U${compteur}`, username: 'u', bot: false, discriminator: '0' },
            content: 'peu importe', channel: { id: 'PIEGE', name: 'piege' }, ...patch.message,
        })[0];
    };

    async function declenche(msg) {
        const { ctx, envois } = contexteEvenement();
        // Le membre n'est ni admin ni modérateur : c'est le cas sanctionnable.
        ctx.api.obtenirMembre = async (g, id) => ({ id, roles: [], aPermission: () => false });
        await honeypot.executer(ctx, msg);
        return envois.length > 0;
    }

    assert.equal(await declenche(message()), true, 'un message humain déclenche');

    // 1. Message SYSTÈME (type 7 = arrivée). Le piège posé sur le salon système
    //    sanctionnerait sinon chaque arrivée, pour un message que personne n'a
    //    écrit.
    assert.equal(await declenche(message({ message: { type: 7 } })), false);

    // 2. Webhook : pas de membre à sanctionner, et c'est une décision d'équipe.
    assert.equal(await declenche(message({ message: { webhook_id: 'W1' } })), false);

    // 3. Le propriétaire du serveur, qui va justement inspecter son piège.
    assert.equal(await declenche(message({ auteurId: '999999999999999999' })), false);

    // 4. Un FIL ouvert dans le salon piège EST le salon piège, sinon le piège se
    //    contourne en répondant dans un fil…
    assert.equal(await declenche(message({
        message: { channelId: 'FIL', channel: { id: 'FIL', name: 'f', parentId: 'PIEGE', isThread: () => true } },
    })), true);

    // … mais un salon ordinaire RANGÉ DANS la catégorie « PIEGE » n'en est pas
    // un : confondre les deux parents rendrait le piège fou.
    assert.equal(await declenche(message({
        message: { channelId: 'AUTRE', channel: { id: 'AUTRE', name: 'a', parentId: 'PIEGE' } },
    })), false);
});

// ── Anti-raid : les deux voies donnent le même résultat ─────────────────────

test('anti-raid — la voie neutre détecte la vague comme la voie historique', async () => {
    const antiraid = require('../bot/modules/antiraid');
    const db = getDb();
    // Serveur dédié : la fenêtre glissante vit en mémoire, pour la durée du
    // processus, et une vague laissée ouverte par un autre test rangerait ces
    // arrivées dans la sienne.
    const GUILDE_VAGUE = '222222222222222222';
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE_VAGUE, 'Serveur Vague');
    db.prepare(`INSERT INTO antiraid_config
        (guild_id, enabled, join_count, join_window_seconds, min_account_age_hours, punishments, panic_duration_seconds, log_channel)
        VALUES (?, 1, 2, 10, 0, '', 0, 'LOGS')
        ON CONFLICT(guild_id) DO UPDATE SET enabled = 1, join_count = 2, join_window_seconds = 10,
            min_account_age_hours = 0, punishments = '', panic_duration_seconds = 0, log_channel = 'LOGS'`)
        .run(GUILDE_VAGUE);
    antiraid.invalidateConfig();

    const envois = [];
    const guilde = normaliserGuilde(guildeDiscord({ id: GUILDE_VAGUE }));
    const portee = {
        guildeId: GUILDE_VAGUE,
        guilde,
        moi: { id: 'BOT' },
        api: {
            async envoyerMessage(canalId, corps) { envois.push(corps); return { id: 'm1' }; },
            async obtenirGuilde() { return guilde; },
        },
    };
    const arrivant = (id) => membreNormalise({ membre: { id, user: { id, username: 'u', bot: false, discriminator: '0', createdTimestamp: Date.UTC(2020, 0, 1) } } });

    await antiraid.handleMemberJoin(arrivant('444444444444444444'), portee);
    const verdict = await antiraid.handleMemberJoin(arrivant('555555555555555555'), portee);

    assert.deepEqual(verdict, { removed: false }, 'alerte seule : personne n\'est retiré');
    assert.equal(envois.length, 1, 'une seule alerte par vague');

    // Mêmes champs que sur la voie historique (cf. modules-antiraid-breach),
    // `membreCount` compris — c'est l'un des deux champs qui bloquaient.
    assert.deepEqual(corpsEnvoye(rendreEmbed(envois[0])).fields, [
        { name: 'Arrivées', value: '2 en moins de 10 s', inline: true },
        { name: 'Déclencheur', value: 'Anti-raid', inline: true },
        { name: 'Membres du serveur', value: '1337', inline: true },
        { name: 'Sanction', value: 'Aucune : ce serveur est réglé en alerte seule.', inline: false },
        { name: 'Mode panique', value: 'Désactivé sur ce serveur (durée réglée à 0).', inline: false },
    ]);
});
