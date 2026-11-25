// Sélection de la plateforme et contrat de la couche neutre.
//
// Raison d'être : `resolvePlatform()` décide de tout ce qui suit. Une valeur mal
// orthographiée qui se replierait en silence sur Discord ferait démarrer le bot
// Discord là où on attendait le bot Fluxer — deux jeux de données, deux publics,
// et rien pour le signaler. Le refus de démarrer est donc un comportement testé,
// pas une commodité.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    resolvePlatform,
    resolvePlatformName,
    PLATFORMS,
    PLATEFORME_PAR_DEFAUT,
} = require('../bot/platform');
const { creerCapacites, CAPACITES_PAR_DEFAUT, NOMS_CAPACITES } = require('../bot/platform/capabilities');
const { embed, estEmbed, CHAMPS_EMBED } = require('../bot/platform/embed');
const { PERMISSIONS, serialiserBitfield, exigerPermissionCanonique } = require('../bot/platform/permissions');

// ── Résolution ───────────────────────────────────────────────────────────────

test('sans QUASAR_PLATFORM, la plateforme est Discord', () => {
    // Régression à ne jamais introduire : les installations existantes, y
    // compris auto-hébergées, n'ont pas cette variable dans leur .env.
    assert.equal(resolvePlatformName({}), 'discord');
    assert.equal(PLATEFORME_PAR_DEFAUT, 'discord');
    assert.equal(resolvePlatform({}).nom, 'discord');
});

test('une valeur vide ou blanche vaut absence', () => {
    for (const valeur of ['', '   ', '\t']) {
        assert.equal(resolvePlatformName({ QUASAR_PLATFORM: valeur }), 'discord');
    }
});

test('la casse et les espaces autour de la valeur sont tolérés', () => {
    assert.equal(resolvePlatformName({ QUASAR_PLATFORM: '  Discord ' }), 'discord');
    assert.equal(resolvePlatformName({ QUASAR_PLATFORM: 'FLUXER' }), 'fluxer');
});

test('une plateforme inconnue lève, et nomme les valeurs acceptées', () => {
    assert.throws(
        () => resolvePlatformName({ QUASAR_PLATFORM: 'irc' }),
        (err) => {
            assert.match(err.message, /QUASAR_PLATFORM invalide/);
            assert.match(err.message, /irc/);
            for (const nom of Object.keys(PLATFORMS)) assert.match(err.message, new RegExp(nom));
            return true;
        },
    );
});

test('un adaptateur pas encore livré est annoncé comme tel, pas en MODULE_NOT_FOUND', () => {
    // Un chemin de fichier dans la pile d'appel laisserait croire à une
    // installation cassée. Le contrôle porte sur le MÉCANISME, pas sur une
    // plateforme précise : nommer « fluxer » ici a fait tomber ce test le jour
    // de la livraison du lot 6, alors qu'il ne vérifie rien de Fluxer.
    const { chargerAdaptateur } = require('../bot/platform');
    assert.throws(
        () => chargerAdaptateur('mastodon'),
        (err) => {
            assert.match(err.message, /pas encore livré/);
            assert.match(err.message, /QUASAR_PLATFORM=discord/);
            assert.match(err.message, /bot\/platform\/mastodon\//);
            return true;
        },
    );
});

// ── Contrat de l'adaptateur ──────────────────────────────────────────────────

test('l\'adaptateur Discord expose le contrat complet de la DA', () => {
    const adaptateur = resolvePlatform({});
    for (const membre of ['nom', 'capacites', 'moi', 'permissions', 'api']) {
        assert.ok(adaptateur[membre], `membre « ${membre} » manquant`);
    }
    for (const methode of ['connecter', 'deconnecter', 'enregistrerCommandes', 'surEvenement']) {
        assert.equal(typeof adaptateur[methode], 'function', `méthode « ${methode} » manquante`);
    }
});

test('le client REST normalisé implémente tout le vocabulaire de la DA §4.3', () => {
    const { api } = resolvePlatform({});
    const attendues = [
        'envoyerMessage', 'modifierMessage', 'supprimerMessage', 'supprimerMessagesEnLot',
        'ajouterReaction', 'obtenirMembre', 'modifierMembre', 'ajouterRole', 'retirerRole',
        'exclureMembre', 'bannirMembre', 'debannirMembre', 'appliquerTimeout',
        'creerCanal', 'modifierCanal', 'supprimerCanal', 'ouvrirMessagePrive',
        'obtenirGuilde', 'obtenirCanal',
    ];
    for (const methode of attendues) {
        assert.equal(typeof api[methode], 'function', `méthode « ${methode} » absente du client REST`);
    }
});

test('l\'identité du bot est nulle tant qu\'il n\'est pas connecté', () => {
    // Le code qui filtre les réactions du bot doit s'abonner à `pret`, pas lire
    // `moi` au chargement : c'est le piège le plus prévisible de ctx.choose.
    const adaptateur = resolvePlatform({});
    assert.equal(adaptateur.moi.id, null);
});

// ── Capacités ────────────────────────────────────────────────────────────────

test('toutes les capacités valent false par défaut', () => {
    for (const nom of NOMS_CAPACITES) {
        assert.equal(CAPACITES_PAR_DEFAUT[nom], false, `${nom} devrait être false par défaut`);
    }
});

test('Discord déclare les sept capacités de la table §4.2', () => {
    const { capacites } = resolvePlatform({});
    assert.deepEqual({ ...capacites }, {
        interactions: true, ephemere: true, automod: true,
        audioBot: true, timeout: true, bulkDelete: true, fils: true,
        // Action d'incident « pause des invitations » : Discord l'a, Fluxer non.
        pauseInvitations: true,
    });
});

test('une capacité inconnue ou non booléenne est refusée', () => {
    // `interaction` au singulier produirait un `undefined` silencieux, donc faux
    // à l'usage : tout le parcours riche disparaîtrait sans un message.
    assert.throws(() => creerCapacites({ interaction: true }), /Capacité inconnue/);
    assert.throws(() => creerCapacites({ interactions: 'oui' }), /true ou false/);
});

// ── Embed neutre ─────────────────────────────────────────────────────────────

test('un embed neutre est une structure inerte aux neuf champs du contrat', () => {
    const e = embed({ titre: 'T', description: 'D', couleur: 0xc8a86e });
    assert.deepEqual(Object.keys(e).sort(), [...CHAMPS_EMBED].sort());
    for (const valeur of Object.values(e)) {
        assert.notEqual(typeof valeur, 'function', 'un embed neutre ne porte aucune méthode');
    }
    assert.equal(JSON.parse(JSON.stringify(e)).titre, 'T');
});

test('estEmbed reconnaît une structure recopiée, qui a perdu son marqueur', () => {
    const e = embed({ titre: 'T' });
    assert.equal(estEmbed(e), true);
    assert.equal(estEmbed({ ...e }), true, 'une copie reste un embed');
    assert.equal(estEmbed(JSON.parse(JSON.stringify(e))), true);
    assert.equal(estEmbed('texte'), false);
    assert.equal(estEmbed(null), false);
    assert.equal(estEmbed(['titre']), false);
});

// ── Permissions ──────────────────────────────────────────────────────────────

test('les 22 permissions canoniques de la DA §7.1 sont traduites par Discord', () => {
    const { bitfield } = require('../bot/platform/discord/permissions');
    assert.equal(PERMISSIONS.length, 22);
    for (const nom of PERMISSIONS) {
        assert.equal(typeof bitfield(nom), 'bigint', `${nom} non traduite`);
    }
});

test('un nom de permission hors vocabulaire lève', () => {
    // `MANAGE_ROLE` au singulier rendrait sinon « false » : la commande
    // deviendrait inaccessible à tout le monde, sans que rien n'en dise la cause.
    assert.throws(() => exigerPermissionCanonique('MANAGE_ROLE'), /Permission inconnue/);
    assert.throws(() => exigerPermissionCanonique('ManageRoles'), /Permission inconnue/);
});

test('un bitfield est sérialisé en chaîne, jamais en nombre', () => {
    // Les bitfields de permission dépassent 2^53 : un `number` en tronque les
    // bits hauts en silence, et l'API accepte le corps sans broncher.
    const { bitfield } = require('../bot/platform/discord/permissions');
    const bits = bitfield(['ADMINISTRATOR', 'MANAGE_ROLES']);
    assert.equal(typeof bits, 'bigint');
    assert.equal(typeof serialiserBitfield(bits), 'string');
    assert.equal(serialiserBitfield(1n << 50n), '1125899906842624');
    // null et undefined passent tels quels : « pas de restriction » n'est pas
    // « aucune permission ».
    assert.equal(serialiserBitfield(null), null);
    assert.equal(serialiserBitfield(undefined), undefined);
});

test('les overwrites de salon sortent en chaînes 64 bits', () => {
    const { normaliserOverwrites } = require('../bot/platform/discord/api');
    const [premier] = normaliserOverwrites([
        { id: '1', type: 'role', autorise: ['VIEW_CHANNEL'], refuse: ['SEND_MESSAGES'] },
    ]);
    assert.equal(premier.type, 0);
    assert.equal(typeof premier.allow, 'string');
    assert.equal(typeof premier.deny, 'string');
    assert.equal(premier.allow, String(1n << 10n));
    assert.equal(premier.deny, String(1n << 11n));

    // Un bitfield déjà sérialisé traverse sans perte, y compris au-delà de 2^53.
    const [second] = normaliserOverwrites([{ id: '2', type: 'membre', autorise: '1125899906842624' }]);
    assert.equal(second.type, 1);
    assert.equal(second.allow, '1125899906842624');
    assert.equal(second.deny, '0');
});
