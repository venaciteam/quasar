// ═══════════════════════════════════════════════════════════════
//  Partials de la vitrine — mini-moteur d'inclusion
//
//  La vitrine est en HTML statique (pas de moteur de template : Quasar est un
//  bot Discord auto-hébergeable, on ne lui ajoute pas EJS pour cinq pages). Mais
//  depuis le passage au chrome standard DS v2, le header et le menu « … »
//  représentent ~90 lignes de markup identique sur CHAQUE page vitrine — dont
//  les liens légaux, qui portent une obligation légale et ne doivent jamais
//  diverger d'une page à l'autre.
//
//  D'où ce moteur volontairement minuscule : il ne fait que trois choses, et
//  n'a pas vocation à en faire une quatrième. Si un jour il en faut plus, c'est
//  le signal qu'il faut un vrai moteur de template, pas rallonger celui-ci.
//
//    1. Inclusion       {{> nom}}                   -> public/partials/nom.html
//    2. Variable        {{ctx}}                     -> valeur, échappée HTML
//    3. Condition       {{#if:x}}A{{else}}B{{/if:x}} -> A si x est vrai, sinon B
//                       ({{else}} facultatif)
//
//  Les inclusions sont récursives (header inclut menu) avec une profondeur
//  bornée : un partial qui s'inclurait lui-même boucle à l'infini sinon.
//
//  Sécurité : les partials sont des fichiers du repo, jamais du contenu
//  utilisateur — leur HTML est donc injecté tel quel. En revanche les VALEURS
//  des variables sont échappées : elles viennent des pages (littéraux
//  aujourd'hui), et rien ne garantit qu'elles le resteront.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const PARTIALS_DIR = path.join(__dirname, '..', '..', 'public', 'partials');

// Profondeur d'inclusion maximale. 4 est très large pour un chrome à deux
// niveaux (page -> header -> menu) : c'est un garde-fou contre la récursion
// infinie, pas une limite de conception.
const MAX_DEPTH = 4;

// Contenu brut des partials, lu une fois pour la vie du process (comme
// assetVersion) : les fichiers ne changent pas sans redéploiement.
const rawCache = new Map();

const INCLUDE = /\{\{>\s*([a-z0-9_-]+)\s*\}\}/gi;
// Conditions : {{#if:nom}} ... {{else}} ... {{/if:nom}}. Le nom est répété dans
// la balise fermante pour que deux conditions imbriquées ne se confondent pas.
const CONDITION = /\{\{#if:([a-z0-9_-]+)\}\}([\s\S]*?)\{\{\/if:\1\}\}/gi;
const VARIABLE = /\{\{([a-z0-9_-]+)\}\}/gi;

// Données de la passe de rendu en cours, lues par applyConditions (le
// callback de replace ne reçoit pas le contexte). Le rendu est synchrone de
// bout en bout : aucune requête ne peut s'intercaler entre l'assignation et
// la lecture.
let conditionData = {};

const SPLIT_ELSE = /\{\{else\}\}/;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Lit un partial. Un partial introuvable rend une chaîne vide (jamais d'exception). */
function readPartial(name) {
    if (rawCache.has(name)) return rawCache.get(name);

    const filePath = path.join(PARTIALS_DIR, `${name}.html`);
    // Le nom vient du gabarit (fichier du repo), pas d'une requête, mais la
    // vérification coûte une ligne et ferme définitivement la traversée.
    if (!filePath.startsWith(PARTIALS_DIR + path.sep)) return '';

    let content = '';
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error(`[Quasar] Partial « ${name} » illisible :`, err.message);
    }
    rawCache.set(name, content);
    return content;
}

/**
 * Résout les conditions d'un fragment, y compris IMBRIQUÉES.
 *
 * Le remplacement se fait par passes successives : `replace` ne rend que le
 * corps de la branche retenue, sans le ré-analyser — une condition imbriquée
 * survivrait donc à une passe unique. On boucle jusqu'à ce qu'il n'y ait plus
 * rien à résoudre, avec une borne dure au cas où un gabarit malformé
 * empêcherait la convergence.
 *
 * Limite assumée du format : un {{else}} appartient à la condition de PLUS HAUT
 * niveau de son bloc. Une condition imbriquée qui porte son propre {{else}}
 * n'est donc pas supportée — le cas ne se présente pas dans le chrome, et le
 * jour où il se présenterait, c'est un vrai moteur de template qu'il faut.
 */
function applyConditions(template) {
    let out = template;
    for (let pass = 0; pass < MAX_DEPTH && CONDITION.test(out); pass++) {
        CONDITION.lastIndex = 0;
        out = out.replace(CONDITION, (_match, name, body) => {
            const [whenTrue, whenFalse = ''] = body.split(SPLIT_ELSE);
            return conditionData[name] ? whenTrue : whenFalse;
        });
    }
    CONDITION.lastIndex = 0;
    return out;
}

/** Substitue les variables. Appelé APRÈS les conditions : une variable placée
 *  dans une branche écartée ne doit pas être substituée. */
function applyVariables(template, data) {
    return template.replace(VARIABLE, (match, name) => (
        // Une variable non fournie est laissée TELLE QUELLE plutôt que vidée :
        // un placeholder visible se remarque en relecture, une disparition
        // silencieuse non. Ne concerne pas les placeholders __MAJUSCULES__ des
        // autres étages (vnctDs / assetVersion), qui n'ont pas cette forme.
        Object.hasOwn(data, name) ? escapeHtml(data[name]) : match
    ));
}

/**
 * Rend un gabarit : inclusions, puis conditions, puis variables.
 *
 * @param {string} html — gabarit de page
 * @param {Record<string, unknown>} data — variables et drapeaux de condition
 * @returns {string}
 */
function expand(html, data = {}) {
    conditionData = data;
    return applyVariables(applyConditions(expandPartials(html, 0)), data);
}

/**
 * Développe récursivement les {{> partial}}, SANS toucher aux conditions ni aux
 * variables : celles-ci sont résolues une seule fois, sur l'arbre complet
 * (cf. expand). Les appliquer à chaque niveau les ferait passer deux fois sur
 * le markup des partials.
 *
 * @param {string} html
 * @param {number} depth — profondeur courante
 * @returns {string}
 */
function expandPartials(html, depth) {
    if (depth >= MAX_DEPTH) {
        console.error('[Quasar] Inclusion de partials trop profonde : récursion probable.');
        return html.replace(INCLUDE, '');
    }
    return html.replace(INCLUDE, (_match, name) => expandPartials(readPartial(name), depth + 1));
}

module.exports = { expand };
