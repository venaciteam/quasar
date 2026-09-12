// L'installateur, exécuté pour de vrai — le parcours complet.
//
// Le compagnon de install-env.test.js : celui-ci ne regarde pas le fichier
// produit mais l'enchaînement, y compris le chemin d'entrée du README —
// « curl … | bash », c'est-à-dire un script lu sur l'entrée standard. C'est très
// exactement ce chemin qui était cassé : les questions de setup.sh lisaient une
// entrée déjà à EOF, « read » rendait 1, et « set -e » sortait sans un mot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RACINE = path.join(__dirname, '..');
const FICHIERS = ['setup.sh', '.env.example', 'docker-compose.yml', 'Dockerfile'];

const FAUX_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  if [ "\${FAUX_COMPOSE_ABSENT:-0}" = "1" ]; then exit 1; fi
  echo "Docker Compose version v2.30.0"; exit 0
fi
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
      build) exit 0 ;;
      up) exit 0 ;;
    esac ;;
esac
exit 0
`;

// Faux git : il note ce qu'on lui demande, et « clone » en recopiant le dépôt.
const FAUX_GIT = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  clone)
    mkdir -p "$3/.git"
    for f in ${FICHIERS.join(' ')}; do cp "$DEPOT_SOURCE/$f" "$3/"; done
    exit 0 ;;
  describe) printf 'v4.0.0\\n'; exit 0 ;;
  rev-parse) exit 0 ;;
esac
exit 0
`;

// Faux curl : il répond à l'API GitHub, et échoue partout ailleurs. Aucun test
// ne touche au réseau.
const FAUX_CURL = `#!/usr/bin/env bash
if [ "\${CURL_HORS_LIGNE:-0}" = "1" ]; then exit 6; fi
for argument in "$@"; do
  case "$argument" in
    *api.github.com*) printf '{"html_url":"x","tag_name":"v9.9.9","name":"v9.9.9"}\\n'; exit 0 ;;
  esac
done
exit 6
`;

function atelier({ avecGit = false } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-flux-'));
    const app = path.join(base, 'app');
    const bin = path.join(base, 'bin');
    const travail = path.join(base, 'travail');
    fs.mkdirSync(app);
    fs.mkdirSync(bin);
    fs.mkdirSync(travail);
    for (const f of FICHIERS) fs.copyFileSync(path.join(RACINE, f), path.join(app, f));
    fs.writeFileSync(path.join(bin, 'docker'), FAUX_DOCKER, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), FAUX_CURL, { mode: 0o755 });
    if (avecGit) fs.writeFileSync(path.join(bin, 'git'), FAUX_GIT, { mode: 0o755 });
    return {
        base, app, bin, travail,
        journalDocker: path.join(base, 'docker.log'),
        journalGit: path.join(base, 'git.log'),
    };
}

function environnement(lieu, variables) {
    return {
        PATH: `${lieu.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: lieu.base,
        NO_COLOR: '1',
        DOCKER_LOG: lieu.journalDocker,
        GIT_LOG: lieu.journalGit,
        DEPOT_SOURCE: RACINE,
        QUASAR_SKIP_TOKEN_CHECK: '1',
        QUASAR_HEALTH_TIMEOUT: '0',
        ...variables,
    };
}

function lancerSetup(lieu, variables = {}, options = ['--non-interactive']) {
    const resultat = spawnSync('bash', ['./setup.sh', ...options], {
        cwd: lieu.app,
        encoding: 'utf8',
        env: environnement(lieu, variables),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return lire(resultat, lieu);
}

// Le chemin du README, à la lettre : le script est lu sur l'entrée standard.
function lancerInstallParTube(lieu, variables = {}, options = ['--non-interactive']) {
    const commande = `cat "${path.join(RACINE, 'install.sh')}" | bash -s -- ${options.join(' ')}`;
    const resultat = spawnSync('bash', ['-c', commande], {
        cwd: lieu.travail,
        encoding: 'utf8',
        env: environnement(lieu, variables),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return lire(resultat, lieu);
}

function lire(resultat, lieu) {
    const journal = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
    return {
        code: resultat.status,
        sortie: `${resultat.stdout || ''}${resultat.stderr || ''}`,
        docker: journal(lieu.journalDocker),
        git: journal(lieu.journalGit),
    };
}

const CONFIG = {
    DISCORD_TOKEN: 'MTA0.jeton.factice',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'secret-client-factice',
    // Le tube n'a pas de terminal à offrir : sans cette déclaration, setup.sh
    // irait chercher /dev/tty et attendrait une frappe qui ne viendra pas.
    QUASAR_NONINTERACTIVE: '1',
};

// Le même parcours sur l'autre plateforme. Depuis la v5.0.0, QUASAR_PLATFORM
// décide de tout ce qui est demandé, vérifié et affiché.
const CONFIG_FLUXER = {
    QUASAR_PLATFORM: 'fluxer',
    FLUXER_TOKEN: '987654321098765432.jeton-factice',
    FLUXER_CLIENT_ID: '987654321098765432',
    FLUXER_CLIENT_SECRET: 'secret-client-factice-fluxer',
    QUASAR_NONINTERACTIVE: '1',
};

// ── Le tube du README ────────────────────────────────────────────────────────

test('« curl … | bash » va jusqu\'au bout et produit un .env', () => {
    // La régression à ne plus jamais réintroduire : ce chemin s'arrêtait sur
    // « 📝 Configuration du bot » et rendait la main, sans fichier, sans
    // conteneur et sans message.
    const lieu = atelier({ avecGit: true });
    const run = lancerInstallParTube(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);

    const produit = path.join(lieu.travail, 'quasar', '.env');
    assert.ok(fs.existsSync(produit), `aucun .env produit :\n${run.sortie}`);
    assert.match(fs.readFileSync(produit, 'utf8'), /DISCORD_TOKEN=MTA0\.jeton\.factice/);
    assert.match(run.docker, /compose up -d/);
});

test('l\'installation prend la dernière version publiée, et --dev prend main', () => {
    // Installer « main » revient à installer ce qui a été poussé cinq minutes
    // plus tôt : deux personnes qui installent le même jour n'obtiennent pas le
    // même code.
    const versionne = atelier({ avecGit: true });
    const run = lancerInstallParTube(versionne, CONFIG);
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.git, /checkout -B main refs\/tags\/v9\.9\.9/);
    assert.match(run.sortie, /v9\.9\.9/);

    const dev = atelier({ avecGit: true });
    const runDev = lancerInstallParTube(dev, CONFIG, ['--dev', '--non-interactive']);
    assert.equal(runDev.code, 0, runDev.sortie);
    assert.ok(!/refs\/tags\//.test(runDev.git), `--dev a posé une étiquette :\n${runDev.git}`);
});

test('l\'API GitHub injoignable ne fait jamais échouer l\'installation', () => {
    // Repli sur la dernière étiquette du dépôt cloné. Une panne d'API n'a pas à
    // empêcher qui que ce soit d'installer Quasar.
    const lieu = atelier({ avecGit: true });
    const run = lancerInstallParTube(lieu, { ...CONFIG, CURL_HORS_LIGNE: '1' });
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.git, /describe --tags --abbrev=0/);
    assert.match(run.git, /checkout -B main refs\/tags\/v4\.0\.0/);
});

test('une installation existante est mise à jour sans fusion inattendue', () => {
    // « git pull » tout court fabriquait un commit de fusion sur une copie qui a
    // divergé, sans que personne ne l'ait demandé. La mise à jour est donc
    // strictement une avance rapide, et le dépôt n'est jamais cloné deux fois.
    const lieu = atelier({ avecGit: true });
    assert.equal(lancerInstallParTube(lieu, CONFIG).code, 0);
    fs.writeFileSync(lieu.journalGit, '');

    const seconde = lancerInstallParTube(lieu, CONFIG);
    assert.equal(seconde.code, 0, seconde.sortie);
    assert.match(seconde.git, /fetch --tags --prune origin/);
    assert.match(seconde.git, /merge --ff-only refs\/tags\/v9\.9\.9/);
    assert.ok(!/^clone/m.test(seconde.git), `le dépôt a été cloné une seconde fois :\n${seconde.git}`);
});

// ── Prérequis ────────────────────────────────────────────────────────────────

test('les prérequis manquants sont annoncés AVANT le téléchargement', () => {
    // Rien n'est plus décourageant que de cloner un dépôt pour apprendre
    // ensuite qu'il manque le greffon compose.
    const lieu = atelier({ avecGit: true });
    const run = lancerInstallParTube(lieu, { ...CONFIG, FAUX_COMPOSE_ABSENT: '1' });
    assert.equal(run.code, 1);
    assert.match(run.sortie, /Docker Compose/);
    assert.match(run.sortie, /docker-compose-plugin/);
    assert.ok(!/clone/.test(run.git), 'le dépôt a été cloné malgré un prérequis manquant');
});

test('sans git ni docker, le message dit quoi installer sur chaque système', () => {
    const lieu = atelier();
    fs.unlinkSync(path.join(lieu.bin, 'docker'));
    // bash et cat sont appelés par leur chemin absolu : le PATH donné au script
    // ne contient délibérément ni git ni docker.
    const resultat = spawnSync('/bin/bash',
        ['-c', `/bin/cat "${path.join(RACINE, 'install.sh')}" | /bin/bash`], {
            cwd: lieu.travail,
            encoding: 'utf8',
            env: { ...environnement(lieu, {}), PATH: lieu.bin },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    const sortie = `${resultat.stdout}${resultat.stderr}`;
    assert.equal(resultat.status, 1, sortie);
    assert.match(sortie, /Git n'est pas installé/);
    assert.match(sortie, /apt install git/);
    assert.match(sortie, /macOS/);
    assert.match(sortie, /Docker n'est pas installé/);
    assert.match(sortie, /get\.docker\.com/);
});

// ── Absence de terminal ──────────────────────────────────────────────────────

test('sans terminal et sans configuration, le refus explique quoi faire', () => {
    // L'échec muet est le pire des résultats : le message doit nommer ce qui
    // manque et donner la sortie de secours.
    const lieu = atelier();
    const run = lancerSetup(lieu, { QUASAR_NONINTERACTIVE: '1' }, []);
    assert.equal(run.code, 1, run.sortie);
    assert.match(run.sortie, /Aucun terminal disponible/);
    for (const variable of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) {
        assert.ok(run.sortie.includes(variable), `variable manquante non nommée : ${variable}`);
    }
    assert.match(run.sortie, /--non-interactive/);
    assert.match(run.sortie, /--help/);
    // Et rien n'a été construit ni démarré au passage.
    assert.ok(!/compose build/.test(run.docker), 'une image a été construite malgré tout');
});

// ── Enchaînement ─────────────────────────────────────────────────────────────

test('le volume, la construction et le démarrage s\'enchaînent dans cet ordre', () => {
    const lieu = atelier();
    const run = lancerSetup(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);

    const lignes = run.docker.split('\n');
    const rang = motif => lignes.findIndex(l => l.startsWith(motif));
    assert.ok(rang('volume create quasar-data') >= 0, run.docker);
    assert.ok(rang('compose build') > rang('volume create quasar-data'), run.docker);
    assert.ok(rang('compose up -d') > rang('compose build'), run.docker);
});

test('le lien d\'invitation est proposé AVANT le démarrage du conteneur', () => {
    // Les commandes slash sont déployées sur les serveurs présents dans le cache
    // au moment de la connexion : un bot invité après coup n'en a aucune.
    const lieu = atelier();
    const run = lancerSetup(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);

    const invitation = run.sortie.indexOf('discord.com/oauth2/authorize');
    const demarrage = run.sortie.indexOf('Démarrage de Quasar');
    assert.ok(invitation >= 0, 'aucun lien d\'invitation affiché');
    assert.ok(demarrage >= 0);
    assert.ok(invitation < demarrage, 'le bot est invité après le démarrage');
    assert.match(run.sortie, /client_id=123456789012345678/);
    assert.match(run.sortie, /scope=bot\+applications\.commands/);
});

test('un conteneur qui refuse de démarrer fait remonter les journaux tels quels', () => {
    // Depuis la v4.9.0, Quasar liste lui-même les variables manquantes avec
    // leur symptôme. Ce message est écrit pour être lu : il est recopié, pas
    // résumé en « ça n'a pas marché ».
    const lieu = atelier();
    const refus = [
        '[Quasar] ❌ Configuration incomplète : je ne peux pas démarrer en mode « bot ».',
        '[Quasar]   • JWT_SECRET — absente ou vide. Elle signe les sessions du dashboard.',
    ].join('\n');
    const run = lancerSetup(lieu, { ...CONFIG, FAKE_ETAT: 'exited', FAKE_LOGS: refus });

    assert.equal(run.code, 1, run.sortie);
    assert.match(run.sortie, /Configuration incomplète/);
    assert.match(run.sortie, /JWT_SECRET — absente ou vide/);
    assert.match(run.sortie, /docker compose up -d/);
    assert.match(run.docker, /logs --tail 40 quasar/);
});

test('la vérification finale confirme le conteneur et la connexion à Discord', () => {
    const lieu = atelier();
    const run = lancerSetup(lieu, CONFIG);
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.sortie, /Conteneur démarré/);
    assert.match(run.sortie, /QuasarTest#4242/);
    assert.match(run.docker, /inspect --format \{\{\.State\.Status\}\} quasar/);
});

test('le récapitulatif donne une adresse joignable, pas « localhost » par principe', () => {
    // Sur un Raspberry Pi installé en SSH, « http://localhost:3000 » ouvert
    // depuis le portable ne mène nulle part : c'est l'échec de première
    // installation le plus probable.
    const ouvert = atelier();
    const runOuvert = lancerSetup(ouvert, {
        ...CONFIG, BIND_ADDRESS: '0.0.0.0',
        SSH_CONNECTION: '10.0.0.5 51000 192.168.1.42 22',
    });
    assert.equal(runOuvert.code, 0, runOuvert.sortie);
    assert.match(runOuvert.sortie, /Dashboard : http:\/\/192\.168\.1\.42:3000/);

    // Resté fermé, il propose le tunnel SSH plutôt qu'une adresse inutilisable.
    const ferme = atelier();
    const runFerme = lancerSetup(ferme, {
        ...CONFIG, SSH_CONNECTION: '10.0.0.5 51000 192.168.1.42 22',
    });
    assert.equal(runFerme.code, 0, runFerme.sortie);
    assert.match(runFerme.sortie, /ssh -L 3000:localhost:3000/);
});

test('l\'adresse de retour OAuth2 est rappelée avec ce qu\'il faut en faire', () => {
    const lieu = atelier();
    const run = lancerSetup(lieu, { ...CONFIG, PORT: '3200' });
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.sortie, /Redirects/);
    assert.match(run.sortie, /http:\/\/localhost:3200\/callback/);
});

// ── Le même enchaînement, sur Fluxer ─────────────────────────────────────────

test('« curl … | bash » installe aussi un bot Fluxer', () => {
    const lieu = atelier({ avecGit: true });
    const run = lancerInstallParTube(lieu, CONFIG_FLUXER);
    assert.equal(run.code, 0, run.sortie);

    const produit = path.join(lieu.travail, 'quasar', '.env');
    assert.ok(fs.existsSync(produit), `aucun .env produit :\n${run.sortie}`);
    const contenu = fs.readFileSync(produit, 'utf8');
    assert.match(contenu, /^QUASAR_PLATFORM=fluxer$/m);
    assert.match(contenu, /^FLUXER_TOKEN=987654321098765432\.jeton-factice$/m);
    assert.match(run.docker, /compose up -d/);
    // Et rien de Discord ne s'est glissé dans le parcours.
    assert.ok(!/discord\.com/.test(run.sortie), `Discord est cité sur un parcours Fluxer :\n${run.sortie}`);
});

test('le lien d\'invitation Fluxer ne demande que le scope bot', () => {
    // `applications.commands` n'existe PAS au registre de scopes de Fluxer, et un
    // scope inconnu fait rejeter toute la demande d'autorisation : le lien serait
    // mort. api/routes/auth.js déclare donc `scopesBot: 'bot'` de ce côté, et
    // l'installateur doit dire la même chose.
    const lieu = atelier();
    const run = lancerSetup(lieu, CONFIG_FLUXER);
    assert.equal(run.code, 0, run.sortie);

    const invitation = run.sortie.indexOf('/oauth2/authorize');
    const demarrage = run.sortie.indexOf('Démarrage de Quasar');
    assert.ok(invitation >= 0, 'aucun lien d\'invitation affiché');
    assert.ok(invitation < demarrage, 'le bot est invité après le démarrage');
    assert.match(run.sortie, /https:\/\/api\.fluxer\.app\/v1\/oauth2\/authorize/);
    assert.match(run.sortie, /client_id=987654321098765432/);
    assert.match(run.sortie, /scope=bot/);
    assert.ok(!/applications\.commands/.test(run.sortie),
        'un scope inconnu de Fluxer est demandé : la demande d\'autorisation serait rejetée');
});

test('le récapitulatif Fluxer dit où déclarer l\'adresse de retour, et par quoi commencer', () => {
    // Le chemin /callback est le même sur les deux plateformes ; l'endroit où le
    // déclarer, non. Et une personne qui tape « /help » sur Fluxer conclut que le
    // bot est muet : le récapitulatif donne la commande qui répond.
    const lieu = atelier();
    const run = lancerSetup(lieu, { ...CONFIG_FLUXER, PORT: '3300' });
    assert.equal(run.code, 0, run.sortie);
    assert.match(run.sortie, /Plateforme: Fluxer/);
    assert.match(run.sortie, /Redirect URIs/);
    assert.ok(!/Developer Portal/.test(run.sortie),
        'le Developer Portal de Discord est cité sur un parcours Fluxer');
    assert.match(run.sortie, /http:\/\/localhost:3300\/callback/);
    assert.match(run.sortie, /!help/);
});

test('sans terminal, le refus nomme les variables de Fluxer et la bonne commande', () => {
    const lieu = atelier();
    const run = lancerSetup(lieu, { QUASAR_PLATFORM: 'fluxer', QUASAR_NONINTERACTIVE: '1' }, []);
    assert.equal(run.code, 1, run.sortie);
    assert.match(run.sortie, /Aucun terminal disponible/);
    for (const variable of ['FLUXER_TOKEN', 'FLUXER_CLIENT_ID', 'FLUXER_CLIENT_SECRET']) {
        assert.ok(run.sortie.includes(variable), `variable manquante non nommée : ${variable}`);
    }
    assert.match(run.sortie, /QUASAR_PLATFORM=fluxer FLUXER_TOKEN=/);
    assert.ok(!run.sortie.includes('DISCORD_TOKEN'),
        'la sortie de secours réclame un jeton Discord pour une installation Fluxer');
    assert.ok(!/compose build/.test(run.docker), 'une image a été construite malgré tout');
});

test('la question de la plateforme précède toute demande de jeton', () => {
    // Ce que ce test prouve : l'ordre des questions dans le SOURCE. Le parcours
    // interactif lui-même réclame un terminal, que la suite ne peut pas offrir —
    // il se déroule à la main avant chaque release. Ce qu'il attrape quand même
    // est la régression la plus probable : une question de jeton remontée avant
    // celle de la plateforme, qui demanderait un jeton Discord à tout le monde
    // puis l'écarterait en silence.
    const source = fs.readFileSync(path.join(RACINE, 'setup.sh'), 'utf8');
    const plateforme = source.indexOf('Sur quelle plateforme ce bot va-t-il tourner ?');
    const jetonDiscord = source.indexOf('"Jeton du bot Discord"');
    const jetonFluxer = source.indexOf('"Jeton du bot Fluxer"');

    assert.ok(plateforme > 0, 'la question de la plateforme a disparu de setup.sh');
    assert.ok(jetonDiscord > 0 && jetonFluxer > 0, 'une des deux questions de jeton a disparu');
    assert.ok(plateforme < jetonDiscord && plateforme < jetonFluxer,
        'la plateforme est demandée après un jeton : l\'ordre est inversé');
});
