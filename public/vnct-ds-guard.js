/* ============================================================================
   vnct-ds-guard.js — Écran de secours « design system indisponible »

   SOURCE CANONIQUE : venaciteam/vncterrors (public/vnct-ds-guard.js).
   Chaque service Venacity en sert une COPIE VERBATIM depuis sa propre origine,
   chargée juste après la balise <script> du design system :

     <script src="/vnct-ds-guard.js" defer></script>

   Pourquoi une copie servie par chaque service plutôt qu'un fichier central :
   le garde doit fonctionner quand l'infrastructure commune est en panne, et
   script-src 'self' passe toutes les CSP du parc (Cardo sans inline, Prisma à
   nonce). La duplication est contrôlée par l'audit du parc, comme le bloc légal.

   Détection : le garde regarde quelles ressources du DS la page demande
   (<link> .../v2/vnct-design-system.css, <script> .../v2/vnct-common.js) et
   vérifie qu'elles sont réellement arrivées :
     - CSS : la variable --z-header est définie sur :root ;
     - JS  : window.VNCT.version existe.
   Vérification à l'événement load (toutes les ressources arrivées ou en échec),
   et dès que le navigateur signale l'échec de chargement d'une ressource du DS.
   Une page qui ne charge pas le DS n'est jamais concernée.

   Notification : AUCUNE depuis le navigateur. L'alerte Discord est envoyée une
   seule fois pour tout l'écosystème par la sonde vnct-sentinelle (Cloudflare
   Worker, dossier worker/ de ce même repo).

   Affichage 100 % autonome : aucun CSS externe, styles posés via CSSOM
   (élément.style.cssText), jamais d'attribut style en dur ni de <style> injecté
   → compatible avec les CSP sans 'unsafe-inline'. Couleurs alignées à la main
   sur la DA v2 (mêmes valeurs que cf-error.html), à tenir à jour si elle évolue.
   ============================================================================ */

(function () {
  'use strict';

  var CSS_MARK = '/v2/vnct-design-system.css';
  var JS_MARK = '/v2/vnct-common.js';
  var shown = false;

  function pageWants(selector, attr, mark) {
    var els = document.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) {
      if ((els[i].getAttribute(attr) || '').indexOf(mark) !== -1) return true;
    }
    return false;
  }

  function cssArrived() {
    return getComputedStyle(document.documentElement).getPropertyValue('--z-header').trim() !== '';
  }

  function jsArrived() {
    return !!(window.VNCT && window.VNCT.version);
  }

  function dsBroken() {
    var needCss = pageWants('link[rel~="stylesheet"]', 'href', CSS_MARK);
    var needJs = pageWants('script[src]', 'src', JS_MARK);
    return (needCss && !cssArrived()) || (needJs && !jsArrived());
  }

  function node(tag, css, text) {
    var n = document.createElement(tag);
    n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function show() {
    shown = true;

    var overlay = node('div',
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:32px;box-sizing:border-box;overflow:auto;' +
      'background:#06060c;color:#ece9f7;text-align:center;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;');
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'vnct-ds-guard-title');
    overlay.setAttribute('aria-describedby', 'vnct-ds-guard-text');

    var box = node('div', 'max-width:520px;width:100%;');

    var title = node('h1',
      'margin:0 0 14px;font-size:clamp(24px,5vw,32px);font-weight:700;line-height:1.25;' +
      'letter-spacing:-0.02em;color:#ff9ad4;' +
      'background:linear-gradient(135deg,#ff9ad4,#bfa6ff,#8fe9ff);' +
      '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;',
      'Un service essentiel est momentanément indisponible.');
    title.id = 'vnct-ds-guard-title';

    var text = node('p',
      'margin:0 0 32px;font-size:17px;line-height:1.6;color:#a6a3bd;',
      'Un problème touche probablement les serveurs Venacity ou l’un de leurs ' +
      'services communs. Réessayez dans quelques instants.');
    text.id = 'vnct-ds-guard-text';

    var retry = node('button',
      'font:inherit;font-weight:600;font-size:16px;padding:12px 22px;border:0;' +
      'border-radius:12px;cursor:pointer;background:#ff9ad4;color:#06060c;',
      'Réessayer');
    retry.type = 'button';
    retry.addEventListener('click', function () { window.location.reload(); });

    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(retry);
    overlay.appendChild(box);

    // Le reste de la page (sans mise en forme) sort de l'arbre d'accessibilité
    // et ne défile plus sous l'écran de secours.
    var children = document.body ? document.body.children : [];
    for (var i = 0; i < children.length; i++) children[i].setAttribute('aria-hidden', 'true');
    document.documentElement.style.overflow = 'hidden';

    (document.body || document.documentElement).appendChild(overlay);
    retry.focus();
  }

  function check() {
    if (!shown && dsBroken()) show();
  }

  // Échec explicite d'une ressource du DS (DNS, 5xx, connexion) : l'événement
  // error des <link>/<script> ne remonte pas, on l'écoute en phase de capture.
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t === window) return;
    var url = t.src || t.href || '';
    if (url.indexOf(CSS_MARK) !== -1 || url.indexOf(JS_MARK) !== -1) setTimeout(check, 0);
  }, true);

  if (document.readyState === 'complete') setTimeout(check, 0);
  else window.addEventListener('load', function () { setTimeout(check, 0); });
})();
