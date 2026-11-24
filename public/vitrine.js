// Vitrine Quasar — mise en scène (v4.13.0).
//
// Mécanique reprise des landings de Polyptyque et de Steam Upgraded : titres
// révélés ligne par ligne, blocs rejoués à chaque arrivée par le bas (jamais
// pendant la remontée), fenêtres flottantes, scène temporisée dans les deux
// sens, barre de progression de lecture, préférence « animations réduites ».
//
// Chargé sur TOUTES les pages de la vitrine : chaque partie vérifie que ses
// éléments existent avant de s'armer. Sans JavaScript, tout le texte reste
// lisible : seul ce script masque des éléments en attente de révélation.
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('qv-js');

  /* ---- Compteur de l'instance publique (carte « L'instance publique ») ----
     La carte n'existe que lorsque le serveur l'a gardée dans le HTML : sans
     elle, aucun appel. Tout échec (404 en mode `site`, 503 robot déconnecté,
     réseau, réponse inattendue) laisse la ligne masquée. */
  (function () {
    var bloc = document.getElementById('instance-stats');
    if (!bloc || !window.fetch) return;
    fetch('/api/public/stats', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var n = data && data.servers;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return;
        bloc.querySelector('[data-stat="servers"]').textContent = n.toLocaleString('fr-FR');
        bloc.querySelector('[data-stat="unit"]').textContent = n > 1 ? 'serveurs' : 'serveur';
        bloc.hidden = false;
      })
      .catch(function () {});
  })();

  /* ---- Onglets « Sur votre serveur » (rôles tablist / tab / tabpanel) ---- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.qv-tabs [role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (other) {
      var selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.classList.toggle('is-active', selected);
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { selectTab(tab, false); });
    tab.addEventListener('keydown', function (event) {
      var moves = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -index, End: tabs.length - 1 - index };
      if (!(event.key in moves)) return;
      event.preventDefault();
      selectTab(tabs[(index + moves[event.key] + tabs.length) % tabs.length], true);
    });
  });

  /* ---- Préférence de mouvement ---- */
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var cinematicViewport = window.matchMedia('(min-width: 901px) and (min-height: 640px)');
  var manualReducedMotion = false;
  function motionIsReduced() { return reducedMotion.matches || manualReducedMotion; }

  if (!('IntersectionObserver' in window)) return;

  /* ---- Révélations ---- */
  var entryAnimations = new Set();
  function animateEntry(element, keyframes, delay, duration) {
    if (motionIsReduced() || !element.animate) return;
    var animation = element.animate(keyframes, {
      duration: duration || 850, delay: delay || 0, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards',
    });
    entryAnimations.add(animation);
    var discard = function () { entryAnimations.delete(animation); };
    animation.addEventListener('finish', discard, { once: true });
    animation.addEventListener('cancel', discard, { once: true });
  }
  // Découpe un titre en lignes (aux <br>), en gardant ses accents de couleur.
  function titleLines(title) {
    var existing = title.querySelectorAll(':scope > .title-line > span');
    if (existing.length) return Array.prototype.slice.call(existing);
    var fragments = [];
    var fragment = document.createDocumentFragment();
    Array.prototype.slice.call(title.childNodes).forEach(function (node) {
      if (node.nodeName === 'BR') {
        fragments.push(fragment);
        fragment = document.createDocumentFragment();
        node.remove();
      } else {
        fragment.append(node);
      }
    });
    fragments.push(fragment);
    return fragments.map(function (content) {
      var line = document.createElement('span');
      line.className = 'title-line';
      var inner = document.createElement('span');
      inner.append(content);
      line.append(inner);
      title.append(line);
      return inner;
    });
  }
  function revealTitle(title) {
    if (motionIsReduced()) return;
    titleLines(title).forEach(function (line, index) {
      animateEntry(line, [
        { transform: 'translateY(110%) rotate(2deg)', opacity: 0 },
        { transform: 'translateY(0) rotate(0deg)', opacity: 1 },
      ], index * 110, 1050);
    });
  }
  function revealBlock(element) {
    animateEntry(element, [
      { opacity: 0, transform: 'translateY(28px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ]);
  }
  // Rejouer à chaque arrivée par le bas, jamais pendant la remontée. Seuls les
  // éléments passés sous l'écran s'arment, et ils y attendent invisibles.
  function playOnArrival(elements, threshold, play) {
    var armed = new Set();
    function arm(element) {
      armed.add(element);
      element.classList.add('is-waiting');
    }
    var arrival = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || !armed.delete(entry.target)) return;
        entry.target.classList.remove('is-waiting');
        play(entry.target);
      });
    }, { threshold: threshold });
    // La zone couvre tout ce qui est au-dessus : un saut vers le haut qui fait
    // passer un élément de dessus à dessous en sort aussi.
    var below = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (!entry.isIntersecting) arm(entry.target); });
    }, { rootMargin: '99999px 0px 64px 0px' });
    Array.prototype.forEach.call(elements, function (element) {
      if (element.getBoundingClientRect().bottom >= 0) arm(element);
      arrival.observe(element);
      below.observe(element);
    });
  }
  playOnArrival(document.querySelectorAll('[data-title-reveal]'), 0.15, revealTitle);
  playOnArrival(document.querySelectorAll('[data-reveal]'), 0.08, revealBlock);

  // Entrée des trois fenêtres de l'ouverture, centre d'abord. La position finale
  // (profondeur comprise) est gardée pendant l'animation : sinon WebKit
  // réordonne les fenêtres à la fin de l'entrée.
  var panes = Array.prototype.slice.call(document.querySelectorAll('.qv-pane'));
  if (panes.length === 3) {
    [panes[1], panes[0], panes[2]].forEach(function (pane, index) {
      var rest = getComputedStyle(pane).transform;
      var base = rest === 'none' ? '' : ' ' + rest;
      animateEntry(pane, [
        { opacity: 0, transform: 'translateY(70px) scale(.92)' + base },
        { opacity: 1, transform: rest === 'none' ? 'none' : rest },
      ], 180 + index * 130, 1200);
    });
  }

  /* ---- Scène : séquence complète à l'arrivée, inverse à la remontée ---- */
  var story = document.querySelector('.qv-story');
  var chapters = story ? Array.prototype.slice.call(story.querySelectorAll('[data-chapter]')) : [];
  var progress = document.querySelector('.qv-progress span');
  var stack = document.querySelector('.qv-stack');
  function clamp(v) { return Math.min(1, Math.max(0, v)); }
  var scrollFrame = 0;
  var lastScrollY = window.scrollY;
  var direction = 1;
  var directionAnchor = window.scrollY;
  var wheelDirection = 0;
  var wheelAt = 0;
  var desiredOpen = false;
  var sceneOpen = false;
  var sequenceRunning = false;
  var sceneEnabled = null;
  var timers = new Set();

  function setChapter(chapter) {
    chapters.forEach(function (el, i) { el.classList.toggle('is-active', i === chapter); });
  }
  function later(callback, delay) {
    var t = setTimeout(function () { timers.delete(t); callback(); }, delay);
    timers.add(t);
  }
  function clearSequence() {
    timers.forEach(clearTimeout);
    timers.clear();
    sequenceRunning = false;
  }
  function setScene(open) {
    story.style.setProperty('--spread', open ? '1' : '0');
    story.style.setProperty('--shared', open ? '1' : '0');
  }
  function settleScene(open) {
    if (!story) return;
    clearSequence();
    desiredOpen = sceneOpen = open;
    story.classList.add('is-instant');
    story.dataset.phase = open ? 'open' : 'closed';
    setScene(open);
    setChapter(open ? 2 : 0);
    story.getBoundingClientRect(); // fige l'état avant de réactiver les transitions
    story.classList.remove('is-instant');
  }
  function playSequence(open) {
    desiredOpen = open;
    if (sequenceRunning || sceneOpen === open) return;
    sequenceRunning = true;
    story.dataset.phase = open ? 'opening' : 'closing';
    setChapter(open ? 0 : 2);
    setScene(open);
    later(function () { setChapter(1); }, open ? 280 : 160);
    later(function () { setChapter(open ? 2 : 0); }, open ? 900 : 740);
    // Ne pas couper une chorégraphie si le visiteur change de sens au milieu.
    later(function () {
      sceneOpen = open;
      sequenceRunning = false;
      story.dataset.phase = open ? 'open' : 'closed';
      if (desiredOpen !== open) playSequence(desiredOpen);
    }, 1300);
  }
  function renderScroll() {
    scrollFrame = 0;
    var y = window.scrollY;
    var total = root.scrollHeight - window.innerHeight;
    if (progress) progress.style.transform = 'scaleX(' + (total > 0 ? clamp(y / total) : 0) + ')';
    if (!story) return;
    var delta = y - lastScrollY;
    lastScrollY = y;
    if (performance.now() - wheelAt < 1200 && wheelDirection) {
      direction = wheelDirection;
      directionAnchor = y;
    } else if (Math.abs(y - directionAnchor) > 28) {
      direction = Math.sign(y - directionAnchor);
      directionAnchor = y;
    }
    var enabled = cinematicViewport.matches && !motionIsReduced();
    var bounds = story.getBoundingClientRect();
    if (enabled !== sceneEnabled) {
      sceneEnabled = enabled;
      settleScene(!enabled || bounds.bottom < 100);
    }
    if (!enabled) return;
    // Déclenchement plus tôt que sur Steam Upgraded (82 % du bloc) : la scène
    // de Quasar est haute, elle partait trop tard. Elle s'ouvre dès que la
    // moitié de ce qui peut tenir à l'écran est visible.
    var visible = Math.min(window.innerHeight - 20, bounds.bottom) - Math.max(90, bounds.top);
    var room = Math.min(bounds.height, window.innerHeight - 110);
    var framed = visible / room > 0.5;
    if (bounds.top > window.innerHeight) {
      if (desiredOpen) playSequence(false);
    } else if (bounds.bottom < 0) {
      if (!desiredOpen) playSequence(true);
    } else if (framed && (delta !== 0 || !sceneOpen)) {
      playSequence(direction > 0);
    }
  }
  function scheduleScroll() { if (!scrollFrame) scrollFrame = requestAnimationFrame(renderScroll); }
  window.addEventListener('wheel', function (event) {
    if (Math.abs(event.deltaY) < 3 || event.ctrlKey) return;
    wheelDirection = Math.sign(event.deltaY);
    wheelAt = performance.now();
  }, { passive: true });
  window.addEventListener('pointerdown', function () { wheelDirection = 0; directionAnchor = window.scrollY; }, { passive: true });
  window.addEventListener('keydown', function (event) {
    if (['ArrowUp', 'PageUp', 'Home'].indexOf(event.key) !== -1) direction = -1;
    else if (['ArrowDown', 'PageDown', 'End', ' '].indexOf(event.key) !== -1) direction = event.shiftKey ? -1 : 1;
    else return;
    wheelDirection = 0;
    directionAnchor = window.scrollY;
  });
  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', scheduleScroll, { passive: true });
  window.addEventListener('pageshow', scheduleScroll);
  if (cinematicViewport.addEventListener) cinematicViewport.addEventListener('change', scheduleScroll);

  // Le flottement ne tourne que lorsque les fenêtres sont visibles et l'onglet actif.
  var stackVisible = false;
  function syncFloat() {
    if (stack) stack.classList.toggle('is-floating', stackVisible && !document.hidden && !motionIsReduced());
  }
  if (stack) {
    new IntersectionObserver(function (entries) {
      stackVisible = entries[0].isIntersecting;
      syncFloat();
    }).observe(stack);
  }

  var motionToggle = document.getElementById('qv-motion');
  function syncMotionPreference() {
    var reduce = motionIsReduced();
    root.classList.toggle('reduce-motion', reduce);
    if (reduce) {
      entryAnimations.forEach(function (a) { a.cancel(); });
      Array.prototype.forEach.call(document.querySelectorAll('.is-waiting'), function (el) { el.classList.remove('is-waiting'); });
      settleScene(true);
    }
    if (motionToggle) {
      motionToggle.setAttribute('aria-pressed', String(reduce));
      motionToggle.textContent = reduce ? 'Animations réduites' : 'Animations actives';
      motionToggle.disabled = reducedMotion.matches;
    }
    syncFloat();
    scheduleScroll();
  }
  if (motionToggle) {
    motionToggle.addEventListener('click', function () {
      manualReducedMotion = !manualReducedMotion;
      syncMotionPreference();
    });
    motionToggle.hidden = false;
  }
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', syncMotionPreference);
  document.addEventListener('visibilitychange', function () {
    syncFloat();
    if (document.hidden && sequenceRunning) settleScene(desiredOpen);
    if (!document.hidden) scheduleScroll();
  });
  window.addEventListener('pagehide', function () {
    settleScene(desiredOpen);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  });
  syncMotionPreference();
  renderScroll();
})();
