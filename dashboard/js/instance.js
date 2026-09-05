/* ==========================================================================
   INSTANCE — Qui héberge cette instance de Quasar, et où en trouver le code

   Quasar est distribué en auto-hébergement : chaque instance est opérée par une
   personne ou une organisation différente. Écrire un nom en dur serait faux
   partout ailleurs que sur l'instance concernée. On interroge donc le serveur,
   qui répond d'après ses variables d'environnement.

   Ces deux mentions vivaient dans un panneau « Késako » ouvert au clic. Le
   bouton qui l'ouvrait a été retiré, et elles sont devenues injoignables — alors
   que l'AGPL-3.0 (article 13) impose de proposer VISIBLEMENT le code source de
   la version réellement exécutée. Elles sont donc désormais écrites dans le
   badge de version (VNCT.VersionBadge, js/vnct-common.js), le seul élément
   présent sur toutes les pages du dashboard et à tous les formats, sans aucune
   interaction pour les lire.

   Chaque fente laissée vide est masquée par le CSS (`:empty`) : une réponse
   incomplète de /api/instance ne produit jamais un lien vide ni un badge cassé.
   ========================================================================== */

(function () {
    'use strict';

    var OPERATOR_SLOT = '[data-instance-operator]';
    var SOURCE_SLOT = '[data-instance-source]';

    // Pas de couleur en ligne ici : la classe porte le style, et le lien est
    // souligné — il ne se distingue donc pas du texte par la seule couleur.
    function makeLink(url, label) {
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'vnct-version-badge__link';
        a.textContent = label;
        return a;
    }

    function renderSource(data) {
        var slot = document.querySelector(SOURCE_SLOT);
        if (!slot) return;

        slot.textContent = '';
        // Sans URL de source, on n'écrit rien plutôt qu'un lien mort. Le serveur
        // en fournit toujours une (le dépôt d'origine à défaut de mieux) : une
        // fente vide signale donc une API muette, pas une instance sans source.
        if (!data.sourceUrl) return;

        slot.appendChild(makeLink(data.sourceUrl, 'Code source de cette instance'));
        slot.appendChild(document.createTextNode(' (AGPL-3.0)'));
    }

    function renderOperator(data) {
        var slot = document.querySelector(OPERATOR_SLOT);
        if (!slot) return;

        slot.textContent = '';

        if (data.operatorName) {
            slot.appendChild(document.createTextNode('Hébergée par ' + data.operatorName));
            if (data.legalUrl) {
                slot.appendChild(document.createTextNode(' — '));
                slot.appendChild(makeLink(data.legalUrl, 'mentions légales'));
            }
            return;
        }

        // Pas de nom d'hébergeur déclaré, mais des mentions légales publiées :
        // le lien seul vaut mieux que rien, il mène à l'identité recherchée.
        if (data.legalUrl) {
            slot.appendChild(makeLink(data.legalUrl, 'Mentions légales'));
        }
    }

    function apply(data) {
        renderSource(data);
        renderOperator(data);
    }

    function init() {
        fetch('/api/instance')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) { if (data) apply(data); })
            .catch(function () {
                // Serveur injoignable : les fentes restent vides et masquées,
                // le badge continue d'afficher la version. Rien de cassé.
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
