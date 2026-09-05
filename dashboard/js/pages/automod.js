// ═══════════════════════════════════════════════════════════════
//  Page Modération automatique — conteneur à onglets
//
//  Quatre modules (AutoMod Discord, escalade, anti-raid, honeypot) pour UNE
//  seule entrée de sidebar : la barre latérale compte déjà plus de douze
//  entrées, quatre de plus la rendraient illisible.
//
//  Chaque module vit dans son propre fichier et s'enregistre au chargement via
//  `registerAutomodTab`. Cette page ne connaît aucun d'entre eux : elle trie par
//  `order` — l'ordre d'affichage ne doit pas dépendre de l'ordre des balises
//  <script> — et rend l'onglet actif. Un module absent, ou qui échoue au rendu,
//  ne casse pas les autres.
// ═══════════════════════════════════════════════════════════════

const _automodTabs = [];

const _automodState = {
    guildId: null,
    // Onglet actif conservé pendant la navigation dans la page (changement de
    // serveur, rafraîchissement d'un onglet). Volontairement pas persisté d'une
    // session à l'autre : rouvrir le dashboard doit repartir du premier onglet.
    activeTabId: null,
};

/**
 * Enregistre un onglet. Appelé par chaque module au chargement de son fichier.
 *
 * @param {object}   tab
 * @param {string}   tab.id     — identifiant unique et stable
 * @param {string}   tab.label  — libellé affiché
 * @param {number}   tab.order  — position (10, 20, 30, 40…)
 * @param {function} tab.render — async (container, guildId) => void
 */
function registerAutomodTab(tab) {
    if (!tab || typeof tab.id !== 'string' || !tab.id) {
        console.error('[Quasar] Onglet de modération automatique sans identifiant — ignoré.');
        return;
    }
    if (typeof tab.render !== 'function') {
        console.error(`[Quasar] Onglet « ${tab.id} » sans fonction de rendu — ignoré.`);
        return;
    }

    const entry = {
        id: tab.id,
        label: tab.label || tab.id,
        order: Number.isFinite(tab.order) ? tab.order : 100,
        render: tab.render,
    };

    // Ré-enregistrement du même identifiant : on remplace au lieu d'empiler.
    // Sans ça, un fichier chargé deux fois (service worker, rechargement partiel)
    // afficherait son onglet en double.
    const existing = _automodTabs.findIndex(t => t.id === entry.id);
    if (existing >= 0) _automodTabs[existing] = entry;
    else _automodTabs.push(entry);
}

function sortedAutomodTabs() {
    return [..._automodTabs].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'fr'));
}

function activeAutomodTab() {
    const tabs = sortedAutomodTabs();
    if (!tabs.length) return null;
    return tabs.find(t => t.id === _automodState.activeTabId) || tabs[0];
}

/**
 * Bandeau « bêta » de la page.
 *
 * Il est rendu par le conteneur, au-dessus de la barre d'onglets : c'est le
 * seul endroit qui reste à l'écran quel que soit l'onglet ouvert. Le mettre
 * dans les quatre fichiers d'onglet l'aurait répété quatre fois, avec quatre
 * occasions de le laisser diverger.
 *
 * Volontairement NON fermable : un avertissement qu'un clic fait disparaître
 * disparaît pour toujours, y compris pour qui revient configurer autre chose
 * trois semaines plus tard. Il reste tant que la fonctionnalité est en bêta ;
 * le retirer, c'est supprimer cette fonction et son appel.
 *
 * Toute l'information est écrite : rien ne dépend d'un survol (inexistant au
 * doigt comme au clavier) ni de la seule couleur du filet d'avertissement.
 *
 * Volontairement TRÈS court : à 375 px, la version longue mesurait 429 px de
 * haut et repoussait la barre d'onglets hors du premier écran — on ne voyait
 * plus que l'avertissement. Les trois messages (c'est en test / commencez en
 * « alerte seule » / faites des retours) sont tous là, en une phrase chacun.
 * Rallonger ce texte, c'est reperdre les onglets.
 */
function automodBetaBanner() {
    return `
        <div class="automod-beta" role="note">
            <span class="automod-beta-icon" aria-hidden="true">⚠️</span>
            <div class="automod-beta-body">
                <strong class="automod-beta-title">Ces quatre protections sont en bêta</strong>
                <p>
                    Activez-les une à une, en commençant par le mode « alerte seule » de chaque onglet :
                    le déclenchement est journalisé sans qu'aucune sanction ne tombe. Un souci, une idée ?
                    Le drapeau en bas à droite de l'écran m'envoie vos retours.
                </p>
            </div>
        </div>
    `;
}

async function loadAutomod(container, guildId) {
    _automodState.guildId = guildId;
    const tabs = sortedAutomodTabs();

    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🤖 Modération automatique</h1>
            <p class="main-subtitle">Configurez les protections qui agissent sans intervention humaine : filtres Discord, escalade des avertissements, anti-raid et salon piège.</p>
        </div>
        ${automodBetaBanner()}
        ${tabs.length ? `
            <div class="automod-tabs" role="tablist" id="automod-tabs">
                ${tabs.map(tab => `
                    <button class="automod-tab" type="button" role="tab"
                            data-tab="${escapeHtml(tab.id)}"
                            aria-selected="false">${escapeHtml(tab.label)}</button>
                `).join('')}
            </div>
        ` : ''}
        <div id="automod-panel" role="tabpanel"></div>
    `;

    if (!tabs.length) {
        document.getElementById('automod-panel').innerHTML = `
            <div class="card">
                <div class="card-title">Aucun module chargé</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Aucun module de modération automatique n'est disponible sur cette instance.
                    Mettez Quasar à jour pour en profiter.
                </p>
            </div>
        `;
        return;
    }

    document.querySelectorAll('#automod-tabs .automod-tab').forEach(btn => {
        btn.addEventListener('click', () => switchAutomodTab(btn.dataset.tab));
    });

    const active = activeAutomodTab();
    await renderAutomodTab(active.id);
}

async function switchAutomodTab(tabId) {
    if (_automodState.activeTabId === tabId) return;
    await renderAutomodTab(tabId);
}

async function renderAutomodTab(tabId) {
    const tab = sortedAutomodTabs().find(t => t.id === tabId);
    const panel = document.getElementById('automod-panel');
    if (!tab || !panel) return;

    _automodState.activeTabId = tab.id;

    document.querySelectorAll('#automod-tabs .automod-tab').forEach(btn => {
        const isActive = btn.dataset.tab === tab.id;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    panel.innerHTML = `<div class="automod-tab-loading">Chargement…</div>`;

    try {
        await tab.render(panel, _automodState.guildId);
    } catch (err) {
        // Un module qui plante ne doit pas emporter la page entière : les autres
        // onglets restent cliquables, et le message dit quoi faire.
        console.error(`[Quasar] Rendu de l'onglet « ${tab.id} » en échec :`, err);
        panel.innerHTML = `
            <div class="card">
                <div class="card-title">Cet onglet n'a pas pu s'afficher</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Une erreur est survenue pendant le chargement de « ${escapeHtml(tab.label)} ».
                    Réessayez dans un instant ; si le problème persiste, signalez-le avec le bouton de retour.
                </p>
            </div>
        `;
    }
}

window.registerAutomodTab = registerAutomodTab;
window.loadAutomod = loadAutomod;
window.switchAutomodTab = switchAutomodTab;
