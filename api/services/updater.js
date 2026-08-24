// ═══════════════════════════════════
//        Quasar Auto-Update Service
// ═══════════════════════════════════

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Dépôt officiel. Il s'appelait 'venaciteam/quasar-discord' jusqu'au regroupement
// des deux dépôts Quasar : GitHub redirige l'API et les opérations git de l'ancien
// nom vers celui-ci, donc les instances installées avant le renommage continuent
// de se mettre à jour sans intervention.
const GITHUB_REPO = 'venaciteam/quasar';
const CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12h
const GITHUB_TIMEOUT = 10000; // 10s

let versionCache = null;
let updating = false;
let periodicTimer = null;
let releaseCheckFailed = false; // évite de répéter le même avertissement à chaque check

// ═══ Helpers ═══

function getLocalVersion() {
    // Pas de require() — on veut toujours la valeur fraiche du fichier
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version;
}

function isDocker() {
    return fs.existsSync('/.dockerenv');
}

function getEnvironment() {
    if (!isDocker()) return { type: 'native', ready: true };

    const hostDir = process.env.QUASAR_HOST_DIR;
    const socketOk = fs.existsSync('/var/run/docker.sock');
    const composeFile = hostDir ? fs.existsSync(path.join(hostDir, 'docker-compose.yml')) : false;

    return {
        type: 'docker',
        ready: !!(hostDir && socketOk && composeFile),
        hostDir: hostDir || null,
        socketOk,
        composeFile
    };
}

function compareVersions(a, b) {
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    }
    return 0;
}

// ═══ Version Check ═══

async function fetchLatestRelease() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT);

    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Quasar-Bot' },
            signal: controller.signal
        });

        if (!res.ok) {
            warnReleaseCheck(`GitHub a répondu ${res.status} pour ${GITHUB_REPO}`);
            return null;
        }

        releaseCheckFailed = false;

        const data = await res.json();
        return {
            version: data.tag_name?.replace(/^v/, '') || null,
            url: data.html_url,
            notes: data.body || '',
            date: data.published_at
        };
    } catch (err) {
        warnReleaseCheck(err?.message || String(err));
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// La vérification de version échoue en silence côté dashboard (pas de bandeau).
// On trace la première occurrence dans les journaux : sans ça, une instance qui
// ne voit plus les mises à jour ne donne aucun indice sur la raison.
function warnReleaseCheck(reason) {
    if (releaseCheckFailed) return;
    releaseCheckFailed = true;
    console.warn(`[Quasar] Vérification des mises à jour indisponible : ${reason}`);
}

async function checkVersion(force = false) {
    const now = Date.now();
    if (!force && versionCache && (now - versionCache.checkedAt) < CHECK_INTERVAL) {
        return versionCache;
    }

    const local = getLocalVersion();
    const release = await fetchLatestRelease();
    const remote = release?.version || null;
    const env = getEnvironment();

    versionCache = {
        local,
        remote,
        releaseUrl: release?.url || null,
        releaseNotes: release?.notes || null,
        releaseDate: release?.date || null,
        updateAvailable: remote ? compareVersions(local, remote) < 0 : false,
        environment: env.type,
        environmentReady: env.ready,
        checkedAt: now
    };

    return versionCache;
}

// ═══ Update Execution ═══

function runUpdate(onLog) {
    if (updating) {
        onLog('error', 'Une mise à jour est déjà en cours.');
        onLog('fail', 'Annulé.');
        return;
    }

    updating = true;
    const env = getEnvironment();

    if (env.type === 'docker') {
        runDockerUpdate(env, onLog);
    } else {
        runNativeUpdate(onLog);
    }
}

function spawnStep(cmd, args, options, onLog) {
    return new Promise((resolve, reject) => {
        onLog('log', `$ ${cmd} ${args.join(' ')}`);
        const proc = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stdout.on('data', chunk => {
            chunk.toString().split('\n').filter(Boolean).forEach(line => onLog('log', line));
        });

        proc.stderr.on('data', chunk => {
            chunk.toString().split('\n').filter(Boolean).forEach(line => onLog('log', line));
        });

        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code ${code}`));
        });

        proc.on('error', err => reject(err));
    });
}

async function runNativeUpdate(onLog) {
    const appDir = path.join(__dirname, '..', '..');
    let previousCommit;

    try {
        previousCommit = execSync('git rev-parse HEAD', { cwd: appDir }).toString().trim();
        onLog('status', 'Mise à jour du code source...');

        await spawnStep('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: appDir }, onLog);

        onLog('status', 'Installation des dépendances...');
        await spawnStep('npm', ['ci', '--omit=dev'], { cwd: appDir }, onLog);

        onLog('status', 'Redémarrage...');
        onLog('done', 'Mise à jour terminée. Quasar redémarre...');

        setTimeout(() => {
            updating = false;
            process.exit(0);
        }, 1500);

    } catch (err) {
        onLog('error', `Erreur : ${err.message}`);
        await rollbackGit(previousCommit, appDir, onLog);
        onLog('fail', 'Mise à jour échouée. Rollback appliqué.');
        updating = false;
    }
}

async function runDockerUpdate(env, onLog) {
    if (!env.ready) {
        onLog('error', 'Configuration Docker incomplète.');
        if (!env.hostDir) onLog('error', 'QUASAR_HOST_DIR manquant — montez le source dans docker-compose.yml');
        if (!env.socketOk) onLog('error', 'Docker socket non monté (/var/run/docker.sock)');
        if (!env.composeFile) onLog('error', 'docker-compose.yml introuvable dans le répertoire monté');
        onLog('fail', 'Impossible de lancer la mise à jour.');
        updating = false;
        return;
    }

    const hostDir = env.hostDir;
    let previousCommit;

    try {
        // 1. Sauvegarder le commit actuel pour rollback
        previousCommit = execSync('git rev-parse HEAD', { cwd: hostDir }).toString().trim();
        onLog('status', 'Mise à jour du code source...');

        // 2. Pull le code source
        await spawnStep('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: hostDir }, onLog);

        // 3. Rebuild l'image via docker compose
        onLog('status', 'Reconstruction de l\'image Docker...');
        await spawnStep('docker', ['compose', 'build', '--no-cache'], { cwd: hostDir }, onLog);

        // 4. Résoudre le chemin hôte réel du code source
        //    (hostDir = /host-app dans le container, on a besoin du chemin sur l'hôte)
        const hostPath = execSync(
            "docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/host-app\"}}{{.Source}}{{end}}{{end}}' quasar",
            { timeout: 5000 }
        ).toString().trim();

        if (!hostPath) {
            throw new Error('Impossible de déterminer le chemin hôte du code source');
        }

        // 5. Récupérer le nom de l'image (qui vient d'être rebuild)
        const quasarImage = execSync(
            "docker inspect --format '{{.Config.Image}}' quasar",
            { timeout: 5000 }
        ).toString().trim();

        onLog('status', 'Redémarrage du container...');
        onLog('done', 'Image reconstruite. Le container redémarre...');

        // 6. Lancer un container helper éphémère pour recréer le container principal.
        //    On ne peut pas faire docker compose up depuis le container qu'on veut recréer :
        //    l'arrêt du container tue le processus compose avant qu'il ne crée le nouveau.
        //    Le helper survit à l'arrêt du container quasar et termine la re-création.
        setTimeout(() => {
            updating = false;
            try { execSync('docker rm -f quasar-updater', { stdio: 'ignore' }); } catch {}

            const up = spawn('docker', [
                'run', '--rm', '-d',
                '--name', 'quasar-updater',
                '-v', '/var/run/docker.sock:/var/run/docker.sock',
                '-v', `${hostPath}:${hostPath}`,
                '-w', hostPath,
                quasarImage,
                'sh', '-c', 'sleep 2 && docker compose up -d --force-recreate'
            ], {
                stdio: 'ignore',
                detached: true
            });
            up.unref();
        }, 1500);

    } catch (err) {
        onLog('error', `Erreur : ${err.message}`);
        await rollbackGit(previousCommit, hostDir, onLog);
        onLog('fail', 'Mise à jour échouée. Rollback appliqué.');
        updating = false;
    }
}

async function rollbackGit(commitHash, dir, onLog) {
    if (!commitHash) return;
    onLog('status', 'Rollback en cours...');
    try {
        await spawnStep('git', ['reset', '--hard', commitHash], { cwd: dir }, onLog);
        onLog('log', 'Code source restauré à la version précédente.');
    } catch (rbErr) {
        onLog('error', `Erreur pendant le rollback : ${rbErr.message}`);
    }
}

// ═══ Periodic Check ═══

function startPeriodicCheck() {
    checkVersion().then(result => {
        if (result?.updateAvailable) {
            console.log(`[Quasar] Mise à jour disponible : v${result.local} → v${result.remote}`);
        }
    }).catch(() => {});

    periodicTimer = setInterval(() => {
        checkVersion(true).catch(() => {});
    }, CHECK_INTERVAL);
}

function isUpdating() {
    return updating;
}

module.exports = { checkVersion, runUpdate, startPeriodicCheck, isUpdating, getEnvironment, getLocalVersion };
