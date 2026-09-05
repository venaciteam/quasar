async function loadReactionRoles(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🎭 Reaction Roles</h1>
            <p class="main-subtitle">Autoroles, rôles vocaux et panels de rôles par réaction emoji</p>
        </div>
        <div id="rr-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const [autoroles, panels, roles, voiceRoles, channels, emojis, panelStatus] = await Promise.all([
        API.get(`/api/guilds/${guildId}/reactionroles/autoroles`),
        API.get(`/api/guilds/${guildId}/reactionroles/panels`),
        API.get(`/api/guilds/${guildId}/roles`),
        API.get(`/api/guilds/${guildId}/reactionroles/voiceroles`),
        API.get(`/api/guilds/${guildId}/channels`),
        API.get(`/api/guilds/${guildId}/emojis`),
        API.get(`/api/guilds/${guildId}/reactionroles/panels/status`)
    ]);

    const voiceChannels = (channels || []).filter(c => c.type === 2 || c.type === 13);
    const textChannels = (channels || []).filter(c => c.type === 0);

    window._guildId = guildId;
    window._rrRoles = roles;
    window._voiceChannels = voiceChannels;
    window._textChannels = textChannels;
    window._serverEmojis = emojis || [];
    window._panelStatus = panelStatus || {};

    document.getElementById('rr-content').innerHTML = `

        <!-- Autoroles -->
        <div class="card">
            <div class="card-title">✅ Autoroles <span style="font-size:.75rem;font-weight:400;color:var(--text-muted)">(attribués automatiquement à l'arrivée)</span></div>
            <div id="autoroles-list" style="display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem">
                ${autoroles.map(ar => {
                    const role = roles.find(r => r.id === ar.role_id);
                    const roleName = role ? role.name : ar.role_id;
                    const roleColor = role?.color || 'var(--accent)';
                    return `
                    <div style="display:inline-flex;align-items:center;gap:.5rem;padding:.3rem .75rem;background:hsla(var(--accent-h), var(--accent-s), var(--accent-l), 0.15);border:1px solid var(--accent);border-radius:20px;font-size:.85rem">
                        <span style="color:${roleColor};font-weight:500">@${roleName}</span>
                        <button onclick="removeAutorole('${ar.role_id}')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:1rem;line-height:1">×</button>
                    </div>`;
                }).join('') || '<p style="color:var(--text-muted);font-size:.85rem">Aucun autorole configuré</p>'}
            </div>
            <div style="display:flex;gap:.75rem;flex-wrap:wrap">
                <select class="select" id="add-autorole-select" style="max-width:220px">
                    <option value="">Choisir un rôle...</option>
                    ${roles.map(r => `<option value="${r.id}" style="color:${r.color}">${r.name}</option>`).join('')}
                </select>
                <button class="btn btn-primary" onclick="addAutorole()">Ajouter</button>
            </div>
        </div>

        <!-- Voice Roles -->
        <div class="card">
            <div class="card-title">🔊 Rôles vocaux <span style="font-size:.75rem;font-weight:400;color:var(--text-muted)">(attribués en vocal, retirés à la déconnexion)</span></div>
            <div id="voiceroles-list" style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1rem">
                ${(voiceRoles || []).map(vr => {
                    const ch = voiceChannels.find(c => c.id === vr.channel_id);
                    const chName = ch ? ch.name : vr.channel_id;
                    const role = roles.find(r => r.id === vr.role_id);
                    const roleName = role ? role.name : vr.role_id;
                    const roleColor = role?.color || 'var(--accent)';
                    return `
                    <div style="display:flex;align-items:center;gap:.75rem;padding:.5rem .75rem;background:hsla(var(--accent-h), var(--accent-s), var(--accent-l), 0.1);border:1px solid var(--accent);border-radius:var(--radius-sm);font-size:.85rem">
                        <span>🔊</span>
                        <span style="flex:1"><strong>#${chName}</strong> → <span style="color:${roleColor};font-weight:500">@${roleName}</span></span>
                        <button onclick="removeVoiceRole('${vr.channel_id}')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;line-height:1">×</button>
                    </div>`;
                }).join('') || '<p style="color:var(--text-muted);font-size:.85rem">Aucun rôle vocal configuré</p>'}
            </div>
            <div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:center">
                <select class="select" id="add-voicerole-channel" style="max-width:200px">
                    <option value="">Salon vocal...</option>
                    ${voiceChannels.map(c => `<option value="${c.id}">🔊 ${c.name}</option>`).join('')}
                </select>
                <select class="select" id="add-voicerole-role" style="max-width:200px">
                    <option value="">Rôle...</option>
                    ${roles.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
                </select>
                <button class="btn btn-blue" onclick="addVoiceRole()">Ajouter</button>
            </div>
        </div>

        <!-- Panels de Reaction Roles -->
        <div class="card">
            <div class="card-title" style="justify-content:space-between">
                <span>🎭 Panels de Reaction Roles</span>
                <button class="btn btn-primary" onclick="openCreatePanel()" style="font-size:.8rem;padding:.4rem .8rem">+ Créer un panel</button>
            </div>
            <div id="panels-list">
                ${renderPanels(panels, roles, channels, panelStatus)}
            </div>
        </div>

        <!-- Formulaire création panel (caché par défaut) -->
        <div class="card" id="panel-form-card" style="display:none">
            <div class="card-title">✏️ Nouveau panel</div>
            <div style="display:flex;flex-direction:column;gap:.75rem">
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Titre du panel</label>
                    <input class="input" id="panel-title" placeholder="Ex : Choisissez vos rôles">
                </div>
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Description (optionnel)</label>
                    <input class="input" id="panel-desc" placeholder="Cliquez sur un emoji pour obtenir le rôle">
                </div>
                <div style="display:flex;gap:.75rem;flex-wrap:wrap">
                    <div style="flex:1;min-width:180px">
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Channel</label>
                        <select class="select" id="panel-channel">
                            ${textChannels.map(c => `<option value="${c.id}">#${c.name}</option>`).join('')}
                        </select>
                    </div>
                    <div style="flex:1;min-width:180px">
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Mode</label>
                        <select class="select" id="panel-mode">
                            <option value="multiple">Multiple (cumul)</option>
                            <option value="unique">Unique (exclusif)</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex;gap:.75rem">
                    <button class="btn btn-primary" onclick="createPanel()">Créer le panel</button>
                    <button class="btn" onclick="closeCreatePanel()">Annuler</button>
                </div>
            </div>
        </div>
    `;

    // Commandes
    setTimeout(() => {
        document.getElementById('rr-content').innerHTML += renderCommandsBlock([
            ['/autorole add @role', 'Ajouter un rôle auto à l\'arrivée'],
            ['/autorole remove @role', 'Retirer un autorole'],
            ['/autorole list', 'Voir les autoroles configurés'],
            ['/reactionrole create #channel [titre] [mode]', 'Créer un panel de reaction roles'],
            ['/reactionrole add [panel_id] [emoji] @role', 'Ajouter un rôle à un panel'],
            ['/reactionrole remove [panel_id] [emoji]', 'Retirer un rôle d\'un panel'],
            ['/reactionrole delete [panel_id]', 'Supprimer un panel entier'],
            ['/reactionrole list', 'Lister les panels'],
            ['/voicerole set #vocal @role', 'Rôle attribué en vocal, retiré à la déco'],
            ['/voicerole remove #vocal', 'Retirer un rôle vocal'],
            ['/voicerole list', 'Voir les rôles vocaux configurés']
        ]);
    }, 0);
}

function renderPanels(panels, roles, channels, status) {
    if (!panels || panels.length === 0) {
        return '<p style="color:var(--text-muted);font-size:.85rem">Aucun panel créé.</p>';
    }

    return panels.map(p => {
        const ch = (channels || []).find(c => c.id === p.channel_id);
        const isMissing = status && status[p.id] === 'missing';
        return `
        <div style="padding:1rem;background:rgba(255,255,255,.02);border:1px solid ${isMissing ? 'var(--danger)' : 'var(--border)'};border-radius:var(--radius-sm);margin-bottom:.75rem" id="panel-${p.id}">
            ${isMissing ? `<div style="display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;background:rgba(231,76,60,.1);border-radius:var(--radius-sm);margin-bottom:.75rem;font-size:.85rem;color:var(--danger)">
                ⚠️ Le message Discord a été supprimé.
                <button class="btn btn-primary" style="font-size:.75rem;padding:.3rem .6rem;margin-left:auto" onclick="repostPanel(${p.id})">Reposter</button>
            </div>` : ''}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
                <div>
                    <strong>#${p.id} — ${p.title}</strong>
                    <span class="badge ${isMissing ? 'badge-inactive' : 'badge-active'}" style="margin-left:.5rem">${isMissing ? 'Message absent' : `Mode ${p.mode}`}</span>
                </div>
                <button class="btn btn-danger" style="font-size:.75rem;padding:.3rem .6rem" onclick="deletePanel(${p.id})">🗑️</button>
            </div>
            <p style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.5rem">Channel : <strong>#${ch?.name || p.channel_id}</strong> • ${p.entries.length} rôle(s)</p>
            
            <!-- Rôles existants -->
            <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
                ${p.entries.map(e => {
                    const r = (window._rrRoles || roles).find(r => r.id === e.role_id);
                    return `
                    <span style="font-size:.8rem;padding:.2rem .6rem;background:hsla(var(--accent-h), var(--accent-s), var(--accent-l), 0.1);border:1px solid var(--accent);border-radius:20px;display:inline-flex;align-items:center;gap:.3rem">
                        ${renderEmoji(e.emoji)} → <span style="color:${r?.color || 'var(--accent)'};font-weight:500">@${r?.name || e.role_id}</span>
                        <button onclick="removePanelEntry(${p.id}, '${encodeURIComponent(e.emoji)}')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:.9rem;line-height:1;margin-left:.2rem">×</button>
                    </span>`;
                }).join('') || '<span style="color:var(--text-muted);font-size:.8rem">Aucun rôle</span>'}
            </div>

            <!-- Ajouter un rôle -->
            <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;padding-top:.5rem;border-top:1px solid var(--border)">
                <div style="position:relative">
                    <input class="input" id="panel-${p.id}-emoji" placeholder="Emoji..." style="width:120px;font-size:.85rem" onfocus="showEmojiPicker(${p.id})" readonly>
                    <div id="emoji-picker-${p.id}" class="emoji-picker" style="display:none;position:absolute;bottom:100%;left:0;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.5rem;max-height:260px;overflow-y:auto;z-index:100;width:280px;box-shadow:var(--shadow)">
                        <input class="input" placeholder="🔍 Rechercher un emoji..." oninput="filterEmojis(${p.id}, this.value)" style="font-size:.8rem;padding:.4rem .6rem;margin-bottom:.5rem">
                        <div id="emoji-grid-${p.id}" style="display:flex;flex-wrap:wrap;gap:.3rem">
                            ${(window._serverEmojis || []).map(e => `
                                <button class="emoji-btn" data-name="${e.name.toLowerCase()}" onclick="selectEmoji(${p.id}, '${e.identifier}', '${e.url}')" style="background:none;border:1px solid transparent;border-radius:4px;cursor:pointer;padding:.2rem;transition:var(--transition)" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='transparent'">
                                    <img src="${e.url}" style="width:24px;height:24px" title=":${e.name}:">
                                </button>
                            `).join('')}
                        </div>
                        <div style="font-size:.7rem;color:var(--text-muted);margin-top:.4rem;padding-top:.3rem;border-top:1px solid var(--border)">Ou tape un emoji Unicode dans le champ</div>
                    </div>
                </div>
                <select class="select" id="panel-${p.id}-role" style="width:160px;font-size:.85rem">
                    <option value="">Rôle...</option>
                    ${(window._rrRoles || []).map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
                </select>
                <button class="btn btn-blue" onclick="addPanelEntry(${p.id})" style="font-size:.8rem;padding:.4rem .8rem">Ajouter</button>
            </div>
        </div>`;
    }).join('');
}

// ═══ Panel CRUD ═══

function openCreatePanel() {
    document.getElementById('panel-form-card').style.display = 'block';
    document.getElementById('panel-title').focus();
}

function closeCreatePanel() {
    document.getElementById('panel-form-card').style.display = 'none';
}

async function createPanel() {
    const title = document.getElementById('panel-title').value.trim();
    const description = document.getElementById('panel-desc').value.trim();
    const channel_id = document.getElementById('panel-channel').value;
    const mode = document.getElementById('panel-mode').value;

    if (!title) return showToast('❌ Un titre est requis.', 'error');

    const result = await API.post(`/api/guilds/${window._guildId}/reactionroles/panels`, {
        channel_id, title, description, mode
    });

    if (result.error) return showToast(`❌ ${result.error}`, 'error');

    showToast(`✅ Panel #${result.id} créé !`);
    closeCreatePanel();
    // Refresh
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function deletePanel(panelId) {
    if (!confirm(`Supprimer le panel #${panelId} ? Le message Discord sera aussi supprimé.`)) return;
    await API.delete(`/api/guilds/${window._guildId}/reactionroles/panels/${panelId}`);
    showToast(`🗑️ Panel #${panelId} supprimé.`);
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function addPanelEntry(panelId) {
    const emojiInput = document.getElementById(`panel-${panelId}-emoji`);
    const roleSelect = document.getElementById(`panel-${panelId}-role`);
    const emoji = emojiInput.dataset.value || emojiInput.value.trim();
    const role_id = roleSelect.value;

    if (!emoji || !role_id) return showToast('❌ Emoji et rôle requis.', 'error');

    const res = await API.post(`/api/guilds/${window._guildId}/reactionroles/panels/${panelId}/entries`, {
        emoji, role_id
    });
    if (!res || res.error) return showToast(res?.error || 'Le rôle n\'a pas pu être ajouté au panel.', 'error');

    showToast('✅ Rôle ajouté au panel !');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function removePanelEntry(panelId, encodedEmoji) {
    await API.delete(`/api/guilds/${window._guildId}/reactionroles/panels/${panelId}/entries/${encodedEmoji}`);
    showToast('🗑️ Rôle retiré du panel.');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function repostPanel(panelId) {
    // Ajouter un entry fictif puis le retirer pour forcer le refresh qui re-poste
    // Plus simple : on fait un appel dédié ou on utilise addPanelEntry qui trigger le refresh
    // Le refreshPanelFromApi détecte automatiquement le message manquant et re-poste
    const result = await API.post(`/api/guilds/${window._guildId}/reactionroles/panels/${panelId}/repost`, {});
    if (result.error) return showToast(`❌ ${result.error}`, 'error');
    showToast('✅ Panel re-posté !');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

// ═══ Emoji Picker ═══

function showEmojiPicker(panelId) {
    // Fermer tous les autres pickers
    document.querySelectorAll('.emoji-picker').forEach(p => p.style.display = 'none');
    const picker = document.getElementById(`emoji-picker-${panelId}`);
    picker.style.display = 'block';

    // Fermer au clic en dehors
    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!picker.contains(e.target) && e.target.id !== `panel-${panelId}-emoji`) {
                picker.style.display = 'none';
                document.removeEventListener('click', handler);
            }
        });
    }, 100);
}

function filterEmojis(panelId, query) {
    const grid = document.getElementById(`emoji-grid-${panelId}`);
    const buttons = grid.querySelectorAll('.emoji-btn');
    const q = query.toLowerCase();
    buttons.forEach(btn => {
        btn.style.display = btn.dataset.name.includes(q) ? '' : 'none';
    });
}

function selectEmoji(panelId, identifier, url) {
    const input = document.getElementById(`panel-${panelId}-emoji`);
    input.value = identifier;
    input.dataset.value = identifier;
    // Afficher l'image dans l'input
    input.style.backgroundImage = `url(${url})`;
    input.style.backgroundSize = '20px 20px';
    input.style.backgroundRepeat = 'no-repeat';
    input.style.backgroundPosition = '8px center';
    input.style.paddingLeft = '36px';
    document.getElementById(`emoji-picker-${panelId}`).style.display = 'none';
}

// ═══ Autoroles ═══

async function addAutorole() {
    const roleId = document.getElementById('add-autorole-select').value;
    if (!roleId) return;
    // La route peut refuser le rôle (géré par une intégration, au-dessus de
    // Quasar dans la hiérarchie…). Sans ce test, le toast annonçait un succès
    // sur un ajout qui n'avait pas eu lieu.
    const res = await API.post(`/api/guilds/${window._guildId}/reactionroles/autoroles`, { role_id: roleId });
    if (!res || res.error) return showToast(res?.error || 'L\'autorôle n\'a pas pu être ajouté.', 'error');
    showToast('✅ Autorole ajouté !');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function removeAutorole(roleId) {
    await API.delete(`/api/guilds/${window._guildId}/reactionroles/autoroles/${roleId}`);
    showToast('🗑️ Autorole retiré.');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

// ═══ Voice Roles ═══

async function addVoiceRole() {
    const channelId = document.getElementById('add-voicerole-channel').value;
    const roleId = document.getElementById('add-voicerole-role').value;
    if (!channelId || !roleId) return showToast('❌ Sélectionnez un salon et un rôle.', 'error');
    const res = await API.post(`/api/guilds/${window._guildId}/reactionroles/voiceroles`, { channel_id: channelId, role_id: roleId });
    if (!res || res.error) return showToast(res?.error || 'Le rôle vocal n\'a pas pu être ajouté.', 'error');
    showToast('✅ Rôle vocal ajouté !');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

async function removeVoiceRole(channelId) {
    await API.delete(`/api/guilds/${window._guildId}/reactionroles/voiceroles/${channelId}`);
    showToast('🗑️ Rôle vocal retiré.');
    const container = document.getElementById('rr-content').parentElement;
    loadReactionRoles(container, window._guildId);
}

window.loadReactionRoles = loadReactionRoles;
window.addAutorole = addAutorole;
window.removeAutorole = removeAutorole;
window.addVoiceRole = addVoiceRole;
window.removeVoiceRole = removeVoiceRole;
window.openCreatePanel = openCreatePanel;
window.closeCreatePanel = closeCreatePanel;
window.createPanel = createPanel;
window.deletePanel = deletePanel;
window.addPanelEntry = addPanelEntry;
window.removePanelEntry = removePanelEntry;
window.showEmojiPicker = showEmojiPicker;
window.selectEmoji = selectEmoji;
window.filterEmojis = filterEmojis;
window.repostPanel = repostPanel;
