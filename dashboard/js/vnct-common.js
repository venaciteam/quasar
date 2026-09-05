/* ============================================================================
   VNCT Common — vnct-common.js
   Version : 1.0.0
   Date    : 2026-03-21

   Ce fichier est la SOURCE DE VÉRITÉ pour tout le comportement JS partagé.
   Il doit être chargé sur CHAQUE page de chaque service VNCT.
   NE PAS dupliquer ces fonctionnalités dans les scripts spécifiques aux services.

   Fonctionnalités :
   1. VNCT — Namespace global & initialisation
   2. Theme — Toggle clair/sombre
   3. Accent — Rose fixe (pas de personnalisation)
   4. Toast — Système de notifications
   5. Feedback — Bouton drapeau flottant + modale de signalement (bug / idée)
   6. PageTransition — Animations de navigation style Windows Phone
   7. Modal — Gestion des modals
   8. Webhook — Envoi vers Discord

   Usage :
   <script src="vnct-common.js"></script>
   Le script s'initialise automatiquement au DOMContentLoaded.
   ============================================================================ */

(function () {
  'use strict';

  /* ==========================================================================
     1. NAMESPACE GLOBAL & INITIALISATION
     ========================================================================== */

  const VNCT = {
    version: '1.1.0',
    config: {
      // Préfixe pour les clés localStorage
      storagePrefix: 'vnct_',
      // Domaine pour le cookie cross-service
      cookieDomain: '.vena.city',
      // Durée du cookie (365 jours)
      cookieMaxAge: 365 * 24 * 60 * 60,
      // Durée par défaut des toasts (ms)
      toastDuration: 4000,
      // URL du webhook Discord (à configurer par service)
      discordWebhookUrl: '',
      // Nom du service courant (à configurer par service)
      serviceName: 'Venacity',
      // Version du service courant
      serviceVersion: '1.0.0',
    },

    /** Initialise tout le système VNCT. Appelé automatiquement. */
    init() {
      VNCT.Theme.init();
      VNCT.Accent.init();
      VNCT.Toast.init();
      VNCT.Feedback.init();
      VNCT.Modal.init();
      VNCT.VersionBadge.init();
      VNCT.Nav.init();
    },
  };

  /* ==========================================================================
     1b. UTILITAIRES INTERNES
     ========================================================================== */

  /**
   * Force un reflow sur un ou plusieurs éléments pour re-déclencher les animations CSS.
   * @param {...HTMLElement} els — Éléments à forcer
   */
  VNCT._forceReflow = function (...els) {
    for (const el of els) {
      el.style.animation = 'none';
    }
    els[0].offsetHeight; // un seul reflow suffit pour tout le batch
    for (const el of els) {
      el.style.animation = '';
    }
  };

  /* ==========================================================================
     2. THEME — Toggle clair/sombre
     Stocké en localStorage ET en cookie cross-domain.
     Attribut : data-theme="dark" | "light" sur <html>
     ========================================================================== */

  VNCT.Theme = {
    _current: 'dark',

    init() {
      // Lire la préférence sauvegardée
      const saved = VNCT._storage.get('theme');
      if (saved === 'light' || saved === 'dark') {
        this._current = saved;
      } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        this._current = 'light';
      } else {
        this._current = 'dark';
      }
      this._apply();
    },

    /** @returns {'dark'|'light'} */
    get() {
      return this._current;
    },

    /** Bascule entre dark et light */
    toggle() {
      this._current = this._current === 'dark' ? 'light' : 'dark';
      this._apply();
      this._save();
    },

    /** Force un thème spécifique
     * @param {'dark'|'light'} theme
     */
    set(theme) {
      if (theme !== 'dark' && theme !== 'light') return;
      this._current = theme;
      this._apply();
      this._save();
    },

    _apply() {
      document.documentElement.setAttribute('data-theme', this._current);
    },

    _save() {
      VNCT._storage.set('theme', this._current);
      VNCT._cookie.set('theme', this._current);
    },
  };

  /* ==========================================================================
     3. ACCENT — Rose FIXE (pas de personnalisation)
     L'accent est toujours "rose". Aucun sélecteur, aucun changement possible.
     Attribut : data-accent="rose" sur <html> — FIXE, ne change JAMAIS.
     ========================================================================== */

  VNCT.Accent = {
    _current: 'rose',

    init() {
      // Rose est fixe. On force toujours l'attribut.
      this._apply();
    },

    /** @returns {string} Toujours 'rose' */
    get() {
      return this._current;
    },

    _apply() {
      document.documentElement.setAttribute('data-accent', 'rose');
    },
  };

  /* ==========================================================================
     4. TOAST — Système de notifications
     ========================================================================== */

  VNCT.Toast = {
    _container: null,

    init() {
      // Réutiliser le container existant ou en créer un
      this._container = document.querySelector('.vnct-toast-container');
      if (!this._container) {
        this._container = document.createElement('div');
        this._container.className = 'vnct-toast-container';
        this._container.setAttribute('role', 'status');
        this._container.setAttribute('aria-live', 'polite');
        document.body.appendChild(this._container);
      }
    },

    /**
     * Affiche un toast
     * @param {Object} options
     * @param {string} options.message — Texte du toast
     * @param {'info'|'success'|'warning'|'error'} [options.type='info']
     * @param {string} [options.title] — Titre optionnel
     * @param {number} [options.duration] — Durée en ms (0 = permanent)
     * @returns {HTMLElement} L'élément toast créé
     */
    show({ message, type = 'info', title = '', duration = VNCT.config.toastDuration }) {
      if (!this._container) this.init();

      const toast = document.createElement('div');
      toast.className = `vnct-toast vnct-toast--${type}`;
      toast.setAttribute('role', 'alert');

      // Icône
      const iconSvg = this._getIcon(type);
      const iconEl = document.createElement('div');
      iconEl.className = 'vnct-toast__icon';
      iconEl.innerHTML = iconSvg;

      // Contenu
      const contentEl = document.createElement('div');
      contentEl.className = 'vnct-toast__content';

      if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'vnct-toast__title';
        titleEl.textContent = title;
        contentEl.appendChild(titleEl);
      }

      const msgEl = document.createElement('div');
      msgEl.className = 'vnct-toast__message';
      msgEl.textContent = message;
      contentEl.appendChild(msgEl);

      // Bouton fermer
      const closeEl = document.createElement('button');
      closeEl.className = 'vnct-toast__close';
      closeEl.innerHTML = '&times;';
      closeEl.setAttribute('aria-label', 'Fermer');
      closeEl.addEventListener('click', () => this._dismiss(toast));

      toast.appendChild(iconEl);
      toast.appendChild(contentEl);
      toast.appendChild(closeEl);

      this._container.appendChild(toast);

      // Auto-dismiss
      if (duration > 0) {
        setTimeout(() => this._dismiss(toast), duration);
      }

      return toast;
    },

    /** Raccourcis typés */
    success(message, title) { return this.show({ message, title, type: 'success' }); },
    error(message, title)   { return this.show({ message, title, type: 'error' }); },
    warning(message, title) { return this.show({ message, title, type: 'warning' }); },
    info(message, title)    { return this.show({ message, title, type: 'info' }); },

    _dismiss(toast) {
      if (!toast || !toast.parentNode) return;
      toast.classList.add('vnct-toast--closing');
      // Supprime le toast après l'animation de fermeture
      // Fallback setTimeout au cas où animationend ne se déclenche pas
      const remove = () => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      };
      toast.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 500);
    },

    _getIcon(type) {
      const icons = {
        success: '<svg viewBox="0 0 20 20" fill="currentColor" style="color:var(--success)"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
        error: '<svg viewBox="0 0 20 20" fill="currentColor" style="color:var(--danger)"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>',
        warning: '<svg viewBox="0 0 20 20" fill="currentColor" style="color:var(--warning)"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
        info: '<svg viewBox="0 0 20 20" fill="currentColor" style="color:var(--accent)"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>',
      };
      return icons[type] || icons.info;
    },
  };

  /* ==========================================================================
     5. FEEDBACK — Bouton drapeau flottant + modale unifiée de signalement

     Remplace l'ancien FAB (pastille ronde + menu à trois entrées), résidu du
     design system historique. Le parcours est désormais celui de la vitrine :
     UN bouton drapeau, UNE modale, et le choix « bug » ou « idée » se fait
     DANS la modale.

     Pourquoi une reprise locale et pas VNCT.Feedback du DS centralisé : le
     dashboard embarque sa propre copie du design system. Charger en plus le DS
     de design.vena.city ferait cohabiter deux définitions de window.VNCT, donc
     deux VNCT.Modal et deux VNCT.Theme — le pop-up des nouveautés et la bascule
     de thème y passeraient. On reproduit donc le parcours ici, à partir des
     formulaires locaux qui postent déjà sur Sema.
     ========================================================================== */

  VNCT.Feedback = {
    _buttonEl: null,
    // Élément qui avait le focus avant l'ouverture. VNCT.Modal.open() le capture
    // lui-même, mais chaque étape du parcours (choix → formulaire → retour)
    // rappelle open() : sans ce report, la fermeture rendrait le focus à un
    // bouton d'étape déjà retiré du DOM au lieu du drapeau.
    _opener: null,

    init() {
      // Le bouton est déclaré dans le HTML de la page (dashboard/app.html) :
      // il s'y relit et s'y revoit. Repli sur un rendu JS pour les pages du
      // dashboard qui ne le déclarent pas (page de connexion), afin qu'aucune
      // d'elles ne perde son entrée de signalement.
      this._buttonEl = document.querySelector('[data-vnct-report]');
      if (!this._buttonEl) this._render();

      this._buttonEl.addEventListener('click', () => this.open());
    },

    _render() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vnct-report-fab';
      btn.setAttribute('data-vnct-report', '');
      btn.setAttribute('title', 'Signaler ou proposer');
      btn.setAttribute('aria-label', 'Signaler ou proposer');
      btn.innerHTML = VNCT.Feedback._FLAG_SVG;
      document.body.appendChild(btn);
      this._buttonEl = btn;
    },

    /** Drapeau du chrome de la vitrine (public/partials/header.html), à l'identique. */
    _FLAG_SVG: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',

    /** Point d'entrée unique : ouvre l'écran de choix. */
    open() {
      this._opener = document.activeElement;
      this._openChoice();
    },

    /** Étape 1 — quel type de retour ? */
    _openChoice() {
      VNCT.Modal.open({
        title: 'Signaler ou proposer',
        body: `
          <p class="vnct-feedback-intro">Que souhaitez-vous m'envoyer ?</p>
          <div class="vnct-feedback-choices">
            <button type="button" class="vnct-feedback-choice" data-feedback-choice="bug">
              <span class="vnct-feedback-choice__icon" aria-hidden="true">🐛</span>
              <span class="vnct-feedback-choice__text">
                <span class="vnct-feedback-choice__title">Signaler un bug</span>
                <span class="vnct-feedback-choice__desc">Quelque chose ne fonctionne pas comme prévu.</span>
              </span>
            </button>
            <button type="button" class="vnct-feedback-choice" data-feedback-choice="suggestion">
              <span class="vnct-feedback-choice__icon" aria-hidden="true">✨</span>
              <span class="vnct-feedback-choice__text">
                <span class="vnct-feedback-choice__title">Proposer une idée</span>
                <span class="vnct-feedback-choice__desc">Une amélioration ou une fonctionnalité à me suggérer.</span>
              </span>
            </button>
          </div>
        `,
        isHtml: true,
      });
      this._restoreOpenerFocusTarget();

      VNCT.Modal._modalEl.querySelectorAll('[data-feedback-choice]').forEach((btn) => {
        btn.addEventListener('click', () => this._openForm(btn.getAttribute('data-feedback-choice')));
      });
    },

    /**
     * Étape 2 — le formulaire correspondant au choix.
     * @param {'bug'|'suggestion'} type
     */
    _openForm(type) {
      const isBug = type === 'bug';

      VNCT.Modal.open({
        title: isBug ? '🐛 Signaler un bug' : '✨ Proposer une idée',
        body: isBug ? this._buildBugForm() : this._buildSuggestionForm(),
        isHtml: true,
      });
      this._restoreOpenerFocusTarget();

      // L'ordre compte : _initUploadField câble un HTML qui doit déjà être dans
      // le DOM. Appelé avant Modal.open(), il ne trouverait rien.
      this._initUploadField(VNCT.Modal._modalEl);

      const back = VNCT.Modal._modalEl.querySelector('[data-feedback-back]');
      if (back) back.addEventListener('click', () => this._openChoice());
    },

    /** Rend à VNCT.Modal la cible de focus d'origine après un changement d'étape. */
    _restoreOpenerFocusTarget() {
      if (this._opener) VNCT.Modal._previousFocus = this._opener;
    },

    /** Formulaire Bug Report */
    _buildBugForm() {
      const techInfo = VNCT.Feedback._getTechInfo();
      return `
        <form class="vnct-feedback-form" data-feedback-type="bug">
          <label class="vnct-label">DESCRIPTION DU PROBLÈME</label>
          <textarea class="vnct-textarea" name="description" rows="4"
            placeholder="Décrivez le problème rencontré..."
            required></textarea>

          <label class="vnct-label" style="margin-top: var(--space-4);">ÉTAPES POUR REPRODUIRE</label>
          <textarea class="vnct-textarea" name="steps" rows="3"
            placeholder="1. J'ai ouvert la page\n2. J'ai cliqué sur...\n3. ..."></textarea>

          <label class="vnct-label" style="margin-top: var(--space-4);">CAPTURES D'ÉCRAN <span style="color: var(--text-muted); font-weight: var(--font-normal); text-transform: none;">optionnel, max 12 Mo par image</span></label>
          ${VNCT.Feedback._buildUploadField()}

          <label class="vnct-label" style="margin-top: var(--space-4);">CONTACT <span style="color: var(--text-muted); font-weight: var(--font-normal); text-transform: none;">optionnel</span></label>
          <input class="vnct-input" name="contact" type="text"
            placeholder="Email, Discord, Twitter..." />

          <div class="vnct-tech-info" style="margin-top: var(--space-4); padding: var(--space-3); background: var(--bg-tertiary); border-radius: var(--radius-sm); font-family: monospace; font-size: var(--text-xs); color: var(--text-muted); line-height: 1.6;">
            <div style="margin-bottom: var(--space-1); color: var(--text-secondary); font-family: var(--font-family); font-weight: var(--font-medium);">Infos techniques (auto)</div>
            <div>Version : ${techInfo.version}</div>
            <div>Plateforme : ${techInfo.platform}</div>
            <div>Navigateur : ${techInfo.userAgent}</div>
            <div>Date : ${techInfo.date}</div>
          </div>

          ${VNCT.Feedback._buildFormActions()}
        </form>
      `;
    },

    /** Formulaire Suggestion */
    _buildSuggestionForm() {
      const techInfo = VNCT.Feedback._getTechInfo();
      return `
        <form class="vnct-feedback-form" data-feedback-type="suggestion">
          <label class="vnct-label">VOTRE IDÉE OU SUGGESTION</label>
          <textarea class="vnct-textarea" name="description" rows="4"
            placeholder="J'aimerais pouvoir..."
            required></textarea>

          <label class="vnct-label" style="margin-top: var(--space-4);">CAPTURES D'ÉCRAN <span style="color: var(--text-muted); font-weight: var(--font-normal); text-transform: none;">optionnel, max 12 Mo par image</span></label>
          ${VNCT.Feedback._buildUploadField()}

          <label class="vnct-label" style="margin-top: var(--space-4);">CONTACT <span style="color: var(--text-muted); font-weight: var(--font-normal); text-transform: none;">optionnel</span></label>
          <input class="vnct-input" name="contact" type="text"
            placeholder="Email, Discord, Twitter..." />

          <div class="vnct-tech-info" style="margin-top: var(--space-4); padding: var(--space-3); background: var(--bg-tertiary); border-radius: var(--radius-sm); font-family: monospace; font-size: var(--text-xs); color: var(--text-muted); line-height: 1.6;">
            <div style="margin-bottom: var(--space-1); color: var(--text-secondary); font-family: var(--font-family); font-weight: var(--font-medium);">Infos techniques (auto)</div>
            <div>Version : ${techInfo.version}</div>
            <div>Plateforme : ${techInfo.platform}</div>
            <div>Navigateur : ${techInfo.userAgent}</div>
            <div>Date : ${techInfo.date}</div>
          </div>

          ${VNCT.Feedback._buildFormActions()}
        </form>
      `;
    },

    /**
     * Pied des deux formulaires. « Retour » ramène au choix : personne ne doit
     * avoir à refermer la modale pour corriger le type de retour choisi.
     */
    _buildFormActions() {
      return `
        <div class="vnct-feedback-actions">
          <button type="button" class="vnct-btn vnct-btn--ghost" data-feedback-back>Retour</button>
          <button type="submit" class="vnct-btn vnct-btn--primary">Envoyer</button>
        </div>
      `;
    },

    /** Retourne le HTML du champ upload multi-images (utilisé dans bug & suggestion) */
    _buildUploadField() {
      return `
        <div class="vnct-upload" data-max-files="10">
          <input type="file" name="screenshots" accept="image/*" multiple class="vnct-upload__input" />
          <div class="vnct-upload__dropzone">
            <svg class="vnct-upload__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
            <span class="vnct-upload__text">Ajouter des captures</span>
          </div>
          <div class="vnct-upload__gallery"></div>
        </div>
      `;
    },

    /**
     * Initialise les interactions du champ upload multi-images.
     * Appelé après injection du HTML dans le DOM (via Modal.open).
     * @param {HTMLElement} container — le form ou le modal body
     */
    _initUploadField(container) {
      const upload = container.querySelector('.vnct-upload');
      if (!upload) return;

      const input = upload.querySelector('.vnct-upload__input');
      const dropzone = upload.querySelector('.vnct-upload__dropzone');
      const gallery = upload.querySelector('.vnct-upload__gallery');
      const maxFiles = parseInt(upload.getAttribute('data-max-files') || '10', 10);

      const MAX_SIZE = 12 * 1024 * 1024; // 12 Mo par image

      // Stocker les fichiers sur l'élément upload pour récupération au submit
      upload._files = [];

      /** Ajoute un fichier à la liste et affiche sa preview */
      const addFile = (file) => {
        if (!file || !file.type.startsWith('image/')) {
          VNCT.Toast.warning('Seules les images sont acceptées.');
          return;
        }
        if (file.size > MAX_SIZE) {
          VNCT.Toast.warning('Image trop lourde (max 12 Mo).');
          return;
        }
        if (upload._files.length >= maxFiles) {
          VNCT.Toast.warning(`Maximum ${maxFiles} images.`);
          return;
        }

        upload._files.push(file);
        updateGallery();
      };

      /** Met à jour la galerie de previews */
      const updateGallery = () => {
        gallery.innerHTML = '';
        upload._files.forEach((file, idx) => {
          const item = document.createElement('div');
          item.className = 'vnct-upload__preview';

          const img = document.createElement('img');
          img.className = 'vnct-upload__img';
          img.alt = 'Aperçu';

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'vnct-upload__remove';
          removeBtn.setAttribute('aria-label', 'Retirer l\'image');
          removeBtn.innerHTML = '&times;';
          removeBtn.addEventListener('click', () => {
            upload._files.splice(idx, 1);
            updateGallery();
          });

          item.appendChild(img);
          item.appendChild(removeBtn);
          gallery.appendChild(item);

          // Charger la preview
          const reader = new FileReader();
          reader.onload = (e) => { img.src = e.target.result; };
          reader.readAsDataURL(file);
        });

        // Masquer la dropzone si max atteint, sinon l'afficher
        dropzone.style.display = upload._files.length >= maxFiles ? 'none' : 'flex';
      };

      // Clic sur la dropzone → ouvre le sélecteur
      dropzone.addEventListener('click', () => input.click());

      // Sélection via input file (multiple)
      input.addEventListener('change', () => {
        if (input.files) {
          for (const file of input.files) addFile(file);
        }
        input.value = ''; // reset pour pouvoir re-sélectionner le même fichier
      });

      // Drag & drop
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('vnct-upload__dropzone--dragover');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('vnct-upload__dropzone--dragover');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('vnct-upload__dropzone--dragover');
        if (e.dataTransfer.files) {
          for (const file of e.dataTransfer.files) addFile(file);
        }
      });
    },

    /** Récupère les infos techniques pour les formulaires et le webhook */
    _getTechInfo() {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      return {
        version: `${VNCT.config.serviceName} v${VNCT.config.serviceVersion}`,
        platform: /mobile|android|iphone|ipad/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop',
        userAgent: navigator.userAgent,
        date: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      };
    },
  };

  /* ==========================================================================
     6. PAGE TRANSITION — Style Windows Phone
     ========================================================================== */

  VNCT.PageTransition = {
    /**
     * Navigue vers une URL avec transition animée.
     * @param {string} url — URL de destination
     * @param {'forward'|'back'} [direction='forward']
     */
    navigate(url, direction = 'forward') {
      const currentPage = document.querySelector('.vnct-page');
      if (!currentPage) {
        window.location.href = url;
        return;
      }

      const exitClass = direction === 'forward'
        ? 'vnct-page-transition--exit-left'
        : 'vnct-page-transition--exit-right';

      currentPage.classList.add(exitClass);

      currentPage.addEventListener('animationend', () => {
        // Stocker la direction pour la page suivante
        sessionStorage.setItem(VNCT.config.storagePrefix + 'page_direction', direction);
        window.location.href = url;
      }, { once: true });
    },

    /**
     * Applique l'animation d'entrée si une transition est en cours.
     * À appeler au chargement de la page.
     */
    applyEntrance() {
      const direction = sessionStorage.getItem(VNCT.config.storagePrefix + 'page_direction');
      sessionStorage.removeItem(VNCT.config.storagePrefix + 'page_direction');

      if (!direction) return;

      const page = document.querySelector('.vnct-page');
      if (!page) return;

      const enterClass = direction === 'forward'
        ? 'vnct-page-transition--enter-right'
        : 'vnct-page-transition--enter-left';

      page.classList.add(enterClass);
      page.addEventListener('animationend', () => {
        page.classList.remove(enterClass);
      }, { once: true });
    },
  };

  /* ==========================================================================
     7. MODAL — Gestion des modals
     ========================================================================== */

  VNCT.Modal = {
    _overlayEl: null,
    _modalEl: null,
    _isOpen: false,
    _previousFocus: null,

    init() {
      // Créer les éléments si pas présents
      if (!document.querySelector('.vnct-modal-overlay')) {
        this._overlayEl = document.createElement('div');
        this._overlayEl.className = 'vnct-modal-overlay';
        this._overlayEl.setAttribute('aria-hidden', 'true');
        this._overlayEl.style.display = 'none';

        this._modalEl = document.createElement('div');
        this._modalEl.className = 'vnct-modal';
        this._modalEl.setAttribute('role', 'dialog');
        this._modalEl.setAttribute('aria-modal', 'true');

        this._overlayEl.appendChild(this._modalEl);
        document.body.appendChild(this._overlayEl);
      } else {
        this._overlayEl = document.querySelector('.vnct-modal-overlay');
        this._modalEl = document.querySelector('.vnct-modal');
      }

      // Fermer au clic sur l'overlay
      this._overlayEl.addEventListener('click', (e) => {
        if (e.target === this._overlayEl) this.close();
      });

      // Fermer avec Escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._isOpen) this.close();
      });

      // Écouter les soumissions de formulaire feedback
      document.addEventListener('submit', async (e) => {
        const form = e.target.closest('.vnct-feedback-form');
        if (!form) return;
        e.preventDefault();
        const type = form.getAttribute('data-feedback-type');
        const description = form.querySelector('[name="description"]')?.value.trim();
        if (!description) return;
        const steps = form.querySelector('[name="steps"]')?.value.trim() || '';
        const contact = form.querySelector('[name="contact"]')?.value.trim() || '';

        // Récupérer les fichiers screenshots (optionnel, multi-images)
        const upload = form.querySelector('.vnct-upload');
        const screenshots = upload?._files?.length ? [...upload._files] : [];

        // Désactiver le bouton pendant l'envoi
        const submitBtn = form.querySelector('[type="submit"]');
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Envoi…';
        }

        const success = await VNCT.Webhook.sendFeedback(type, { description, steps, contact, screenshots });
        VNCT.Modal.close();
        if (success) {
          VNCT.Toast.success('Merci pour votre retour !');
        }
      });
    },

    /**
     * Ouvre une modal
     * @param {Object} options
     * @param {string} options.title
     * @param {string} options.body — Contenu texte ou HTML
     * @param {boolean} [options.isHtml=false]
     * @param {string} [options.footer] — HTML pour le footer
     */
    open({ title, body, isHtml = false, footer = '' }) {
      this._previousFocus = document.activeElement;

      let html = `
        <div class="vnct-modal__header">
          <h3 class="vnct-modal__title">${this._escapeHtml(title)}</h3>
          <button class="vnct-modal__close" aria-label="Fermer">&times;</button>
        </div>
        <div class="vnct-modal__body">
          ${isHtml ? body : '<p>' + this._escapeHtml(body) + '</p>'}
        </div>
      `;

      if (footer) {
        html += `<div class="vnct-modal__footer">${footer}</div>`;
      }

      this._modalEl.innerHTML = html;

      // Re-trigger CSS animations on modal + overlay (force reflow)
      this._overlayEl.style.display = 'flex';
      VNCT._forceReflow(this._modalEl, this._overlayEl);

      this._overlayEl.setAttribute('aria-hidden', 'false');
      this._isOpen = true;

      // Fermer via le bouton X
      const closeBtn = this._modalEl.querySelector('.vnct-modal__close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.close());
      }

      // Animate modal body children (staggered entrance)
      this._animateModalContent();

      // Focus trap
      requestAnimationFrame(() => {
        const firstFocusable = this._modalEl.querySelector(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (firstFocusable) firstFocusable.focus();
      });

      // Empêcher le scroll du body
      document.body.style.overflow = 'hidden';
    },

    close() {
      if (!this._isOpen) return;

      // Animate modal content out (reverse stagger)
      this._animateModalContentOut();

      this._overlayEl.classList.add('vnct-modal-overlay--closing');

      let closed = false;
      const onEnd = () => {
        if (closed) return;
        closed = true;
        this._overlayEl.style.display = 'none';
        this._overlayEl.setAttribute('aria-hidden', 'true');
        this._overlayEl.classList.remove('vnct-modal-overlay--closing');
        this._isOpen = false;
        document.body.style.overflow = '';
        // Clear animations so they can replay on next open
        this._clearModalAnimations();
        if (this._previousFocus) this._previousFocus.focus();
      };

      // Wait for the modal scale-out to finish (not children fade-outs)
      this._modalEl.addEventListener('animationend', (e) => {
        if (e.target === this._modalEl) onEnd();
      }, { once: true });

      // Fallback si pas d'animation (prefers-reduced-motion)
      setTimeout(onEnd, 500);
    },

    /**
     * Récupère les éléments à animer dans le body du modal.
     * Si le body contient un formulaire (.vnct-feedback-form),
     * anime les enfants du form (chaque champ) au lieu du form en bloc.
     */
    _getAnimTargets() {
      const body = this._modalEl.querySelector('.vnct-modal__body');
      if (!body) return [];
      const form = body.querySelector('.vnct-feedback-form');
      if (form) {
        // Animer chaque enfant direct du form (label, textarea, input, div, etc.)
        return Array.from(form.children);
      }
      // Pas de form → animer les enfants directs du body (écran de choix du
      // signalement, pop-up des nouveautés…)
      return Array.from(body.children);
    },

    // Staggered entrance for modal body children
    _animateModalContent() {
      requestAnimationFrame(() => {
        const targets = this._getAnimTargets();
        for (let i = 0; i < targets.length; i++) {
          const child = targets[i];
          child.style.animation = 'none';
          child.offsetHeight;
          child.style.animation = `vnct-appear 450ms cubic-bezier(0.16, 1, 0.3, 1) ${80 + i * 50}ms backwards`;
        }
        const footer = this._modalEl.querySelector('.vnct-modal__footer');
        if (footer) {
          footer.style.animation = 'none';
          footer.offsetHeight;
          footer.style.animation = `vnct-appear 450ms cubic-bezier(0.16, 1, 0.3, 1) ${80 + targets.length * 50}ms backwards`;
        }
      });
    },

    // Fade out content before modal closes
    _animateModalContentOut() {
      const targets = this._getAnimTargets();
      for (let i = 0; i < targets.length; i++) {
        targets[i].style.animation = `vnct-fade-out 150ms ease ${i * 30}ms forwards`;
      }
      const footer = this._modalEl.querySelector('.vnct-modal__footer');
      if (footer) {
        footer.style.animation = `vnct-fade-out 150ms ease forwards`;
      }
    },

    // Clear inline animations so next open can replay them
    _clearModalAnimations() {
      const targets = this._getAnimTargets();
      for (const child of targets) {
        child.style.animation = '';
      }
      const footer = this._modalEl.querySelector('.vnct-modal__footer');
      if (footer) footer.style.animation = '';
    },

    _escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    },
  };

  /* ==========================================================================
     8. DEVREPORT — Envoi vers le DevPortal (dev.vena.city)
     ========================================================================== */

  VNCT.Webhook = {
    /**
     * Envoie un feedback (bug ou suggestion) au DevPortal.
     * Utilise l'API publique POST /api/public/report (multipart/form-data).
     * Supporte les screenshots (max 10 fichiers, 12 Mo chacun).
     * @param {'bug'|'suggestion'} type
     * @param {Object} data — { description, steps?, contact?, screenshots? }
     */
    async sendFeedback(type, data) {
      // Envoie via le relay local /api/feedback/vnct qui forward au DevPortal.
      // Pas d'appel direct à dev.vena.city — évite les problèmes de CORS
      // et permet à chaque instance Quasar de remonter les reports.
      const relayUrl = VNCT.config.discordWebhookUrl || '/api/feedback/vnct';

      const techInfo = VNCT.Feedback._getTechInfo();
      const screenshots = data.screenshots || [];

      // Construction du FormData (multipart/form-data)
      const formData = new FormData();
      formData.append('type', type);
      formData.append('service', VNCT.config.serviceName || 'Unknown');
      formData.append('service_version', VNCT.config.serviceVersion || '');
      formData.append('description', data.description);
      if (data.steps) formData.append('steps', data.steps);
      if (data.contact) formData.append('contact', data.contact);
      formData.append('platform', techInfo.platform);
      formData.append('browser', navigator.userAgent.substring(0, 200));
      formData.append('url', window.location.href);

      // Screenshots (max 10, champ "screenshots" attendu par le DevPortal)
      screenshots.slice(0, 10).forEach((file) => {
        formData.append('screenshots', file, file.name || 'screenshot.png');
      });

      try {
        const res = await fetch(relayUrl, {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error('[VNCT] DevReport error:', res.status, body);
          if (res.status === 429) {
            VNCT.Toast.error('Trop de reports envoyés. Réessayez dans une minute.');
          } else {
            VNCT.Toast.error(body.error || 'Erreur lors de l\'envoi. Réessayez plus tard.');
          }
          return false;
        }

        return true;
      } catch (err) {
        console.error('[VNCT] DevReport error:', err);
        VNCT.Toast.error('Impossible de contacter le serveur. Réessayez plus tard.');
        return false;
      }
    },
  };

  /* ==========================================================================
     9. VERSION BADGE — version courante + mentions de licence AGPL-3.0

     Quasar est sous AGPL-3.0. Son article 13 impose d'offrir de façon VISIBLE
     le code source correspondant à quiconque utilise le logiciel à distance par
     un réseau. Sur une instance dont le code a été modifié, ce lien doit mener
     à la source de CETTE instance, pas au dépôt d'origine : d'où la valeur
     servie par /api/instance, et jamais une URL écrite en dur.

     Pourquoi ici. Le badge est le seul élément présent sur toutes les pages du
     dashboard et à tous les formats. La barre latérale ne l'est pas : sous
     768 px elle est hors écran (translateX(-100%)) et aucun bouton ne l'ouvre.

     Pourquoi sans interaction. Ces mentions vivaient dans un panneau « Késako »
     ouvert au clic sur un bouton flottant. Le bouton a été retiré, et
     l'information est devenue injoignable sans que personne ne le voie. Un lien
     visible en permanence ne peut pas subir ça : rien à déplier ici.

     Les deux fentes sont créées vides et remplies par dashboard/js/instance.js
     au retour de /api/instance. Restées vides (serveur muet, réseau coupé, JS
     de l'instance absent), le CSS les masque via `:empty` : le badge garde sa
     version et n'affiche jamais un lien vide ou mort.
     ========================================================================== */

  VNCT.VersionBadge = {
    init() {
      // Ne pas recréer si déjà présent
      if (document.querySelector('.vnct-version-badge')) return;

      const badge = document.createElement('div');
      badge.className = 'vnct-version-badge';

      badge.appendChild(VNCT.VersionBadge._item(`v${VNCT.config.serviceVersion}`));
      // Le code source d'abord : c'est lui que l'AGPL exige, l'hébergeur suit.
      badge.appendChild(VNCT.VersionBadge._slot('data-instance-source'));
      badge.appendChild(VNCT.VersionBadge._slot('data-instance-operator'));

      document.body.appendChild(badge);
    },

    /** Segment de texte simple du badge. */
    _item(text) {
      const el = document.createElement('span');
      el.className = 'vnct-version-badge__item';
      el.textContent = text;
      return el;
    },

    /** Segment vide, identifié par son attribut, à remplir par instance.js. */
    _slot(attr) {
      const el = document.createElement('span');
      el.className = 'vnct-version-badge__item';
      el.setAttribute(attr, '');
      return el;
    },
  };

  /* ==========================================================================
     UTILITAIRES INTERNES — Storage & Cookie
     ========================================================================== */

  VNCT._storage = {
    get(key) {
      try {
        return localStorage.getItem(VNCT.config.storagePrefix + key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(VNCT.config.storagePrefix + key, value);
      } catch {
        // localStorage indisponible
      }
    },
  };

  VNCT._cookie = {
    get(key) {
      const name = VNCT.config.storagePrefix + key + '=';
      const decoded = decodeURIComponent(document.cookie);
      const parts = decoded.split(';');
      for (let part of parts) {
        part = part.trim();
        if (part.startsWith(name)) return part.substring(name.length);
      }
      return null;
    },
    set(key, value) {
      const name = VNCT.config.storagePrefix + key;
      // En local (localhost), on ne peut pas utiliser un domaine custom
      const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
      const domain = isLocalhost ? '' : `; domain=${VNCT.config.cookieDomain}`;
      document.cookie = `${name}=${value}; path=/${domain}; max-age=${VNCT.config.cookieMaxAge}; SameSite=Lax`;
    },
  };

  /* ==========================================================================
     10. NAV — Hide on scroll down, show on scroll up
     Ajoute la classe --hidden sur la nav desktop et le header mobile
     ========================================================================== */

  VNCT.Nav = {
    _threshold: 10,

    init() {
      const nav = document.querySelector('.vnct-nav-desktop');
      const header = document.querySelector('.vnct-header-mobile');
      if (!nav && !header) return;

      let lastY = window.scrollY;
      let ticking = false;

      const onScroll = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          const currentY = window.scrollY;
          const delta = currentY - lastY;

          if (delta > VNCT.Nav._threshold && currentY > 56) {
            // Scroll down → hide
            if (nav) nav.classList.add('vnct-nav-desktop--hidden');
            if (header) header.classList.add('vnct-header-mobile--hidden');
          } else if (delta < -VNCT.Nav._threshold) {
            // Scroll up → show
            if (nav) nav.classList.remove('vnct-nav-desktop--hidden');
            if (header) header.classList.remove('vnct-header-mobile--hidden');
          }

          lastY = currentY;
          ticking = false;
        });
      };

      window.addEventListener('scroll', onScroll, { passive: true });
    },
  };

  /* ==========================================================================
     INITIALISATION AUTOMATIQUE
     ========================================================================== */

  // Exposer le namespace globalement
  window.VNCT = VNCT;

  // Initialiser au chargement du DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      VNCT.init();
      VNCT.PageTransition.applyEntrance();
    });
  } else {
    VNCT.init();
    VNCT.PageTransition.applyEntrance();
  }

  /* ==========================================================================
     iOS SAFARI — Activer :active au toucher
     Safari iOS ne déclenche pas la pseudo-classe :active sur les événements
     touch par défaut. Un listener touchstart vide suffit à l'activer.
     ========================================================================== */
  document.addEventListener('touchstart', function () {}, { passive: true });

})();
