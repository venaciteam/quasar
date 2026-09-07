// Garde-fou anti-XSS du dashboard.
//
// Modèle de menace : le jeton de session vit dans localStorage et voyage en
// en-tête Authorization. Il n'y a donc pas de CSRF possible… mais aucun cookie
// HttpOnly à opposer à un XSS, aucune CSP, et un jeton valable 7 jours sans
// révocation. La moindre balise injectée dans une page du dashboard vaut donc
// une session d'administrateur·ice volée.
//
// Deux niveaux de contrôle :
//  1. l'échappement lui-même, exécuté pour de vrai — dashboard/js/utils.js est
//     chargé dans un bac à sable SANS `document`, ce qui prouve au passage qu'il
//     n'échappe plus par sérialisation `textContent` → `innerHTML` ;
//  2. des relevés statiques sur le code source, dans l'esprit de copy.test.js,
//     pour les régressions qu'un test unitaire ne peut pas voir : réapparition
//     d'une implémentation faible, données rendues brutes dans un attribut,
//     objet sérialisé dans un gestionnaire d'événement en ligne.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'dashboard', 'js');

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.js')) out.push(p);
    }
    return out;
}

const FILES = walk(JS_DIR);
const rel = f => path.relative(ROOT, f);

// Exceptions documentées, pas oubliées.
//
// vnct-common.js est la brique commune du design system VNCT, partagée avec les
// autres services : elle porte encore un `_escapeHtml` par sérialisation
// `textContent` → `innerHTML`. Il n'y sert QUE des contextes texte (titre et
// corps d'une modale, entre <h3> et <p>), où le procédé suffit — et le fichier
// se corrige en amont, pas ici. À retirer de cette liste le jour où l'amont est
// aligné.
const ESCAPE_FAIBLE_TOLERE = new Set(['dashboard/js/vnct-common.js']);

// `JSON.stringify` dans un gestionnaire en ligne : toléré pour cette constante
// locale de nombres (les raccourcis de jours de la semaine), qui ne vient
// d'aucune API et ne peut produire ni guillemet ni esperluette.
const JSON_INLINE_TOLERE = /JSON\.stringify\(p\.days\)/;

// ── 1. L'échappement, exécuté ────────────────────────────────────────────────

// utils.js est un script de navigateur : il est évalué dans un contexte qui ne
// fournit QUE `window`. Pas de `document` : une implémentation qui repasserait
// par un <div> jetable planterait ici au premier appel.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(JS_DIR, 'utils.js'), 'utf8'), sandbox, { filename: 'utils.js' });
const { escapeHtml, renderEmoji } = sandbox.window;

test('escapeHtml neutralise les cinq caractères qui comptent', () => {
    assert.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;');
    // Les guillemets sont l'enjeu : c'est ce que les implémentations faibles
    // laissaient passer, et donc toute la sortie de contexte d'attribut.
    assert.equal(escapeHtml('a" onmouseover="alert(1)'), 'a&quot; onmouseover=&quot;alert(1)');
    assert.equal(escapeHtml("a' onmouseover='alert(1)"), 'a&#39; onmouseover=&#39;alert(1)');
    assert.equal(escapeHtml('R&D'), 'R&amp;D');
});

test('escapeHtml : rien à afficher pour null et undefined, un nombre reste un nombre', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
    assert.equal(escapeHtml(12), '12');
});

test('renderEmoji rend une image pour un emoji custom', () => {
    const html = renderEmoji('<:chat:123456789012345678>');
    assert.match(html, /^<img src="https:\/\/cdn\.discordapp\.com\/emojis\/123456789012345678\.png"/);
    assert.match(renderEmoji('<a:chat:123456789012345678>'), /\.gif"/);
});

test('renderEmoji échappe tout ce qui n\'est pas un emoji custom', () => {
    // Le champ « emoji » d'un panel n'est validé nulle part côté serveur et son
    // rendu part dans innerHTML : la valeur de repli était renvoyée telle quelle.
    const html = renderEmoji('<img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<img/);
    assert.equal(html, '&lt;img src=x onerror=alert(1)&gt;');
    // Un vrai emoji Unicode traverse sans dommage.
    assert.equal(renderEmoji('🎉'), '🎉');
});

// ── 2. Relevés statiques ─────────────────────────────────────────────────────

test('aucune implémentation faible d\'escapeHtml dans le dashboard', () => {
    // Le procédé interdit : `div.textContent = str; return div.innerHTML`.
    // Il n'échappe ni `"` ni `'` — inoffensif en contexte texte, ouvert en grand
    // en contexte d'attribut.
    const hits = [];
    for (const file of FILES) {
        const contenu = fs.readFileSync(file, 'utf8');
        if (ESCAPE_FAIBLE_TOLERE.has(rel(file))) continue;
        if (/\.textContent\s*=[^\n]*\n\s*return\s+\w+\.innerHTML/.test(contenu)) hits.push(rel(file));
    }
    assert.deepEqual(hits, [], `Échappement par sérialisation textContent → innerHTML :\n${hits.join('\n')}`);
});

test('toute fonction d\'échappement du dashboard couvre les cinq caractères', () => {
    // Y compris les copies volontairement locales (contractGate.js vit dans sa
    // propre fermeture) : si elle existe, elle doit être robuste.
    const hits = [];
    for (const file of FILES) {
        const contenu = fs.readFileSync(file, 'utf8');
        const re = /function\s+_?escapeHtml\s*\([^)]*\)\s*\{/g;
        let m;
        while ((m = re.exec(contenu)) !== null) {
            const corps = contenu.slice(m.index, m.index + 400);
            if (!corps.includes('[&<>"\']')) hits.push(`${rel(file)} → ${m[0]}`);
        }
    }
    assert.deepEqual(hits, [], `Échappement incomplet :\n${hits.join('\n')}`);
});

test('une seule implémentation globale d\'escapeHtml, dans utils.js', () => {
    // La sécurité ne doit plus dépendre de l'ordre des balises <script> de
    // app.html : deux versions concurrentes, c'est la dernière chargée qui gagne.
    const publications = FILES.filter(f => /window\.escapeHtml\s*=/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(publications.map(rel), ['dashboard/js/utils.js']);

    // Les définitions au niveau supérieur d'un fichier (celles qui créent un
    // global) : une seule, celle de utils.js.
    const globales = FILES.filter(f => /^function\s+_?escapeHtml\s*\(/m.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(globales.map(rel), ['dashboard/js/utils.js']);
});

test('aucun objet sérialisé dans un gestionnaire d\'événement en ligne', () => {
    // `JSON.stringify(e).replace(/"/g, '&quot;')` dans un onclick : l'esperluette
    // n'étant pas échappée, un `&quot;` présent dans la donnée était décodé par
    // le parseur HTML, refermait la chaîne et devenait du JavaScript. Le motif
    // correct est celui de js/pages/owner.js — attributs data-* + écouteur.
    const hits = [];
    for (const file of FILES) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((ligne, i) => {
            if (/on[a-z]+="[^"]*JSON\.stringify/.test(ligne) && !JSON_INLINE_TOLERE.test(ligne)) {
                hits.push(`${rel(file)}:${i + 1}`);
            }
        });
    }
    assert.deepEqual(hits, [], `JSON sérialisé dans un attribut d'événement :\n${hits.join('\n')}`);
});

test('noms et identifiants Discord échappés dans les attributs et les <option>', () => {
    // Le mode d'insertion « in select » neutralise la plupart des balises, sauf
    // `</select>` — un rôle nommé `</select><img src=x onerror=…>` tient
    // largement dans les 100 caractères autorisés par Discord.
    const hits = [];
    for (const file of FILES) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((ligne, i) => {
            const cibles = ligne.match(/\$\{[^}]*\.(name|id)\b[^}]*\}/g) || [];
            const enContexte = /<option|value="|data-[a-z-]+="/.test(ligne);
            for (const cible of cibles) {
                // Les ternaires qui ne rendent qu'un littéral ('selected',
                // 'checked'…) ne peuvent rien injecter : la donnée n'est que
                // comparée, jamais écrite.
                if (/\?[^}]*'/.test(cible)) continue;
                if (enContexte && !cible.includes('escapeHtml(')) {
                    hits.push(`${rel(file)}:${i + 1} → ${cible}`);
                }
            }
        });
    }
    assert.deepEqual(hits, [], `Donnée Discord brute dans un attribut :\n${hits.join('\n')}`);
});

test('la page Modération n\'injecte plus le motif d\'une sanction brut', () => {
    // Le motif d'un `/warn` est du texte libre écrit par n'importe quel
    // modérateur (permission ModerateMembers), stocké tel quel, puis relu dans
    // le DOM d'une administratrice : c'était un XSS stocké complet.
    const contenu = fs.readFileSync(path.join(JS_DIR, 'pages', 'moderation.js'), 'utf8');
    const bruts = contenu.match(/\$\{s\.(reason|user_id|duration|id)\s*(\|\|[^}?]*)?\}/g) || [];
    assert.deepEqual(bruts, [], `Champs de sanction rendus bruts : ${bruts.join(', ')}`);
    assert.ok(contenu.includes('escapeHtml(s.reason'), 'le motif doit passer par escapeHtml');
});
