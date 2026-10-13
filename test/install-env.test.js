// L'installateur, exécuté pour de vrai — le fichier .env qu'il produit.
//
// Raison d'être : l'installateur a été livré cassé sur ses deux portes d'entrée
// à la fois (le tube du README sortait en silence avant la première question, et
// « sed -i » sans suffixe échouait sur macOS et BSD) sans que personne ne s'en
// aperçoive, parce qu'aucun test ne l'avait jamais exécuté. Ces tests le lancent
// réellement, en mode non interactif, avec un faux « docker » en tête de PATH :
// tout le parcours devient vérifiable sans Docker dans Docker.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');

// Fichiers que setup.sh lit ou écrit. .env.example en fait partie : le .env est
// dérivé de lui, ses 240 lignes de commentaires doivent survivre au passage.
const FICHIERS = ['setup.sh', '.env.example', 'docker-compose.yml', 'Dockerfile'];

// Faux docker : il journalise ce qu'on lui demande et répond « tout va bien ».
// La ligne BUILD_ENV rend visible ce que la construction reçoit dans son
// environnement — c'est ainsi que DOCKER_GID est réellement transmis.
const FAUX_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "Docker Compose version v2.30.0"; exit 0; fi
case "$1" in
  info) exit 0 ;;
  volume)
    case "$2" in
      inspect) exit 1 ;;
      create) echo quasar-data; exit 0 ;;
    esac ;;
  inspect) printf '%s\\n' "\${FAKE_ETAT:-running}"; exit 0 ;;
  logs) printf '%s\\n' "\${FAKE_LOGS:-[Quasar] Connecté en tant que QuasarTest#4242}"; exit 0 ;;
  compose)
    case "$2" in
      build) printf 'BUILD_ENV DOCKER_GID=%s\\n' "\${DOCKER_GID:-<absent>}" >> "$DOCKER_LOG"; exit 0 ;;
      up) exit 0 ;;
    esac ;;
esac
exit 0
`;

// curl est neutralisé : aucun test ne doit dépendre du réseau, ni frapper à la
// porte de Discord.
const FAUX_CURL = '#!/usr/bin/env bash\nexit 6\n';

function atelier() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-install-'));
    const app = path.join(base, 'app');
    const bin = path.join(base, 'bin');
    fs.mkdirSync(app);
    fs.mkdirSync(bin);
    for (const f of FICHIERS) fs.copyFileSync(path.join(RACINE, f), path.join(app, f));
    fs.writeFileSync(path.join(bin, 'docker'), FAUX_DOCKER, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), FAUX_CURL, { mode: 0o755 });
    return { base, app, bin, journal: path.join(base, 'docker.log') };
}

function lancer(lieu, variables = {}, options = []) {
    const resultat = spawnSync('bash', ['./setup.sh', '--non-interactive', ...options], {
        cwd: lieu.app,
        encoding: 'utf8',
        // Environnement fermé : le .env de la machine qui exécute la suite ne
        // doit jamais changer le résultat.
        env: {
            PATH: `${lieu.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            HOME: lieu.base,
            NO_COLOR: '1',
            DOCKER_LOG: lieu.journal,
            QUASAR_SKIP_TOKEN_CHECK: '1',
            QUASAR_HEALTH_TIMEOUT: '0',
            ...variables,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
        code: resultat.status,
        sortie: `${resultat.stdout || ''}${resultat.stderr || ''}`,
        journal: fs.existsSync(lieu.journal) ? fs.readFileSync(lieu.journal, 'utf8') : '',
        env: () => lireEnv(path.join(lieu.app, '.env')),
        brut: () => fs.readFileSync(path.join(lieu.app, '.env'), 'utf8'),
    };
}

function lireEnv(fichier) {
    const valeurs = new Map();
    for (const ligne of fs.readFileSync(fichier, 'utf8').split('\n')) {
        const trouve = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(ligne);
        if (trouve) valeurs.set(trouve[1], trouve[2]);
    }
    return valeurs;
}

const CONFIG = {
    DISCORD_TOKEN: 'MTA0.jeton.factice',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'secret-client-factice',
};

test('le .env produit porte toute la configuration, et plus aucune valeur d\'exemple', () => {
    const lieu = atelier();
    const run = lancer(lieu, { ...CONFIG, PORT: '4000', BOT_OWNER_ID: '987654321098765432' });
    assert.equal(run.code, 0, run.sortie);

    const env = run.env();
    assert.equal(env.get('DISCORD_TOKEN'), CONFIG.DISCORD_TOKEN);
    assert.equal(env.get('DISCORD_CLIENT_ID'), CONFIG.DISCORD_CLIENT_ID);
    assert.equal(env.get('DISCORD_CLIENT_SECRET'), CONFIG.DISCORD_CLIENT_SECRET);
    assert.equal(env.get('BOT_OWNER_ID'), '987654321098765432');
    assert.equal(env.get('PORT'), '4000');
    // Défaut fermé : le dashboard n'écoute que sur la machine hôte tant que
    // personne n'a demandé le contraire.
    assert.equal(env.get('BIND_ADDRESS'), '127.0.0.1');
    // L'adresse de retour suit le port, sinon la connexion échoue en
    // redirect_uri_mismatch sans que rien ne le dise.
    assert.equal(env.get('CALLBACK_URL'), 'http://localhost:4000/callback');

    // Ces valeurs sont publiées sur GitHub : depuis la v4.9.0, Quasar refuse de
    // démarrer si l'une d'elles subsiste.
    for (const exemple of ['your_bot_token_here', 'your_client_id_here', 'your_client_secret_here']) {
        assert.ok(!run.brut().includes(exemple), `valeur d'exemple laissée en place : ${exemple}`);
    }
});

test('les commentaires du fichier d\'exemple survivent à la génération', () => {
    // Le .env est dérivé de .env.example ligne à ligne : ses explications (modes,
    // relais de confiance, conservation des données) sont ce qui permet de
    // configurer Quasar plus tard sans repartir du dépôt.
    const lieu = atelier();
    const run = lancer(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);

    const brut = run.brut();
    for (const repere of ['Mode de fonctionnement', 'Ouverture de l\'instance publique',
        'Exposition du dashboard', 'Conservation des données']) {
        assert.ok(brut.includes(repere), `commentaire perdu : ${repere}`);
    }
    const exemple = fs.readFileSync(path.join(RACINE, '.env.example'), 'utf8');
    assert.ok(brut.split('\n').length >= exemple.split('\n').length,
        'le .env est plus court que le fichier d\'exemple : des lignes ont disparu');
});

test('une valeur contenant « | », « & » ou des espaces ne corrompt pas le fichier', () => {
    // C'est le défaut que « sed » introduisait : « | » cassait le motif, et « & »
    // y désigne la chaîne trouvée, donc s'y recopiait tout seul. Personne ne
    // voyait rien, le .env était simplement faux.
    const lieu = atelier();
    const piege = 'a|b&c d e';
    const run = lancer(lieu, { ...CONFIG, DISCORD_CLIENT_SECRET: piege });
    assert.equal(run.code, 0, run.sortie);

    assert.equal(run.env().get('DISCORD_CLIENT_SECRET'), piege);
    assert.ok(run.brut().includes(`\nDISCORD_CLIENT_SECRET=${piege}\n`),
        'la ligne n\'est pas écrite telle quelle');
    // Le reste du fichier n'a pas bougé pour autant.
    assert.equal(run.env().get('DISCORD_TOKEN'), CONFIG.DISCORD_TOKEN);
    assert.equal(run.env().get('PORT'), '3000');
});

test('JWT_SECRET est fabriqué au hasard, et assez long pour le garde de démarrage', () => {
    // index.js refuse de démarrer sous 32 caractères : une clé courte se casse
    // hors ligne sur un jeton intercepté.
    const premier = lancer(atelier(), CONFIG);
    const second = lancer(atelier(), CONFIG);
    assert.equal(premier.code, 0, premier.sortie);
    assert.equal(second.code, 0, second.sortie);

    const a = premier.env().get('JWT_SECRET');
    const b = second.env().get('JWT_SECRET');
    assert.match(a, /^[0-9a-f]{64}$/, `clé inattendue : ${a}`);
    assert.ok(a.length >= 32);
    assert.notEqual(a, b, 'deux installations partagent la même clé de session');
});

test('JWT_SECRET fourni par l\'environnement est repris tel quel', () => {
    const lieu = atelier();
    const fourni = 'z'.repeat(48);
    const run = lancer(lieu, { ...CONFIG, JWT_SECRET: fourni });
    assert.equal(run.code, 0, run.sortie);
    assert.equal(run.env().get('JWT_SECRET'), fourni);
});

test('DOCKER_GID est écrit dans le .env et transmis à la construction', () => {
    // Le Dockerfile portait 972 en dur, et rien ne lui passait jamais autre
    // chose : le processus node n'avait donc aucun droit sur le socket Docker
    // monté, et la mise à jour depuis le dashboard échouait en permission denied.
    const lieu = atelier();
    const run = lancer(lieu, { ...CONFIG, DOCKER_GID: '990' });
    assert.equal(run.code, 0, run.sortie);

    assert.equal(run.env().get('DOCKER_GID'), '990');
    assert.ok(run.journal.includes('BUILD_ENV DOCKER_GID=990'),
        `la construction n'a pas reçu le GID :\n${run.journal}`);

    // Et le compose le passe bien en argument de construction, sans quoi la
    // valeur du .env ne servirait à rien.
    const compose = fs.readFileSync(path.join(RACINE, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /args:/);
    assert.match(compose, /DOCKER_GID:\s*\$\{DOCKER_GID:-972\}/);
});

test('le .env n\'est lisible que par la personne qui l\'installe', () => {
    // Il contient le jeton du bot et la clé de signature des sessions.
    const lieu = atelier();
    const run = lancer(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);
    const mode = fs.statSync(path.join(lieu.app, '.env')).mode & 0o777;
    assert.equal(mode & 0o077, 0, `permissions trop larges : ${mode.toString(8)}`);
});

test('un .env existant est conservé, et --reconfigure le sauvegarde avant de le refaire', () => {
    const lieu = atelier();
    const cible = path.join(lieu.app, '.env');
    fs.writeFileSync(cible, 'DISCORD_TOKEN=ancien\nJWT_SECRET=' + 'a'.repeat(40) + '\nPORT=7777\n');

    const conserve = lancer(lieu, CONFIG);
    assert.equal(conserve.code, 0, conserve.sortie);
    assert.equal(conserve.env().get('DISCORD_TOKEN'), 'ancien',
        'une configuration existante ne doit jamais être écrasée en silence');
    assert.match(conserve.sortie, /existant conservé/);

    const refait = lancer(lieu, CONFIG, ['--reconfigure']);
    assert.equal(refait.code, 0, refait.sortie);
    assert.equal(refait.env().get('DISCORD_TOKEN'), CONFIG.DISCORD_TOKEN);
    const sauvegardes = fs.readdirSync(lieu.app).filter(f => f.endsWith('.bak'));
    assert.equal(sauvegardes.length, 1, `sauvegarde absente : ${fs.readdirSync(lieu.app)}`);
    assert.match(fs.readFileSync(path.join(lieu.app, sauvegardes[0]), 'utf8'), /DISCORD_TOKEN=ancien/);
});

test('un .env existant mais incomplet est signalé avant la construction', () => {
    // Le cas du « cp .env.example .env » fait à la main : Quasar refusera de
    // démarrer, autant le dire tout de suite plutôt qu'après plusieurs minutes
    // de construction sur un Raspberry Pi.
    const lieu = atelier();
    fs.copyFileSync(path.join(RACINE, '.env.example'), path.join(lieu.app, '.env'));
    const run = lancer(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.sortie, /incomplet/);
    assert.match(run.sortie, /DISCORD_TOKEN/);
    assert.match(run.sortie, /JWT_SECRET/);
});

test('le mode non interactif ne pose aucune question', () => {
    // L'entrée standard est fermée : la moindre question ferait échouer le
    // script au lieu de le faire aboutir.
    const lieu = atelier();
    const run = lancer(lieu, { ...CONFIG, BOT_OWNER_ID: '987654321098765432', PORT: '3100' });
    assert.equal(run.code, 0, run.sortie);
    for (const question of ['Jeton du bot Discord', 'Client ID', 'Client Secret',
        'Port du dashboard', 'Votre identifiant Discord', 'Votre choix']) {
        assert.ok(!run.sortie.includes(question), `question posée malgré tout : ${question}`);
    }
    // Et chaque valeur déjà présente est annoncée comme reprise, pas redemandée.
    assert.match(run.sortie, /DISCORD_TOKEN repris de l'environnement/);
    assert.match(run.sortie, /BOT_OWNER_ID repris de l'environnement/);
});

test('le jeton n\'apparaît jamais en clair dans la sortie', () => {
    const lieu = atelier();
    const run = lancer(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);
    assert.ok(!run.sortie.includes(CONFIG.DISCORD_TOKEN), 'le jeton du bot est affiché');
    assert.ok(!run.sortie.includes(CONFIG.DISCORD_CLIENT_SECRET), 'le secret client est affiché');
});
