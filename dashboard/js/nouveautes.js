// ═══════════════════════════════════════════════════════════════════
//     Quasar — Pop-up des nouveautés au premier accès après une mise à jour
//
//     Expose window.QuasarNouveautes :
//       • autoOpen()  — appelé une fois au démarrage du dashboard (app.js).
//                       Ouvre le pop-up S'IL y a des nouveautés non vues.
//       • open()      — rouvre le pop-up à la demande (entrée « Nouveautés »
//                       de la barre latérale). Montre toujours les entrées les
//                       plus récentes, même si elles ont déjà été vues.
//
//     ─── Décisions structurantes ───────────────────────────────────────────
//
//     1. LA VERSION VUE EST DANS localStorage, PAS EN BASE. Le pop-up ne vaut
//        pas une table associant un identifiant Discord à un numéro de version :
//        ce serait une donnée personnelle de plus, pour un confort d'affichage.
//        Conséquence assumée : le pop-up réapparaît sur un autre navigateur.
//
//     2. AUCUNE LECTURE NI ÉCRITURE DE STOCKAGE N'EST NUE. Navigation privée,
//        stockage désactivé, quota plein : localStorage LÈVE. Un dashboard qui
//        ne s'ouvre plus parce qu'un pop-up n'a pas pu mémoriser une préférence
//        serait une régression bien pire que le pop-up lui-même.
//
//     3. RIEN N'EST BLOQUANT. autoOpen() n'est pas attendu par app.js : endpoint
//        en erreur, réseau lent, journal vide — le dashboard s'affiche
//        normalement et le pop-up ne s'ouvre simplement pas.
//
//     4. LA MARQUE EST ÉCRITE À LA FERMETURE, JAMAIS À L'OUVERTURE. Écrire au
//        chargement ferait disparaître le pop-up pour toujours si la page était
//        rechargée pendant sa lecture. On observe donc la fermeture réelle de la
//        modale (bouton, Échap ou clic sur le fond — les trois passent par
//        VNCT.Modal.close(), qui repasse l'overlay en aria-hidden="true").
//
//     5. LE CONTENU VIENT DU JOURNAL, RENDU CÔTÉ SERVEUR. GET /api/nouveautes
//        renvoie du HTML déjà produit à partir du markdown publié : une seule
//        source, et aucun rendu markdown embarqué dans le navigateur.
//
//     Ce fichier n'est chargé QUE par dashboard/app.html : il ne s'exécute donc
//     jamais sur la page publique /nouveautes.
// ═══════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    const TOKEN_KEY = 'quasar_token';
    const SEEN_KEY = 'quasar_nouveautes_seen';
    const ENDPOINT = '/api/nouveautes';
    const TRIGGER_ID = 'sidebar-whatsnew';

    // Même forme que côté serveur : 2 ou 3 composantes numériques. Tout ce qui
    // ne colle pas (stockage corrompu, valeur écrite par une version antérieure,
    // bricolage manuel) est traité comme « aucun repère » — donc comme une
    // première visite, qui affiche le pop-up.
    const VERSION_RE = /^\d+(?:\.\d+){1,2}$/;

    // Un seul pop-up AUTOMATIQUE par chargement de page. La réouverture manuelle
    // n'est pas concernée : c'est une action explicite.
    let autoOpened = false;

    // Dernière réponse « sans repère », réutilisée par les réouvertures
    // manuelles successives : inutile de retaper l'endpoint à chaque clic.
    let latestCache = null;

    // ─── Stockage, toujours sous garde ──────────────────────────────────────

    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Stockage indisponible : le pop-up se rouvrira au prochain
            // chargement. Gênant, jamais bloquant.
        }
    }

    /** Version déjà vue, ou null si rien de lisible n'est mémorisé. */
    function readSeenVersion() {
        const raw = readStorage(SEEN_KEY);
        return raw && VERSION_RE.test(raw) ? raw : null;
    }

    // ─── Accès à l'endpoint ─────────────────────────────────────────────────

    /**
     * @param {string|null} since — version déjà vue, ou null pour « les plus récentes »
     * @returns {Promise<object|null>} null sur toute erreur (réseau, 401, 500…)
     */
    async function fetchNouveautes(since) {
        const url = since ? `${ENDPOINT}?since=${encodeURIComponent(since)}` : ENDPOINT;
        const token = readStorage(TOKEN_KEY);

        try {
            const res = await fetch(url, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            // Volontairement PAS de déconnexion sur 401, contrairement à API.get
            // de app.js : un changelog qui répond mal ne doit jamais éjecter
            // quelqu'un de son dashboard.
            if (!res.ok) return null;
            const data = await res.json();
            return data && Array.isArray(data.entries) ? data : null;
        } catch {
            return null;
        }
    }

    // ─── Rendu ──────────────────────────────────────────────────────────────

    function renderBody(data) {
        if (data.entries.length === 0) {
            return '<div class="qnews">'
                + '<p class="qnews-empty">Aucune nouveauté n\'est publiée pour le moment. '
                + 'Les prochaines évolutions de Quasar s\'afficheront ici.</p>'
                + '</div>';
        }

        // entry.html est produit par le serveur à partir du markdown du journal
        // (seed du dépôt ou publication via l'API admin authentifiée) : même
        // contrat de confiance que la page publique /nouveautes, qui l'injecte
        // déjà tel quel. Rien de ce contenu ne vient d'une personne utilisatrice.
        const entries = data.entries
            .map(entry => `<article class="qnews-entry">${entry.html}</article>`)
            .join('');

        let more = '';
        if (data.hasMore) {
            // Sans page publique (auto-hébergement), on dit la troncature sans
            // renvoyer nulle part : mieux vaut une phrase courte qu'un lien mort
            // ou une indication technique sur l'emplacement du journal.
            more = data.journalUrl
                ? '<p class="qnews-more">Des versions plus anciennes ne sont pas reprises ici. '
                    + `L'historique complet est sur <a href="${data.journalUrl}" target="_blank" rel="noopener noreferrer">la page des nouveautés</a>.</p>`
                : '<p class="qnews-more">Seules les versions les plus récentes sont reprises ici.</p>';
        }

        return `<div class="qnews"><div class="qnews-list">${entries}</div>${more}</div>`;
    }

    /**
     * Mémorise la version vue quand la modale se referme réellement.
     *
     * VNCT.Modal gère les trois sorties (bouton, Échap, clic sur le fond) sans
     * exposer d'événement : on observe donc l'attribut aria-hidden de l'overlay,
     * que close() repasse à "true" une fois l'animation terminée. L'observateur
     * se débranche au premier déclenchement — l'overlay est partagé avec les
     * autres modales du design system.
     */
    function markSeenOnClose(seenMark) {
        if (!seenMark) return;
        const overlay = document.querySelector('.vnct-modal-overlay');
        if (!overlay) return;

        const observer = new MutationObserver(() => {
            if (overlay.getAttribute('aria-hidden') !== 'true') return;
            observer.disconnect();
            writeStorage(SEEN_KEY, seenMark);
        });
        observer.observe(overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
    }

    function showModal(data) {
        // Le design system porte déjà tout ce qu'on attend d'une modale
        // accessible : focus déplacé dedans à l'ouverture et rendu à son origine
        // à la fermeture, Échap, clic sur le fond, scroll de la page verrouillé
        // et contenu qui défile à l'intérieur. Rien à réécrire.
        VNCT.Modal.open({
            title: 'Quoi de neuf dans Quasar',
            body: renderBody(data),
            isHtml: true,
            footer: '<button type="button" class="btn btn-primary" id="qnews-close">Fermer</button>',
        });

        const closeBtn = document.getElementById('qnews-close');
        if (closeBtn) closeBtn.addEventListener('click', () => VNCT.Modal.close());

        markSeenOnClose(data.seenMark);
    }

    // ─── Points d'entrée ────────────────────────────────────────────────────

    /**
     * Ouverture automatique au démarrage du dashboard. Ne rend jamais d'erreur :
     * en cas de souci, le dashboard reste tel quel, sans pop-up.
     */
    async function autoOpen() {
        if (autoOpened) return;
        autoOpened = true;

        if (!window.VNCT || !VNCT.Modal) return;

        // Aucune version mémorisée (première visite, autre navigateur, stockage
        // vidé) → on demande les plus récentes, et le pop-up s'affiche. C'est ce
        // qui rend la fonctionnalité testable sur une preview.
        const since = readSeenVersion();
        const data = await fetchNouveautes(since);
        if (!data) return;

        if (since === null) latestCache = data;

        // Journal vide, ou version mémorisée déjà à jour — y compris le cas du
        // retour arrière de version (rollback d'auto-update) : la marque en
        // stockage est alors PLUS récente que tout le journal, aucune entrée ne
        // remonte, et rien ne s'ouvre. On ne réécrit surtout pas la marque à la
        // baisse, sinon la prochaine mise à jour rejouerait des blocs déjà lus.
        if (data.entries.length === 0) return;

        showModal(data);
    }

    /** Réouverture à la demande : toujours les entrées les plus récentes. */
    async function open() {
        if (!window.VNCT || !VNCT.Modal) return;

        const data = latestCache || await fetchNouveautes(null);
        if (!data) {
            if (typeof window.showToast === 'function') {
                window.showToast('Les nouveautés sont indisponibles pour le moment.', 'error');
            }
            return;
        }

        latestCache = data;
        showModal(data);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const trigger = document.getElementById(TRIGGER_ID);
        if (trigger) trigger.addEventListener('click', open);
    });

    window.QuasarNouveautes = { autoOpen, open };
})();
