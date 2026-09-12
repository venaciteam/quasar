// ═══════════════════════════════════════════════════════════════
//  Étanchéité de la couche de plateforme
//
//  Le chantier multiplateforme tient à une seule promesse : RIEN au-dessus de
//  `bot/platform/` ne sait sur quelle plateforme il tourne. Cette promesse ne se
//  vérifie pas à la lecture — soixante-huit fichiers importaient `discord.js` au
//  départ, et il suffit d'un seul `require` réintroduit par habitude pour que le
//  bot Fluxer meure au chargement d'un module, très loin de la ligne fautive.
//
//  Ce test est donc PERMANENT, et pas un contrôle de fin de lot. Il balaie les
//  sources et refuse cinq choses :
//
//    1. `require('discord.js')` hors de l'adaptateur ;
//    2. `.brut`, l'échappatoire qui rendait l'objet natif au code métier ;
//    3. une comparaison sur le NOM d'une plateforme (on teste une capacité) ;
//    4. `PermissionFlagsBits.` et `ChannelType.` hors de l'adaptateur ;
//    5. le chargement de `discord.js` par le simple `require` de la couche.
//
//  ─── Les exceptions sont NOMMÉES ────────────────────────────────────────────
//
//  Chaque dérogation est écrite en toutes lettres ci-dessous, avec sa raison.
//  C'est le point de ce test : une nouvelle exception est un fichier à ajouter
//  ici, donc un choix relu — jamais une dérive qu'un motif trop large aurait
//  laissée passer.
// ═══════════════════════════════════════════════════════════════

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const DOSSIER_BOT = path.join(RACINE, 'bot');

// ─── Exceptions, une par une ────────────────────────────────────────────────

/**
 * Dossiers où `discord.js` a le droit d'exister sans réserve.
 *
 * `bot/platform/discord/` est l'adaptateur : c'est sa raison d'être.
 * `bot/modules/music/` est la famille MUSIQUE, coupée le 2026-06-18 et exclue du
 * portage par la DA (voix Fluxer en LiveKit, sans protocole de signalisation
 * publié). Elle n'est jamais chargée : `@discordjs/voice` n'est plus une
 * dépendance du `package.json`.
 */
const DOSSIERS_AUTORISES = Object.freeze([
    'bot/platform/discord/',
    'bot/modules/music/',
]);

/**
 * Fichiers nommément autorisés à importer `discord.js`, avec leur raison.
 *
 * Aucun n'est un oubli de migration : ce sont les trois cas où le portage
 * n'avait pas de sens, et ils sont tous documentés en tête de leur fichier.
 */
const FICHIERS_AUTORISES = Object.freeze({
    // Miroir des règles d'AutoMod NATIVES de Discord. Fluxer n'a aucun automod :
    // il n'y a rien en face à mirrorer, et le portage n'a pas d'objet (DA §2.2).
    // Chargement paresseux, pour qu'un processus Fluxer ne l'évalue jamais.
    'bot/utils/automodSync.js': 'miroir de l\'AutoMod natif, sans équivalent Fluxer',
    // Famille musique, coupée : fichiers dans DISABLED_COMMAND_FILES, donc ni
    // chargés ni déployés, et leurs modules ne sont même pas résolubles.
    'bot/commands/play.js': 'famille musique coupée (DISABLED_COMMAND_FILES)',
    'bot/commands/musiccontrols.js': 'famille musique coupée (DISABLED_COMMAND_FILES)',
});

/**
 * Fichiers dont l'import de `discord.js` est une branche TRANSITION retenue par
 * un appelant dans `api/`.
 *
 * ⚠️ VIDE, et c'est le résultat du lot 7. Les deux dérogations qui vivaient ici
 * — `bot/commands/customcmd.js` pour `api/routes/customcmds.js`,
 * `bot/modules/antiraid/panic.js` pour `api/routes/antiraid.js` — sont tombées
 * le jour où `createApi` a reçu l'ADAPTATEUR au lieu du client natif. Avec
 * elles sont tombées la voie `Guild` de `punishments.sendAutomodLog`, celle de
 * `modlog.sendModLog` et le pont `assignableRole.describeForApi`, dont ces deux
 * fichiers étaient le dernier chemin d'accès.
 *
 * La table reste en place, avec son contrôle : une dérogation future devra
 * NOMMER la route qui la retient, et ne sera donc jamais un endroit où ranger ce
 * qu'on ne veut pas migrer.
 */
const TRANSITIONS_RETENUES_PAR_API = Object.freeze({});

// ─── Balayage ───────────────────────────────────────────────────────────────

/** Tous les `.js` d'un dossier, récursivement, en chemins relatifs à la racine. */
function sources(dossier) {
    const trouves = [];
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
        const chemin = path.join(dossier, entree.name);
        if (entree.isDirectory()) trouves.push(...sources(chemin));
        else if (entree.name.endsWith('.js')) trouves.push(path.relative(RACINE, chemin));
    }
    return trouves.sort();
}

/**
 * Retire les COMMENTAIRES d'un source, et eux seuls.
 *
 * Indispensable : la moitié des motifs cherchés ici apparaissent LÉGITIMEMENT
 * dans les commentaires du dépôt, qui expliquent précisément ce qu'on interdit.
 * Sans ce nettoyage, ce test refuserait sa propre documentation — et la réponse
 * naturelle serait d'effacer les explications, ce qui est l'inverse du but.
 *
 * ⚠️ Les chaînes littérales sont CONSERVÉES, contrairement à une première
 * version de ce fichier qui les effaçait aussi : `require('discord.js')` EST
 * une chaîne, et les vider faisait passer le test sur n'importe quel import.
 * Un motif cherché dans une chaîne de message reste donc possible en théorie ;
 * aucun n'existe dans le dépôt, et un faux positif se réglerait en nommant le
 * fichier ici plutôt qu'en aveuglant le contrôle.
 *
 * Volontairement grossier : il ne s'agit pas d'analyser du JavaScript, mais de
 * ne pas confondre du code avec de la prose.
 */
function codeSeul(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')      // commentaires de bloc
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // commentaires de ligne
}

const FICHIERS = sources(DOSSIER_BOT);
const CODE = new Map(FICHIERS.map(relatif => [
    relatif,
    codeSeul(fs.readFileSync(path.join(RACINE, relatif), 'utf8')),
]));
const BRUT = new Map(FICHIERS.map(relatif => [
    relatif,
    fs.readFileSync(path.join(RACINE, relatif), 'utf8'),
]));

const dansDossierAutorise = (relatif) => DOSSIERS_AUTORISES.some(d => relatif.startsWith(d));

test('le balayage voit bien tout bot/ — sinon il ne prouve rien', () => {
    // Un test d'étanchéité qui ne lit aucun fichier passe toujours. On vérifie
    // donc d'abord qu'il a de la matière, et qu'il atteint les endroits les plus
    // exposés du dépôt.
    assert.ok(FICHIERS.length > 100, `seulement ${FICHIERS.length} fichiers balayés`);
    for (const temoin of [
        'bot/index.js',
        'bot/commands/ticket.js',
        'bot/events/messageCreate.js',
        'bot/utils/punishments.js',
        'bot/modules/defer/index.js',
        'bot/panneaux/defer.js',
    ]) {
        assert.ok(CODE.has(temoin), `${temoin} n'a pas été balayé`);
    }
});

test('aucun require(\'discord.js\') hors de l\'adaptateur et des exceptions nommées', () => {
    const motif = /require\(\s*['"`]discord\.js['"`]\s*\)/;
    const fautifs = [];

    for (const [relatif, code] of CODE) {
        if (!motif.test(code)) continue;
        if (dansDossierAutorise(relatif)) continue;
        if (relatif in FICHIERS_AUTORISES) continue;

        if (relatif in TRANSITIONS_RETENUES_PAR_API) {
            // La dérogation n'est valable que si le fichier DIT qui la retient.
            const route = TRANSITIONS_RETENUES_PAR_API[relatif];
            const source = BRUT.get(relatif);
            assert.ok(
                /TRANSITION/.test(source) && source.includes(route),
                `${relatif} : dérogation accordée, mais le fichier ne porte pas de marqueur `
                + `« TRANSITION » nommant ${route}. Une dérogation qui ne dit pas ce qui la lèvera `
                + 'est une dérogation permanente.',
            );
            continue;
        }

        fautifs.push(relatif);
    }

    assert.deepEqual(
        fautifs, [],
        'discord.js n\'a le droit d\'exister que dans bot/platform/discord/ et bot/modules/music/. '
        + 'Passez par le contrat neutre (bot/platform/), ou ajoutez une exception NOMMÉE dans '
        + 'test/platform-etancheite.test.js avec sa raison.',
    );
});

test('aucun accès à « .brut » : l\'échappatoire n\'existe plus', () => {
    // Une seule occurrence suffisait à ce qu'un fichier redevienne Discord-only
    // sans que rien ne l'indique. Les normaliseurs ne l'exposent plus ; ce test
    // empêche qu'on la remette, adaptateur compris.
    const fautifs = [];
    // Plus AUCUNE exception : les deux adaptateurs l'ont retiré, et il n'y a
    // pas de raison qu'un troisième le réintroduise.
    for (const [relatif, code] of CODE) {
        if (/\w\.brut\b/.test(code) || /['"`]brut['"`]\s*,/.test(code)) fautifs.push(relatif);
    }
    assert.deepEqual(
        fautifs, [],
        'Une information qui manque au code métier s\'AJOUTE au normaliseur, pour les deux '
        + 'plateformes — jamais en rouvrant un accès à l\'objet natif.',
    );
});

test('aucune comparaison sur le NOM d\'une plateforme : on teste une capacité', () => {
    // Le jour où Fluxer livre les interactions, un seul booléen bascule et tout
    // le code métier en bénéficie. Un `plateforme === 'fluxer'` semé dans une
    // commande annule ce bénéfice, et ne se voit pas.
    const motif = /\b(plateforme|nom)\s*[=!]==\s*['"`](discord|fluxer)['"`]/;
    const fautifs = [];
    for (const [relatif, code] of CODE) {
        if (relatif.startsWith('bot/platform/')) continue;
        if (motif.test(code)) fautifs.push(relatif);
    }
    assert.deepEqual(
        fautifs, [],
        'Testez `ctx.capacites.<capacité>`, jamais le nom de la plateforme. '
        + 'Une capacité manquante s\'ajoute à bot/platform/capabilities.js.',
    );
});

test('aucune énumération discord.js hors de l\'adaptateur', () => {
    // `PermissionFlagsBits` et `ChannelType` sont les deux tables que le code
    // métier lisait le plus. Elles ont chacune leur équivalent canonique —
    // bot/platform/permissions.js et bot/platform/channels.js — et l'adaptateur
    // est le seul endroit du dépôt où la traduction est écrite.
    const fautifs = [];
    for (const [relatif, code] of CODE) {
        if (dansDossierAutorise(relatif)) continue;
        if (relatif in FICHIERS_AUTORISES) continue;
        for (const enumeration of ['PermissionFlagsBits.', 'ChannelType.']) {
            if (!code.includes(enumeration)) continue;
            // Les deux fichiers retenus par `api/` les chargent dans leur branche
            // historique : la dérogation est la même que pour `require`, et elle
            // a déjà été justifiée par le test ci-dessus.
            if (relatif in TRANSITIONS_RETENUES_PAR_API) continue;
            fautifs.push(`${relatif} (${enumeration})`);
        }
    }
    assert.deepEqual(
        fautifs, [],
        'Utilisez les noms canoniques : `MANAGE_GUILD` (bot/platform/permissions.js), '
        + '`vocal` / `texte` (bot/platform/channels.js).',
    );
});

test('require(\'./bot/platform\') ne charge pas discord.js', () => {
    // Le contrôle le plus concret des cinq : c'est cette résolution-là qui tue
    // un processus Fluxer, à l'endroit exact où il croit ne charger que du
    // neutre. `bot/platform/index.js` ne doit résoudre son adaptateur qu'à
    // l'appel de `resolvePlatform()`, jamais au chargement du module.
    const script = `
        require('./bot/platform');
        const charge = Object.keys(require.cache)
            .filter(f => f.includes(require('path').join('node_modules', 'discord.js')));
        process.stdout.write(String(charge.length));
    `;
    const sortie = execFileSync(process.execPath, ['-e', script], { cwd: RACINE, encoding: 'utf8' });
    assert.equal(
        sortie, '0',
        'Le seul require de la couche neutre a chargé discord.js. Un adaptateur doit être '
        + 'résolu par resolvePlatform(), à l\'appel, jamais au chargement du module.',
    );
});

test('le contrat neutre ne charge pas discord.js non plus', () => {
    // Même contrôle sur les cinq pièces que le code métier importe vraiment :
    // c'est par elles qu'un `require` de l'adaptateur remonterait en cascade.
    const script = `
        for (const piece of ['commands', 'events', 'embed', 'permissions', 'channels', 'panneaux', 'erreurs']) {
            require('./bot/platform/' + piece);
        }
        const charge = Object.keys(require.cache)
            .filter(f => f.includes(require('path').join('node_modules', 'discord.js')));
        process.stdout.write(String(charge.length));
    `;
    const sortie = execFileSync(process.execPath, ['-e', script], { cwd: RACINE, encoding: 'utf8' });
    assert.equal(sortie, '0', 'une pièce du contrat neutre importe l\'adaptateur');
});

test('api/ ne lit le client natif que par api/services/plateforme.js', () => {
    // Le lot 7 a fait passer `createApi` du client natif à l'ADAPTATEUR. La
    // clé `discordClient` n'existe plus, et les quelques lectures qui n'ont pas
    // encore de méthode au contrat sont rassemblées dans un seul fichier, où
    // elles se comptent (cf. son en-tête).
    const dossierApi = path.join(RACINE, 'api');
    const fautifs = [];
    for (const relatif of sources(dossierApi)) {
        if (relatif === 'api/services/plateforme.js') continue;
        const code = codeSeul(fs.readFileSync(path.join(RACINE, relatif), 'utf8'));
        if (/discordClient/.test(code)) fautifs.push(`${relatif} (discordClient)`);
        if (/\.client\s*\?\.\s*guilds|\.client\.guilds/.test(code)) fautifs.push(`${relatif} (client.guilds)`);
    }
    assert.deepEqual(
        fautifs, [],
        'Passez par api/services/plateforme.js : il expose le client REST normalisé, '
        + 'les capacités, et regroupe les lectures natives restantes avec leur marqueur.',
    );
});

test('le routage des clics ne connaît plus aucun préfixe historique', () => {
    // Le `interactionCreate` de bot/index.js routait `tv_`, `ticket_`, `defer_`,
    // `signaler_` et `mesdonnees_` en dur. C'était la dernière connaissance de
    // composants Discord dans le bootstrap, et elle doublait un routage que
    // `platform.routerPanneau` fait déjà.
    // Source BRUTE : le motif cherché est une chaîne littérale, que `codeSeul`
    // aurait justement effacée.
    const bootstrap = BRUT.get('bot/index.js');
    for (const prefixe of ['tv_', 'ticket_', 'defer_', 'signaler_', 'mesdonnees_']) {
        assert.equal(
            new RegExp(`startsWith\\(\\s*['"\`]${prefixe}`).test(bootstrap), false,
            `bot/index.js route encore le préfixe ${prefixe}`,
        );
    }
    // Et les deux modules qui n'existaient que pour lui ont disparu.
    for (const disparu of ['bot/interactions/ticket.js', 'bot/interactions/defer.js']) {
        assert.equal(fs.existsSync(path.join(RACINE, disparu)), false, `${disparu} devrait avoir disparu`);
    }
});
