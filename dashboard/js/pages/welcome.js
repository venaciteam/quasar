async function loadWelcome(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">👋 Welcome / Leave</h1>
            <p class="main-subtitle">Messages de bienvenue et de départ personnalisés</p>
        </div>
        <div id="welcome-content"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const [config, channels] = await Promise.all([
        API.get(`/api/guilds/${guildId}/welcome/config`),
        API.get(`/api/guilds/${guildId}/channels`)
    ]);

    window._guildId = guildId;
    window._welcomeConfig = config;

    const channelOptions = `<option value="">— Désactivé —</option>${channels.map(c => `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.name)}</option>`).join('')}`;

    document.getElementById('welcome-content').innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem">

            <!-- Welcome -->
            <div class="card">
                <div class="card-title" style="justify-content:space-between">
                    <span>👋 Bienvenue</span>
                    <label class="toggle"><input type="checkbox" id="welcome-enabled" ${config.welcome_enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
                </div>

                <div style="display:flex;flex-direction:column;gap:1rem">
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Channel</label>
                        <select class="select" id="welcome-channel">${channelOptions}</select>
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Message texte</label>
                        <textarea class="input" id="welcome-message" rows="3" placeholder="Bienvenue {user} sur {server} ! Membre numéro {membercount}." style="resize:vertical">${escapeHtml(config.welcome_message || '')}</textarea>
                        <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">{user} · {username} · {server} · {membercount}</p>
                    </div>

                    <details style="cursor:pointer">
                        <summary style="font-size:.85rem;color:var(--accent);margin-bottom:.75rem">⚙️ Embed (optionnel)</summary>
                        <div style="display:flex;flex-direction:column;gap:.75rem;padding:.75rem;background:rgba(255,255,255,.02);border-radius:var(--radius-sm);border:1px solid var(--border)">
                            <div>
                                <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Titre embed</label>
                                <input class="input" id="welcome-embed-title" placeholder="Bienvenue sur {server} !" value="${escapeHtml(config.welcome_embed?.title || '')}">
                            </div>
                            <div>
                                <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Description embed</label>
                                <textarea class="input" id="welcome-embed-desc" rows="2" style="resize:vertical">${escapeHtml(config.welcome_embed?.description || '')}</textarea>
                            </div>
                            <div style="display:flex;gap:.75rem;align-items:center">
                                <div style="flex:1">
                                    <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Couleur</label>
                                    <input class="input" id="welcome-embed-color" type="color" value="${escapeHtml(config.welcome_embed?.color || '#c86e8e')}" style="height:38px;padding:.2rem">
                                </div>
                                <div style="flex:1">
                                    <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Avatar en thumbnail</label>
                                    <label class="toggle" style="margin-top:.3rem"><input type="checkbox" id="welcome-embed-avatar" ${config.welcome_embed?.thumbnail === 'avatar' ? 'checked' : ''}><span class="toggle-slider"></span></label>
                                </div>
                            </div>
                        </div>
                    </details>

                    <button class="btn btn-primary" onclick="saveWelcomeConfig()">Enregistrer</button>
                </div>
            </div>

            <!-- Leave -->
            <div class="card">
                <div class="card-title" style="justify-content:space-between">
                    <span>🚪 Départ</span>
                    <label class="toggle"><input type="checkbox" id="leave-enabled" ${config.leave_enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
                </div>

                <div style="display:flex;flex-direction:column;gap:1rem">
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Channel</label>
                        <select class="select" id="leave-channel">${channelOptions}</select>
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.4rem;display:block">Message texte</label>
                        <textarea class="input" id="leave-message" rows="3" placeholder="{username} nous a quitté... Il reste {membercount} membres." style="resize:vertical">${escapeHtml(config.leave_message || '')}</textarea>
                        <p style="font-size:.75rem;color:var(--text-muted);margin-top:.3rem">{username} · {server} · {membercount}</p>
                    </div>

                    <details style="cursor:pointer">
                        <summary style="font-size:.85rem;color:var(--accent);margin-bottom:.75rem">⚙️ Embed (optionnel)</summary>
                        <div style="display:flex;flex-direction:column;gap:.75rem;padding:.75rem;background:rgba(255,255,255,.02);border-radius:var(--radius-sm);border:1px solid var(--border)">
                            <div>
                                <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Titre embed</label>
                                <input class="input" id="leave-embed-title" placeholder="{username} nous a quitté..." value="${escapeHtml(config.leave_embed?.title || '')}">
                            </div>
                            <div>
                                <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Description embed</label>
                                <textarea class="input" id="leave-embed-desc" rows="2" style="resize:vertical">${escapeHtml(config.leave_embed?.description || '')}</textarea>
                            </div>
                            <div style="display:flex;gap:.75rem;align-items:center">
                                <div style="flex:1">
                                    <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Couleur</label>
                                    <input class="input" id="leave-embed-color" type="color" value="${escapeHtml(config.leave_embed?.color || '#6e8ec8')}" style="height:38px;padding:.2rem">
                                </div>
                                <div style="flex:1">
                                    <label style="font-size:.75rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Avatar en thumbnail</label>
                                    <label class="toggle" style="margin-top:.3rem"><input type="checkbox" id="leave-embed-avatar" ${config.leave_embed?.thumbnail === 'avatar' ? 'checked' : ''}><span class="toggle-slider"></span></label>
                                </div>
                            </div>
                        </div>
                    </details>

                    <button class="btn btn-blue" onclick="saveWelcomeConfig()">Enregistrer</button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('welcome-content').innerHTML += renderCommandsBlock([
        ['/welcome channel #channel', 'Définir le channel de bienvenue'],
        ['/welcome message [texte]', 'Définir le message texte'],
        ['/welcome embed [titre] [desc] [couleur]', 'Activer un embed avec avatar'],
        ['/welcome embedoff', 'Retirer l\'embed (repasse en texte)'],
        ['/welcome test', 'Prévisualiser le message'],
        ['/welcome off', 'Désactiver les messages de bienvenue'],
        ['/leave channel #channel', 'Définir le channel de départ'],
        ['/leave message [texte]', 'Définir le message de départ'],
        ['/leave embed [titre] [desc] [couleur]', 'Activer un embed de départ'],
        ['/leave embedoff', 'Retirer l\'embed de départ'],
        ['/leave test', 'Prévisualiser le message de départ'],
        ['/leave off', 'Désactiver les messages de départ'],
        ['/autorole add @role', 'Ajouter un rôle automatique à l\'arrivée'],
        ['/autorole remove @role', 'Retirer un autorole'],
        ['/autorole list', 'Voir les autoroles configurés']
    ]);

    // Pré-sélectionner les channels
    if (config.welcome_channel) document.getElementById('welcome-channel').value = config.welcome_channel;
    if (config.leave_channel) document.getElementById('leave-channel').value = config.leave_channel;
}

async function saveWelcomeConfig() {
    const welcomeEmbedTitle = document.getElementById('welcome-embed-title').value;
    const leaveEmbedTitle = document.getElementById('leave-embed-title').value;

    const data = {
        welcome_enabled: document.getElementById('welcome-enabled').checked,
        welcome_channel: document.getElementById('welcome-channel').value || null,
        welcome_message: document.getElementById('welcome-message').value || null,
        welcome_embed: welcomeEmbedTitle ? {
            title: welcomeEmbedTitle,
            description: document.getElementById('welcome-embed-desc').value,
            color: document.getElementById('welcome-embed-color').value,
            thumbnail: document.getElementById('welcome-embed-avatar').checked ? 'avatar' : null
        } : null,
        leave_enabled: document.getElementById('leave-enabled').checked,
        leave_channel: document.getElementById('leave-channel').value || null,
        leave_message: document.getElementById('leave-message').value || null,
        leave_embed: leaveEmbedTitle ? {
            title: leaveEmbedTitle,
            description: document.getElementById('leave-embed-desc').value,
            color: document.getElementById('leave-embed-color').value,
            thumbnail: document.getElementById('leave-embed-avatar').checked ? 'avatar' : null
        } : null
    };

    // L'API valide désormais ces champs (types, longueurs, schéma de l'embed) :
    // sans ce test, un refus 400 s'affichait comme un succès et la personne
    // croyait sa configuration enregistrée.
    const res = await API.put(`/api/guilds/${window._guildId}/welcome/config`, data);
    if (res?.error) return showToast(`❌ ${res.error}`, 'error');
    showToast('✅ Welcome/Leave sauvegardé !');
}

window.loadWelcome = loadWelcome;
window.saveWelcomeConfig = saveWelcomeConfig;
