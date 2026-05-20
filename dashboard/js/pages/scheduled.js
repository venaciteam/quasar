// ═══════════════════════════════════════════════════════════════
//  Page Rappels — Messages programmés
// ═══════════════════════════════════════════════════════════════

const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const SCHEDULE_LABELS = {
    once: 'Une fois',
    daily: 'Quotidien',
    weekly: 'Hebdomadaire',
    monthly: 'Mensuel'
};

// Timezones francophones courantes (label affiché — IANA en value)
const TIMEZONES_FR = [
    { id: 'Europe/Paris',        label: 'France métropolitaine (Europe/Paris)' },
    { id: 'Europe/Brussels',     label: 'Belgique (Europe/Brussels)' },
    { id: 'Europe/Zurich',       label: 'Suisse (Europe/Zurich)' },
    { id: 'Europe/Luxembourg',   label: 'Luxembourg (Europe/Luxembourg)' },
    { id: 'America/Montreal',    label: 'Québec / Montréal (America/Montreal)' },
    { id: 'America/Martinique',  label: 'Martinique (America/Martinique)' },
    { id: 'America/Guadeloupe',  label: 'Guadeloupe (America/Guadeloupe)' },
    { id: 'America/Cayenne',     label: 'Guyane (America/Cayenne)' },
    { id: 'Indian/Reunion',      label: 'La Réunion (Indian/Reunion)' },
    { id: 'Indian/Mayotte',      label: 'Mayotte (Indian/Mayotte)' },
    { id: 'Indian/Antananarivo', label: 'Madagascar (Indian/Antananarivo)' },
    { id: 'Pacific/Tahiti',      label: 'Polynésie française (Pacific/Tahiti)' },
    { id: 'Pacific/Noumea',      label: 'Nouvelle-Calédonie (Pacific/Noumea)' },
    { id: 'Africa/Abidjan',      label: 'Côte d\'Ivoire & Afrique de l\'Ouest (Africa/Abidjan)' },
    { id: 'Africa/Dakar',        label: 'Sénégal (Africa/Dakar)' },
    { id: 'Africa/Kinshasa',     label: 'RDC ouest / Kinshasa (Africa/Kinshasa)' }
];

let _scheduledState = {
    guildId: null,
    channels: [],
    roles: [],
    embeds: [],
    timezone: 'Europe/Paris',
    editingId: null      // null = mode création
};

async function loadScheduled(container, guildId) {
    _scheduledState.guildId = guildId;
    _scheduledState.editingId = null;

    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">⏰ Rappels</h1>
            <p class="main-subtitle">Programme l'envoi automatique de messages dans tes channels, avec mentions et récurrence.</p>
        </div>
        <div id="scheduled-tz-bar"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start" id="scheduled-grid">
            <!-- Builder -->
            <div class="card">
                <div class="card-title" id="scheduled-builder-title">✏️ Nouveau rappel</div>
                <div id="scheduled-form"></div>
            </div>

            <!-- Liste -->
            <div class="card">
                <div class="card-title">📋 Rappels programmés</div>
                <div id="scheduled-list"><p style="color:var(--text-secondary)">Chargement...</p></div>
            </div>
        </div>
    `;

    // Charger en parallèle channels + rôles + embeds + rappels + settings
    const [channels, roles, embeds, scheduled, settings] = await Promise.all([
        API.get(`/api/guilds/${guildId}/channels`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/embeds`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/scheduled`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/settings`).then(r => r || {})
    ]);

    _scheduledState.channels = channels.filter(c => c.type === 0); // text only
    _scheduledState.roles = roles;
    _scheduledState.embeds = embeds;
    _scheduledState.timezone = settings.timezone || 'Europe/Paris';

    renderTimezoneBar();
    renderScheduledForm();
    renderScheduledList(scheduled);
}

function renderTimezoneBar() {
    const tz = _scheduledState.timezone;
    const known = TIMEZONES_FR.find(t => t.id === tz);
    const label = known ? known.label : tz;
    const bar = document.getElementById('scheduled-tz-bar');
    if (!bar) return;
    bar.innerHTML = `
        <div class="card" style="padding:.75rem 1rem;margin-bottom:1.25rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
            <span style="font-size:.85rem;color:var(--text-secondary)">🌍 Fuseau horaire du serveur :</span>
            <strong style="font-size:.9rem">${escapeHtml(label)}</strong>
            <button class="btn" style="padding:.3rem .7rem;font-size:.75rem;margin-left:auto" onclick="openTimezoneEditor()">Modifier</button>
        </div>
        <div id="tz-editor" hidden style="margin-bottom:1.25rem"></div>
    `;
}

function openTimezoneEditor() {
    const editor = document.getElementById('tz-editor');
    if (!editor) return;
    const currentTz = _scheduledState.timezone;
    const isKnown = TIMEZONES_FR.some(t => t.id === currentTz);
    const selectValue = isKnown ? currentTz : '__custom__';

    editor.hidden = false;
    editor.innerHTML = `
        <div class="card" style="padding:1rem">
            <div style="font-size:.85rem;color:var(--text-secondary);margin-bottom:.5rem">Choisis dans la liste ou utilise "Autre" pour une zone IANA personnalisée.</div>
            <div style="display:flex;flex-direction:column;gap:.5rem">
                <select class="input" id="tz-select" onchange="onTimezoneSelectChange()">
                    ${TIMEZONES_FR.map(t => `<option value="${t.id}" ${t.id === selectValue ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
                    <option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Autre (saisie libre)</option>
                </select>
                <input class="input" id="tz-custom" placeholder="ex: Europe/London, Asia/Bangkok..." value="${isKnown ? '' : escapeHtml(currentTz)}" style="${selectValue === '__custom__' ? '' : 'display:none'}">
                <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="saveTimezone()">💾 Enregistrer</button>
                    <button class="btn" onclick="closeTimezoneEditor()">Annuler</button>
                </div>
                <p style="font-size:.7rem;color:var(--text-muted);margin:.25rem 0 0">Changer la timezone recalcule la prochaine exécution de tous les rappels actifs.</p>
            </div>
        </div>
    `;
}

function closeTimezoneEditor() {
    const editor = document.getElementById('tz-editor');
    if (editor) { editor.hidden = true; editor.innerHTML = ''; }
}

function onTimezoneSelectChange() {
    const sel = document.getElementById('tz-select');
    const custom = document.getElementById('tz-custom');
    if (!sel || !custom) return;
    custom.style.display = sel.value === '__custom__' ? '' : 'none';
}

async function saveTimezone() {
    const sel = document.getElementById('tz-select');
    const custom = document.getElementById('tz-custom');
    if (!sel) return;
    let tz = sel.value;
    if (tz === '__custom__') {
        tz = (custom?.value || '').trim();
        if (!tz) { showToast('Renseigne une timezone IANA', 'error'); return; }
    }
    const res = await API.put(`/api/guilds/${_scheduledState.guildId}/settings`, { timezone: tz });
    if (res?.success) {
        _scheduledState.timezone = tz;
        showToast('Fuseau horaire mis à jour');
        closeTimezoneEditor();
        renderTimezoneBar();
        await refreshScheduledList();
    } else {
        showToast(res?.error || 'Erreur', 'error');
    }
}

function renderScheduledForm(existing = null) {
    const isEdit = !!existing;
    _scheduledState.editingId = isEdit ? existing.id : null;

    const titleEl = document.getElementById('scheduled-builder-title');
    if (titleEl) titleEl.textContent = isEdit ? `✏️ Modifier "${existing.name}"` : '✏️ Nouveau rappel';

    const data = existing || {
        name: '',
        channel_id: _scheduledState.channels[0]?.id || '',
        content_type: 'text',
        content_text: '',
        embed_id: null,
        mention_roles: [],
        mention_users: [],
        mention_everyone: false,
        mention_here: false,
        schedule_type: 'daily',
        schedule_time: '09:00',
        schedule_day: 1,
        schedule_date: null
    };

    const channelOptions = _scheduledState.channels
        .map(c => `<option value="${c.id}" ${c.id === data.channel_id ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`)
        .join('');

    const embedOptions = _scheduledState.embeds.length
        ? _scheduledState.embeds.map(e => `<option value="${e.id}" ${e.id === data.embed_id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('')
        : '<option disabled>Aucun embed sauvegardé</option>';

    const rolesHtml = _scheduledState.roles.length
        ? _scheduledState.roles.map(r => {
            const checked = (data.mention_roles || []).includes(r.id) ? 'checked' : '';
            const color = r.color && r.color !== '#000000' ? r.color : 'var(--text-secondary)';
            return `<label style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.8rem;cursor:pointer">
                <input type="checkbox" class="sm-role" value="${r.id}" ${checked}>
                <span style="color:${color}">@${escapeHtml(r.name)}</span>
            </label>`;
        }).join('')
        : '<p style="color:var(--text-muted);font-size:.8rem">Aucun rôle disponible</p>';

    const usersText = (data.mention_users || []).join(', ');

    const form = document.getElementById('scheduled-form');
    form.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:.75rem">
            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Nom du rappel</label>
                <input class="input" id="sm-name" maxlength="80" placeholder="ex: Daily standup, Réunion lundi..." value="${escapeHtml(data.name)}">
            </div>

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Channel cible</label>
                <select class="input" id="sm-channel">${channelOptions}</select>
            </div>

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Contenu du message</label>
                <div style="display:flex;gap:1rem;margin-bottom:.5rem">
                    <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                        <input type="radio" name="sm-content-type" value="text" ${data.content_type === 'text' ? 'checked' : ''} onchange="toggleScheduledContent()">
                        Texte brut
                    </label>
                    <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                        <input type="radio" name="sm-content-type" value="embed" ${data.content_type === 'embed' ? 'checked' : ''} onchange="toggleScheduledContent()">
                        Embed sauvegardé
                    </label>
                </div>
                <div id="sm-content-text-wrap" style="${data.content_type === 'text' ? '' : 'display:none'}">
                    <textarea class="input" id="sm-content-text" rows="4" maxlength="2000" placeholder="Le texte du rappel (markdown Discord supporté)" style="resize:vertical">${escapeHtml(data.content_text || '')}</textarea>
                </div>
                <div id="sm-embed-wrap" style="${data.content_type === 'embed' ? '' : 'display:none'}">
                    <select class="input" id="sm-embed-id">${embedOptions}</select>
                    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Crée tes embeds dans la page 📝 Embeds.</p>
                </div>
            </div>

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Mentions — Rôles</label>
                <div id="sm-roles" style="display:flex;flex-wrap:wrap;gap:.4rem">${rolesHtml}</div>
            </div>

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Mentions — Utilisateurs (IDs Discord séparés par virgules)</label>
                <input class="input" id="sm-users" placeholder="123456789012345678, 987654321098765432" value="${escapeHtml(usersText)}">
                <p style="font-size:.7rem;color:var(--text-muted);margin-top:.2rem">Active le mode développeur dans Discord → clic droit sur un user → Copier l'ID.</p>
            </div>

            <div style="display:flex;gap:1rem;flex-wrap:wrap">
                <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                    <input type="checkbox" id="sm-everyone" ${data.mention_everyone ? 'checked' : ''}>
                    @everyone
                </label>
                <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                    <input type="checkbox" id="sm-here" ${data.mention_here ? 'checked' : ''}>
                    @here
                </label>
            </div>

            <hr style="border:none;border-top:1px solid var(--border-default);margin:.25rem 0">

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Récurrence</label>
                <select class="input" id="sm-schedule-type" onchange="toggleScheduledSchedule()">
                    <option value="once" ${data.schedule_type === 'once' ? 'selected' : ''}>Une fois (date + heure)</option>
                    <option value="daily" ${data.schedule_type === 'daily' ? 'selected' : ''}>Tous les jours</option>
                    <option value="weekly" ${data.schedule_type === 'weekly' ? 'selected' : ''}>Toutes les semaines</option>
                    <option value="monthly" ${data.schedule_type === 'monthly' ? 'selected' : ''}>Tous les mois</option>
                </select>
            </div>

            <div id="sm-once-wrap" style="${data.schedule_type === 'once' ? '' : 'display:none'}">
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Date</label>
                <input class="input" type="date" id="sm-date" value="${data.schedule_date || ''}">
            </div>

            <div id="sm-weekly-wrap" style="${data.schedule_type === 'weekly' ? '' : 'display:none'}">
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Jour de la semaine</label>
                <select class="input" id="sm-weekday">
                    ${WEEKDAYS.map((d, i) => `<option value="${i}" ${Number(data.schedule_day) === i ? 'selected' : ''}>${d}</option>`).join('')}
                </select>
            </div>

            <div id="sm-monthly-wrap" style="${data.schedule_type === 'monthly' ? '' : 'display:none'}">
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Jour du mois (1-31)</label>
                <input class="input" type="number" min="1" max="31" id="sm-monthday" value="${Number.isInteger(Number(data.schedule_day)) ? data.schedule_day : 1}">
                <p style="font-size:.7rem;color:var(--text-muted);margin-top:.2rem">Si un mois n'a pas ce jour (ex: 31 en février), le dernier jour du mois sera utilisé.</p>
            </div>

            <div>
                <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Heure (24h, ${escapeHtml(_scheduledState.timezone)})</label>
                <input class="input" type="time" id="sm-time" value="${data.schedule_time || '09:00'}">
            </div>

            <div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.25rem">
                <button class="btn btn-primary" onclick="saveScheduled()">💾 ${isEdit ? 'Mettre à jour' : 'Créer le rappel'}</button>
                ${isEdit ? '<button class="btn" onclick="cancelScheduledEdit()">Annuler</button>' : '<button class="btn" onclick="renderScheduledForm()">Effacer</button>'}
            </div>
        </div>
    `;
}

function toggleScheduledContent() {
    const type = document.querySelector('input[name="sm-content-type"]:checked')?.value || 'text';
    document.getElementById('sm-content-text-wrap').style.display = type === 'text' ? '' : 'none';
    document.getElementById('sm-embed-wrap').style.display = type === 'embed' ? '' : 'none';
}

function toggleScheduledSchedule() {
    const type = document.getElementById('sm-schedule-type').value;
    document.getElementById('sm-once-wrap').style.display = type === 'once' ? '' : 'none';
    document.getElementById('sm-weekly-wrap').style.display = type === 'weekly' ? '' : 'none';
    document.getElementById('sm-monthly-wrap').style.display = type === 'monthly' ? '' : 'none';
}

function cancelScheduledEdit() {
    _scheduledState.editingId = null;
    renderScheduledForm();
}

function readScheduledForm() {
    const contentType = document.querySelector('input[name="sm-content-type"]:checked')?.value || 'text';
    const scheduleType = document.getElementById('sm-schedule-type').value;

    const usersRaw = document.getElementById('sm-users').value || '';
    const mentionUsers = usersRaw.split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));

    const mentionRoles = Array.from(document.querySelectorAll('#sm-roles input.sm-role:checked')).map(el => el.value);

    const payload = {
        name: document.getElementById('sm-name').value.trim(),
        channel_id: document.getElementById('sm-channel').value,
        content_type: contentType,
        content_text: contentType === 'text' ? document.getElementById('sm-content-text').value : null,
        embed_id: contentType === 'embed' ? Number(document.getElementById('sm-embed-id').value) : null,
        mention_roles: mentionRoles,
        mention_users: mentionUsers,
        mention_everyone: document.getElementById('sm-everyone').checked,
        mention_here: document.getElementById('sm-here').checked,
        schedule_type: scheduleType,
        schedule_time: document.getElementById('sm-time').value
    };

    if (scheduleType === 'once') payload.schedule_date = document.getElementById('sm-date').value;
    if (scheduleType === 'weekly') payload.schedule_day = Number(document.getElementById('sm-weekday').value);
    if (scheduleType === 'monthly') payload.schedule_day = Number(document.getElementById('sm-monthday').value);

    return payload;
}

async function saveScheduled() {
    const payload = readScheduledForm();
    if (!payload.name) { showToast('Nom requis', 'error'); return; }
    if (payload.content_type === 'text' && !payload.content_text?.trim()) { showToast('Texte requis', 'error'); return; }
    if (payload.content_type === 'embed' && !payload.embed_id) { showToast('Sélectionne un embed', 'error'); return; }
    if (payload.schedule_type === 'once' && !payload.schedule_date) { showToast('Date requise', 'error'); return; }

    const guildId = _scheduledState.guildId;
    const editingId = _scheduledState.editingId;

    const url = editingId
        ? `/api/guilds/${guildId}/scheduled/${editingId}`
        : `/api/guilds/${guildId}/scheduled`;
    const method = editingId ? 'put' : 'post';

    const res = await API[method](url, payload);
    if (res?.success) {
        showToast(editingId ? 'Rappel mis à jour' : 'Rappel créé');
        _scheduledState.editingId = null;
        await refreshScheduledList();
        renderScheduledForm();
    } else {
        showToast(res?.error || 'Erreur', 'error');
    }
}

async function refreshScheduledList() {
    const rows = await API.get(`/api/guilds/${_scheduledState.guildId}/scheduled`) || [];
    renderScheduledList(rows);
}

function renderScheduledList(rows) {
    const list = document.getElementById('scheduled-list');
    if (!rows.length) {
        list.innerHTML = '<p style="color:var(--text-secondary);font-size:.9rem">Aucun rappel programmé pour ce serveur.</p>';
        return;
    }

    list.innerHTML = rows.map(r => {
        const channelName = _scheduledState.channels.find(c => c.id === r.channel_id)?.name || r.channel_id;
        const nextStr = r.next_run ? formatFutureDate(r.next_run * 1000) : '—';
        const recurStr = formatRecurrence(r);
        const mentions = [];
        if (r.mention_everyone) mentions.push('@everyone');
        if (r.mention_here) mentions.push('@here');
        if (r.mention_roles?.length) mentions.push(`${r.mention_roles.length} rôle${r.mention_roles.length > 1 ? 's' : ''}`);
        if (r.mention_users?.length) mentions.push(`${r.mention_users.length} user${r.mention_users.length > 1 ? 's' : ''}`);
        const mentionsStr = mentions.length ? mentions.join(', ') : 'aucune';
        const contentBadge = r.content_type === 'embed' ? '📝 Embed' : '✏️ Texte';

        return `
            <div class="card" style="padding:.85rem;margin-bottom:.6rem;background:var(--bg-card)">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem">
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                            <span>${escapeHtml(r.name)}</span>
                            <span class="badge ${r.enabled ? 'badge-active' : 'badge-inactive'}">${r.enabled ? 'Actif' : 'Inactif'}</span>
                        </div>
                        <div style="font-size:.78rem;color:var(--text-secondary);margin-top:.3rem;display:flex;flex-wrap:wrap;gap:.6rem">
                            <span>📍 #${escapeHtml(channelName)}</span>
                            <span>${contentBadge}</span>
                            <span>🔁 ${recurStr}</span>
                            <span>👥 ${mentionsStr}</span>
                        </div>
                        <div style="font-size:.75rem;color:var(--text-muted);margin-top:.2rem">⏭️ Prochain : ${nextStr}</div>
                    </div>
                    <div style="display:flex;gap:.3rem;flex-shrink:0">
                        <button class="btn" style="padding:.3rem .55rem;font-size:.75rem" onclick="toggleScheduled(${r.id})" title="${r.enabled ? 'Désactiver' : 'Activer'}">${r.enabled ? '⏸' : '▶'}</button>
                        <button class="btn" style="padding:.3rem .55rem;font-size:.75rem" onclick="editScheduled(${r.id})">✏️</button>
                        <button class="btn" style="padding:.3rem .55rem;font-size:.75rem" onclick="deleteScheduled(${r.id})">🗑</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Cache la liste pour edit
    list.dataset.cached = JSON.stringify(rows);
}

function formatRecurrence(r) {
    const time = r.schedule_time || '??:??';
    switch (r.schedule_type) {
        case 'once':
            if (!r.schedule_date) return `Une fois à ${time}`;
            const [y, m, d] = r.schedule_date.split('-');
            return `Le ${d}/${m}/${y} à ${time}`;
        case 'daily':
            return `Chaque jour à ${time}`;
        case 'weekly':
            return `Chaque ${WEEKDAYS[r.schedule_day] || '?'} à ${time}`;
        case 'monthly':
            return `Le ${r.schedule_day} de chaque mois à ${time}`;
        default:
            return SCHEDULE_LABELS[r.schedule_type] || r.schedule_type;
    }
}

function formatFutureDate(ms) {
    const d = new Date(ms);
    const tz = _scheduledState.timezone || 'Europe/Paris';
    try {
        const fmt = new Intl.DateTimeFormat('fr-FR', {
            timeZone: tz,
            weekday: 'short', day: '2-digit', month: 'short',
            hour: '2-digit', minute: '2-digit'
        });
        return fmt.format(d);
    } catch {
        return d.toISOString();
    }
}

async function toggleScheduled(id) {
    const res = await API.post(`/api/guilds/${_scheduledState.guildId}/scheduled/${id}/toggle`, {});
    if (res?.success) {
        showToast(res.enabled ? 'Rappel activé' : 'Rappel désactivé');
        await refreshScheduledList();
    } else {
        showToast(res?.error || 'Erreur', 'error');
    }
}

async function editScheduled(id) {
    const list = document.getElementById('scheduled-list');
    let rows = [];
    try { rows = JSON.parse(list.dataset.cached || '[]'); } catch {}
    const row = rows.find(r => r.id === id);
    if (!row) {
        showToast('Rappel introuvable', 'error');
        return;
    }
    renderScheduledForm(row);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteScheduled(id) {
    if (!confirm('Supprimer ce rappel ?')) return;
    const res = await API.delete(`/api/guilds/${_scheduledState.guildId}/scheduled/${id}`);
    if (res?.success) {
        showToast('Rappel supprimé');
        if (_scheduledState.editingId === id) {
            _scheduledState.editingId = null;
            renderScheduledForm();
        }
        await refreshScheduledList();
    } else {
        showToast(res?.error || 'Erreur', 'error');
    }
}

// Expose globalement (cohérent avec les autres pages dashboard)
window.loadScheduled = loadScheduled;
window.toggleScheduledContent = toggleScheduledContent;
window.toggleScheduledSchedule = toggleScheduledSchedule;
window.saveScheduled = saveScheduled;
window.toggleScheduled = toggleScheduled;
window.editScheduled = editScheduled;
window.deleteScheduled = deleteScheduled;
window.cancelScheduledEdit = cancelScheduledEdit;
window.renderScheduledForm = renderScheduledForm;
window.openTimezoneEditor = openTimezoneEditor;
window.closeTimezoneEditor = closeTimezoneEditor;
window.onTimezoneSelectChange = onTimezoneSelectChange;
window.saveTimezone = saveTimezone;
