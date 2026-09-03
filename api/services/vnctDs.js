// ═══════════════════════════════════════════════════════════════
//  Design System VNCT — intégration côté serveur
//
//  Les pages de la vitrine (public/) n'embarquent pas le design system : elles
//  le chargent depuis design.vena.city, versionné par majeure (/v2/) et
//  cache-busté par un ?v= qui suit la version réelle du DS. Cette version est
//  publiée par le DS sur GET /version.json et évolue sans que Quasar redémarre :
//  on la relit donc périodiquement (polling) au lieu de la figer au boot.
//
//  Règle absolue : ce mécanisme ne sert QU'au cache-busting. Il ne doit jamais
//  faire tomber l'app — design.vena.city injoignable, JSON invalide, timeout :
//  tout est absorbé, on retombe sur la dernière version connue, sinon sur le
//  repli figé ci-dessous.
// ═══════════════════════════════════════════════════════════════

const assetVersion = require('./assetVersion');
const partials = require('./partials');

// Base URL du DS, surchargeable par environnement (dev / mock local).
const DS_BASE = process.env.VNCT_DS_BASE_URL || 'https://design.vena.city';

// Repli figé dans le code : utilisé UNIQUEMENT si /version.json est injoignable
// au tout premier appel (boot). À bumper manuellement quand la vitrine valide une
// nouvelle version majeure/mineure du DS. Un repli périmé n'est jamais bloquant
// (il ne sert qu'au cache-busting ?v=).
const FALLBACK_VERSION = '2.0.1';

// Chemin versionné par majeure : figé dans le code (protection breaking v3).
const DS_MAJOR_PATH = '/v2';

// Délai maximal accordé à /version.json. Le polling tourne hors du chemin de
// rendu, mais un fetch sans timeout laisserait des sockets ouvertes à l'infini.
const FETCH_TIMEOUT = 3000;

const POLL_INTERVAL = 5 * 60 * 1000;

// Version courante du DS, tenue à jour en mémoire. null tant qu'aucune valeur
// (ni réseau, ni repli) n'a été établie.
let currentVersion = null;

/**
 * Récupère /version.json avec un timeout dur. Ne throw jamais.
 * @returns {Promise<string|null>} la version, ou null (réseau, HTTP != 2xx,
 *          timeout, JSON invalide, champ version manquant).
 */
async function fetchVersion() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const res = await fetch(`${DS_BASE}/version.json`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return typeof data.version === 'string' && data.version ? data.version : null;
    } catch {
        // Timeout, DNS, refus de connexion, JSON invalide... : on absorbe tout.
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Rafraîchit la version courante. En cas d'échec : on conserve la dernière
 * version connue ; si aucune n'existe encore (échec au boot), on tombe sur le
 * repli figé.
 */
async function refreshVersion() {
    const fetched = await fetchVersion();
    if (fetched) {
        currentVersion = fetched;
    } else if (currentVersion === null) {
        currentVersion = FALLBACK_VERSION;
    }
    // else : échec réseau alors qu'une version connue existe -> on ne change rien.
    return currentVersion;
}

/**
 * À appeler une fois au démarrage, uniquement si la vitrine est servie. Premier
 * fetch immédiat puis toutes les 5 minutes. unref() pour ne pas empêcher le
 * process de s'arrêter.
 */
function startVersionPolling() {
    refreshVersion().catch(() => {});
    const interval = setInterval(() => {
        refreshVersion().catch(() => {});
    }, POLL_INTERVAL);
    if (typeof interval.unref === 'function') interval.unref();
}

/** URLs finales du DS, forgées avec la version courante (ou le repli). */
function dsUrls() {
    const v = currentVersion || FALLBACK_VERSION;
    return {
        css: `${DS_BASE}${DS_MAJOR_PATH}/vnct-design-system.css?v=${v}`,
        js: `${DS_BASE}${DS_MAJOR_PATH}/vnct-common.js?v=${v}`,
    };
}

// ═══════════════════════════════════════════════════════════════
//  Bloc conditionnel « bouton dashboard »
//
//  Le fragment encadré par ces marqueurs n'est envoyé que si le serveur a
//  décidé de proposer le bouton d'accès au dashboard. Il est RETIRÉ du HTML,
//  pas seulement masqué en CSS : un lien simplement caché resterait dans la
//  page servie (source, préchargement, parcours clavier si une règle saute).
//  Bouton fermé = la vitrine ne contient aucune trace du dashboard, donc
//  exactement la page d'avant l'ouverture de l'instance publique.
//
//  Le marqueur ne porte AUCUNE condition : la décision est prise en amont
//  (api/index.js). Ne pas y réintroduire de logique de mode.
// ═══════════════════════════════════════════════════════════════
const CTA_BLOCK = /[^\S\n]*<!--\s*__DASHBOARD_CTA_ON__\s*-->\n?([\s\S]*?)[^\S\n]*<!--\s*\/__DASHBOARD_CTA_ON__\s*-->\n?/g;

/**
 * @param {string} html
 * @param {boolean} isOn — true : on garde le contenu et on retire les marqueurs.
 *                         false : on retire le bloc entier.
 */
function applyDashboardCta(html, isOn) {
    return html.replace(CTA_BLOCK, (_match, inner) => (isOn ? inner : ''));
}

/**
 * Rendu d'une page de la vitrine, en deux étages de substitution :
 *
 *  1. __VERSION__ (assets locaux) — délégué à assetVersion.render(), qui lit le
 *     disque et met le résultat en cache pour la vie du process. C'est correct :
 *     la version du package.json ne bouge pas sans redéploiement, donc sans
 *     redémarrage. Aucune relecture disque par requête.
 *  2. __VNCT_CSS_URL__ / __VNCT_JS_URL__ / __QUASAR_MODE__ / __DASHBOARD_CTA__ —
 *     appliqués ici, à CHAQUE requête, sur la chaîne déjà mise en cache.
 *     Indispensable pour les URLs du DS : leur ?v= change en cours de vie du
 *     process (polling), les mettre en cache figerait le cache-busting jusqu'au
 *     prochain redémarrage. Le mode et l'état du bouton, eux, sont fixes ; ils
 *     sont substitués au même étage pour ne pas avoir à indexer le cache par
 *     (fichier, mode, cta) — quelques replace de plus sur une chaîne déjà en
 *     mémoire sont négligeables.
 *  3. Blocs conditionnels __DASHBOARD_CTA_ON__ — voir applyDashboardCta().
 *  4. Partials {{> header}} / {{> menu}} / {{> scripts}} — développés AVANT
 *     tout le reste (cf. readPage). Le markup qu'ils apportent porte lui aussi
 *     des placeholders (__VERSION__ et __VNCT_JS_URL__ dans scripts.html) : il
 *     doit donc entrer dans le flux avant les substitutions, sinon ces
 *     placeholders seraient servis bruts.
 *
 * L'ordre compte : l'étage caché d'abord, l'étage volatil ensuite. L'inverse
 * ferait entrer les URLs du DS dans le cache de assetVersion.
 *
 * @param {string} filePath
 * @param {{mode: string, dashboardCta: 'on'|'off', blocks?: Record<string, () => string>}} context
 *        état déjà tranché par le serveur (cf. api/index.js). Le rendu ne décide
 *        de rien lui-même ; un contexte absent retombe sur le défaut sûr :
 *        bouton fermé, aucun fragment dynamique.
 * @returns {string|null} null si le fichier est illisible
 */
function render(filePath, { mode = '', dashboardCta = 'off', blocks = {} } = {}) {
    const raw = readPage(filePath);
    if (raw === null) return null;

    const { css, js } = dsUrls();
    let out = applyDashboardCta(raw, dashboardCta === 'on')
        .replaceAll('__VNCT_CSS_URL__', css)
        .replaceAll('__VNCT_JS_URL__', js)
        .replaceAll('__QUASAR_MODE__', mode)
        .replaceAll('__DASHBOARD_CTA__', dashboardCta);

    // Fragments HTML calculés par requête (ex. __NOUVEAUTES_LIST__, dont le
    // contenu change à chaud via l'API admin). Injectés BRUTS et volontairement
    // hors du cache de page : les mettre en cache figerait le changelog jusqu'au
    // prochain redémarrage. La fonction n'est appelée que si son placeholder est
    // réellement présent — une page qui ne l'utilise pas ne paie pas son calcul.
    for (const [name, produce] of Object.entries(blocks)) {
        const placeholder = `__${name}__`;
        if (out.includes(placeholder)) out = out.replaceAll(placeholder, produce());
    }
    return out;
}

// Gabarits de page entièrement assemblés (partials développés, __VERSION__
// substituée), mis en cache pour la vie du process. Le cache est indexé par
// (fichier + variables de page) : deux pages qui incluent le même header avec
// un `ctx` différent ne doivent pas se marcher dessus.
//
// Ce qui reste HORS de ce cache : les URLs du DS, le mode et l'état du bouton
// dashboard — leur ?v= change en cours de vie du process (polling), les figer
// ici casserait le cache-busting jusqu'au prochain redémarrage.
const pageCache = new Map();

function readPage(filePath) {
    const data = PAGE_DATA[filePath] || {};
    const key = `${filePath}::${JSON.stringify(data)}`;
    if (pageCache.has(key)) return pageCache.get(key);

    // assetVersion.render() lit le disque et substitue __VERSION__. Les partials
    // sont développés APRÈS : partials/scripts.html porte lui aussi un
    // __VERSION__, il doit donc entrer dans le flux avant cette substitution.
    // On relit donc le gabarit brut, on développe, puis on substitue.
    const source = assetVersion.raw(filePath);
    if (source === null) return null;

    const rendered = partials
        .expand(source, data)
        .replaceAll('__VERSION__', assetVersion.VERSION);
    pageCache.set(key, rendered);
    return rendered;
}

// Variables de rendu des pages vitrine (chrome). Déclarées ici, à côté du
// moteur, et pas dans chaque HTML : la variante de header et le libellé
// contextuel sont une décision de navigation, elle se lit mieux d'un bloc.
// Une page absente de cette table rend le header en variante statique sans
// libellé — le défaut sûr.
const path = require('path');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const pageFile = (name) => path.join(PUBLIC_DIR, name);

/**
 * Liens de paiement de la page /soutenir, lus dans l'environnement.
 *
 * TOUS optionnels, et c'est le mécanisme central de la page : une variable
 * absente masque le bouton correspondant, et si AUCUNE n'est définie la page
 * bascule d'elle-même en mode « bientôt » (drapeau `supportSoon`). Aucun lien
 * de paiement n'est donc jamais écrit en dur dans le HTML — et tant que le
 * soutien n'est pas ouvert, la page reste honnête toute seule, sans qu'il faille
 * penser à la modifier.
 *
 * Même convention de nommage que Prisma (STRIPE_LINK_*) : les deux services
 * puisent dans le même compte, autant que les variables se lisent pareil.
 */
function supportLinks() {
    const link = (name) => (process.env[name] || '').trim();
    const links = {
        once2: link('STRIPE_LINK_ONCE_2'),
        once5: link('STRIPE_LINK_ONCE_5'),
        onceCustom: link('STRIPE_LINK_ONCE_CUSTOM'),
        monthly2: link('STRIPE_LINK_MONTHLY_2'),
        monthly5: link('STRIPE_LINK_MONTHLY_5'),
        monthly10: link('STRIPE_LINK_MONTHLY_10'),
    };
    const hasOnce = Boolean(links.once2 || links.once5 || links.onceCustom);
    const hasMonthly = Boolean(links.monthly2 || links.monthly5 || links.monthly10);
    return { ...links, hasOnce, hasMonthly, supportSoon: !hasOnce && !hasMonthly };
}

const PAGE_DATA = {
    // L'accueil porte le chrome applicatif : pas de marque à gauche (on est
    // déjà sur la page de la marque, le hero la porte en grand), drapeau de
    // signalement + menu à droite.
    [pageFile('index.html')]: { app: true },
    [pageFile('ethique.html')]: { ctx: 'éthique' },
    [pageFile('pourquoi.html')]: { ctx: 'un mot de la créatrice' },
    [pageFile('nouveautes.html')]: { ctx: 'nouveautés' },
    [pageFile('soutenir.html')]: { ctx: 'soutenir', ...supportLinks() },
    [pageFile('instance-bientot.html')]: { ctx: 'instance publique' },
};

/**
 * Envoie une page de la vitrine, tous placeholders substitués. Le code de statut
 * déjà posé sur la réponse est conservé (cf. la page « bientôt de retour », en 503).
 *
 * @param {{mode: string, dashboardCta: 'on'|'off'}} context
 */
function send(res, filePath, context) {
    const content = render(filePath, context);
    if (content === null) {
        return res.status(500).send('Erreur de lecture du fichier.');
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    // no-cache : le navigateur revalide à chaque fois. La page porte des URLs
    // versionnées qui peuvent changer sans redéploiement.
    res.set('Cache-Control', 'no-cache');
    return res.send(content);
}

module.exports = { startVersionPolling, dsUrls, render, send, DS_BASE };
