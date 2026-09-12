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
