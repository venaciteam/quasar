// ═══════════════════════════════════════════════════════════════════
//     Quasar — Écran d'acceptation du contrat de sous-traitance
//     Sous-lot B (Lot 2 conformité RGPD, art. 28)
//
//     Expose window.checkContractGate() : Promise<boolean>.
//
//     Appelé dans init() (app.js), APRÈS /auth/me et AVANT tout chargement de
//     serveur ou de module. Comportement :
//       • contrat déjà accepté (version courante) → resolve(true), aucun écran.
//       • non accepté → overlay plein écran BLOQUANT ; resolve(true) seulement
//         après acceptation explicite (case cochée + bouton Accepter).
//       • refus → écran « accès bloqué » (ne résout jamais → accès verrouillé).
//       • token absent / réseau en échec → on affiche l'écran d'acceptation
//         (fail-closed) plutôt que de laisser passer.
//
//     Ce fichier peut être chargé AVANT app.js : il ne dépend d'aucun helper de
//     app.js (pas de API.get, pas de getToken). Il lit le token directement dans
//     localStorage ('quasar_token') et style tout au design system VNCT.
// ═══════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    const TOKEN_KEY = 'quasar_token';
    const STATUS_URL = '/api/contract/status';
    const ACCEPT_URL = '/api/contract/accept';
    const OVERLAY_ID = 'contract-gate-overlay';
    const STYLE_ID = 'contract-gate-styles';
    const LOCAL_URL_FALLBACK = '/dashboard/legal/contrat.html';

    function getToken() {
        try {
            return localStorage.getItem(TOKEN_KEY);
        } catch {
            return null;
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Styles injectés une seule fois. Tout est dérivé des variables du design
    // system VNCT (thèmes dark/light gérés nativement via les variables).
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .cgate-overlay {
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: var(--space-4, 1rem);
                background: rgba(0, 0, 0, 0.72);
                -webkit-backdrop-filter: blur(8px);
                backdrop-filter: blur(8px);
                animation: cgate-fade-in var(--duration-fast, 150ms) ease;
                overscroll-behavior: contain;
            }
            @keyframes cgate-fade-in { from { opacity: 0; } to { opacity: 1; } }
            .cgate-card {
                display: flex;
                flex-direction: column;
                width: 100%;
                max-width: 620px;
                max-height: 90vh;
                background: var(--bg-secondary, #12121a);
                border: 1px solid var(--border-default, rgba(255,255,255,0.08));
                border-radius: var(--radius-xl, 20px);
                box-shadow: var(--shadow-elevation-3, 0 8px 24px rgba(0,0,0,0.6));
                overflow: hidden;
                animation: cgate-scale-in 450ms cubic-bezier(0.34, 1.56, 0.64, 1);
            }
            @keyframes cgate-scale-in {
                from { opacity: 0; transform: scale(0.96); }
                to { opacity: 1; transform: scale(1); }
            }
            .cgate-head {
                display: flex;
                align-items: center;
                gap: var(--space-3, 0.75rem);
                padding: var(--space-6, 1.5rem) var(--space-6, 1.5rem) var(--space-4, 1rem);
                border-bottom: 1px solid var(--border-default, rgba(255,255,255,0.08));
                flex-shrink: 0;
            }
            .cgate-head-icon {
                width: 40px;
                height: 40px;
                flex-shrink: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: var(--radius-md, 10px);
                background: hsla(var(--accent-h, 330), var(--accent-s, 90%), 60%, 0.12);
                color: var(--accent, #ec4899);
            }
            .cgate-head-icon svg { width: 22px; height: 22px; }
            .cgate-head-titles { min-width: 0; }
            .cgate-title {
                font-size: var(--text-lg, 1.25rem);
                font-weight: var(--font-semibold, 600);
                color: var(--text-primary, #f0f0f5);
                line-height: var(--leading-tight, 1.2);
            }
            .cgate-subtitle {
                font-size: var(--text-xs, 0.75rem);
                color: var(--text-muted, #606075);
                margin-top: 2px;
            }
            .cgate-body {
                padding: var(--space-5, 1.25rem) var(--space-6, 1.5rem);
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                flex: 1 1 auto;
            }
            .cgate-lead {
                font-size: var(--text-sm, 0.875rem);
                color: var(--text-secondary, #a0a0b5);
                line-height: var(--leading-relaxed, 1.7);
                margin-bottom: var(--space-4, 1rem);
            }
            .cgate-summary {
                list-style: none;
                display: flex;
                flex-direction: column;
                gap: var(--space-3, 0.75rem);
                margin: 0 0 var(--space-5, 1.25rem);
                padding: 0;
            }
            .cgate-summary li {
                position: relative;
                padding-left: calc(var(--space-6, 1.5rem) + 2px);
                font-size: var(--text-sm, 0.875rem);
                color: var(--text-secondary, #a0a0b5);
                line-height: var(--leading-normal, 1.5);
            }
            .cgate-summary li::before {
                content: '';
                position: absolute;
                left: 0;
                top: 0.45em;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--accent, #ec4899);
                box-shadow: 0 0 8px hsla(var(--accent-h, 330), var(--accent-s, 90%), 60%, 0.5);
            }
            .cgate-fulltext {
                display: inline-flex;
                align-items: center;
                gap: var(--space-2, 0.5rem);
                font-size: var(--text-sm, 0.875rem);
                font-weight: var(--font-medium, 500);
                color: var(--accent, #ec4899);
                text-decoration: none;
                margin-bottom: var(--space-5, 1.25rem);
            }
            .cgate-fulltext:hover { text-decoration: underline; }
            .cgate-fulltext svg { width: 15px; height: 15px; }
            .cgate-notice {
                display: flex;
                gap: var(--space-3, 0.75rem);
                padding: var(--space-3, 0.75rem) var(--space-4, 1rem);
                margin-bottom: var(--space-4, 1rem);
                border-radius: var(--radius-md, 10px);
                background: hsla(35, 90%, 50%, 0.08);
                border: 1px solid hsla(35, 90%, 50%, 0.25);
                font-size: var(--text-xs, 0.75rem);
                color: var(--warning, #f0a030);
                line-height: var(--leading-normal, 1.5);
            }
            .cgate-consent {
                display: flex;
                align-items: flex-start;
                gap: var(--space-3, 0.75rem);
                padding: var(--space-4, 1rem);
                border-radius: var(--radius-md, 10px);
                background: var(--bg-tertiary, #1a1a28);
                border: 1px solid var(--border-default, rgba(255,255,255,0.08));
                cursor: pointer;
                transition: border-color var(--duration-fast, 150ms) ease;
            }
            .cgate-consent:hover { border-color: var(--border-hover, rgba(255,255,255,0.15)); }
            .cgate-consent input[type="checkbox"] {
                flex-shrink: 0;
                width: 20px;
                height: 20px;
                margin-top: 1px;
                accent-color: var(--accent, #ec4899);
                cursor: pointer;
            }
            .cgate-consent-label {
                font-size: var(--text-sm, 0.875rem);
                color: var(--text-primary, #f0f0f5);
                line-height: var(--leading-normal, 1.5);
                user-select: none;
            }
            .cgate-foot {
                display: flex;
                gap: var(--space-3, 0.75rem);
                justify-content: flex-end;
                padding: var(--space-4, 1rem) var(--space-6, 1.5rem);
                border-top: 1px solid var(--border-default, rgba(255,255,255,0.08));
                flex-shrink: 0;
                flex-wrap: wrap;
            }
            .cgate-btn {
                font-family: var(--font-family, sans-serif);
                font-size: var(--text-sm, 0.875rem);
                font-weight: var(--font-semibold, 600);
                padding: var(--space-3, 0.75rem) var(--space-6, 1.5rem);
                border-radius: var(--radius-md, 10px);
                border: 1px solid transparent;
                cursor: pointer;
                transition: all var(--duration-fast, 150ms) ease;
                line-height: 1;
            }
            .cgate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .cgate-btn-primary {
                background: var(--accent, #ec4899);
                color: #000;
                border-color: var(--accent, #ec4899);
            }
            .cgate-btn-primary:not(:disabled):hover { filter: brightness(1.1); box-shadow: var(--neon-shadow-sm, 0 0 6px rgba(236,72,153,0.4)); }
            .cgate-btn-ghost {
                background: transparent;
                color: var(--text-secondary, #a0a0b5);
                border-color: var(--border-default, rgba(255,255,255,0.08));
            }
            .cgate-btn-ghost:hover { color: var(--text-primary, #f0f0f5); background: var(--surface-hover, rgba(255,255,255,0.05)); }
            .cgate-btn-danger {
                background: transparent;
                color: var(--danger, #f04050);
                border-color: var(--danger, #f04050);
            }
            .cgate-btn-danger:hover { background: var(--danger, #f04050); color: #fff; }
            .cgate-loading {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: var(--space-3, 0.75rem);
                padding: var(--space-12, 3rem);
                color: var(--text-muted, #606075);
                font-size: var(--text-sm, 0.875rem);
            }
            .cgate-spinner {
                width: 26px;
                height: 26px;
                border: 3px solid var(--border-default, rgba(255,255,255,0.15));
                border-top-color: var(--accent, #ec4899);
                border-radius: 50%;
                animation: cgate-spin 0.8s linear infinite;
            }
            @keyframes cgate-spin { to { transform: rotate(360deg); } }
            .cgate-refuse-icon {
                background: hsla(0, 80%, 55%, 0.12);
                color: var(--danger, #f04050);
            }
            @media (max-width: 560px) {
                .cgate-foot { flex-direction: column-reverse; }
                .cgate-btn { width: 100%; }
            }
        `;
        document.head.appendChild(style);
    }

    // Petits pictogrammes SVG inline (pas de dépendance externe).
    const ICON_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';
    const ICON_BLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
    const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';

    window.checkContractGate = function checkContractGate() {
        return new Promise((resolve) => {
            ensureStyles();

            // État d'affichage (rempli depuis le serveur, avec des replis sûrs).
            const state = {
                version: '1.0',
                summary: [],
                url: null,
                localUrl: LOCAL_URL_FALLBACK,
                degraded: false, // true si /status a échoué → mode dégradé, mais bloquant
            };

            const overlay = document.createElement('div');
            overlay.id = OVERLAY_ID;
            overlay.className = 'cgate-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-label', 'Acceptation du contrat de sous-traitance');
            document.body.appendChild(overlay);

            // Verrouille le scroll de la page tant que l'écran est présent.
            const prevOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';

            function teardown() {
                document.body.style.overflow = prevOverflow;
                overlay.remove();
            }

            function showLoading() {
                overlay.innerHTML = `
                    <div class="cgate-card">
                        <div class="cgate-loading">
                            <div class="cgate-spinner"></div>
                            Vérification du contrat…
                        </div>
                    </div>`;
            }

            // ── Écran d'acceptation ──────────────────────────────────────────
            function renderAcceptance() {
                // Le texte publie fait foi : on pointe dessus en priorite. La copie
                // embarquee sert de repli si aucune URL publique n'est configuree.
                const localUrl = state.url || state.localUrl || LOCAL_URL_FALLBACK;
                const summaryItems = state.summary.length
                    ? state.summary.map(p => `<li>${escapeHtml(p)}</li>`).join('')
                    : `<li>Venacity héberge Quasar pour votre compte : en tant qu'administratrice ou administrateur, vous restez responsable de traitement (art. 28 du RGPD). Prenez connaissance du texte intégral via le lien ci-dessous avant d'accepter.</li>`;

                const degradedNotice = state.degraded ? `
                    <div class="cgate-notice">
                        <span>Le résumé n'a pas pu être chargé (problème réseau ou session). Vous pouvez consulter le texte intégral ci-dessous, réessayer, ou vous déconnecter. L'accès reste bloqué tant que le contrat n'est pas accepté.</span>
                    </div>` : '';

                overlay.innerHTML = `
                    <div class="cgate-card">
                        <div class="cgate-head">
                            <div class="cgate-head-icon">${ICON_SHIELD}</div>
                            <div class="cgate-head-titles">
                                <div class="cgate-title">Contrat de sous-traitance des données</div>
                                <div class="cgate-subtitle">Version ${escapeHtml(state.version)} · Article 28 du RGPD</div>
                            </div>
                        </div>
                        <div class="cgate-body">
                            <p class="cgate-lead">
                                Avant d'accéder à la configuration de vos serveurs, vous devez accepter le contrat
                                qui encadre le traitement des données personnelles réalisé par Venacity pour votre compte.
                                Voici les points essentiels :
                            </p>
                            ${degradedNotice}
                            <ul class="cgate-summary">${summaryItems}</ul>
                            <a class="cgate-fulltext" href="${escapeHtml(localUrl)}" target="_blank" rel="noopener noreferrer">
                                ${ICON_DOC} Lire le texte intégral du contrat
                            </a>
                            <label class="cgate-consent" for="cgate-consent-check">
                                <input type="checkbox" id="cgate-consent-check">
                                <span class="cgate-consent-label">J'ai lu et j'accepte le contrat de sous-traitance version ${escapeHtml(state.version)}.</span>
                            </label>
                        </div>
                        <div class="cgate-foot">
                            <button type="button" class="cgate-btn cgate-btn-ghost" id="cgate-refuse">Refuser</button>
                            <button type="button" class="cgate-btn cgate-btn-primary" id="cgate-accept" disabled>Accepter</button>
                        </div>
                    </div>`;

                const check = overlay.querySelector('#cgate-consent-check');
                const acceptBtn = overlay.querySelector('#cgate-accept');
                const refuseBtn = overlay.querySelector('#cgate-refuse');

                // Case JAMAIS pré-cochée : le bouton Accepter reste désactivé tant
                // qu'elle n'est pas cochée (un consentement pré-coché est nul en droit).
                check.checked = false;
                acceptBtn.disabled = true;
                check.addEventListener('change', () => {
                    acceptBtn.disabled = !check.checked;
                });

                acceptBtn.addEventListener('click', () => {
                    if (!check.checked) return; // garde-fou
                    accept(acceptBtn, refuseBtn);
                });
                refuseBtn.addEventListener('click', renderRefusal);
            }

            // ── Enregistrement de l'acceptation ──────────────────────────────
            async function accept(acceptBtn, refuseBtn) {
                acceptBtn.disabled = true;
                refuseBtn.disabled = true;
                const original = acceptBtn.textContent;
                acceptBtn.textContent = 'Enregistrement…';

                try {
                    const token = getToken();
                    const res = await fetch(ACCEPT_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                    });
                    const data = await res.json().catch(() => ({}));

                    if (res.ok && data && data.success) {
                        teardown();
                        resolve(true);
                        return;
                    }

                    // Échec côté serveur : on réactive pour permettre une nouvelle
                    // tentative, sans jamais débloquer l'accès.
                    acceptBtn.textContent = original;
                    acceptBtn.disabled = false;
                    refuseBtn.disabled = false;
                    showError('L\'enregistrement a échoué. Réessaie dans un instant.');
                } catch {
                    acceptBtn.textContent = original;
                    acceptBtn.disabled = false;
                    refuseBtn.disabled = false;
                    showError('Connexion impossible. Vérifie ta connexion et réessaie.');
                }
            }

            // Petit bandeau d'erreur non bloquant, injecté en tête du corps.
            function showError(message) {
                const body = overlay.querySelector('.cgate-body');
                if (!body) return;
                let notice = overlay.querySelector('#cgate-error');
                if (!notice) {
                    notice = document.createElement('div');
                    notice.id = 'cgate-error';
                    notice.className = 'cgate-notice';
                    notice.style.background = 'hsla(0, 80%, 55%, 0.10)';
                    notice.style.borderColor = 'hsla(0, 80%, 55%, 0.30)';
                    notice.style.color = 'var(--danger, #f04050)';
                    body.prepend(notice);
                }
                notice.textContent = message;
            }

            // ── Écran « accès bloqué » (refus) ───────────────────────────────
            // Ne résout PAS la promesse : l'accès reste verrouillé.
            function renderRefusal() {
                overlay.innerHTML = `
                    <div class="cgate-card">
                        <div class="cgate-head">
                            <div class="cgate-head-icon cgate-refuse-icon">${ICON_BLOCK}</div>
                            <div class="cgate-head-titles">
                                <div class="cgate-title">Accès bloqué</div>
                                <div class="cgate-subtitle">Contrat non accepté</div>
                            </div>
                        </div>
                        <div class="cgate-body">
                            <p class="cgate-lead">
                                Sans acceptation du contrat de sous-traitance, l'accès aux fonctions de configuration
                                de vos serveurs reste bloqué. Vous pouvez revenir à l'écran d'acceptation à tout moment.
                            </p>
                            <p class="cgate-lead" style="margin-bottom:0">
                                <strong style="color:var(--text-primary, #f0f0f5)">Que deviennent vos données ?</strong><br>
                                Vos données déjà présentes ne sont pas supprimées du seul fait du refus : elles suivent
                                le régime de conservation habituel et sont purgées au retrait du bot, après un délai de
                                grâce de 7 jours.
                            </p>
                        </div>
                        <div class="cgate-foot">
                            <button type="button" class="cgate-btn cgate-btn-danger" id="cgate-logout">Se déconnecter</button>
                            <button type="button" class="cgate-btn cgate-btn-primary" id="cgate-back">Revenir</button>
                        </div>
                    </div>`;

                overlay.querySelector('#cgate-back').addEventListener('click', renderAcceptance);
                overlay.querySelector('#cgate-logout').addEventListener('click', () => {
                    try { localStorage.removeItem(TOKEN_KEY); } catch {}
                    window.location.href = '/';
                });
            }

            // ── Chargement initial ───────────────────────────────────────────
            async function load() {
                showLoading();

                const token = getToken();
                if (!token) {
                    // Pas de session : on ne peut pas confirmer l'acceptation → bloquer.
                    state.degraded = true;
                    renderAcceptance();
                    return;
                }

                try {
                    const res = await fetch(STATUS_URL, {
                        headers: { 'Authorization': `Bearer ${token}` },
                    });

                    if (!res.ok) {
                        // 401/500… : fail-closed, on affiche l'écran (mode dégradé).
                        state.degraded = true;
                        renderAcceptance();
                        return;
                    }

                    const data = await res.json();

                    // Instance auto-hebergee : le contrat de Venacity ne la concerne pas.
                    if (data && data.required === false) {
                        teardown();
                        resolve(true);
                        return;
                    }

                    if (data && data.accepted) {
                        // Déjà accepté (version courante) → aucun écran.
                        teardown();
                        resolve(true);
                        return;
                    }

                    if (data) {
                        state.version = data.version || state.version;
                        state.summary = Array.isArray(data.summary) ? data.summary : [];
                        state.url = data.url || null;
                        state.localUrl = data.localUrl || LOCAL_URL_FALLBACK;
                    }
                    renderAcceptance();
                } catch {
                    // Réseau en échec : bloquer plutôt que laisser passer.
                    state.degraded = true;
                    renderAcceptance();
                }
            }

            load();
        });
    };
})();
