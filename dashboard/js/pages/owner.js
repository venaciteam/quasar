// ═══════════════════════════════════════════════════════════════
//  Quasar Dashboard — Page « Instance » (owner only, sous-lot E)
//
//  Deux garde-fous de l'ouverture, réservés à la propriétaire :
//    1. Compteur de serveurs connectés + note de seuil de vigilance.
//    2. Coupure ciblée : suspendre / réactiver un serveur (réversible,
//       sans perte de données, sans retirer le bot).
//
//  L'API /api/owner/* est strictement owner-only (requireOwner). Si elle
//  renvoie 403, on affiche un message clair au lieu de la page.
//
//  Réutilise le design system VNCT et les globaux d'app.js :
//  API, showToast, escapeHtml, getToken, loadOwner (câblés dans loadPage).
// ═══════════════════════════════════════════════════════════════

// Formate un horodatage unixepoch (secondes) en date/heure locale FR.
function formatOwnerDate(unixSeconds) {
    if (!unixSeconds) return '';
    try {
        return new Date(unixSeconds * 1000).toLocaleString('fr-FR', {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return '';
    }
}

async function loadOwner(container) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">Instance ✨</h1>
            <p class="main-subtitle">Garde-fous de l'ouverture — réservé à la propriétaire</p>
        </div>
        <div id="owner-content">
            <div style="display:flex;align-items:center;justify-content:center;padding:3rem;color:var(--text-muted)">
                <div style="width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin-right:.75rem"></div>
                Chargement...
            </div>
        </div>
    `;

    const content = document.getElementById('owner-content');

    // Appel direct (plutôt que le helper API) pour pouvoir lire le code HTTP et
    // distinguer un 403 (non-owner) d'une vraie erreur serveur.
    let res;
    try {
        res = await fetch('/api/owner/guilds', {
            headers: { 'Authorization': `Bearer ${getToken()}` },
        });
    } catch {
        content.innerHTML = ownerErrorCard('Impossible de contacter le serveur.');
        return;
    }

    if (res.status === 403) {
        content.innerHTML = `
            <div class="card" style="border-color:var(--danger)">
                <div class="card-title">🔒 Accès réservé</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Cette page est réservée à la propriétaire de l'instance Quasar.
                </p>
            </div>
        `;
        return;
    }
    if (res.status === 401) {
        // Session expirée : aligné sur le comportement du helper API.
        localStorage.removeItem('quasar_token');
        window.location.href = '/';
        return;
    }
    if (!res.ok) {
        content.innerHTML = ownerErrorCard('Le serveur a renvoyé une erreur.');
        return;
    }

    let data;
    try {
        data = await res.json();
    } catch {
        content.innerHTML = ownerErrorCard('Réponse illisible du serveur.');
        return;
    }

    const servers = Array.isArray(data.servers) ? data.servers : [];
    const serverCount = Number.isInteger(data.serverCount) ? data.serverCount : servers.length;
    const threshold = Number.isInteger(data.vigilanceThreshold) ? data.vigilanceThreshold : 30;
    const warn = !!data.warn;

    // ── Compteur + note de seuil de vigilance ──
    const counterColor = warn ? 'var(--danger)' : 'var(--accent)';
    const vigilanceBlock = warn
        ? `<div style="margin-top:1rem;padding:.75rem 1rem;background:var(--bg-card);border:1px solid var(--danger);border-radius:var(--radius-sm);color:var(--text-primary);font-size:.85rem">
               ⚠️ <strong>Seuil de vigilance atteint (${threshold}+).</strong>
               Au-delà de quelques dizaines de serveurs, réévaluez l'échelle du traitement et vos obligations.
           </div>`
        : `<p style="margin-top:.9rem;color:var(--text-muted);font-size:.82rem">
               Seuil de vigilance : ${threshold} serveurs. Au-delà de quelques dizaines de serveurs,
               réévaluez l'échelle du traitement et vos obligations.
           </p>`;

    const counterCard = `
        <div class="card">
            <div class="card-title">🌐 Serveurs connectés</div>
            <div style="display:flex;align-items:baseline;gap:.75rem;flex-wrap:wrap">
                <span style="font-size:2.6rem;font-weight:800;line-height:1;color:${counterColor}">${serverCount}</span>
                <span style="color:var(--text-secondary);font-size:.9rem">serveur${serverCount > 1 ? 's' : ''} où Quasar est présent</span>
            </div>
            ${vigilanceBlock}
        </div>
    `;

    // ── Rappel sur l'effet d'une suspension ──
    const reminderCard = `
        <div class="card" style="margin-top:1rem">
            <p style="color:var(--text-secondary);font-size:.85rem;margin:0">
                🛑 <strong>Suspendre</strong> coupe les fonctions de Quasar sur CE serveur
                <strong>sans supprimer ses données</strong> ni <strong>retirer le bot</strong>. Réversible à tout moment,
                et sans effet sur les autres serveurs.
            </p>
        </div>
    `;

    // ── Liste des serveurs ──
    const rows = servers.length === 0
        ? `<p style="color:var(--text-muted);font-size:.85rem">Aucun serveur connecté.</p>`
        : servers.map(g => {
            const name = escapeHtml(g.name || g.id);
            const members = Number.isInteger(g.memberCount)
                ? `<span style="color:var(--text-muted);font-size:.8rem;margin-left:.5rem">👥 ${g.memberCount}</span>`
                : '';
            const badge = g.suspended
                ? `<span class="badge badge-inactive">Suspendu</span>`
                : `<span class="badge badge-active">Actif</span>`;

            let details = '';
            if (g.suspended) {
                const when = formatOwnerDate(g.suspended_at);
                const reason = g.suspended_reason ? escapeHtml(g.suspended_reason) : '—';
                details = `
                    <div style="margin-top:.35rem;font-size:.78rem;color:var(--text-muted)">
                        Suspendu${when ? ` le ${when}` : ''} — motif : <span style="color:var(--text-secondary)">${reason}</span>
                    </div>
                `;
            }

            const actionBtn = g.suspended
                ? `<button class="btn btn-primary btn-sm" data-action="unsuspend" data-id="${g.id}">Réactiver</button>`
                : `<button class="btn btn-danger btn-sm" data-action="suspend" data-id="${g.id}">Suspendre</button>`;

            return `
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;padding:.7rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                    <div style="min-width:0">
                        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                            <span style="color:var(--text-primary);font-weight:500;word-break:break-word">${name}</span>
                            ${badge}
                            ${members}
                        </div>
                        ${details}
                    </div>
                    <div style="flex-shrink:0">${actionBtn}</div>
                </div>
            `;
        }).join('');

    const listCard = `
        <div class="card" style="margin-top:1rem">
            <div class="card-title">🗂️ Coupure ciblée par serveur</div>
            <div id="owner-servers-list">${rows}</div>
        </div>
    `;

    content.innerHTML = counterCard + reminderCard + listCard;

    // Binding des actions (data-attributes plutôt qu'inline onclick : les noms de
    // serveurs peuvent contenir des apostrophes/guillemets).
    content.querySelectorAll('[data-action]').forEach(btn => {
        const id = btn.dataset.id;
        const server = servers.find(s => s.id === id);
        const displayName = server ? (server.name || id) : id;
        if (btn.dataset.action === 'suspend') {
            btn.addEventListener('click', () => suspendServer(container, id, displayName));
        } else {
            btn.addEventListener('click', () => unsuspendServer(container, id, displayName));
        }
    });
}

// Suspendre : le prompt du motif sert aussi de confirmation (Annuler = abandon).
async function suspendServer(container, guildId, name) {
    const reason = prompt(
        `Suspendre « ${name} » ?\n\n` +
        `Cela coupe Quasar sur CE serveur (réversible, sans perte de données, le bot reste).\n\n` +
        `Indiquez le motif de la suspension :`
    );
    if (reason === null) return;          // Annulé
    if (!reason.trim()) {
        showToast('Un motif est requis pour suspendre.', 'error');
        return;
    }

    const result = await API.post(`/api/owner/guilds/${guildId}/suspend`, { reason: reason.trim() });
    if (result?.suspended) {
        showToast(`« ${name} » suspendu.`);
        await loadOwner(container);
    } else {
        showToast(result?.error || 'Erreur lors de la suspension.', 'error');
    }
}

async function unsuspendServer(container, guildId, name) {
    if (!confirm(`Réactiver Quasar sur « ${name} » ?`)) return;

    const result = await API.post(`/api/owner/guilds/${guildId}/unsuspend`, {});
    if (result && result.suspended === false) {
        showToast(`« ${name} » réactivé.`);
        await loadOwner(container);
    } else {
        showToast(result?.error || 'Erreur lors de la réactivation.', 'error');
    }
}

function ownerErrorCard(message) {
    return `
        <div class="card" style="border-color:var(--danger)">
            <div class="card-title">⚠️ Erreur</div>
            <p style="color:var(--text-secondary);font-size:.9rem">${escapeHtml(message)}</p>
        </div>
    `;
}

window.loadOwner = loadOwner;
window.suspendServer = suspendServer;
window.unsuspendServer = unsuspendServer;
