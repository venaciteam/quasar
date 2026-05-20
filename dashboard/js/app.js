// ═══════════════════════════════════
//          Quasar Dashboard App
// ═══════════════════════════════════

// Récupérer et stocker le token depuis l'URL si présent
const urlParams = new URLSearchParams(window.location.search);
const urlToken = urlParams.get('token');
if (urlToken) {
    localStorage.setItem('quasar_token', urlToken);
    // Nettoyer l'URL
    window.history.replaceState({}, '', '/dashboard/app.html');
}

const getToken = () => localStorage.getItem('quasar_token');

const API = {
    async get(url) {
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${getToken()}` } });
        if (res.status === 401) { localStorage.removeItem('quasar_token'); window.location.href = '/'; return null; }
        return res.json();
    },
    async put(url, data) {
        const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }, body: JSON.stringify(data) });
        return res.json();
    },
    async post(url, data) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }, body: JSON.stringify(data) });
        return res.json();
    },
    async delete(url) {
        const res = await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${getToken()}` } });
        return res.json();
    }
};

// Toast notifications
function showToast(message, type = 'success') {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.style.cssText = 'position:fixed;bottom:2rem;right:2rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem';
        document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    const color = type === 'error' ? 'var(--danger)' : type === 'info' ? 'var(--accent)' : 'var(--success)';
    toast.style.cssText = `padding:.75rem 1.25rem;background:var(--bg-secondary);border:1px solid ${color};border-radius:var(--radius-sm);color:var(--text-primary);font-size:.875rem;box-shadow:var(--shadow);opacity:0;transition:opacity .3s ease;max-width:320px`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// State
let currentUser = null;
let currentGuild = null;
let guilds = [];
let inviteUrlCache = null;
let lastGuildsFetch = 0;
const REFRESH_MIN_INTERVAL = 4000; // anti-spam des refreshes auto

// ═══ Init ═══
async function init() {
    if (!getToken()) { window.location.href = '/'; return; }
    const auth = await API.get('/auth/me');
    if (!auth?.authenticated) { localStorage.removeItem('quasar_token'); window.location.href = '/'; return; }

    currentUser = auth.user;
    renderUserInfo();

    guilds = await API.get('/api/guilds') || [];
    lastGuildsFetch = Date.now();

    if (guilds.length === 0) {
        showNoGuilds();
        renderServerMenu();
        checkForUpdate();
        return;
    }

    selectGuild(guilds[0]);
    renderServerMenu();
    checkForUpdate();
}

// ═══ Helpers ═══
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}

async function getInviteUrl() {
    if (inviteUrlCache) return inviteUrlCache;
    try {
        const res = await fetch('/api/bot/invite');
        if (!res.ok) return null;
        const data = await res.json();
        inviteUrlCache = data.url || null;
        return inviteUrlCache;
    } catch {
        return null;
    }
}

async function openInvite() {
    const url = await getInviteUrl();
    if (!url) {
        showToast('Lien d\'invitation indisponible. Réessaie dans un instant.', 'error');
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}

async function refreshGuilds({ force = false } = {}) {
    if (!force && Date.now() - lastGuildsFetch < REFRESH_MIN_INTERVAL) return;
    lastGuildsFetch = Date.now();

    const fresh = await API.get('/api/guilds');
    if (!Array.isArray(fresh)) return;
    guilds = fresh;

    if (currentGuild && !guilds.find(g => g.id === currentGuild.id)) {
        // Le serveur courant n'est plus accessible — bascule
        currentGuild = null;
    }

    if (!currentGuild && guilds.length > 0) {
        selectGuild(guilds[0]);
    } else if (!currentGuild && guilds.length === 0) {
        showNoGuilds();
    }

    renderServerMenu();
}

async function checkForUpdate() {
    try {
        const data = await API.get('/api/version?force=true');
        // Afficher la version dans le bouton sidebar
        const sidebarBtn = document.getElementById('sidebar-update');
        if (sidebarBtn) {
            const badge = data.updateAvailable ? `<span class="update-dot"></span>` : '';
            sidebarBtn.innerHTML = `<span class="sidebar-link-icon">⬆</span> Mise à jour ${badge}<span style="margin-left:auto;font-size:.7rem;opacity:.5">v${data.local}</span>`;
        }
        if (data?.updateAvailable) showUpdateBanner(data.local, data.remote);
    } catch {}
}

function showUpdateBanner(local, remote) {
    if (document.getElementById('update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.innerHTML = `
        <span class="update-banner-icon">⬆</span>
        <div style="flex:1">
            <strong>Mise à jour disponible</strong>
            <p>v${local} → v${remote}</p>
        </div>
        <button class="btn btn-primary" onclick="loadPage('update')" style="flex-shrink:0;font-size:.8rem;padding:.4rem .8rem">Mettre à jour</button>
    `;
    const main = document.querySelector('.main');
    const content = document.getElementById('content');
    if (main && content) main.insertBefore(banner, content);
}

function renderUserInfo() {
    const avatarUrl = currentUser.avatar
        ? `https://cdn.discordapp.com/avatars/${currentUser.id}/${currentUser.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;
    document.getElementById('user-avatar').src = avatarUrl;
    document.getElementById('user-name').textContent = currentUser.username;
}

function selectGuild(guild) {
    currentGuild = guild;
    const guildIcon = guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=48` : null;
    const guildEl = document.getElementById('guild-info');
    if (guildIcon) {
        guildEl.innerHTML = `<img src="${guildIcon}" alt="">`;
        guildEl.appendChild(document.createTextNode(` ${guild.name}`));
    } else {
        guildEl.textContent = `🔹 ${guild.name}`;
    }
    loadPage('overview');
}

function showNoGuilds() {
    // Sidebar — état "aucun serveur"
    const guildEl = document.getElementById('guild-info');
    if (guildEl) guildEl.textContent = 'Aucun serveur';

    document.getElementById('content').innerHTML = `
        <div class="onboarding">
            <div class="onboarding-icon">🚀</div>
            <h1 class="onboarding-title">Ajoute Quasar à un de tes serveurs</h1>
            <p class="onboarding-desc">
                Quasar n'est encore sur aucun serveur Discord où tu es administrateur. Ajoute-le maintenant pour configurer la modération, les welcome, les tickets et le reste depuis ce dashboard.
            </p>
            <button class="onboarding-cta" id="onboarding-add" type="button">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Ajouter Quasar à un serveur
            </button>
            <button class="onboarding-refresh" id="onboarding-refresh" type="button">J'ai ajouté le bot, actualiser</button>
        </div>
    `;

    document.getElementById('onboarding-add').addEventListener('click', openInvite);
    document.getElementById('onboarding-refresh').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('is-spinning');
        btn.disabled = true;
        await refreshGuilds({ force: true });
        // Si toujours rien, on retourne ici ; le bouton est ré-affiché au prochain render
        setTimeout(() => {
            if (btn.isConnected) {
                btn.classList.remove('is-spinning');
                btn.disabled = false;
            }
        }, 500);
    });
}

// ═══ Server menu (popup) ═══
function renderServerMenu() {
    const list = document.getElementById('server-menu-list');
    if (!list) return;

    if (guilds.length === 0) {
        list.innerHTML = `<div class="server-menu-empty">Quasar n'est sur aucun de tes serveurs admin pour l'instant.</div>`;
        return;
    }

    list.innerHTML = guilds.map(g => {
        const isCurrent = currentGuild && g.id === currentGuild.id;
        const iconHtml = g.icon
            ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=32" alt="">`
            : `<span>${escapeHtml((g.name[0] || '?').toUpperCase())}</span>`;
        const checkSvg = isCurrent
            ? '<svg class="server-menu-item-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '';
        return `
            <button class="server-menu-item ${isCurrent ? 'is-current' : ''}" data-guild-id="${g.id}" type="button" role="option" aria-selected="${isCurrent ? 'true' : 'false'}">
                <span class="server-menu-item-icon">${iconHtml}</span>
                <span class="server-menu-item-name">${escapeHtml(g.name)}</span>
                ${checkSvg}
            </button>
        `;
    }).join('');

    list.querySelectorAll('.server-menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.guildId;
            const guild = guilds.find(g => g.id === id);
            if (guild && (!currentGuild || guild.id !== currentGuild.id)) {
                selectGuild(guild);
            }
            closeServerMenu();
        });
    });
}

function openServerMenu() {
    const menu = document.getElementById('server-menu');
    const switcher = document.getElementById('guild-switcher');
    if (!menu || !switcher) return;
    renderServerMenu();
    menu.hidden = false;
    switcher.setAttribute('aria-expanded', 'true');
}

function closeServerMenu() {
    const menu = document.getElementById('server-menu');
    const switcher = document.getElementById('guild-switcher');
    if (!menu || !switcher) return;
    menu.hidden = true;
    switcher.setAttribute('aria-expanded', 'false');
}

function toggleServerMenu() {
    const menu = document.getElementById('server-menu');
    if (!menu) return;
    if (menu.hidden) openServerMenu();
    else closeServerMenu();
}

function bindServerMenuEvents() {
    const switcher = document.getElementById('guild-switcher');
    const refreshBtn = document.getElementById('server-menu-refresh');
    const addBtn = document.getElementById('server-menu-add');
    const menu = document.getElementById('server-menu');

    if (switcher) {
        switcher.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleServerMenu();
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            refreshBtn.classList.add('is-spinning');
            await refreshGuilds({ force: true });
            setTimeout(() => refreshBtn.classList.remove('is-spinning'), 500);
        });
    }

    if (addBtn) {
        addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openInvite();
        });
    }

    document.addEventListener('click', (e) => {
        if (!menu || menu.hidden) return;
        if (menu.contains(e.target) || (switcher && switcher.contains(e.target))) return;
        closeServerMenu();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menu && !menu.hidden) closeServerMenu();
    });
}

// Refresh auto quand l'onglet reprend le focus (après ajout du bot dans Discord)
function bindAutoRefresh() {
    window.addEventListener('focus', () => { refreshGuilds(); });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshGuilds();
    });
}

// ═══ Navigation ═══
function getMobileBackHtml() {
    return `<button class="mobile-back" onclick="loadPage('overview')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Retour
    </button>`;
}

async function loadPage(page) {
    document.querySelectorAll('.sidebar-link').forEach(el => {
        el.classList.toggle('active', el.dataset.page === page);
    });

    const content = document.getElementById('content');

    // Loading state
    if (page !== 'overview' && page !== 'music') {
        content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:4rem;color:var(--text-muted)">
            <div style="text-align:center">
                <div style="width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 1rem"></div>
                Chargement...
            </div>
        </div>`;
    }

    switch (page) {
        case 'overview':   await loadOverview(content); break;
        case 'moderation': await loadModeration(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'welcome':    await loadWelcome(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'reactionroles': await loadReactionRoles(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'embeds':     await loadEmbeds(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'customcmds': await loadCustomCmds(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'tempvoice':  await loadTempVoice(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'tickets':    await loadTickets(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'scheduled':  await loadScheduled(content, currentGuild.id); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'music':      loadMusic(content); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        case 'update':     await loadUpdate(content); content.insertAdjacentHTML('afterbegin', getMobileBackHtml()); break;
        default:
            content.innerHTML = `<div class="main-header"><h1 class="main-title">${page}</h1><p class="main-subtitle">Module en construction 🔧</p></div>`;
    }
}

// ═══ Présence du bot (owner only) ═══
const STATUS_EMOJIS = { online: '🟢', idle: '🌙', dnd: '⛔', invisible: '👻' };
const ACTIVITY_LABELS = { 0: 'Joue à', 2: 'Écoute', 3: 'Regarde', 5: 'En compétition sur' };
let savingPresence = false;

async function getPresenceHtml() {
    try {
        const data = await API.get('/api/presence');
        if (!data || !data.isOwner) return '';

        const statusOptions = [
            { value: 'online', label: '🟢 En ligne' },
            { value: 'idle', label: '🌙 Inactif' },
            { value: 'dnd', label: '⛔ Ne pas déranger' },
            { value: 'invisible', label: '👻 Invisible' }
        ];
        const activityOptions = [
            { value: -1, label: 'Aucune' },
            { value: 0, label: 'Joue à' },
            { value: 2, label: 'Écoute' },
            { value: 3, label: 'Regarde' },
            { value: 5, label: 'En compétition sur' }
        ];
        const noActivity = data.activity_type === -1;

        const selectedStatus = statusOptions.find(o => o.value === data.status) || statusOptions[0];
        const selectedActivity = activityOptions.find(o => o.value === data.activity_type) || activityOptions[0];

        return `
            <div class="card presence-card">
                <div class="card-title">
                    <span id="presence-emoji">${STATUS_EMOJIS[data.status] || '🟢'}</span> Statut du bot
                    <span class="badge badge-active" style="margin-left:auto">Owner</span>
                </div>
                <div class="presence-grid">
                    <div class="presence-field">
                        <label class="presence-label">Statut</label>
                        <div class="custom-select" id="cs-presence-status">
                            <input type="hidden" id="presence-status" value="${data.status}">
                            <div class="custom-select-trigger" tabindex="0">
                                <span class="custom-select-value">${selectedStatus.label}</span>
                                <svg class="custom-select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </div>
                            <div class="custom-select-options">
                                ${statusOptions.map(o => `<div class="custom-select-option${o.value === data.status ? ' selected' : ''}" data-value="${o.value}">${o.label}</div>`).join('')}
                            </div>
                        </div>
                    </div>
                    <div class="presence-field">
                        <label class="presence-label">Activité</label>
                        <div class="custom-select" id="cs-presence-activity-type">
                            <input type="hidden" id="presence-activity-type" value="${data.activity_type}">
                            <div class="custom-select-trigger" tabindex="0">
                                <span class="custom-select-value">${selectedActivity.label}</span>
                                <svg class="custom-select-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </div>
                            <div class="custom-select-options">
                                ${activityOptions.map(o => `<div class="custom-select-option${o.value === data.activity_type ? ' selected' : ''}" data-value="${o.value}">${o.label}</div>`).join('')}
                            </div>
                        </div>
                    </div>
                    <div class="presence-field presence-field-text">
                        <label class="presence-label">Texte</label>
                        <input type="text" class="input" id="presence-activity-text" maxlength="128" placeholder="atlas.vena.city" value="${data.activity_text.replace(/"/g, '&quot;')}" ${noActivity ? 'disabled style="opacity:.4"' : ''}>
                    </div>
                    <div class="presence-field presence-field-btn">
                        <button class="btn btn-primary" id="presence-save">Appliquer</button>
                    </div>
                </div>
            </div>
        `;
    } catch {
        return '';
    }
}

// ═══ Custom Select Component ═══
function initCustomSelects() {
    document.querySelectorAll('.custom-select').forEach(wrapper => {
        const trigger = wrapper.querySelector('.custom-select-trigger');
        const options = wrapper.querySelector('.custom-select-options');
        const hiddenInput = wrapper.querySelector('input[type="hidden"]');

        // Toggle open/close on click
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close all other open selects
            document.querySelectorAll('.custom-select.open').forEach(el => {
                if (el !== wrapper) el.classList.remove('open');
            });
            wrapper.classList.toggle('open');
        });

        // Keyboard support
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                trigger.click();
            } else if (e.key === 'Escape') {
                wrapper.classList.remove('open');
            }
        });

        // Option selection
        wrapper.querySelectorAll('.custom-select-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                const value = opt.dataset.value;
                const label = opt.textContent;

                // Update hidden input
                hiddenInput.value = value;

                // Update visual
                wrapper.querySelector('.custom-select-value').textContent = label;
                wrapper.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');

                // Close dropdown
                wrapper.classList.remove('open');

                // Dispatch change event on hidden input for listeners
                hiddenInput.dispatchEvent(new Event('change'));
            });
        });
    });

    // Close all selects when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
    });
}

function bindPresenceEvents() {
    const saveBtn = document.getElementById('presence-save');
    if (!saveBtn) return;

    saveBtn.addEventListener('click', savePresence);

    // Init custom selects
    initCustomSelects();

    // Mettre à jour l'emoji indicateur quand le statut change
    const statusInput = document.getElementById('presence-status');
    if (statusInput) {
        statusInput.addEventListener('change', () => {
            const emoji = document.getElementById('presence-emoji');
            if (emoji) emoji.textContent = STATUS_EMOJIS[statusInput.value] || '🟢';
        });
    }

    // Activer/désactiver le champ texte selon le type d'activité
    const activityInput = document.getElementById('presence-activity-type');
    const activityText = document.getElementById('presence-activity-text');
    if (activityInput && activityText) {
        activityInput.addEventListener('change', () => {
            const none = activityInput.value === '-1';
            activityText.disabled = none;
            activityText.style.opacity = none ? '.4' : '1';
        });
    }
}

async function savePresence() {
    if (savingPresence) return;
    savingPresence = true;

    const btn = document.getElementById('presence-save');
    const originalText = btn.textContent;
    btn.textContent = '...';
    btn.disabled = true;

    try {
        const status = document.getElementById('presence-status').value;
        const activityType = parseInt(document.getElementById('presence-activity-type').value);
        const activityText = document.getElementById('presence-activity-text').value.trim();

        if (!activityText) {
            showToast('Le texte ne peut pas être vide', 'error');
            return;
        }

        const result = await API.put('/api/presence', {
            status,
            activity_type: activityType,
            activity_text: activityText
        });

        if (result.success) {
            showToast('Statut du bot mis à jour');
        } else {
            showToast(result.error || 'Erreur', 'error');
        }
    } catch {
        showToast('Erreur de connexion', 'error');
    } finally {
        setTimeout(() => {
            savingPresence = false;
            if (btn) {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }, 500);
    }
}

async function loadOverview(container) {
    const [modules, presenceHtml] = await Promise.all([
        API.get(`/api/guilds/${currentGuild.id}/modules`).then(m => m || {}),
        getPresenceHtml()
    ]);

    const moduleList = [
        { key: 'moderation', icon: '🛡️', name: 'Modération', desc: 'Warn, mute, kick, ban, logs automatiques', page: 'moderation' },
        { key: 'welcome', icon: '👋', name: 'Welcome / Leave', desc: 'Messages de bienvenue et départ personnalisés', page: 'welcome' },
        { key: 'reactionroles', icon: '🎭', name: 'Reaction Roles', desc: 'Rôles automatiques via réactions emoji', page: 'reactionroles' },
        { key: 'embeds', icon: '📝', name: 'Embeds Custom', desc: 'Constructeur d\'embeds avec preview live', page: 'embeds' },
        { key: 'customcmds', icon: '⚡', name: 'Commandes Custom', desc: 'Commandes personnalisées avec texte ou embed', page: 'customcmds' },
        { key: 'tempvoice', icon: '🎧', name: 'Vocaux Temp.', desc: 'Salons vocaux créés automatiquement, supprimés quand vides', page: 'tempvoice' },
        { key: 'tickets', icon: '🎫', name: 'Tickets', desc: 'Système de support avec channels privés et transcripts', page: 'tickets' },
        { key: 'scheduled', icon: '⏰', name: 'Rappels', desc: 'Messages programmés et récurrents avec mentions ciblées', page: 'scheduled' },
        { key: 'music', icon: '🎵', name: 'Musique', desc: 'Lecture depuis n\'importe quelle plateforme', page: 'music' }
    ];

    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">Vue d'ensemble ✨</h1>
            <p class="main-subtitle">Gère les modules d'Quasar sur ${currentGuild.name}</p>
        </div>
        ${presenceHtml}
        <div class="modules-grid">
            ${moduleList.map((m, i) => {
                const mod = modules[m.key];
                const enabled = mod?.enabled ?? false;
                return `
                    <div class="module-card" onclick="loadPage('${m.page}')">
                        <div class="module-card-header">
                            <div style="display:flex;align-items:center;gap:.5rem">
                                <span class="module-card-icon">${m.icon}</span>
                                <span class="module-card-title">${m.name}</span>
                            </div>
                            <span class="badge ${enabled ? 'badge-active' : 'badge-inactive'}">${enabled ? 'Actif' : 'Inactif'}</span>
                        </div>
                        <div class="module-card-desc">${m.desc}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;

    // Attacher les events de la section présence après insertion dans le DOM
    bindPresenceEvents();
}

function loadMusic(container) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🎵 Musique</h1>
            <p class="main-subtitle">Contrôlé directement via les commandes Discord</p>
        </div>
        <div class="card">
            <div class="card-title">Commandes disponibles</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                ${[
                    ['/play [lien ou recherche]', 'Jouer une musique'],
                    ['/pause', 'Mettre en pause'],
                    ['/resume', 'Reprendre'],
                    ['/skip', 'Passer à la suivante'],
                    ['/stop', 'Arrêter et vider la queue'],
                    ['/queue', 'Voir la file d\'attente'],
                    ['/np', 'Piste en cours'],
                    ['/disconnect', 'Déconnecter le bot']
                ].map(([cmd, desc]) => `
                    <div style="padding:.6rem .9rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                        <code style="color:var(--accent);font-size:.85rem">${cmd}</code>
                        <p style="color:var(--text-secondary);font-size:.8rem;margin-top:.2rem">${desc}</p>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="card">
            <p style="color:var(--text-secondary);font-size:.85rem">💡 La musique supporte YouTube, Spotify, Apple Music, Deezer et tout lien compatible Odesli.</p>
        </div>
    `;
}

// ═══ Event Listeners ═══
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.sidebar-link[data-page]').forEach(el => {
        el.addEventListener('click', () => loadPage(el.dataset.page));
    });
    bindServerMenuEvents();
    bindAutoRefresh();
    init();
});

window.showToast = showToast;
window.loadPage = loadPage;
