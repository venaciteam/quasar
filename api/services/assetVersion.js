// ═══════════════════════════════════════════════════════════════
//  Cache-busting automatique
//
//  Les ressources statiques portent un paramètre ?v=<version> pour que Cloudflare
//  serve les nouveaux fichiers après un déploiement plutôt que son cache. Tenir ces
//  références à jour à la main, c'est une trentaine d'occurrences à modifier à chaque
//  release — l'oubli le plus courant, et le plus pénible à diagnostiquer : le
//  déploiement réussit, mais les utilisateurs continuent de recevoir l'ancien CSS.
//
//  Les fichiers servis portent donc le marqueur __VERSION__, remplacé ici à la volée
//  par la version du package.json. Bumper la version dans package.json suffit.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const VERSION = require('../../package.json').version;
const PLACEHOLDER = /__VERSION__/g;

// Le contenu ne change pas pendant la vie du process : on ne relit pas le disque
// à chaque requête. Le cache est vidé au redémarrage, donc à chaque déploiement.
const cache = new Map();

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

// Contenu BRUT des fichiers, placeholders inclus. Séparé du cache de render()
// pour que les deux ne se contaminent pas.
const rawCache = new Map();

/**
 * Lit un fichier SANS rien y substituer. Utilisé par le rendu de la vitrine
 * (vnctDs), qui doit développer ses partials avant de substituer __VERSION__ :
 * les partials portent eux aussi ce placeholder.
 * @returns {string|null} null si le fichier est illisible
 */
function raw(filePath) {
    if (rawCache.has(filePath)) return rawCache.get(filePath);

    let content = null;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.error(`[Quasar] Lecture impossible de ${path.basename(filePath)} :`, err.message);
    }
    rawCache.set(filePath, content);
    return content;
}

/**
 * Lit un fichier et y injecte la version courante.
 * @returns {string|null} null si le fichier est illisible
 */
function render(filePath) {
    if (cache.has(filePath)) return cache.get(filePath);

    const content = raw(filePath);
    if (content === null) return null;

    const rendered = content.replace(PLACEHOLDER, VERSION);
    cache.set(filePath, rendered);
    return rendered;
}

/**
 * Envoie un fichier avec la version injectée.
 */
function send(res, filePath) {
    const content = render(filePath);
    if (content === null) {
        return res.status(500).send('Erreur de lecture du fichier.');
    }

    const type = CONTENT_TYPES[path.extname(filePath)] || 'text/plain; charset=utf-8';
    res.set('Content-Type', type);
    // no-cache : le navigateur revalide à chaque fois. Ce sont ces fichiers qui
    // portent les références versionnées, ils doivent toujours être frais — sinon
    // le cache-busting ne sert à rien.
    res.set('Cache-Control', 'no-cache');
    return res.send(content);
}

module.exports = { VERSION, send, render, raw };
