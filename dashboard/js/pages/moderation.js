async function loadModeration(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🛡️ Modération</h1>
            <p class="main-subtitle">Logs, sanctions automatiques et historique</p>
        </div>
        <div id="mod-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const [config, channels] = await Promise.all([
        API.get(`/api/guilds/${guildId}/moderation/config`),
        API.get(`/api/guilds/${guildId}/channels`)
    ]);

    document.getElementById('mod-content').innerHTML = `
        <!-- Channel de logs -->
        <div class="card">
            <div class="card-title">📝 Channel de logs</div>
            <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                <select class="select" id="log-channel" style="max-width:280px">
                    <option value="">— Désactivé —</option>
                    ${channels.map(c => `<option value="${c.id}" ${config.logChannel === c.id ? 'selected' : ''}>#${c.name}</option>`).join('')}
                </select>
                <button class="btn btn-primary" onclick="saveModConfig()">Enregistrer</button>
                ${config.logChannel ? `<button class="btn btn-danger" onclick="removeLogChannel()">Retirer</button>` : ''}
            </div>
        </div>

        <!-- Sanctions auto : déplacées vers « Modération auto » → onglet « Escalade ».
             La carte qui vivait ici (mute-at / mute-duration / kick-at / ban-at) écrivait
             dans modules.config.autoSanctions, un champ que plus aucun code ne lit depuis
             que l'escalade à paliers multiples l'a remplacé. Régler « ban après 5 » n'y
             produisait plus rien : une interface muette est pire que pas d'interface,
             alors elle est retirée plutôt que laissée en décor. -->
        <div class="card">
            <div class="card-title">⚡ Sanctions automatiques</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin-bottom:1rem">
                Les sanctions déclenchées par l'accumulation d'avertissements se règlent désormais
                dans <strong>Modération auto</strong>, onglet <strong>Escalade</strong> : autant de paliers que vous voulez,
                des sanctions composables, et une portée par rôle ou par salon.
            </p>
            <button class="btn btn-primary" onclick="openEscalationSettings()">Ouvrir l'onglet Escalade</button>
        </div>

        <!-- Conservation des sanctions -->
        <div class="card">
            <div class="card-title">🗃️ Conservation des sanctions</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin-bottom:1rem">
                Au-delà de cette durée, les sanctions sont supprimées définitivement de la base.
                Elles contiennent des données nominatives (membre visé, modérateur, motif) : c'est toi,
                administrateur de ce serveur, qui décides combien de temps les garder.
            </p>
            <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;max-width:500px">
                <label style="width:140px;font-size:.9rem">Conserver pendant</label>
                <input class="input" type="number" id="sanction-retention" min="0" max="120"
                    value="${config.sanctionRetentionMonths ?? 12}" style="width:80px">
                <span style="color:var(--text-secondary);font-size:.85rem">mois</span>
                <button class="btn btn-primary" onclick="saveModConfig()">Enregistrer</button>
            </div>
            <p style="color:var(--text-muted);font-size:.8rem;margin-top:1rem;line-height:1.5">
                ⚠️ Cette durée sert aussi de fenêtre à l'escalade des avertissements : un warn
                plus ancien ne compte plus dans le déclenchement d'un palier.<br>
                Les bannissements <strong>encore en vigueur</strong> ne sont jamais supprimés, quelle que soit leur ancienneté.<br>
                <code>0</code> désactive la suppression — les sanctions sont alors conservées sans limite de durée.
            </p>
        </div>

        <!-- Logs activés -->
        <div class="card">
            <div class="card-title">📋 Types de logs</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin-bottom:1rem">Coche les événements que tu veux voir dans le channel de logs.</p>
            <div id="log-toggles"><p style="color:var(--text-muted)">Chargement...</p></div>
        </div>

        <!-- Historique -->
        <div class="card">
            <div class="card-title">📋 Historique des sanctions</div>
            <div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap">
                <select class="select" id="sanction-type" onchange="loadSanctions()" style="width:160px">
                    <option value="">Tous types</option>
                    <option value="warn">⚠️ Warns</option>
                    <option value="mute">🔇 Mutes</option>
                    <option value="kick">🔴 Kicks</option>
                    <option value="ban">🔨 Bans</option>
                    <!-- Type écrit par les déclenchements de l'AutoMod natif de Discord.
                         Ces lignes existaient déjà en base et s'affichaient en « Tous types » :
                         il ne manquait que l'entrée pour les filtrer. -->
                    <option value="automod">🤖 AutoMod Discord</option>
                </select>
            </div>
            <div id="sanctions-list"><p style="color:var(--text-secondary)">Chargement...</p></div>
        </div>
    `;

    document.getElementById('mod-content').innerHTML += renderCommandsBlock([
        ['/warn @membre [raison]', 'Avertir un membre'],
        ['/warns @membre', 'Voir les warns d\'un membre'],
        ['/unwarn [id]', 'Retirer un avertissement'],
        ['/mute @membre [durée] [raison]', 'Timeout un membre (ex: 10m, 2h, 1d)'],
        ['/unmute @membre', 'Retirer le timeout'],
        ['/kick @membre [raison]', 'Expulser un membre'],
        ['/ban @membre [raison] [supprimer]', 'Bannir un membre'],
        ['/unban [id]', 'Débannir un utilisateur'],
        ['/clear [nombre] [@membre]', 'Supprimer des messages (optionnel : d\'un membre)'],
        ['/sanctions @membre', 'Historique complet d\'un membre'],
        ['/log #channel', 'Définir le channel de logs'],
        ['/unlog', 'Retirer le channel de logs']
    ]);

    window._modConfig = config;
    window._guildId = guildId;
    loadSanctions();
    loadLogToggles(guildId, config);
}

// Construit la configuration complète du module modération à partir du formulaire.
// L'API remplace la config entière : tout champ omis ici serait effacé — c'est ce
// qui faisait disparaître les types de logs cochés à chaque « Enregistrer ».
function _buildModConfig() {
    const logChannel = document.getElementById('log-channel').value;

    const retentionField = document.getElementById('sanction-retention');
    const retentionRaw = retentionField ? retentionField.value : '';
    const sanctionRetentionMonths = retentionRaw === '' ? 12 : Math.max(0, parseInt(retentionRaw) || 0);

    // Types de logs : depuis les cases si elles sont affichées, sinon depuis la
    // config déjà chargée. Jamais reconstruits à vide.
    const checkboxes = document.querySelectorAll('.log-toggle');
    let enabledLogs;
    if (checkboxes.length > 0) {
        enabledLogs = {};
        checkboxes.forEach(cb => { enabledLogs[cb.dataset.key] = cb.checked; });
    } else {
        enabledLogs = (window._modConfig && window._modConfig.enabledLogs) || {};
    }

    // `autoSanctions` n'est PLUS écrit : le champ ne pilotait plus rien depuis que
    // l'escalade à paliers multiples l'a remplacé, et l'API remplace la config
    // entière — le réécrire ici l'aurait maintenu en vie pour rien. Les
    // configurations existantes ont déjà été reprises en base par la migration
    // warn_escalation_from_autosanctions_v1.
    return {
        logChannel: logChannel || null,
        sanctionRetentionMonths,
        enabledLogs
    };
}

/**
 * Ouvre la page « Modération auto » directement sur l'onglet « Escalade ».
 * L'onglet actif est choisi au rendu : il faut donc attendre que la page soit
 * montée avant de basculer, sinon le changement porte sur une page qui n'existe
 * pas encore.
 */
async function openEscalationSettings() {
    await loadPage('automod');
    if (typeof switchAutomodTab === 'function') await switchAutomodTab('escalation');
}

let _savingMod = false;
async function saveModConfig() {
    if (_savingMod) return;
    _savingMod = true;

    const config = _buildModConfig();

    try {
        await API.put(`/api/guilds/${window._guildId}/moderation/config`, config);
        window._modConfig = config;
        showToast('✅ Modération sauvegardée !');
    } finally { _savingMod = false; }
}

async function removeLogChannel() {
    document.getElementById('log-channel').value = '';
    await saveModConfig();
    showToast('✅ Channel de logs retiré.');
}

async function loadSanctions() {
    const type = document.getElementById('sanction-type')?.value || '';
    const url = `/api/guilds/${window._guildId}/moderation/sanctions?limit=30${type ? `&type=${type}` : ''}`;
    const sanctions = await API.get(url) || [];
    const list = document.getElementById('sanctions-list');

    if (!sanctions.length) {
        list.innerHTML = '<p style="color:var(--text-secondary)">Aucune sanction.</p>';
        return;
    }

    const icons = { warn: '⚠️', mute: '🔇', kick: '🔴', ban: '🔨', automod: '🤖' };
    list.innerHTML = `<div style="display:flex;flex-direction:column;gap:.5rem">
        ${sanctions.map(s => `
            <div style="display:flex;gap:1rem;align-items:center;padding:.75rem 1rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.85rem">
                <span style="font-size:1.1rem">${icons[s.type] || '📋'}</span>
                <span style="color:var(--text-secondary);">#${s.id}</span>
                <span style="flex:1"><code style="color:var(--accent)">${s.user_id}</code> — ${s.reason || 'Aucune raison'}</span>
                ${s.duration ? `<span style="color:var(--text-muted)">${s.duration}</span>` : ''}
                <span style="color:var(--text-muted)">${new Date(s.created_at + 'Z').toLocaleDateString('fr-FR')}</span>
                <span class="badge ${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? 'Actif' : 'Retiré'}</span>
            </div>
        `).join('')}
    </div>`;
}

async function loadLogToggles(guildId, config) {
    const categories = await API.get(`/api/guilds/${guildId}/moderation/log-categories`);
    if (!categories) return;

    const enabledLogs = config.enabledLogs || {};
    const container = document.getElementById('log-toggles');

    // Grouper par catégorie
    const groups = {};
    for (const [key, val] of Object.entries(categories)) {
        if (!groups[val.category]) groups[val.category] = [];
        groups[val.category].push({ key, ...val });
    }

    let html = '';
    for (const [cat, items] of Object.entries(groups)) {
        html += `<div style="margin-bottom:1rem">
            <div style="font-size:.85rem;font-weight:600;color:var(--text-secondary);margin-bottom:.5rem">${cat}</div>
            <div style="display:flex;flex-wrap:wrap;gap:.5rem">
                ${items.map(item => {
                    const isDefault = item.key.startsWith('mod_');
                    const checked = enabledLogs[item.key] !== undefined ? enabledLogs[item.key] : isDefault;
                    return `<label style="display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:20px;font-size:.8rem;cursor:pointer;transition:var(--transition)">
                        <input type="checkbox" class="log-toggle" data-key="${item.key}" ${checked ? 'checked' : ''} onchange="saveLogToggles()" style="accent-color:var(--accent)">
                        ${item.label}
                    </label>`;
                }).join('')}
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

async function saveLogToggles() {
    const config = _buildModConfig();
    await API.put(`/api/guilds/${window._guildId}/moderation/config`, config);
    window._modConfig = config;
    showToast('✅ Logs mis à jour !');
}

window.saveModConfig = saveModConfig;
window.removeLogChannel = removeLogChannel;
window.loadSanctions = loadSanctions;
window.loadModeration = loadModeration;
window.saveLogToggles = saveLogToggles;
window.openEscalationSettings = openEscalationSettings;
