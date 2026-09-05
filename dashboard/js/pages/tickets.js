async function loadTickets(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🎫 Tickets</h1>
            <p class="main-subtitle">Système de support avec salons privés — transcript remis dans Discord à la fermeture</p>
        </div>
        <div id="tickets-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const [config, roles, channels] = await Promise.all([
        API.get(`/api/guilds/${guildId}/tickets`),
        API.get(`/api/guilds/${guildId}/roles`),
        API.get(`/api/guilds/${guildId}/channels`)
    ]);

    const textChannels = channels.filter(c => c.type === 0);
    const categories = channels.filter(c => c.type === 4);

    // Pas encore configuré → formulaire de setup
    if (!config.configured) {
        document.getElementById('tickets-content').innerHTML = `
            <div class="card">
                <div class="card-title">🚀 Configurer le système de tickets</div>
                <p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:1.5rem">
                    Configurez le système de tickets pour votre serveur. Un message avec un bouton 🎫 sera envoyé dans le salon choisi.
                </p>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Salon d'ouverture <span style="color:var(--accent)">*</span></label>
                        <select class="select" id="setup-channel">
                            <option value="">— Choisir un salon —</option>
                            ${textChannels.map(c => `<option value="${c.id}"># ${c.name}</option>`).join('')}
                        </select>
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Rôle staff <span style="color:var(--accent)">*</span></label>
                        <select class="select" id="setup-staff-role">
                            <option value="">— Choisir un rôle —</option>
                            ${roles.filter(r => r.name !== '@everyone').map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
                        </select>
                    </div>
                </div>

                <div style="margin-top:1rem">
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Catégorie des tickets</label>
                    <select class="select" id="setup-category">
                        <option value="">— Aucune (racine du serveur) —</option>
                        ${categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                    </select>
                </div>

                <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)">
                    <div style="font-size:.9rem;font-weight:600;color:var(--text-primary);margin-bottom:.75rem">📨 Message du panel (embed dans le salon)</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                        <div>
                            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Titre</label>
                            <input class="input" id="setup-panel-title" type="text" placeholder="🎫 Support — Ouvrir un ticket" style="width:100%">
                        </div>
                        <div style="grid-column:1/-1">
                            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Description</label>
                            <textarea class="input" id="setup-panel-desc" rows="2" placeholder="Cliquez sur le bouton ci-dessous pour ouvrir un ticket.&#10;Un membre du staff vous répondra dès que possible." style="width:100%;resize:vertical"></textarea>
                        </div>
                    </div>
                    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Laissez vide pour utiliser le message par défaut.</p>
                </div>

                <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)">
                    <div style="font-size:.9rem;font-weight:600;color:var(--text-primary);margin-bottom:.75rem">👋 Message d'accueil (dans le ticket)</div>
                    <textarea class="input" id="setup-welcome" rows="3" placeholder="Décrivez votre problème, un membre du staff vous répondra bientôt !"
                        style="width:100%;resize:vertical"></textarea>
                    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Ce message sera affiché quand un ticket est créé. Laissez vide pour le message par défaut.</p>
                </div>

                <div style="margin-top:1.5rem;display:flex;justify-content:flex-end">
                    <button class="btn btn-primary" id="setup-btn">🎫 Activer les tickets</button>
                </div>
            </div>

            <!-- Commandes -->
            ${buildCommandsCard()}
        `;

        document.getElementById('setup-btn').addEventListener('click', async () => {
            const channelId = document.getElementById('setup-channel').value;
            const staffRoleId = document.getElementById('setup-staff-role').value;
            const categoryId = document.getElementById('setup-category').value;
            const welcomeMessage = document.getElementById('setup-welcome').value;

            if (!channelId) { showToast('Choisissez un salon d\'ouverture.', 'error'); return; }
            if (!staffRoleId) { showToast('Choisissez un rôle staff.', 'error'); return; }

            const panelTitle = document.getElementById('setup-panel-title').value;
            const panelDesc = document.getElementById('setup-panel-desc').value;

            const btn = document.getElementById('setup-btn');
            btn.disabled = true;
            btn.textContent = 'Configuration...';

            const res = await API.post(`/api/guilds/${guildId}/tickets/setup`, {
                channel_id: channelId,
                staff_role_id: staffRoleId,
                category_id: categoryId || null,
                welcome_message: welcomeMessage || null,
                panel_title: panelTitle || null,
                panel_description: panelDesc || null
            });

            if (res.error) {
                showToast(res.error, 'error');
                btn.disabled = false;
                btn.textContent = '🎫 Activer les tickets';
            } else {
                showToast('Tickets configurés ! Le message a été envoyé dans le salon ✨');
                await loadTickets(container, guildId);
            }
        });

        return;
    }

    // Déjà configuré → afficher la config + tickets
    const list = await API.get(`/api/guilds/${guildId}/tickets/list`);
    const openTickets = list.open || [];
    const closedTickets = list.recent_closed || [];

    document.getElementById('tickets-content').innerHTML = `
        <!-- Config -->
        <div class="card">
            <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
                <span>⚙️ Configuration</span>
                <div style="display:flex;align-items:center;gap:.75rem">
                    <label class="toggle">
                        <input type="checkbox" id="tickets-enabled" ${config.enabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    <span style="color:var(--text-secondary);font-size:.85rem" id="tickets-enabled-label">${config.enabled ? 'Activé' : 'Désactivé'}</span>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:.75rem">
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Rôle staff</label>
                    <select class="select" id="tickets-staff-role">
                        ${roles.filter(r => r.name !== '@everyone').map(r => `<option value="${r.id}" ${r.id === config.staff_role_id ? 'selected' : ''}>${r.name}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Catégorie des tickets</label>
                    <select class="select" id="tickets-category">
                        <option value="">— Aucune (racine du serveur) —</option>
                        ${categories.map(c => `<option value="${c.id}" ${c.id === config.category_id ? 'selected' : ''}>${c.name}</option>`).join('')}
                    </select>
                </div>
            </div>

            <div style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--border)">
                <div style="font-size:.9rem;font-weight:600;color:var(--text-primary);margin-bottom:.75rem">📨 Message du panel</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Titre</label>
                        <input class="input" id="tickets-panel-title" type="text" placeholder="🎫 Support — Ouvrir un ticket" value="${_escapeHtml(config.panel_title || '')}" style="width:100%">
                    </div>
                    <div style="grid-column:1/-1">
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Description</label>
                        <textarea class="input" id="tickets-panel-desc" rows="2" placeholder="Cliquez sur le bouton ci-dessous pour ouvrir un ticket.&#10;Un membre du staff vous répondra dès que possible." style="width:100%;resize:vertical">${_escapeHtml(config.panel_description || '')}</textarea>
                    </div>
                </div>
                <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">Laissez vide pour le message par défaut. Les changements s'appliquent au prochain renvoi du panel.</p>
            </div>

            <div style="margin-top:1rem">
                <div style="font-size:.9rem;font-weight:600;color:var(--text-primary);margin-bottom:.75rem">👋 Message d'accueil (dans le ticket)</div>
                <textarea class="input" id="tickets-welcome" rows="3" placeholder="Décrivez votre problème, un membre du staff vous répondra bientôt !"
                    style="width:100%;resize:vertical">${_escapeHtml(config.welcome_message || '')}</textarea>
            </div>

            <div style="margin-top:1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem">
                <div style="display:flex;gap:.75rem;flex-wrap:wrap">
                    <button class="btn btn-sm" id="tickets-resend-btn" title="Renvoyer le message avec le bouton 🎫 dans un salon">📨 Renvoyer le message</button>
                    <select class="select" id="tickets-resend-channel" style="max-width:200px;font-size:.8rem">
                        ${textChannels.map(c => `<option value="${c.id}" ${c.id === config.channel_id ? 'selected' : ''}># ${c.name}</option>`).join('')}
                    </select>
                </div>
                <button class="btn btn-primary" id="tickets-save-btn">💾 Sauvegarder</button>
            </div>
        </div>

        <!-- Stats -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-top:1rem">
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${openTickets.length}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Ouverts</div>
            </div>
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${closedTickets.length}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Fermés (récents)</div>
            </div>
            <div class="card">
                <div style="font-size:2rem;font-weight:700;color:var(--accent)">${openTickets.length + closedTickets.length}</div>
                <div style="font-size:.85rem;color:var(--text-secondary)">Total</div>
            </div>
        </div>

        <!-- Open tickets -->
        <div class="card" style="margin-top:1rem">
            <div class="card-title">📬 Tickets ouverts</div>
            <div id="tickets-open-list">
                ${openTickets.length === 0
                    ? '<p style="color:var(--text-muted);font-size:.85rem">Aucun ticket ouvert.</p>'
                    : openTickets.map(t => `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                            <div>
                                <span style="color:var(--accent);font-weight:600">#${t.id}</span>
                                <span style="color:var(--text-primary);font-weight:500;margin-left:.5rem">${_escapeHtml(t.user_name)}</span>
                                <span style="color:var(--text-muted);font-size:.8rem;margin-left:.5rem">${_formatDate(t.opened_at)}</span>
                            </div>
                            <span style="padding:2px 8px;background:var(--accent);color:#000;border-radius:20px;font-size:.75rem;font-weight:600">Ouvert</span>
                        </div>
                    `).join('')}
            </div>
        </div>

        <!-- Closed tickets -->
        <div class="card" style="margin-top:1rem">
            <div class="card-title">📪 Tickets fermés (50 derniers)</div>
            <div id="tickets-closed-list">
                ${closedTickets.length === 0
                    ? '<p style="color:var(--text-muted);font-size:.85rem">Aucun ticket fermé.</p>'
                    : closedTickets.map(t => `
                        <div style="display:flex;align-items:center;justify-content:space-between;padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                            <div style="flex:1;min-width:0">
                                <span style="color:var(--text-muted);font-weight:600">#${t.id}</span>
                                <span style="color:var(--text-primary);font-weight:500;margin-left:.5rem">${_escapeHtml(t.user_name)}</span>
                                <span style="color:var(--text-muted);font-size:.8rem;margin-left:.5rem">fermé ${_formatDate(t.closed_at)}</span>
                                ${t.close_reason ? `<span style="color:var(--text-secondary);font-size:.8rem;margin-left:.5rem">— ${_escapeHtml(t.close_reason)}</span>` : ''}
                            </div>
                        </div>
                    `).join('')}
            </div>
        </div>

        <!-- Commandes -->
        ${buildCommandsCard()}
    `;

    // Toggle enabled
    document.getElementById('tickets-enabled').addEventListener('change', async function() {
        await API.put(`/api/guilds/${guildId}/tickets`, { enabled: this.checked });
        document.getElementById('tickets-enabled-label').textContent = this.checked ? 'Activé' : 'Désactivé';
        showToast(this.checked ? 'Tickets activés ✨' : 'Tickets désactivés');
    });

    // Sauvegarder config
    document.getElementById('tickets-save-btn').addEventListener('click', async () => {
        const data = {
            staff_role_id: document.getElementById('tickets-staff-role').value,
            category_id: document.getElementById('tickets-category').value || null,
            welcome_message: document.getElementById('tickets-welcome').value,
            panel_title: document.getElementById('tickets-panel-title').value || null,
            panel_description: document.getElementById('tickets-panel-desc').value || null
        };
        const res = await API.put(`/api/guilds/${guildId}/tickets`, data);
        if (res.error) {
            showToast(res.error, 'error');
        } else {
            showToast('Configuration sauvegardée ✨');
        }
    });

    // Renvoyer le message
    document.getElementById('tickets-resend-btn').addEventListener('click', async () => {
        const channelId = document.getElementById('tickets-resend-channel').value;
        const btn = document.getElementById('tickets-resend-btn');
        btn.disabled = true;
        btn.textContent = 'Envoi...';

        const res = await API.post(`/api/guilds/${guildId}/tickets/resend`, { channel_id: channelId });
        btn.disabled = false;
        btn.textContent = '📨 Renvoyer le message';

        if (res.error) {
            showToast(res.error, 'error');
        } else {
            showToast('Message envoyé dans le salon ✨');
        }
    });
}

function buildCommandsCard() {
    return `
        <div class="card" style="margin-top:1rem">
            <div class="card-title">📋 Commandes</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                ${[
                    ['/ticket setup #salon @staff', 'Configurer le système de tickets'],
                    ['/ticket close [raison]', 'Fermer le ticket actuel'],
                    ['/ticket add @membre', 'Ajouter quelqu\'un au ticket'],
                    ['/ticket remove @membre', 'Retirer quelqu\'un du ticket'],
                    ['/ticket config', 'Voir la configuration']
                ].map(([cmd, desc]) => `
                    <div style="padding:.6rem .9rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                        <code style="color:var(--accent);font-size:.85rem">${cmd}</code>
                        <p style="color:var(--text-secondary);font-size:.8rem;margin-top:.2rem">${desc}</p>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// La consultation des transcripts depuis le dashboard a été retirée : Quasar ne
// conserve plus le contenu des conversations de tickets. Le transcript est remis
// en pièce jointe dans Discord au moment de la fermeture, et sa conservation
// relève ensuite de l'administrateur du serveur.

function _formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

window.loadTickets = loadTickets;
