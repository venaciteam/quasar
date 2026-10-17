// Registre de commandes déclaratif : dérivation, validation et cohabitation.
//
// Raison d'être : le lot 0 pose le contrat sur lequel 27 commandes vont être
// migrées, et la migration se fait sur une instance en PRODUCTION. Le JSON
// produit par un descripteur doit donc être strictement identique à celui du
// `SlashCommandBuilder` qu'il remplace — une différence, même sur un champ
// « cosmétique », se paie en re-déploiement silencieux à chaque démarrage.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données :
// le chargeur parcourt bot/commands/, dont plusieurs fichiers l'ouvrent.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { construireSlashCommand, chargerCommandes } = require('../bot/platform/discord/commands');
const { definirCommande, estDescripteurNeutre, TYPES_OPTION } = require('../bot/platform/commands');
const { DISABLED_COMMAND_FILES } = require('../bot/utils/disabledCommands');

const DOSSIER_COMMANDES = path.join(__dirname, '..', 'bot', 'commands');

/**
 * Corps RÉELLEMENT envoyé à Discord. `toJSON()` d'un builder laisse en place les
 * champs non renseignés à `undefined` ; la sérialisation les retire, et c'est
 * elle qui décide de ce qui part sur le fil. Comparer les objets bruts ferait
 * échouer le test sur des champs qui n'existent pas dans la requête.
 */
const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

// ── Forme simple : /ping ─────────────────────────────────────────────────────

test('un descripteur simple produit le JSON de son builder d\'origine', () => {
    // Référence relevée sur la v4.10.0, AVANT migration. Écrite en dur : la
    // recalculer depuis le code testé ne prouverait rien.
    const REFERENCE_PING = {
        options: [],
        name: 'ping',
        description: 'Vérifier si Quasar est en ligne',
        type: 1,
    };
    const descripteur = require('../bot/commands/ping');
    assert.deepEqual(corpsEnvoye(construireSlashCommand(descripteur)), REFERENCE_PING);
});

// ── Forme à sous-commandes : /autorole ───────────────────────────────────────

test('un descripteur à sous-commandes produit le JSON de son builder d\'origine', () => {
    const REFERENCE_AUTOROLE = {
        options: [
            {
                type: 1,
                name: 'add',
                description: 'Ajouter un rôle automatique',
                options: [
                    { name: 'role', description: 'Le rôle à attribuer', required: true, type: 8 },
                ],
            },
            {
                type: 1,
                name: 'remove',
                description: 'Retirer un rôle automatique',
                options: [
                    { name: 'role', description: 'Le rôle à retirer', required: true, type: 8 },
                ],
            },
            {
                type: 1,
                name: 'list',
                description: 'Voir les rôles automatiques configurés',
                options: [],
            },
        ],
        name: 'autorole',
        description: 'Gérer les rôles attribués automatiquement à l\'arrivée',
        // ManageRoles, sérialisée en CHAÎNE par l'API : un `number` tronquerait
        // les bits hauts des permissions au-delà de 2^53.
        default_member_permissions: '268435456',
        type: 1,
    };
    const descripteur = require('../bot/commands/autorole');
    assert.deepEqual(corpsEnvoye(construireSlashCommand(descripteur)), REFERENCE_AUTOROLE);
});

// ── Couverture des types d'option ────────────────────────────────────────────

test('chaque type d\'option du contrat est dérivé vers le bon type Discord', () => {
    const descripteur = definirCommande({
        nom: 'temoin',
        description: 'Commande de contrôle des types',
        accesParDefaut: true,
        options: [
            { nom: 'a', type: 'texte', description: 'chaîne', requis: true },
            { nom: 'b', type: 'entier', description: 'nombre' },
            { nom: 'c', type: 'booleen', description: 'oui ou non' },
            { nom: 'd', type: 'utilisateur', description: 'une personne' },
            { nom: 'e', type: 'canal', description: 'un salon' },
            { nom: 'f', type: 'role', description: 'un rôle' },
            { nom: 'g', type: 'choix', description: 'une valeur', choix: [{ nom: 'Un', valeur: 'un' }] },
        ],
        async executer() {},
    });

    const json = corpsEnvoye(construireSlashCommand(descripteur));
    // 3 = STRING, 4 = INTEGER, 5 = BOOLEAN, 6 = USER, 7 = CHANNEL, 8 = ROLE
    assert.deepEqual(json.options.map(o => o.type), [3, 4, 5, 6, 7, 8, 3]);
    assert.deepEqual(json.options.map(o => o.name), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(json.options[0].required, true);
    assert.deepEqual(json.options[6].choices, [{ name: 'Un', value: 'un' }]);
    assert.equal(TYPES_OPTION.length, 7, 'un type ajouté au contrat doit être couvert ici');
});

test('les bornes min et max portent la longueur sur un texte et la valeur sur un entier', () => {
    const json = corpsEnvoye(construireSlashCommand(definirCommande({
        nom: 'bornes',
        description: 'Contrôle des bornes',
        accesParDefaut: true,
        options: [
            { nom: 'texte', type: 'texte', description: 't', min: 2, max: 10 },
            { nom: 'entier', type: 'entier', description: 'e', min: 1, max: 99 },
        ],
        async executer() {},
    })));

    assert.equal(json.options[0].min_length, 2);
    assert.equal(json.options[0].max_length, 10);
    assert.equal(json.options[1].min_value, 1);
    assert.equal(json.options[1].max_value, 99);
});

// ── Validation du descripteur ────────────────────────────────────────────────

test('un descripteur incomplet ou fautif est refusé AU CHARGEMENT', () => {
    const base = { nom: 'x', description: 'd', accesParDefaut: true, async executer() {} };

    assert.throws(() => definirCommande({ description: 'd' }), /nom/);
    assert.throws(() => definirCommande({ nom: 'x' }), /description/);
    assert.throws(() => definirCommande({ nom: 'x', description: 'd', accesParDefaut: true }), /executer/);
    // Une faute de frappe sur un type produirait sinon une commande déployée
    // sans son option, ou un lot entier refusé par Discord.
    assert.throws(
        () => definirCommande({ ...base, options: [{ nom: 'o', type: 'string', description: 'd' }] }),
        /type « string » inconnu/,
    );
    assert.throws(() => definirCommande({ ...base, permission: 'MANAGE_ROLE' }), /permission/);
    assert.throws(() => definirCommande({ ...base, plateformes: ['irc'] }), /plateforme/);
});

test('les règles que Discord impose à l\'ordre des options sont vérifiées ici', () => {
    const base = { nom: 'x', description: 'd', accesParDefaut: true, async executer() {} };

    // Discord refuse une option requise après une option facultative.
    assert.throws(() => definirCommande({
        ...base,
        options: [
            { nom: 'a', type: 'texte', description: 'd' },
            { nom: 'b', type: 'texte', description: 'd', requis: true },
        ],
    }), /ne peut pas suivre une option facultative/);

    // `reste: true` capte la fin de la ligne côté Fluxer : rien ne peut suivre.
    assert.throws(() => definirCommande({
        ...base,
        options: [
            { nom: 'a', type: 'texte', description: 'd', reste: true },
            { nom: 'b', type: 'texte', description: 'd' },
        ],
    }), /DERNIÈRE option/);

    // Options et sous-commandes s'excluent : Discord rejetterait le lot entier.
    assert.throws(() => definirCommande({
        nom: 'x',
        description: 'd',
        accesParDefaut: true,
        options: [{ nom: 'a', type: 'texte', description: 'd' }],
        sousCommandes: [{ nom: 's', description: 'd', async executer() {} }],
    }), /sous-commandes ne peut pas porter d'options/);
});

test('les noms réservés se lisent sur le descripteur, sans pont data.name', () => {
    // `reservedCommandNames()` (bot/commands/customcmd.js) lisait `mod.data.name`,
    // ce qui obligeait `definirCommande` à poser un `data` factice sur chaque
    // descripteur. Le pont a été retiré à la consolidation : la liste se
    // construit sur `mod.nom`, et un homonyme personnalisé reste impossible.
    const { reservedCommandNames } = require('../bot/commands/customcmd');
    const noms = reservedCommandNames();
    assert.ok(noms.has('ping'), '/ping doit rester un nom réservé');
    assert.ok(noms.has('autorole'), '/autorole doit rester un nom réservé');

    // TOUTES les commandes chargées, sans exception : c'est la liste des noms
    // que Quasar occupe déjà sur un serveur.
    for (const entree of chargerCommandes({ dossier: DOSSIER_COMMANDES, exclus: DISABLED_COMMAND_FILES })) {
        assert.ok(noms.has(entree.nom), `/${entree.nom} doit être un nom réservé`);
    }

    // Et le pont lui-même a bien disparu du descripteur.
    assert.equal(require('../bot/commands/ping').data, undefined,
        'un descripteur neutre ne doit plus porter de `data`');
});

// ── Cohabitation des deux formats ────────────────────────────────────────────

test('le chargeur REFUSE un module resté au format historique', () => {
    // Le chargeur a accepté les deux formats le temps des lots 1 à 5. Depuis la
    // consolidation il n'accepte plus que le descripteur neutre, et il LÈVE sur
    // l'autre — il ne l'ignore pas. La différence est tout l'objet de ce test :
    // une commande simplement ignorée disparaîtrait du bot ET du déploiement
    // sans erreur, sans journal, et sans symptôme qui désigne sa cause.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-biformat-'));
    const registre = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'commands'));
    // Chemins absolus : le dossier factice est hors du dépôt, la résolution
    // relative de node_modules n'y remonterait pas.
    const discordjs = JSON.stringify(require.resolve('discord.js'));

    fs.writeFileSync(path.join(dossier, 'neutre.js'), `
        const { definirCommande } = require(${registre});
        module.exports = definirCommande({
            nom: 'temoin-neutre', description: 'Témoin neutre', accesParDefaut: true,
            async executer(ctx) { return ctx; },
        });
    `);

    try {
        const [entree, ...reste] = chargerCommandes({ dossier });
        assert.equal(reste.length, 0);
        assert.equal(entree.nom, 'temoin-neutre');
        assert.equal(entree.neutre, true);
        assert.equal(typeof entree.data.toJSON, 'function', 'non déployable');
        assert.equal(typeof entree.execute, 'function', 'non exécutable');

        fs.writeFileSync(path.join(dossier, 'historique.js'), `
            const { SlashCommandBuilder } = require(${discordjs});
            module.exports = {
                data: new SlashCommandBuilder().setName('temoin-historique').setDescription('Témoin historique'),
                async execute(interaction) { return interaction; },
            };
        `);

        assert.throws(
            () => chargerCommandes({ dossier }),
            (err) => {
                // Le message doit nommer LE FICHIER et LA CORRECTION : c'est la
                // seule information utile à qui découvre l'échec au démarrage.
                assert.match(err.message, /historique\.js/);
                assert.match(err.message, /temoin-historique/);
                assert.match(err.message, /definirCommande/);
                return true;
            },
        );
    } finally {
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});

test('toutes les commandes du bot sont neutres, déployables et exécutables', () => {
    // Le pendant du test ci-dessus sur le VRAI dossier : il ne nomme aucune
    // commande, donc il survit à tout ajout — mais il attrape un fichier qui ne
    // serait chargé par aucune voie, et qui disparaîtrait donc en silence.
    const entrees = chargerCommandes({ dossier: DOSSIER_COMMANDES, exclus: DISABLED_COMMAND_FILES });
    for (const entree of entrees) {
        assert.equal(entree.neutre, true, `/${entree.nom} : encore au format historique`);
        assert.equal(typeof entree.data.toJSON, 'function', `/${entree.nom} : non déployable`);
        assert.equal(typeof entree.execute, 'function', `/${entree.nom} : non exécutable`);
    }
});

test('les commandes désactivées ne sont pas chargées', () => {
    const noms = chargerCommandes({ dossier: DOSSIER_COMMANDES, exclus: DISABLED_COMMAND_FILES })
        .map(e => e.nom);
    for (const interdit of ['play', 'musicconfig']) {
        assert.equal(noms.includes(interdit), false, `/${interdit} est désactivée`);
    }
});

test('les 26 commandes actives restent chargées, sans doublon', () => {
    // Garde-fou de non-régression : la migration ne doit ni perdre ni dupliquer
    // une commande. Discord refuse un lot contenant deux fois le même nom.
    const noms = chargerCommandes({ dossier: DOSSIER_COMMANDES, exclus: DISABLED_COMMAND_FILES })
        .map(e => e.nom);
    assert.equal(noms.length, 26);
    assert.equal(new Set(noms).size, noms.length, 'nom de commande en double');
});

test('estDescripteurNeutre refuse une migration à moitié faite', () => {
    assert.equal(estDescripteurNeutre({ nom: 'x', executer() {} }), true);
    assert.equal(estDescripteurNeutre({ data: { name: 'x' }, execute() {} }), false);
    assert.equal(estDescripteurNeutre(null), false);
    // Les deux à la fois : on le signale plutôt que de choisir à sa place.
    assert.throws(
        () => estDescripteurNeutre({ nom: 'x', executer() {}, execute() {} }),
        /executer.*execute|à la fois/s,
    );
});

test('une commande indisponible sur la plateforme active est écartée du chargement', () => {
    // `plateformes: ['fluxer']` sur l'adaptateur Discord : la déployer puis
    // refuser de l'exécuter afficherait une commande morte dans le sélecteur.
    const fs = require('node:fs');
    const os = require('node:os');
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-cmd-'));
    fs.writeFileSync(path.join(dossier, 'ailleurs.js'), `
        const { definirCommande } = require(${JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'commands'))});
        module.exports = definirCommande({
            nom: 'ailleurs', description: 'Ailleurs', accesParDefaut: true,
            plateformes: ['fluxer'], async executer() {},
        });
    `);
    assert.deepEqual(chargerCommandes({ dossier }).map(e => e.nom), []);
    fs.rmSync(dossier, { recursive: true, force: true });
});
