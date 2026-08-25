// Contrôle d'accès des commandes personnalisées.
// Une commande custom rejoue les mentions de son embed (@everyone compris) :
// c'est ce réglage qui décide qui peut déclencher ce ping — les administrateurs
// du serveur passant toujours, quel que soit le mode. Il n'est ici qu'un
// confort de configuration — la règle est appliquée côté bot à l'exécution, et
// validée côté API à l'écriture.
const ACCESS_MODES = [
    { value: 'everyone', icon: '🌍', label: 'Tout le monde' },
    { value: 'admins', icon: '🛡️', label: 'Administrateurs uniquement' },
    { value: 'role', icon: '🎭', label: 'Un rôle précis' },
];

// Options du sélecteur de rôle. Même source que la page Rappels (l'endpoint
// /roles, qui exclut déjà @everyone et les rôles gérés par des bots), mais en
// <select> : le mode « rôle » n'en accepte qu'un seul, là où les mentions d'un
// rappel en acceptent plusieurs et justifient des cases à cocher.
function renderRoleOptions(selectedId) {
    const roles = window._availableRoles || [];
    if (roles.length === 0) return '<option value="">Aucun rôle disponible</option>';
    return roles.map(r =>
        `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>@${escapeHtml(r.name)}</option>`
    ).join('');
}

// Pastille « qui peut lancer cette commande » affichée dans la liste.
function renderAccessBadge(cmd) {
    // Même règle de repli que le bot et l'API (effectiveAccessMode) : une valeur
    // absente vaut « tout le monde », une valeur non reconnue vaut le plus
    // restrictif. L'API renvoie déjà un mode normalisé ; ce filet évite qu'une
    // réponse inattendue affiche un accès plus permissif que la réalité.
    const fallback = cmd.access_mode ? 'admins' : 'everyone';
    const mode = ACCESS_MODES.find(m => m.value === cmd.access_mode)
        || ACCESS_MODES.find(m => m.value === fallback);
    let label = mode.label;
    if (mode.value === 'role') {
        const role = (window._availableRoles || []).find(r => r.id === cmd.access_role_id);
        label = role ? `@${escapeHtml(role.name)}` : 'Rôle supprimé';
    }
    return `<span title="Qui peut utiliser la commande — les administrateurs du serveur y ont toujours accès" style="flex-shrink:0;font-size:.72rem;padding:.15rem .45rem;border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-muted);white-space:nowrap">${mode.icon} ${label}</span>`;
}

async function loadCustomCmds(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">⚡ Commandes Custom</h1>
            <p class="main-subtitle">Crée et gère des commandes personnalisées</p>
        </div>
        <div id="cmds-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    window._guildId = guildId;

    const [cmds, embeds, roles] = await Promise.all([
        API.get(`/api/guilds/${guildId}/customcmds`),
        API.get(`/api/guilds/${guildId}/embeds`),
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || [])
    ]);

    window._availableEmbeds = embeds || [];
    // Mêmes rôles que ceux proposés par la page Rappels (@everyone et rôles de
    // bots exclus côté API), pour que l'ergonomie ne change pas d'une page à
    // l'autre.
    window._availableRoles = roles || [];

    const container2 = document.getElementById('cmds-content');
    container2.innerHTML = `
        <!-- Créer une commande -->
        <div class="card">
            <div class="card-title" id="cmd-form-title">✏️ Créer une commande</div>
            <div style="display:flex;flex-direction:column;gap:.75rem">
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Nom de la commande (sans /)</label>
                    <input class="input" id="cmd-name" placeholder="ex: regles, socials, info..." style="max-width:300px">
                    <!-- Aide affichée seulement en édition : c'est là que le champ
                         devient un outil de renommage, pas un simple rappel. -->
                    <p id="cmd-name-hint" style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem;display:none"></p>
                    <!-- Erreur en ligne, sous le champ concerné : un refus de
                         renommage explique quoi corriger, un toast de 3 secondes
                         disparaît avant qu'on ait fini de le lire. -->
                    <p id="cmd-name-error" style="font-size:.75rem;color:var(--danger);margin-top:.3rem;display:none"></p>
                </div>
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Type de réponse</label>
                    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
                        <label style="display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.9rem">
                            <input type="radio" name="cmd-type" value="text" checked onchange="toggleCmdType()"> Texte
                        </label>
                        <label style="display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;font-size:.9rem">
                            <input type="radio" name="cmd-type" value="embed" onchange="toggleCmdType()"> Embed sauvegardé
                        </label>
                    </div>
                </div>
                <div id="cmd-text-field">
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Réponse texte</label>
                    <textarea class="input" id="cmd-response" rows="3" placeholder="Le texte que le bot répondra..." style="resize:vertical"></textarea>
                    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Supporte le markdown Discord : **gras**, *italique*, __souligné__, etc.</p>
                </div>
                <div id="cmd-embed-field" style="display:none">
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Embed à utiliser</label>
                    <select class="select" id="cmd-embed-select" style="max-width:300px">
                        <option value="">Choisir un embed...</option>
                        ${(embeds || []).map(e => `<option value="${e.name}">📝 ${e.name}</option>`).join('')}
                    </select>
                    ${embeds?.length === 0 ? '<p style="font-size:.8rem;color:var(--text-muted);margin-top:.3rem">Aucun embed — crée-en un dans la section Embeds d\'abord.</p>' : ''}
                </div>
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Qui peut utiliser la commande</label>
                    <select class="select" id="cmd-access" onchange="toggleCmdAccess()" style="max-width:300px">
                        ${ACCESS_MODES.map(m => `<option value="${m.value}">${m.icon} ${m.label}</option>`).join('')}
                    </select>
                    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Les mentions configurées sur l'embed lié sont envoyées à chaque utilisation : restreins l'accès si l'embed ping @everyone.</p>
                </div>
                <div id="cmd-access-role-field" style="display:none">
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Rôle autorisé</label>
                    <select class="select" id="cmd-access-role" style="max-width:300px">
                        ${renderRoleOptions()}
                    </select>
                    ${(roles || []).length === 0 ? '<p style="font-size:.8rem;color:var(--text-muted);margin-top:.3rem">Aucun rôle disponible sur ce serveur.</p>' : ''}
                </div>
                <div style="display:flex;gap:.75rem">
                    <button class="btn btn-primary" onclick="createCmd()">Créer la commande</button>
                </div>
            </div>
        </div>

        <!-- Liste des commandes -->
        <div class="card">
            <div class="card-title">⚡ Commandes actives (${(cmds || []).length})</div>
            <div id="cmds-list">
                ${renderCmds(cmds)}
            </div>
        </div>
    `;

    container2.innerHTML += renderCommandsBlock([
        ['/cmd create [nom] [reponse]', 'Créer une commande texte'],
        ['/cmd create [nom] embed:[nom_embed]', 'Créer une commande liée à un embed'],
        ['/cmd edit [nom] [reponse/embed]', 'Modifier une commande existante'],
        ['/cmd edit [nom] nouveau_nom:[nouveau]', 'Renommer une commande'],
        ['/cmd create [nom] acces:[mode] role:[@role]', 'Restreindre qui peut lancer la commande'],
        ['/cmd delete [nom]', 'Supprimer une commande'],
        ['/cmd list', 'Lister toutes les commandes']
    ]);
}

function renderCmds(cmds) {
    if (!cmds || cmds.length === 0) {
        return '<p style="color:var(--text-muted);font-size:.85rem">Aucune commande custom.</p>';
    }

    return `<div style="display:flex;flex-direction:column;gap:.5rem" id="cmds-list-inner" onclick="handleCmdAction(event)">
        ${cmds.map(c => `
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:.75rem;padding:.75rem 1rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                <code style="color:var(--accent);font-size:.9rem;min-width:100px">/${c.name}</code>
                <span style="flex:1;color:var(--text-secondary);font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    ${c.embed_id ? `📝 Embed : <strong>${c.embed_name || 'lié'}</strong>` : (c.response?.substring(0, 80) + (c.response?.length > 80 ? '…' : '') || '*vide*')}
                </span>
                ${renderAccessBadge(c)}
                <button class="btn" style="font-size:.75rem;padding:.3rem .6rem" data-action="edit" data-name="${c.name}" data-response="${(c.response || '').replace(/"/g, '&quot;')}" data-embed="${c.embed_name || ''}" data-access="${c.access_mode || 'everyone'}" data-access-role="${c.access_role_id || ''}">✏️</button>
                <button class="btn btn-danger" style="font-size:.75rem;padding:.3rem .6rem" data-action="delete" data-name="${c.name}">🗑️</button>
            </div>
        `).join('')}
    </div>`;
}

function toggleCmdType() {
    const type = document.querySelector('input[name="cmd-type"]:checked').value;
    document.getElementById('cmd-text-field').style.display = type === 'text' ? 'block' : 'none';
    document.getElementById('cmd-embed-field').style.display = type === 'embed' ? 'block' : 'none';
}

// Le sélecteur de rôle n'a de sens que dans le mode « un rôle précis ».
function toggleCmdAccess() {
    const mode = document.getElementById('cmd-access').value;
    document.getElementById('cmd-access-role-field').style.display = mode === 'role' ? 'block' : 'none';
}

// Message d'erreur en ligne sous le champ « nom ». Passer une chaîne vide le
// masque. `textContent` et non `innerHTML` : le message peut contenir le nom
// saisi par l'utilisateur.
function setCmdNameError(message) {
    const zone = document.getElementById('cmd-name-error');
    if (!zone) return;
    zone.textContent = message || '';
    zone.style.display = message ? 'block' : 'none';
}

// Aide affichée sous le champ « nom ». Vide = masquée.
function setCmdNameHint(message) {
    const zone = document.getElementById('cmd-name-hint');
    if (!zone) return;
    zone.textContent = message || '';
    zone.style.display = message ? 'block' : 'none';
}

// Lit le contrôle d'accès du formulaire. Renvoie null (et prévient) si le mode
// « rôle » est choisi sans rôle sélectionnable : l'API le refuserait de toute
// façon, autant le dire tout de suite.
function readCmdAccess() {
    const access_mode = document.getElementById('cmd-access').value;
    if (access_mode !== 'role') return { access_mode, access_role_id: null };

    const access_role_id = document.getElementById('cmd-access-role').value;
    if (!access_role_id) {
        showToast('❌ Sélectionne le rôle autorisé.', 'error');
        return null;
    }
    return { access_mode, access_role_id };
}

let _creatingCmd = false;
async function createCmd() {
    if (_creatingCmd) return;
    setCmdNameError('');
    const name = document.getElementById('cmd-name').value.trim();
    if (!name) {
        setCmdNameError('Un nom est requis.');
        return showToast('❌ Un nom est requis.', 'error');
    }

    const type = document.querySelector('input[name="cmd-type"]:checked').value;
    const body = { name };

    if (type === 'text') {
        body.response = document.getElementById('cmd-response').value.trim();
        if (!body.response) return showToast('❌ Le texte de réponse est requis.', 'error');
    } else {
        body.embed_name = document.getElementById('cmd-embed-select').value;
        if (!body.embed_name) return showToast('❌ Sélectionne un embed.', 'error');
    }

    const access = readCmdAccess();
    if (!access) return;
    Object.assign(body, access);

    // Verrou posé seulement une fois le formulaire validé : sur une sortie
    // anticipée plus haut, il serait resté fermé et aurait bloqué le bouton.
    _creatingCmd = true;
    try {
        const result = await API.post(`/api/guilds/${window._guildId}/customcmds`, body);
        if (result.error) {
            setCmdNameError(result.error);
            return showToast(`❌ ${result.error}`, 'error');
        }

        showToast(`✅ Commande /${name} créée !`);
        document.getElementById('cmd-name').value = '';
        document.getElementById('cmd-response').value = '';
        document.getElementById('cmd-access').value = 'everyone';
        toggleCmdAccess();
        const container = document.getElementById('cmds-content').parentElement;
        loadCustomCmds(container, window._guildId);
    } finally { _creatingCmd = false; }
}

function editCmd(name, response, embedName, accessMode, accessRoleId) {
    // Le champ « nom » reste modifiable : le modifier renomme la commande.
    // L'intitulé de la carte et l'aide sous le champ le disent explicitement,
    // pour qu'on ne croie pas être en train de créer une seconde commande.
    document.getElementById('cmd-name').value = name;
    document.getElementById('cmd-form-title').textContent = `✏️ Modifier /${name}`;
    setCmdNameHint(`Modifie ce champ pour renommer la commande. /${name} sera retirée du serveur Discord et remplacée par le nouveau nom.`);
    setCmdNameError('');

    // Préremplir le contrôle d'accès avec la configuration réelle de la commande.
    const accessSelect = document.getElementById('cmd-access');
    accessSelect.value = ACCESS_MODES.some(m => m.value === accessMode) ? accessMode : 'everyone';
    document.getElementById('cmd-access-role').innerHTML = renderRoleOptions(accessRoleId || '');
    toggleCmdAccess();

    if (embedName) {
        document.querySelector('input[name="cmd-type"][value="embed"]').checked = true;
        toggleCmdType();
        document.getElementById('cmd-embed-select').value = embedName;
    } else {
        document.querySelector('input[name="cmd-type"][value="text"]').checked = true;
        toggleCmdType();
        document.getElementById('cmd-response').value = response || '';
    }

    // Changer le bouton en "Modifier"
    const createBtn = document.querySelector('#cmds-content .btn-primary');
    createBtn.textContent = 'Modifier la commande';
    createBtn.onclick = async () => {
        setCmdNameError('');

        // Le nom est envoyé dans `new_name` à chaque enregistrement, même quand
        // il n'a pas bougé : l'API traite « nouveau nom = nom actuel » comme un
        // non-renommage, il n'y a donc rien à comparer côté navigateur — et rien
        // à oublier de comparer.
        const newName = document.getElementById('cmd-name').value.trim();
        if (!newName) {
            setCmdNameError('Le nom de la commande ne peut pas être vide.');
            return showToast('❌ Le nom de la commande ne peut pas être vide.', 'error');
        }

        const type = document.querySelector('input[name="cmd-type"]:checked').value;
        const body = { new_name: newName };

        if (type === 'text') {
            body.response = document.getElementById('cmd-response').value.trim();
            if (!body.response) return showToast('❌ Le texte de réponse est requis.', 'error');
        } else {
            body.embed_name = document.getElementById('cmd-embed-select').value;
            if (!body.embed_name) return showToast('❌ Sélectionne un embed.', 'error');
        }

        const access = readCmdAccess();
        if (!access) return;
        Object.assign(body, access);

        // Verrou : un double-clic enverrait deux PUT, et le second chercherait
        // une commande que le premier vient de renommer — un « introuvable »
        // affiché alors que tout s'est bien passé.
        if (createBtn.disabled) return;
        createBtn.disabled = true;
        let result;
        try {
            result = await API.put(`/api/guilds/${window._guildId}/customcmds/${encodeURIComponent(name)}`, body);
        } finally {
            createBtn.disabled = false;
        }

        if (result.error) {
            // Sous le champ ET en toast : le refus d'un renommage explique quoi
            // corriger, il doit rester lisible après la disparition du toast.
            setCmdNameError(result.error);
            return showToast(`❌ ${result.error}`, 'error');
        }

        const nomFinal = result.name || newName;
        showToast(nomFinal !== name
            ? `✅ Commande /${name} renommée en /${nomFinal} !`
            : `✅ Commande /${name} modifiée !`);
        // Discord injoignable : le renommage est enregistré, seul l'affichage des
        // commandes du serveur est en retard. On le dit sans crier à l'échec.
        if (result.warning) showToast(`⚠️ ${result.warning}`, 'info');

        const container = document.getElementById('cmds-content').parentElement;
        loadCustomCmds(container, window._guildId);
    };

    // Scroll vers le formulaire
    document.getElementById('cmd-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteCmd(name) {
    if (!confirm(`Supprimer la commande /${name} ?`)) return;
    await API.delete(`/api/guilds/${window._guildId}/customcmds/${name}`);
    showToast(`🗑️ Commande /${name} supprimée.`);
    const container = document.getElementById('cmds-content').parentElement;
    loadCustomCmds(container, window._guildId);
}

function handleCmdAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'edit') editCmd(btn.dataset.name, btn.dataset.response, btn.dataset.embed, btn.dataset.access, btn.dataset.accessRole);
    if (btn.dataset.action === 'delete') deleteCmd(btn.dataset.name);
}

window.loadCustomCmds = loadCustomCmds;
window.toggleCmdType = toggleCmdType;
window.toggleCmdAccess = toggleCmdAccess;
window.createCmd = createCmd;
window.editCmd = editCmd;
window.deleteCmd = deleteCmd;
window.handleCmdAction = handleCmdAction;
