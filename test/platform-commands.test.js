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

test('un descripteur porte un pont data.name, pour la liste des noms réservés', () => {
    // `reservedCommandNames()` (bot/commands/customcmd.js) lit `mod.data.name`.
    // Sans ce pont, /ping et /autorole sortiraient de la liste et un homonyme
    // personnalisé pourrait être créé — inerte, puis écarté au déploiement.
    const { reservedCommandNames } = require('../bot/commands/customcmd');
    const noms = reservedCommandNames();
    assert.ok(noms.has('ping'), '/ping doit rester un nom réservé');
    assert.ok(noms.has('autorole'), '/autorole doit rester un nom réservé');
    assert.ok(noms.has('warn'), 'une commande restée au format historique aussi');
});

// ── Cohabitation des deux formats ────────────────────────────────────────────

test('le chargeur accepte descripteurs neutres et modules historiques', () => {
    const entrees = chargerCommandes({ dossier: DOSSIER_COMMANDES, exclus: DISABLED_COMMAND_FILES });
    const parNom = new Map(entrees.map(e => [e.nom, e]));

    assert.equal(parNom.get('ping').neutre, true);
    assert.equal(parNom.get('autorole').neutre, true);
    assert.equal(parNom.get('warn').neutre, false, '/warn n\'est pas encore migrée');

    // Dans les deux cas, la même entrée exploitable des deux côtés.
    for (const entree of entrees) {
        assert.equal(typeof entree.nom, 'string');
        assert.equal(typeof entree.data.toJSON, 'function');
        assert.equal(typeof entree.execute, 'function', `${entree.nom} n'est pas exécutable`);
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
