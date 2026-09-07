// ═══════════════════════════════════
//        Quasar — Page Mise à jour
// ═══════════════════════════════════

// eslint-disable-next-line no-unused-vars
async function loadUpdate(container) {
    const data = await API.get('/api/version');

    if (!data) {
        container.innerHTML = `
            <div class="main-header">
                <h1 class="main-title">Mise à jour</h1>
                <p class="main-subtitle">Impossible de vérifier la version.</p>
            </div>`;
        return;
    }

    const envLabel = data.environment === 'docker' ? 'Docker' : 'Natif (Node.js)';
    const envReady = data.environmentReady;
    const hasUpdate = data.updateAvailable;

    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">Mise à jour</h1>
            <p class="main-subtitle">Gestion des versions de Quasar</p>
        </div>

        <div class="card">
            <div class="card-title">Informations</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:.75rem">
                <div>
                    <div style="color:var(--text-muted);font-size:.75rem;margin-bottom:.25rem">Version actuelle</div>
                    <div style="font-size:1.1rem;font-weight:600">v${escapeHtml(data.local)}</div>
                </div>
                <div>
                    <div style="color:var(--text-muted);font-size:.75rem;margin-bottom:.25rem">Dernière version</div>
                    <div style="font-size:1.1rem;font-weight:600;color:${hasUpdate ? 'var(--accent)' : 'var(--success)'}">
                        ${data.remote ? 'v' + escapeHtml(data.remote) : 'Aucune release'}
                    </div>
                </div>
                <div>
                    <div style="color:var(--text-muted);font-size:.75rem;margin-bottom:.25rem">Environnement</div>
                    <div style="font-size:.9rem">${envLabel}</div>
                </div>
                <div>
                    <div style="color:var(--text-muted);font-size:.75rem;margin-bottom:.25rem">Statut</div>
                    <div style="font-size:.9rem">
                        <span class="badge ${hasUpdate ? 'badge-active' : 'badge-inactive'}" style="${hasUpdate ? 'background:hsla(var(--accent-h), var(--accent-s), var(--accent-l), 0.1);color:var(--accent)' : ''}">
                            ${hasUpdate ? 'Mise à jour disponible' : 'À jour'}
                        </span>
                    </div>
                </div>
            </div>
            ${data.releaseUrl ? `<div style="margin-top:1rem"><a href="${data.releaseUrl}" target="_blank" rel="noopener" style="color:var(--accent);font-size:.8rem">Voir les notes de version →</a></div>` : ''}
        </div>

        ${!envReady && data.environment === 'docker' ? `
        <div class="card" style="border-color:var(--warning)">
            <div class="card-title" style="color:var(--warning)">Configuration requise</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin-top:.5rem">
                Pour utiliser la mise à jour automatique en Docker, ajoutez ces volumes à votre <code>docker-compose.yml</code> :
            </p>
            <pre class="update-terminal" style="margin-top:.75rem;max-height:none">volumes:
  - quasar-data:/app/data
  - /var/run/docker.sock:/var/run/docker.sock
  - .:/host-app
environment:
  - QUASAR_HOST_DIR=/host-app</pre>
        </div>` : ''}

        <div id="update-action" class="card">
            ${hasUpdate && envReady ? `
                <button class="btn btn-primary" id="btn-update" style="width:100%">
                    Lancer la mise à jour — v${data.local} → v${data.remote}
                </button>
            ` : !hasUpdate ? `
                <p style="color:var(--text-secondary);font-size:.85rem;text-align:center">Quasar est à jour.</p>
            ` : `
                <p style="color:var(--text-secondary);font-size:.85rem;text-align:center">Configurez l'environnement Docker pour activer la mise à jour automatique.</p>
            `}
        </div>

        <div id="update-output" style="display:none">
            <div class="card">
                <div class="card-title" id="update-status-title">Mise à jour en cours...</div>
                <pre class="update-terminal" id="update-log"></pre>
            </div>
        </div>
    `;

    const btnUpdate = document.getElementById('btn-update');
    if (btnUpdate) {
        btnUpdate.addEventListener('click', () => startUpdate());
    }
}

function startUpdate() {
    const actionDiv = document.getElementById('update-action');
    const outputDiv = document.getElementById('update-output');
    const logPre = document.getElementById('update-log');
    const statusTitle = document.getElementById('update-status-title');

    actionDiv.style.display = 'none';
    outputDiv.style.display = 'block';

    const token = getToken();
    const es = new EventSource(`/api/update?token=${token}`);

    es.onmessage = (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }

        const line = document.createElement('div');

        switch (data.type) {
            case 'status':
                line.className = 'log-status';
                line.textContent = `▸ ${data.message}`;
                statusTitle.textContent = data.message;
                break;
            case 'error':
                line.className = 'log-error';
                line.textContent = data.message;
                break;
            case 'done':
                line.className = 'log-success';
                line.textContent = `\n✓ ${data.message}`;
                statusTitle.textContent = data.message;
                es.close();
                waitForRestart();
                break;
            case 'fail':
                line.className = 'log-error';
                line.textContent = `\n✗ ${data.message}`;
                statusTitle.textContent = data.message;
                statusTitle.style.color = 'var(--danger)';
                es.close();
                break;
            default:
                line.textContent = data.message;
        }

        logPre.appendChild(line);
        logPre.scrollTop = logPre.scrollHeight;
    };

    es.onerror = () => {
        es.close();
        // Si la connexion se ferme pendant l'update, c'est normal (le container redémarre)
        const line = document.createElement('div');
        line.className = 'log-status';
        line.textContent = '\n▸ Connexion perdue — le serveur redémarre...';
        logPre.appendChild(line);
        logPre.scrollTop = logPre.scrollHeight;
        waitForRestart();
    };
}

function waitForRestart() {
    const statusTitle = document.getElementById('update-status-title');
    const logPre = document.getElementById('update-log');

    statusTitle.textContent = 'Reconnexion...';

    let attempts = 0;
    const maxAttempts = 60; // 3 minutes max

    const poll = setInterval(async () => {
        attempts++;
        try {
            const res = await fetch('/api/version', {
                headers: { 'Authorization': `Bearer ${getToken()}` }
            });
            if (res.ok) {
                clearInterval(poll);
                const data = await res.json();
                statusTitle.textContent = `Mise à jour terminée — v${data.local}`;
                statusTitle.style.color = 'var(--success)';

                const line = document.createElement('div');
                line.className = 'log-success';
                line.textContent = `✓ Quasar v${data.local} opérationnel.`;
                logPre.appendChild(line);
                logPre.scrollTop = logPre.scrollHeight;

                // Retirer le bandeau update
                const banner = document.getElementById('update-banner');
                if (banner) banner.remove();
            }
        } catch {
            // pas encore up
        }

        if (attempts >= maxAttempts) {
            clearInterval(poll);
            statusTitle.textContent = 'Le serveur ne répond pas';
            statusTitle.style.color = 'var(--danger)';
        }
    }, 3000);
}
