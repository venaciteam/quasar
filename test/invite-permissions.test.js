// Garde-fou : le lien d'invitation « moindre privilège » du README.
//
// La liste qu'il donnait était incomplète, et suivre ce conseil produisait un
// bot MUET : ni « Voir les salons », ni « Envoyer des messages », ni « Intégrer
// des liens » n'y figuraient. Manquaient aussi « Joindre des fichiers » (les
// transcripts de tickets, sans quoi Quasar refuse de fermer le ticket plutôt que
// de perdre la conversation), « Ajouter des réactions » (le bot pose lui-même
// les réactions des panneaux de rôles) et « Déplacer des membres » (TempVoice
// déplace la personne dans le salon qu'il vient de créer).
//
// Le défaut touchait précisément qui fait attention. Ce test existe pour que le
// masque du README suive le code : au premier module qui réclamera une
// permission de plus, il faudra passer ici, et le passage sera visible.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Position du bit, telle que Discord la définit. Le commentaire dit à quoi elle
// sert dans Quasar : une permission sans usage identifiable n'a rien à faire ici.
const PERMISSIONS = {
    ViewChannel: [10n, 'voir les salons où répondre'],
    SendMessages: [11n, 'répondre, poster les panneaux et les messages de bienvenue'],
    AddReactions: [6n, 'poser les réactions des panneaux de rôles'],
    EmbedLinks: [14n, 'la quasi-totalité des réponses sont des embeds'],
    AttachFiles: [15n, 'remettre le transcript d\'un ticket à sa fermeture'],
    ReadMessageHistory: [16n, '/clear et la constitution des transcripts'],
    ManageChannels: [4n, 'tickets et salons vocaux temporaires'],
    MoveMembers: [24n, 'déplacer la personne dans son salon vocal temporaire'],
    ManageRoles: [28n, 'autoroles, panneaux de rôles, rôles vocaux'],
    ManageMessages: [13n, '/clear, suppression en masse de messages'],
    KickMembers: [1n, '/kick et les expulsions automatiques'],
    BanMembers: [2n, '/ban et la levée des bannissements temporaires'],
    ModerateMembers: [40n, 'toutes les exclusions temporaires'],
    ManageGuild: [5n, 'AutoMod de Discord et mode panique anti-raid'],
};

// Nom canonique du contrat -> nom discord.js, via le bit. Écrit ainsi plutôt
// qu'en table recopiée : une table de plus serait une table de plus à tenir à
// jour, et elle divergerait au premier ajout.
function permissionsBotDeclarees() {
    process.env.QUASAR_DB_PATH = process.env.QUASAR_DB_PATH || ':memory:';
    const { PermissionFlagsBits } = require('discord.js');
    const { BITS } = require('../bot/platform/discord/permissions');
    const { chargerCommandes } = require('../bot/platform/discord/commands');
    const { DISABLED_COMMAND_FILES } = require('../bot/utils/disabledCommands');

    const nomParBit = new Map(Object.entries(PermissionFlagsBits).map(([nom, bit]) => [bit, nom]));
    const declarees = new Set();

    const entrees = chargerCommandes({
        dossier: path.join(__dirname, '..', 'bot', 'commands'),
        exclus: DISABLED_COMMAND_FILES,
    });
    for (const entree of entrees) {
        const sources = [entree.descripteur, ...(entree.descripteur?.sousCommandes || [])];
        for (const source of sources) {
            for (const canonique of source?.permissionsBot || []) {
                const nomDiscord = nomParBit.get(BITS[canonique]);
                if (nomDiscord) declarees.add(nomDiscord);
            }
        }
    }
    return declarees;
}

function masque() {
    let total = 0n;
    for (const [bit] of Object.values(PERMISSIONS)) total |= 1n << bit;
    return total;
}

test('le masque du README correspond aux permissions réellement nécessaires', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const trouve = readme.match(/permissions=(\d+)/);
    assert.ok(trouve, 'aucun lien d\'invitation avec permissions= dans le README');
    assert.equal(trouve[1], String(masque()),
        `masque du README obsolète. Attendu ${masque()} pour : ${Object.keys(PERMISSIONS).join(', ')}`);
});

test('le socle minimal est présent : sans lui le bot est muet', () => {
    // C'est l'oubli exact que ce fichier corrige. Un bot sans ces quatre
    // permissions s'invite, apparaît en ligne, et ne produit jamais rien.
    for (const nom of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']) {
        assert.ok(PERMISSIONS[nom], `${nom} doit rester dans le socle`);
        assert.notEqual((masque() & (1n << PERMISSIONS[nom][0])), 0n, `${nom} absente du masque`);
    }
});

test('chaque permission du masque est justifiée par un usage', () => {
    for (const [nom, [, raison]] of Object.entries(PERMISSIONS)) {
        assert.ok(raison && raison.length > 8, `${nom} n'a pas de justification lisible`);
    }
});

test('les permissions citées dans le code sont toutes couvertes par le masque', () => {
    // Deux sources, le temps de la transition.
    //
    //  1. Balayage du code source : toute `PermissionFlagsBits.X` que Quasar
    //     teste doit se retrouver dans le lien d'invitation. C'est le garde-fou
    //     d'origine, et il s'érode : une commande migrée passe de
    //     `PermissionFlagsBits.ManageRoles` à la chaîne canonique
    //     'MANAGE_ROLES', et sort du regex. À la fin du lot 5 il ne verrait
    //     plus rien, tout en continuant de passer — un faux témoin.
    //
    //  2. Déclarations `permissionsBot` des descripteurs migrés. C'est la forme
    //     qui remplace le balayage, au fur et à mesure des lots.
    //
    // La forme déclarative règle au passage un défaut du balayage : il ne
    // distingue pas les permissions du BOT de celles exigées du MEMBRE, et
    // capture donc les `setDefaultMemberPermissions`. `permissionsBot` ne porte
    // que les premières, `permission` les secondes.
    const racine = path.join(__dirname, '..');
    const citees = new Set();

    // La table de correspondance de la couche plateforme n'est PAS un usage :
    // elle traduit les 22 noms canoniques du contrat multiplateforme (DA §7.1)
    // en drapeaux discord.js, y compris ceux que Quasar ne demande pas pour
    // lui-même. La balayer ferait grossir le lien d'invitation de permissions
    // dont personne n'a besoin — l'inverse exact de ce que ce fichier protège.
    const TABLES_DE_CORRESPONDANCE = [path.join(racine, 'bot', 'platform', 'discord', 'permissions.js')];

    (function parcourir(dossier) {
        for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
            if (entree.name === 'node_modules' || entree.name.startsWith('.')) continue;
            const chemin = path.join(dossier, entree.name);
            if (entree.isDirectory()) { parcourir(chemin); continue; }
            if (!entree.name.endsWith('.js')) continue;
            if (TABLES_DE_CORRESPONDANCE.includes(chemin)) continue;
            const source = fs.readFileSync(chemin, 'utf8');
            for (const m of source.matchAll(/PermissionFlagsBits\.(\w+)/g)) citees.add(m[1]);
        }
    })(path.join(racine, 'bot'));

    for (const nom of permissionsBotDeclarees()) citees.add(nom);

    // Administrator n'est jamais une permission demandée : c'est le raccourci
    // proposé à l'invitation, et le test de droits de la personne qui commande.
    citees.delete('Administrator');

    const manquantes = [...citees].filter((nom) => !PERMISSIONS[nom]);
    assert.deepEqual(manquantes, [],
        `permissions testées dans le code mais absentes du lien d'invitation : ${manquantes.join(', ')}`);
});

test('une commande migrée déclare ses permissions de bot au lieu de les cacher', () => {
    // Sans cette déclaration, une commande migrée disparaît du balayage et le
    // garde-fou devient muet. Les deux commandes témoins du lot 0 la portent ;
    // les lots 1 à 5 rempliront le champ en migrant les 27 autres.
    for (const fichier of ['ping', 'autorole']) {
        const descripteur = require(path.join(__dirname, '..', 'bot', 'commands', fichier));
        assert.ok(
            Array.isArray(descripteur.permissionsBot),
            `/${fichier} : « permissionsBot » manquant (un tableau vide est une réponse valable)`,
        );
    }
    assert.ok(
        permissionsBotDeclarees().has('ManageRoles'),
        '/autorole doit déclarer MANAGE_ROLES : sans elle, la configuration s\'enregistre '
        + 'mais l\'attribution échoue plus tard, à l\'arrivée d\'un membre',
    );
});
