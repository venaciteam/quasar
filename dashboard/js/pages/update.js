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

// La mise à jour se déclenche désormais en POST authentifié par en-tête : en GET,
// un simple préchargement de lien suffisait à la lancer, et le jeton voyageait
// dans l'URL. `EventSource` ne sait faire ni l'un ni l'autre (GET seul, aucun
// en-tête possible) : le flux est donc lu à la main avec fetch + ReadableStream.
// Le format des événements reste identique côté serveur — du SSE, un événement
// par bloc séparé d'une ligne vide, chaque ligne utile préfixée « data: » — c'est
// seulement le découpage qui est fait ici au lieu d'être offert par le navigateur.
async function startUpdate() {
    const actionDiv = document.getElementById('update-action');
    const outputDiv = document.getElementById('update-output');
    const logPre = document.getElementById('update-log');
    const statusTitle = document.getElementById('update-status-title');

    actionDiv.style.display = 'none';
    outputDiv.style.display = 'block';

    // Passe à true dès que le serveur a annoncé la fin (done/fail) : au-delà, la
    // fermeture du flux est attendue et ne doit plus être signalée comme une perte
    // de connexion.
    let acheve = false;

    function ajouterLigne(className, texte) {
        const line = document.createElement('div');
        if (className) line.className = className;
        line.textContent = texte;
        logPre.appendChild(line);
        logPre.scrollTop = logPre.scrollHeight;
    }

    function traiterEvenement(data) {
        switch (data.type) {
            case 'status':
                ajouterLigne('log-status', `▸ ${data.message}`);
                statusTitle.textContent = data.message;
                break;
            case 'error':
                ajouterLigne('log-error', data.message);
                break;
            case 'done':
                ajouterLigne('log-success', `\n✓ ${data.message}`);
                statusTitle.textContent = data.message;
                acheve = true;
                waitForRestart();
                break;
            case 'fail':
                ajouterLigne('log-error', `\n✗ ${data.message}`);
                statusTitle.textContent = data.message;
                statusTitle.style.color = 'var(--danger)';
                acheve = true;
                break;
            default:
                ajouterLigne(null, data.message);
        }
    }

    // Un bloc SSE peut porter plusieurs lignes ; seules celles préfixées « data: »
    // nous intéressent, les commentaires de maintien de connexion (« : ping ») et
    // les champs event/id sont ignorés sans bruit.
    function traiterBloc(bloc) {
        for (const ligne of bloc.split('\n')) {
            if (!ligne.startsWith('data:')) continue;
            let data;
            try { data = JSON.parse(ligne.slice(5).trim()); } catch { continue; }
            traiterEvenement(data);
        }
    }

    function signalerPerteConnexion() {
        // Si la connexion se ferme pendant l'update, c'est normal (le container redémarre)
        statusTitle.textContent = 'Connexion perdue';
        ajouterLigne('log-status', '\n▸ Connexion perdue — le serveur redémarre...');
        waitForRestart();
    }

    let reponse;
    try {
        reponse = await fetch('/api/update', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
    } catch {
        statusTitle.textContent = 'Serveur injoignable';
        statusTitle.style.color = 'var(--danger)';
        ajouterLigne('log-error', '✗ Impossible de joindre le serveur. Vérifiez votre connexion, puis réessayez.');
        return;
    }

    // Refus avant même le flux : 403 pour un compte qui n'est pas propriétaire de
    // l'instance, 409 si une mise à jour tourne déjà. Le corps JSON porte le motif.
    if (!reponse.ok || !reponse.body) {
        const corps = await reponse.json().catch(() => ({}));
        const motif = corps.error
            || (reponse.status === 403
                ? 'La mise à jour est réservée à la personne propriétaire de l\'instance.'
                : 'La mise à jour n\'a pas pu être lancée.');
        statusTitle.textContent = 'Mise à jour refusée';
        statusTitle.style.color = 'var(--danger)';
        ajouterLigne('log-error', `✗ ${motif}`);
        return;
    }

    const lecteur = reponse.body.getReader();
    const decodeur = new TextDecoder();
    let tampon = '';

    try {
        while (!acheve) {
            const { value, done } = await lecteur.read();
            if (done) break;
            tampon += decodeur.decode(value, { stream: true });

            // Un bloc se termine sur une ligne vide ; le reste attend le prochain
            // morceau, un événement pouvant être coupé au milieu par le réseau.
            let separateur;
            while ((separateur = tampon.indexOf('\n\n')) !== -1) {
                traiterBloc(tampon.slice(0, separateur));
                tampon = tampon.slice(separateur + 2);
            }
        }
        if (acheve) {
            // Fin annoncée : on relâche le flux sans attendre que le serveur ferme.
            lecteur.cancel().catch(() => {});
        } else {
            signalerPerteConnexion();
        }
    } catch {
        if (!acheve) signalerPerteConnexion();
    }
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
