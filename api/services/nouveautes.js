// ═══════════════════════════════════════════════════════════════
//  Journal des nouveautés — page publique /nouveautes
//
//  Piloté À CHAUD via l'API admin (cf. api/routes/adminNouveautes.js) : publier
//  une nouveauté ne demande aucun redéploiement. Les entrées sont persistées
//  dans un simple fichier JSON du volume `quasar-data` (/app/data), à côté de
//  la base SQLite — elles survivent donc aux redéploiements.
//
//  Pourquoi un fichier JSON et PAS la base SQLite (choix structurant, ne pas
//  « corriger » plus tard) : la vitrine est servie en mode `site` comme en mode
//  `public`, et le mode `site` démarre VOLONTAIREMENT sans base ni token
//  Discord (cf. index.js). Passer par SQLite rendrait la page indisponible
//  précisément dans le mode où quasar.vena.city tourne aujourd'hui. C'est aussi
//  le choix fait par Maât, dont ce module reprend le fonctionnement.
//
//  Une entrée = UN bloc markdown de version. Le bloc est stocké TEL QUEL et
//  rendu à l'affichage ; version, titre et date en sont extraits au parsing
//  pour le tri, sans jamais réécrire le markdown.
//
//  Premier boot sur un volume neuf : l'historique est initialisé depuis
//  content/nouveautes.md, versionné dans le repo. Un fichier DÉJÀ présent n'est
//  JAMAIS écrasé — les publications faites via l'API priment sur le seed, même
//  après un rebuild.
//
//  Fail-soft : si l'écriture échoue (volume non monté, droits), l'état reste
//  appliqué en mémoire pour CETTE instance mais ne survit pas à un redémarrage.
//  Jamais d'exception qui ferait tomber la vitrine pour un changelog.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// marked est chargé PARESSEUSEMENT, au premier rendu de la page. Le mode `bot`
// (auto-hébergement) ne sert pas la vitrine : il ne doit pas payer le coût d'un
// module dont il ne se servira jamais. Même doctrine que api/index.js, qui ne
// require ses routes qu'à l'appel de createApi().
let _marked = null;
function markdown(src) {
    if (_marked === null) _marked = require('marked').marked;
    return _marked(src, { async: false });
}

// Même répertoire que la base SQLite : le volume persistant du service.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'nouveautes.json');
const SEED_FILE = path.join(__dirname, '..', '..', 'content', 'nouveautes.md');

// dateISO de repli pour un bloc sans date interprétable : tout en bas du tri
// décroissant, sans jamais bloquer l'import.
const FALLBACK_DATE_ISO = '0000-01-01';

let entries = [];
let loaded = false;
let warnedWriteFail = false;

// ─── Parsing d'un bloc markdown ───────────────────────────────────────────────

// Mois français → numéro. Variantes sans accent tolérées (saisie manuelle).
const FR_MONTHS = {
    janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
    juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
    décembre: 12, decembre: 12,
};

/**
 * Convertit une date FR (« 5 juillet 2026 », « 1er juin 2026 », plage
 * « 20 – 27 mai 2026 ») en ISO YYYY-MM-DD. Pour une plage, on retient la date
 * de FIN : c'est elle qui ordonne le bloc dans l'historique.
 * @returns {string|null} null si le libellé n'est pas interprétable
 */
function frDateToISO(label) {
    const lower = label.toLowerCase();
    let month;
    for (const [name, num] of Object.entries(FR_MONTHS)) {
        if (lower.includes(name)) { month = num; break; }
    }
    const year = /(?<!\d)(\d{4})(?!\d)/.exec(lower)?.[1];
    if (month === undefined || year === undefined) return null;

    // Jours candidats : nombres à 1-2 chiffres (l'année, à 4 chiffres, est
    // exclue par les gardes). Une plage « 20 – 27 » donne [20, 27] : on garde
    // le dernier, la date de fin.
    const days = [...lower.matchAll(/(?<!\d)(\d{1,2})(?!\d)/g)]
        .map((m) => Number(m[1]))
        .filter((d) => d >= 1 && d <= 31);
    const day = days.length > 0 ? days[days.length - 1] : 1;
    const pad = (n) => String(n).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Extrait version / titre / date d'un bloc markdown. Best-effort et SANS
 * exception : un bloc mal formé donne des champs vides mais reste importable.
 * Regex tolérantes : émoji optionnel, tiret — – ou -, « v » optionnel devant la
 * version, version à 2 ou 3 composantes.
 */
function parseBlock(block) {
    // Titre principal : « ## 🌌 Quasar — v4.5.0 ».
    const heading = /^##(?!#)\s*(.+?)\s*$/mu.exec(block)?.[1] ?? '';
    const version = /\bv?(\d+(?:\.\d+){1,2})\b/u.exec(heading)?.[1] ?? '';
    // Sous-titre : première ligne « ### … ».
    const title = /^###\s*(.+?)\s*$/mu.exec(block)?.[1] ?? '';
    // Date : première ligne blockquote en italique « > *5 juillet 2026* ».
    const dateLabel = /^>\s*\*([^*\n]+)\*/mu.exec(block)?.[1]?.trim() ?? '';
    const dateISO = dateLabel ? (frDateToISO(dateLabel) ?? '') : '';
    return { version, title, dateLabel, dateISO };
}

/**
 * Découpe un markdown en blocs de version. Un bloc commence à un « ## » de
 * début de ligne ; tout ce qui précède le premier est ignoré (en-tête de
 * fichier, commentaire HTML de convention).
 */
function splitBlocks(markdown) {
    return markdown
        .split(/^(?=##(?!#)\s)/mu)
        .map((b) => b.trim())
        .filter((b) => b.startsWith('##'));
}

// ─── Tri ──────────────────────────────────────────────────────────────────────

// Comparaison sémantique pour un tri DÉCROISSANT, composante par composante en
// NUMÉRIQUE — jamais lexicographique, qui classerait « 4.9.0 » au-dessus de
// « 4.51.0 ». Une version absente se classe SOUS toute version explicite.
function compareVersionsDesc(a, b) {
    if (a === b) return 0;
    if (a === '') return 1;
    if (b === '') return -1;
    const as = a.split('.').map(Number);
    const bs = b.split('.').map(Number);
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const diff = (bs[i] ?? 0) - (as[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function sortDesc(list) {
    // dateISO est en YYYY-MM-DD : l'ordre lexicographique EST l'ordre
    // chronologique. Puis version décroissante (plusieurs versions peuvent
    // sortir le même jour), puis id pour un ordre totalement stable.
    return [...list].sort((a, b) => (
        b.dateISO.localeCompare(a.dateISO)
        || compareVersionsDesc(a.version, b.version)
        || b.id.localeCompare(a.id)
    ));
}

// ─── Persistance ──────────────────────────────────────────────────────────────

/** Construit une entrée complète (id compris) à partir d'un bloc markdown. */
function toEntry(block) {
    const trimmed = block.trim();
    const parsed = parseBlock(trimmed);
    return {
        // Id = date + version : stable, lisible, et porteur de la règle
        // d'upsert. Sans version, date seule ; sans date, hash court du contenu.
        id: parsed.dateISO
            ? (parsed.version ? `${parsed.dateISO}-v${parsed.version}` : parsed.dateISO)
            : `sans-date-${crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 8)}`,
        dateISO: parsed.dateISO || FALLBACK_DATE_ISO,
        dateLabel: parsed.dateLabel,
        version: parsed.version,
        title: parsed.title,
        block: trimmed,
    };
}

/**
 * Relit une liste d'entrées depuis le JSON du volume en ne gardant que les
 * objets bien formés : un fichier édité à la main ne doit jamais faire planter
 * le boot ni injecter des types inattendus.
 */
function normalizeEntries(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        if (typeof item.id !== 'string' || !item.id) continue;
        if (typeof item.block !== 'string' || !item.block) continue;
        out.push({
            id: item.id,
            dateISO: typeof item.dateISO === 'string' && item.dateISO ? item.dateISO : FALLBACK_DATE_ISO,
            dateLabel: typeof item.dateLabel === 'string' ? item.dateLabel : '',
            version: typeof item.version === 'string' ? item.version : '',
            title: typeof item.title === 'string' ? item.title : '',
            block: item.block,
        });
    }
    return sortDesc(out);
}

/** Persiste la liste sur le volume. Fail-soft : false si l'écriture échoue. */
function save() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // JSON indenté : le fichier reste lisible et éditable à la main sur le volume.
        fs.writeFileSync(FILE, JSON.stringify(entries, null, 2), 'utf8');
        return true;
    } catch (err) {
        if (!warnedWriteFail) {
            warnedWriteFail = true;
            console.warn('[Quasar] nouveautes : écriture impossible (volume ?), entrées en mémoire seulement —', err.message);
        }
        return false;
    }
}

/** Lit le seed markdown du repo. Absent ou illisible : historique vide. */
function readSeed() {
    try {
        return splitBlocks(fs.readFileSync(SEED_FILE, 'utf8')).map(toEntry);
    } catch {
        return [];
    }
}

/**
 * Charge le journal au premier accès. Trois cas :
 *  - fichier présent et lisible → chargé, le seed est IGNORÉ (les publications
 *    faites via l'API priment, quel que soit le seed embarqué) ;
 *  - fichier présent mais JSON corrompu → démarrage à vide SANS l'écraser (on
 *    ne détruit jamais un contenu potentiellement récupérable) ;
 *  - fichier ABSENT (premier boot sur ce volume) → seed depuis le markdown du
 *    repo, puis persistance.
 * Idempotent.
 */
function init() {
    if (loaded) return;
    loaded = true;

    let raw;
    try {
        raw = fs.readFileSync(FILE, 'utf8');
    } catch {
        raw = undefined; // fichier absent : premier boot, on passe au seed
    }

    if (raw !== undefined) {
        try {
            entries = normalizeEntries(JSON.parse(raw));
            console.log(`[Quasar] nouveautes : ${entries.length} entrée(s) chargée(s)`);
        } catch (err) {
            entries = [];
            console.warn('[Quasar] nouveautes : nouveautes.json corrompu — démarrage à vide, fichier NON écrasé —', err.message);
        }
        return;
    }

    entries = sortDesc(readSeed());
    const persisted = save();
    console.log(
        `[Quasar] nouveautes : premier boot, seed de ${entries.length} entrée(s)`
        + (persisted ? '' : ' (NON persisté : volume inaccessible)')
    );
}

// ─── API du module ────────────────────────────────────────────────────────────

/** Toutes les entrées, de la plus récente à la plus ancienne. Copie défensive. */
function list() {
    if (!loaded) init();
    return [...entries];
}

/**
 * Insère ou remplace l'entrée correspondant à la paire (DATE + VERSION) du
 * bloc : deux blocs du même jour de versions DIFFÉRENTES coexistent ; re-poster
 * un bloc de la même version le même jour REMPLACE l'entrée (correction sans
 * doublon). Un bloc sans date reste accepté, classé en fin d'historique.
 */
function upsert(block) {
    if (!loaded) init();
    const entry = toEntry(block);
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    entries = sortDesc(entries);
    return { entry, persisted: save() };
}

/** Supprime une entrée par id. @returns {boolean} false si l'id n'existe pas. */
function remove(id) {
    if (!loaded) init();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) return { removed: false, persisted: true };
    entries.splice(idx, 1);
    return { removed: true, persisted: save() };
}

// ─── Rendu HTML de la page publique ───────────────────────────────────────────

// HTML rendu par bloc, mémorisé par contenu : marked ne retourne pas sur un
// bloc inchangé. Le cache se vide de lui-même quand un bloc change (nouvelle
// clé), et reste borné par le nombre de versions publiées.
const htmlCache = new Map();

function blockToHtml(block) {
    if (htmlCache.has(block)) return htmlCache.get(block);
    // Le markdown vient du repo (seed) ou de l'API admin authentifiée : contenu
    // interne de confiance, rendu sans sanitizer — même contrat que Maât et
    // Prisma. Si un jour cette route s'ouvre à autre chose qu'une clé d'admin,
    // c'est ICI qu'il faudra brancher un assainissement.
    const html = markdown(block);
    htmlCache.set(block, html);
    return html;
}

/**
 * Fragment HTML complet de la liste des nouveautés, prêt à être injecté dans
 * public/nouveautes.html (placeholder __NOUVEAUTES_LIST__). Rendu à CHAQUE
 * requête et jamais mis en cache au niveau de la page : le contenu change à
 * chaud via l'API admin.
 */
function listHtml() {
    const all = list();
    if (all.length === 0) {
        return '<p class="quasar-news-empty">Rien ici pour le moment. Les évolutions de Quasar '
            + "s'afficheront sur cette page dès leur publication.</p>";
    }
    return '<section class="quasar-news-list" aria-label="Historique des mises à jour">'
        + all.map((e) => (
            `<article class="quasar-news-entry"${e.version ? ` data-version="${e.version}"` : ''}>`
            + blockToHtml(e.block)
            + '</article>'
        )).join('')
        + '</section>';
}

// compareVersionsDesc et blockToHtml sont exposés pour api/routes/nouveautes.js
// (pop-up des nouveautés du dashboard), qui doit filtrer les entrées plus
// récentes qu'une version donnée et les rendre une par une. Ajout purement
// additif : aucun comportement existant ne change, et surtout AUCUNE
// réimplémentation de la comparaison sémantique ailleurs dans le projet — un
// second comparateur finirait par diverger de celui qui trie l'historique.
module.exports = {
    init, list, listHtml, upsert, remove, parseBlock, frDateToISO, splitBlocks,
    compareVersionsDesc, blockToHtml,
};
