// Garde-fou de copy — les règles éditoriales Venacity, version exécutable.
//
// Le correctif de vouvoiement de la v4.7.0 (35070ab) avait nettoyé les pronoms
// mais laissé passer 13 impératifs à la 2e personne du singulier, dont trois
// phrases mélangeant tu et vous. Ce test rend la récidive impossible.
//
// Trois niveaux de détection, calibrés sur le dépôt réel :
//  1. enclitiques 2sg (« ferme-le », « crée-en ») — fiables, quasi sans faux
//     positifs (les formes vouvoyées finissent en -z, exclues par la regex) ;
//  2. « d'Quasar » — l'élision fautive devant consonne ;
//  3. pronoms tu/toi/ton/ta/tes — UNIQUEMENT dans les fichiers de prose
//     (public/*.html, content/*.md) : en JS, les commentaires et les noms de
//     variables (`const ta = …`) rendraient le contrôle inexploitable.
// La détection générique des impératifs sans enclitique (« Active le mode »)
// est volontairement absente : les homographes de 3e personne (« Envoie un
// embed » en JSDoc, « j'utilise le salon » en copy) la condamnent au bruit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Zones où vit de la copy visible par l'utilisateur.
const SCAN_DIRS = ['bot', 'api', 'dashboard/js', 'public', 'content'];
const SCAN_FILES = ['index.js', 'install.sh', 'setup.sh'];
const PROSE_EXT = new Set(['.html', '.md']);
const CODE_EXT = new Set(['.js', '.sh']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
        } else {
            yield path.join(dir, entry.name);
        }
    }
}

function collectFiles() {
    const files = [];
    for (const d of SCAN_DIRS) {
        const abs = path.join(ROOT, d);
        if (!fs.existsSync(abs)) continue;
        for (const f of walk(abs)) {
            const ext = path.extname(f);
            if (PROSE_EXT.has(ext) || CODE_EXT.has(ext)) files.push(f);
        }
    }
    for (const f of SCAN_FILES) {
        const abs = path.join(ROOT, f);
        if (fs.existsSync(abs)) files.push(abs);
    }
    return files;
}

function findMatches(files, regex, { proseOnly = false } = {}) {
    const hits = [];
    for (const file of files) {
        if (proseOnly && !PROSE_EXT.has(path.extname(file))) continue;
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
            const m = line.match(regex);
            if (m) hits.push(`${path.relative(ROOT, file)}:${i + 1} → ${m[0]} (${line.trim().slice(0, 80)})`);
        });
    }
    return hits;
}

const FILES = collectFiles();

test('aucun enclitique de tutoiement (« ferme-le », « crée-en », « accorde-moi »)', () => {
    // Le mot avant le tiret ne finit pas par z : « fermez-le » (vouvoiement)
    // est exclu, « ferme-le » est pris. Le suffixe -y est exclu (overflow-y).
    const regex = /\b[A-Za-zÀ-ÿ]*[a-yà-ÿ]-(le|la|les|en|moi|toi)\b/;
    const hits = findMatches(FILES, regex);
    assert.deepEqual(hits, [], `Tutoiement par enclitique :\n${hits.join('\n')}`);
});

test('aucune élision fautive « d\'Quasar »', () => {
    const hits = findMatches(FILES, /d'Quasar/);
    assert.deepEqual(hits, [], `« d'Quasar » (dire « de Quasar ») :\n${hits.join('\n')}`);
});

test('aucun pronom de tutoiement dans la prose publique', () => {
    // Pas de \b : en JS il est ASCII et voit une frontière après « ê »
    // (« requêtes » matcherait « tes », « bêta » matcherait « ta »).
    const regex = /(?<![A-Za-zÀ-ÿ'’-])([Tt]u|[Tt]oi|[Tt]on|[Tt]a|[Tt]es)(?![A-Za-zÀ-ÿ'’-])/;
    const hits = findMatches(FILES, regex, { proseOnly: true });
    assert.deepEqual(hits, [], `Tutoiement dans la prose :\n${hits.join('\n')}`);
});

test('« don » proscrit dans la prose publique — dire « soutien »', () => {
    // Mot entier, frontières unicode ; la citation « don » entre guillemets
    // français est tolérée (c'est ainsi que la charte énonce la règle).
    const regex = /(?<![A-Za-zÀ-ÿ-])(?<!« )[Dd]ons?(?! »)(?![A-Za-zÀ-ÿ-])/;
    const hits = findMatches(FILES, regex, { proseOnly: true });
    assert.deepEqual(hits, [], `Vocabulaire du don :\n${hits.join('\n')}`);
});
