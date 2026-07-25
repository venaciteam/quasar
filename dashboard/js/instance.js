/* ==========================================================================
   INSTANCE — Qui héberge cette instance de Quasar, et où en trouver le code

   Quasar est distribué en auto-hébergement : chaque instance est opérée par une
   personne ou une organisation différente. Écrire un nom en dur serait faux
   partout ailleurs que sur l'instance concernée. On interroge donc le serveur,
   qui répond d'après ses variables d'environnement.

   Le bloc « Késako » vit dans un <template> lu au clic (vnct-common.js).
   On peut donc le réécrire tranquillement au chargement de la page.
   ========================================================================== */

(function () {
    'use strict';

    var OPERATOR_SLOT = '[data-instance-operator]';
    var SOURCE_SLOT = '[data-instance-source]';

    function eachTemplateRoot(callback) {
        // Le contenu vit dans un <template> : on passe par .content, sinon les
        // nœuds ne sont pas accessibles. Fallback sur l'élément lui-même au cas où
        // le bloc serait un jour sorti du template.
        var tpl = document.querySelector('[data-kesako-content]');
        if (!tpl) return;
        callback(tpl.content || tpl);
    }

    function renderOperator(root, data) {
        var slot = root.querySelector(OPERATOR_SLOT);
        if (!slot) return;

        slot.textContent = '';

        if (!data.operatorName) {
            // Défaut : on ne nomme personne, mais on dit clairement que l'hébergeur
            // est celui qui a installé le service — pas l'auteur du logiciel.
            slot.appendChild(document.createTextNode(
                'Cette instance est hébergée par la personne ou l\'organisation qui l\'a installée.'
            ));
            return;
        }

        slot.appendChild(document.createTextNode(
            'Cette instance de Quasar est hébergée par ' + data.operatorName
        ));

        if (data.legalUrl) {
            slot.appendChild(document.createTextNode(' — '));
            var link = document.createElement('a');
            link.href = data.legalUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.color = 'var(--accent)';
            link.textContent = 'mentions légales';
            slot.appendChild(link);
            slot.appendChild(document.createTextNode('.'));
        } else {
            slot.appendChild(document.createTextNode('.'));
        }
    }

    function renderSource(root, data) {
        var slot = root.querySelector(SOURCE_SLOT);
        if (!slot || !data.sourceUrl) return;

        slot.textContent = '';
        slot.appendChild(document.createTextNode('Quasar est un logiciel libre sous licence AGPL-3.0 — '));

        var link = document.createElement('a');
        link.href = data.sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.color = 'var(--accent)';
        link.textContent = 'code source de cette instance';
        slot.appendChild(link);
        slot.appendChild(document.createTextNode('.'));
    }

    function apply(data) {
        eachTemplateRoot(function (root) {
            renderOperator(root, data);
            renderSource(root, data);
        });
    }

    function init() {
        fetch('/api/instance')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) { if (data) apply(data); })
            .catch(function () {
                // Serveur injoignable : le texte par défaut du HTML reste affiché,
                // il est déjà correct (il ne nomme personne).
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
