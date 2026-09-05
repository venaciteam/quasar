async function loadTempVoice(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🎧 Vocaux Temporaires</h1>
            <p class="main-subtitle">Salons vocaux créés automatiquement, supprimés quand vides</p>
        </div>
        <div id="tempvoice-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const [triggers, channels, active, stats] = await Promise.all([
        API.get(`/api/guilds/${guildId}/tempvoice/triggers`),
        API.get(`/api/guilds/${guildId}/channels`),
        API.get(`/api/guilds/${guildId}/tempvoice/active`),
        API.get(`/api/guilds/${guildId}/tempvoice/stats`)
    ]);

    const voiceChannels = channels.filter(c => c.type === 2);

    document.getElementById('tempvoice-content').innerHTML = `
        <!-- Triggers -->
        <div class="card">
            <div class="card-title">📡 Salons Triggers</div>
            <p style="font-size:.8rem;color:var(--text-muted);margin-bottom:1rem">1 trigger max par catégorie. Les membres qui rejoignent un trigger obtiennent un vocal personnel.</p>

            <div id="tv-triggers-list">
                ${triggers.length === 0
                    ? '<p style="color:var(--text-muted);font-size:.85rem">Aucun trigger configuré.</p>'
                    : triggers.map(t => `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                            <div style="display:flex;align-items:center;gap:.75rem">
                                <label class="toggle">
                                    <input type="checkbox" ${t.enabled ? 'checked' : ''} onchange="toggleTrigger('${guildId}', '${t.channel_id}', this.checked)">
                                    <span class="toggle-slider"></span>
                                </label>
                                <div>
                                    <span style="color:var(--text-primary);font-weight:500">🔊 ${escapeHtml(t.channel_name)}</span>
                                    <span style="color:var(--text-muted);font-size:.8rem;margin-left:.5rem">→ ${escapeHtml(t.category_name)}</span>
                                </div>
                            </div>
                            <button class="btn btn-danger btn-sm" onclick="removeTrigger('${guildId}', '${t.channel_id}')">✕</button>
                        </div>
                    `).join('')}
            </div>

            <!-- Ajouter un trigger -->
            <div style="display:flex;gap:.75rem;margin-top:1rem;align-items:flex-end">
                <div style="flex:1">
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Ajouter un trigger</label>
                    <select class="select" id="tv-add-channel">
                        <option value="">— Choisir un salon vocal —</option>
                        ${voiceChannels.map(c => `<option value="${c.id}">🔊 ${c.name}</option>`).join('')}
                    </select>
                </div>
                <button class="btn btn-primary" id="tv-add-btn">+ Ajouter</button>
            </div>
        </div>

        <!-- Stats -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-top:1rem">
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${stats.triggers}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Triggers</div>
            </div>
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${stats.active}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Vocaux actifs</div>
            </div>
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${stats.preferences}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Préférences sauvées</div>
            </div>
        </div>

        <!-- Active channels -->
        <div class="card" style="margin-top:1rem">
            <div class="card-title">🎧 Salons actifs</div>
            <div id="tv-active-list">
                ${active.length === 0
                    ? '<p style="color:var(--text-muted);font-size:.85rem">Aucun salon temporaire actif.</p>'
                    : active.map(ch => `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                            <div>
                                <span style="color:var(--text-primary);font-weight:500">🎧 ${escapeHtml(ch.channel_name)}</span>
                                <span style="color:var(--text-muted);font-size:.8rem;margin-left:.5rem">par ${escapeHtml(ch.owner_name)}</span>
                                <span style="color:var(--text-muted);font-size:.75rem;margin-left:.5rem">(${escapeHtml(ch.category_name)})</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:.75rem">
                                <span style="font-size:.8rem;color:var(--text-secondary)">👥 ${ch.member_count}</span>
                                <button class="btn btn-danger btn-sm" onclick="deleteTempVoice('${guildId}', '${ch.channel_id}')">✕</button>
                            </div>
                        </div>
                    `).join('')}
            </div>
        </div>

        <!-- Commandes -->
        <div class="card" style="margin-top:1rem">
            <div class="card-title">📋 Commandes</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                ${[
                    ['/tempvoice setup #salon', 'Ajouter un trigger'],
                    ['/tempvoice remove #salon', 'Retirer un trigger'],
                    ['/tempvoice disable', 'Désactiver tous les triggers'],
                    ['/tempvoice enable', 'Réactiver tous les triggers'],
                    ['/tempvoice info', 'Voir la config'],
                    ['/voice name <nom>', 'Renommer son salon'],
                    ['/voice limit <n>', 'Limiter les places'],
                    ['/voice lock', 'Verrouiller'],
                    ['/voice unlock', 'Déverrouiller'],
                    ['/voice permit @user', 'Autoriser quelqu\'un'],
                    ['/voice kick @user', 'Expulser quelqu\'un'],
                    ['/voice reset', 'Reset préférences (catégorie)']
                ].map(([cmd, desc]) => `
                    <div style="padding:.6rem .9rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                        <code style="color:var(--accent);font-size:.85rem">${cmd}</code>
                        <p style="color:var(--text-secondary);font-size:.8rem;margin-top:.2rem">${desc}</p>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Ajouter un trigger
    document.getElementById('tv-add-btn').addEventListener('click', async () => {
        const channelId = document.getElementById('tv-add-channel').value;
        if (!channelId) { showToast('Choisissez un salon vocal.', 'error'); return; }

        const res = await API.post(`/api/guilds/${guildId}/tempvoice/triggers`, { channel_id: channelId });
        if (res.error) {
            showToast(res.error, 'error');
        } else {
            showToast('Trigger ajouté ✨');
            await loadTempVoice(container, guildId);
        }
    });
}

async function toggleTrigger(guildId, channelId, enabled) {
    await API.put(`/api/guilds/${guildId}/tempvoice/triggers/${channelId}/toggle`, { enabled });
    showToast(enabled ? 'Trigger activé ✨' : 'Trigger désactivé');
}

async function removeTrigger(guildId, channelId) {
    if (!confirm('Retirer ce trigger ?')) return;
    await API.delete(`/api/guilds/${guildId}/tempvoice/triggers/${channelId}`);
    showToast('Trigger retiré');
    loadPage('tempvoice');
}

async function deleteTempVoice(guildId, channelId) {
    if (!confirm('Supprimer ce salon vocal ?')) return;
    await API.delete(`/api/guilds/${guildId}/tempvoice/active/${channelId}`);
    showToast('Salon supprimé');
    loadPage('tempvoice');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

window.toggleTrigger = toggleTrigger;
window.removeTrigger = removeTrigger;
window.deleteTempVoice = deleteTempVoice;
