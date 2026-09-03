// ═══════════════════════════════════════════════════════════════
//  Page « Droits des personnes » — Demandes de suppression (RGPD art. 17)
//
//  Destinée à l'admin RESPONSABLE du serveur : c'est lui qui décide (effacer /
//  refuser motivé), Venacity exécute. Enregistrement manuel d'une demande reçue
//  par e-mail, suivi des échéances (délai légal d'un mois) et contrôles de décision
//  par catégorie.
// ═══════════════════════════════════════════════════════════════

// Libellés lisibles des catégories.
const ERASURE_CATEGORY_LABELS = {
    active_sanction: 'Sanction active',
    expired_sanction: 'Sanction expirée',
    non_moderation: 'Hors modération',
    mixed: 'Mixte (sanctions expirées + hors modération)'
};

// Rappel de la règle par catégorie, affiché au moment de décider.
const ERASURE_CATEGORY_RULES = {
    active_sanction: "Refus motivé possible (art. 21) : une sanction encore en vigueur peut être conservée. À défaut de refus, l'effacement préserve automatiquement les bannissements toujours actifs.",
    expired_sanction: 'Effacement dû : suppression des sanctions du membre qui ne sont plus en vigueur (les bans encore actifs sont conservés).',
    non_moderation: 'Effacement dû, sans discussion : préférences de salons vocaux temporaires et métadonnées des tickets ouverts par la personne.',
    mixed: 'Effacement dû : sanctions expirées + données hors modération. Les bans encore en vigueur sont conservés.'
};

// Libellés / couleurs des statuts.
const ERASURE_STATUS = {
    pending:     { label: 'En attente', color: 'var(--warning)' },
    executed:    { label: 'Effacée',    color: 'var(--success)' },
    refused:     { label: 'Refusée',    color: 'var(--danger)' },
    decided:     { label: 'Décidée',    color: 'var(--accent)' },
    no_response: { label: 'Sans réponse', color: 'var(--text-muted)' }
};

const DAY_SECONDS = 24 * 60 * 60;

async function loadErasure(container, guildId) {
    window._erasureGuildId = guildId;

    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">⚖️ Droits des personnes</h1>
            <p class="main-subtitle">Demandes de suppression (droit à l'effacement, RGPD art. 17) — tu décides, Venacity exécute.</p>
        </div>

        <div class="card">
            <div class="card-title">✍️ Enregistrer une demande</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin-bottom:1rem">
                Pour une demande reçue par e-mail (contact@vena.city) ou autrement. Les demandes
                déposées via la commande <code>/mes-donnees</code> apparaissent directement dans la liste.
            </p>
            <div style="display:grid;gap:1rem;max-width:560px">
                <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                    <label style="width:150px;font-size:.9rem">ID Discord</label>
                    <input class="input" id="erasure-subject" placeholder="Identifiant de la personne concernée" style="flex:1;min-width:220px">
                </div>
                <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                    <label style="width:150px;font-size:.9rem">Catégorie</label>
                    <select class="select" id="erasure-category" style="flex:1;min-width:220px">
                        ${Object.entries(ERASURE_CATEGORY_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
                    </select>
                </div>
                <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
                    <label style="width:150px;font-size:.9rem;padding-top:.5rem">Détails (facultatif)</label>
                    <textarea class="input" id="erasure-details" rows="2" placeholder="Précisions éventuelles de la demande" style="flex:1;min-width:220px;resize:vertical"></textarea>
                </div>
                <button class="btn btn-primary" onclick="createErasureRequest()" style="align-self:flex-start">Enregistrer la demande</button>
            </div>
            <p id="erasure-category-hint" style="color:var(--text-muted);font-size:.8rem;margin-top:1rem;line-height:1.5"></p>
        </div>

        <div class="card">
            <div class="card-title">📋 Demandes de ce serveur</div>
            <div id="erasure-list"><p style="color:var(--text-secondary)">Chargement...</p></div>
        </div>
    `;

    // Rappel de la règle sous le formulaire, mis à jour au changement de catégorie.
    const catSelect = document.getElementById('erasure-category');
    const hint = document.getElementById('erasure-category-hint');
    const refreshHint = () => { hint.textContent = ERASURE_CATEGORY_RULES[catSelect.value] || ''; };
    catSelect.addEventListener('change', refreshHint);
    refreshHint();

    await loadErasureList();
}

async function loadErasureList() {
    const guildId = window._erasureGuildId;
    const list = document.getElementById('erasure-list');
    const requests = await API.get(`/api/guilds/${guildId}/erasure`) || [];

    if (!requests.length) {
        list.innerHTML = '<p style="color:var(--text-secondary)">Aucune demande de suppression pour l\'instant.</p>';
        return;
    }

    list.innerHTML = `<div style="display:flex;flex-direction:column;gap:1rem">
        ${requests.map(renderErasureCard).join('')}
    </div>`;
}

// Rend une carte de demande. Les demandes 'pending' portent les contrôles de décision.
function renderErasureCard(r) {
    const status = ERASURE_STATUS[r.status] || { label: r.status, color: 'var(--text-muted)' };
    const catLabel = ERASURE_CATEGORY_LABELS[r.category] || r.category;
    const requestedStr = new Date(r.requested_at * 1000).toLocaleDateString('fr-FR');

    // Échéance + alerte (proche / dépassée).
    const now = Math.floor(Date.now() / 1000);
    const dueStr = new Date(r.due_at * 1000).toLocaleDateString('fr-FR');
    const daysLeft = Math.floor((r.due_at - now) / DAY_SECONDS);
    let dueBadge;
    if (r.status !== 'pending') {
        dueBadge = `<span style="color:var(--text-muted)">Échéance : ${dueStr}</span>`;
    } else if (r.due_at < now) {
        dueBadge = `<span style="color:var(--danger);font-weight:600">⚠ Échéance dépassée (${dueStr})</span>`;
    } else if (daysLeft <= 7) {
        dueBadge = `<span style="color:var(--warning);font-weight:600">⏳ Échéance proche : ${dueStr} (${daysLeft} j)</span>`;
    } else {
        dueBadge = `<span style="color:var(--text-secondary)">Échéance : ${dueStr} (${daysLeft} j)</span>`;
    }

    const details = r.details
        ? `<div style="color:var(--text-secondary);font-size:.85rem;margin-top:.5rem">${escapeHtml(r.details)}</div>`
        : '';

    // Bloc de décision (pending) OU récapitulatif de la décision prise.
    let actions = '';
    if (r.status === 'pending') {
        actions = `
            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border)">
                <p style="color:var(--text-muted);font-size:.8rem;margin-bottom:.75rem;line-height:1.5">${escapeHtml(ERASURE_CATEGORY_RULES[r.category] || '')}</p>
                <textarea class="input" id="erasure-motif-${r.id}" rows="2" placeholder="Motif du refus (obligatoire si tu refuses — art. 21)" style="width:100%;resize:vertical;margin-bottom:.75rem"></textarea>
                <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                    <button class="btn btn-danger" onclick="decideErasure(${r.id}, 'erase')">🗑️ Effacer</button>
                    <button class="btn btn-secondary" onclick="decideErasure(${r.id}, 'refuse')">✋ Refuser (motivé)</button>
                </div>
            </div>`;
    } else {
        const decidedStr = r.decided_at ? new Date(r.decided_at * 1000).toLocaleDateString('fr-FR') : '—';
        const verb = r.decision === 'erase' ? 'Effacement exécuté' : r.decision === 'refuse' ? 'Refus' : 'Décision';
        const motif = r.decision_reason
            ? `<div style="color:var(--text-secondary);font-size:.85rem;margin-top:.35rem"><strong>Motif :</strong> ${escapeHtml(r.decision_reason)}</div>`
            : '';
        actions = `
            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border);font-size:.85rem;color:var(--text-muted)">
                <strong>${verb}</strong> le ${decidedStr}${r.decided_by ? ` par <code>${escapeHtml(r.decided_by)}</code>` : ''}.
                ${motif}
            </div>`;
    }

    return `
        <div style="padding:1rem 1.25rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
            <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                <span style="color:var(--text-muted);font-size:.85rem">#${r.id}</span>
                <span style="flex:1;min-width:180px">Personne : <code style="color:var(--accent)">${escapeHtml(r.subject_id)}</code></span>
                <span class="badge" style="background:transparent;border:1px solid ${status.color};color:${status.color}">${status.label}</span>
            </div>
            <div style="display:flex;gap:1.25rem;align-items:center;flex-wrap:wrap;margin-top:.6rem;font-size:.85rem">
                <span style="color:var(--text-secondary)">Catégorie : <strong>${catLabel}</strong></span>
                <span style="color:var(--text-muted)">Demandée le ${requestedStr}</span>
                ${dueBadge}
                ${r.source === 'command' ? '<span style="color:var(--text-muted)">via /mes-donnees</span>' : ''}
            </div>
            ${details}
            ${actions}
        </div>`;
}

let _creatingErasure = false;
async function createErasureRequest() {
    if (_creatingErasure) return;

    const subjectId = document.getElementById('erasure-subject').value.trim();
    const category = document.getElementById('erasure-category').value;
    const details = document.getElementById('erasure-details').value.trim();

    if (!subjectId) {
        showToast('Renseigne l\'identifiant Discord de la personne concernée.', 'error');
        return;
    }

    _creatingErasure = true;
    try {
        const res = await API.post(`/api/guilds/${window._erasureGuildId}/erasure`, {
            subject_id: subjectId,
            category,
            details
        });
        if (res && res.id) {
            showToast('✅ Demande enregistrée.');
            document.getElementById('erasure-subject').value = '';
            document.getElementById('erasure-details').value = '';
            await loadErasureList();
        } else {
            showToast(res?.error || 'Erreur lors de l\'enregistrement.', 'error');
        }
    } finally {
        _creatingErasure = false;
    }
}

let _decidingErasure = false;
async function decideErasure(id, decision) {
    if (_decidingErasure) return;

    let decisionReason = '';
    if (decision === 'refuse') {
        decisionReason = (document.getElementById(`erasure-motif-${id}`)?.value || '').trim();
        if (!decisionReason) {
            showToast('Un refus doit être motivé (art. 21). Renseigne le motif.', 'error');
            return;
        }
    } else if (decision === 'erase') {
        if (!confirm('Effacer les données de cette personne selon la catégorie de la demande ? Cette action est définitive.')) {
            return;
        }
    }

    _decidingErasure = true;
    try {
        const res = await API.post(`/api/guilds/${window._erasureGuildId}/erasure/${id}/decision`, {
            decision,
            decision_reason: decisionReason
        });

        if (res && res.error) {
            showToast(res.error, 'error');
            return;
        }

        if (decision === 'refuse') {
            showToast('Demande refusée (motif enregistré).', 'info');
        } else {
            showToast(formatErasureReport(res.report), 'success');
        }
        await loadErasureList();
    } finally {
        _decidingErasure = false;
    }
}

// Résume l'exécution d'un effacement pour le retour visuel.
function formatErasureReport(report) {
    if (!report) return '✅ Effacement exécuté.';
    const parts = Object.entries(report.perTable || {}).map(([t, n]) => `${t}=${n}`);
    let msg = report.total > 0
        ? `✅ Effacement exécuté : ${parts.join(', ')}.`
        : '✅ Effacement exécuté : aucune donnée à supprimer.';
    if (report.keptActiveBans > 0) {
        msg += ` ${report.keptActiveBans} ban(s) en vigueur conservé(s).`;
    }
    if (report.warning) {
        msg += ` ⚠ ${report.warning}`;
    }
    return msg;
}

window.loadErasure = loadErasure;
window.createErasureRequest = createErasureRequest;
window.decideErasure = decideErasure;
