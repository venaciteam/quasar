// ═══════════════════════════════════════════════════════════════
//  Lecture du journal des nouveautés pour le dashboard
//
//  Alimente le pop-up « nouveautés de la version que vous venez d'installer »
//  (dashboard/js/nouveautes.js). Le journal reste la SEULE source : ce qui est
//  publié sur /nouveautes est exactement ce que le pop-up affiche — pas de
//  second contenu à maintenir.
//
//  Pourquoi une route d'INSTANCE et pas une route par serveur : le journal ne
//  dépend d'aucun serveur Discord. Elle est donc montée sur /api comme
//  update.js, jamais sous /api/guilds/:guildId.
//
//  Pourquoi requireAuth et pas la clé d'admin : lire le changelog n'est pas un
//  acte d'administration. adminNouveautes.js garde la clé pour l'ÉCRITURE ; ici
//  on demande seulement d'être connecté·e au dashboard.
//
//  Pourquoi la version installée est renvoyée ICI et pas lue sur /api/version :
//  cette route-là interroge l'API GitHub pour connaître la dernière release
//  publiée. C'est lent, sujet au rate-limit, et le pop-up n'en a aucun besoin —
//  il lui faut la version LOCALE, que package.json porte déjà. Le pop-up tient
//  donc en un seul appel, sans requête sortante.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const assetVersion = require('../services/assetVersion');
const nouveautes = require('../services/nouveautes');

const router = express.Router();

// Borne dure du nombre d'entrées renvoyées. Qui met à jour après un an ne doit
// pas recevoir trente blocs dans une fenêtre modale : au-delà, la réponse porte
// hasMore et l'interface renvoie vers la page complète.
const MAX_ENTRIES = 5;

// Une version exploitable : 2 ou 3 composantes numériques, sans « v ». Même
// forme que celle extraite des blocs par le service. Tout le reste (chaîne
// vide, « v4.6.0 », « latest », stockage corrompu) est traité comme une absence
// de repère — on retombe alors sur « les plus récentes ».
const VERSION_RE = /^\d+(?:\.\d+){1,2}$/;

/**
 * GET /api/nouveautes[?since=X.Y.Z]
 *
 * Sans `since` : les MAX_ENTRIES entrées les plus récentes. C'est le cas de la
 * première visite (aucune version mémorisée) et celui du bouton « revoir les
 * nouveautés ».
 *
 * Avec `since` : uniquement les entrées STRICTEMENT plus récentes que cette
 * version, de la plus récente à la plus ancienne. Une version mémorisée plus
 * récente que tout le journal (retour arrière après un rollback d'auto-update)
 * ne remonte donc rien, et le pop-up ne s'ouvre pas : c'est le comportement
 * voulu, ces blocs-là ont déjà été lus.
 */
router.get('/nouveautes', requireAuth, (req, res) => {
    try {
        const installedVersion = assetVersion.VERSION;

        const rawSince = typeof req.query.since === 'string' ? req.query.since.trim() : '';
        const since = VERSION_RE.test(rawSince) ? rawSince : null;

        // list() est déjà trié du plus récent au plus ancien et initialise le
        // journal au premier accès (seed depuis content/nouveautes.md).
        const all = nouveautes.list();

        // compareVersionsDesc est la comparaison sémantique du service : négatif
        // = « a est plus récent que b ». Une entrée sans version se classe sous
        // toute version explicite et sort donc naturellement du filtre — elle ne
        // peut pas être située dans l'historique, elle n'est jamais « nouvelle ».
        const matching = since
            ? all.filter(e => e.version && nouveautes.compareVersionsDesc(e.version, since) < 0)
            : all;

        const shown = matching.slice(0, MAX_ENTRIES);

        // Repère à mémoriser côté navigateur une fois le pop-up vu. C'est le MAX
        // de la version installée et de la plus récente entrée affichée, jamais
        // l'une des deux seulement :
        //  - prendre la seule entrée la plus récente laisserait rouvrir le pop-up
        //    quand le journal est en retard sur la version installée ;
        //  - prendre la seule version installée le ferait rouvrir à CHAQUE
        //    chargement dès qu'une nouveauté est publiée à chaud pour une version
        //    supérieure à celle qui tourne.
        const newest = shown[0]?.version || '';
        const seenMark = newest && nouveautes.compareVersionsDesc(newest, installedVersion) < 0
            ? newest
            : installedVersion;

        return res.json({
            installedVersion,
            seenMark,
            // Le HTML est rendu ici, par le même chemin que la page publique
            // (markdown de confiance : seed du dépôt ou API admin authentifiée).
            // Le navigateur n'a donc aucun rendu markdown à faire.
            entries: shown.map(e => ({
                id: e.id,
                version: e.version,
                title: e.title,
                dateLabel: e.dateLabel,
                html: nouveautes.blockToHtml(e.block),
            })),
            hasMore: matching.length > shown.length,
            // La page complète n'existe que là où la vitrine est servie. En
            // auto-hébergement (mode `bot`), y renvoyer mènerait à un 404 :
            // l'interface n'affiche le lien que si cette valeur est non nulle.
            journalUrl: req.app.get('vitrineMounted') ? '/nouveautes' : null,
        });
    } catch (err) {
        // Le journal est fail-soft de bout en bout : arriver ici serait
        // inattendu. On répond quand même proprement — un changelog ne doit
        // jamais renvoyer une erreur non formatée au dashboard.
        console.error('[Quasar] nouveautes : lecture impossible —', err.message);
        return res.status(500).json({ error: 'Journal des nouveautés indisponible.' });
    }
});

module.exports = router;
