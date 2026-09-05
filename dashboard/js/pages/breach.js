// ═══════════════════════════════════════════════════════════════
//  Page « Notification de violation » — réservée à la propriétaire (owner)
//
//  Sous-lot C du lot 2 RGPD (art. 33). Rédaction LIBRE (un simple textarea) avec
//  un aide-mémoire des 4 mentions de l'art. 33.3 à côté — surtout PAS de gabarit
//  paramétrable ni de génération automatique. Un brouillon pré-rempli sert de
//  canevas entièrement modifiable et effaçable.
//
//  Flux imposé : rédiger → PRÉVISUALISER (jamais d'envoi) → CONFIRMER (bouton
//  distinct, avertissement « un message parti ne se rattrape pas ») → envoi enfilé.
//  L'entrée sidebar owner et le case 'breach' de loadPage sont câblés par
//  l'intégration ; ici on gère l'affichage owner-only (403 → message clair).
// ═══════════════════════════════════════════════════════════════

// Canevas de départ : reprend les 4 mentions de l'art. 33.3 comme trame. C'est un
// texte qu'on ÉCRASE, jamais une structure imposée (le champ reste 100 % libre).
const BREACH_DEFAULT_DRAFT = `Objet : notification de violation de données personnelles (RGPD art. 33)

1. Nature de la violation
[Décrire ce qui s'est passé, quand la violation a eu lieu et comment elle a été découverte.]

2. Catégories et volume de données concernées
[Préciser les catégories touchées, parmi celles traitées par Quasar :
 - identifiants Discord (serveurs, salons, rôles, membres, modérateurs) ;
 - sanctions de modération (type, motif, durée, auteur, destinataire) ;
 - métadonnées de tickets ;
 - configurations de serveur.
 Les transcriptions de tickets ne sont plus stockées.
 Indiquer le nombre approximatif de personnes concernées et d'enregistrements concernés.]

3. Point de contact
Pour toute question relative à cette violation : contact@vena.city.

4. Conséquences probables
[Décrire les conséquences vraisemblables de la violation pour les personnes concernées.]

5. Mesures prises ou proposées
[Décrire les mesures prises pour remédier à la violation et en atténuer les effets négatifs.]`;

const _breachState = {
    incidents: [],
    selectedId: null,
    preview: null,        // { incidentId, body } — snapshot prévisualisé, envoyé tel quel à la confirmation
};

// ─── Utilitaires ───────────────────────────────────────────────────────────

function fmtBreachDate(sec) {
    if (!sec) return '—';
    try {
        return new Intl.DateTimeFormat('fr-FR', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(new Date(sec * 1000));
    } catch {
        return new Date(sec * 1000).toISOString();
    }
}

function breachStatusBadge(status) {
    return status === 'open'
        ? '<span class="badge badge-active">Ouvert</span>'
        : '<span class="badge badge-inactive">Clôturé</span>';
}

// ─── Chargement ──────────────────────────────────────────────────────────────

async function loadBreach(container) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">🚨 Notification de violation</h1>
            <p class="main-subtitle">Notifier les responsables de traitement (RGPD art. 33) — réservé à la propriétaire de l'instance.</p>
        </div>
        <div id="breach-root"><p style="color:var(--text-secondary)">Chargement...</p></div>
    `;

    const incidents = await API.get('/api/breach');

    // Owner-only : un 403 renvoie un objet { error }, pas un tableau.
    if (!Array.isArray(incidents)) {
        document.getElementById('breach-root').innerHTML = `
            <div class="card" style="border-color:var(--danger)">
                <div class="card-title">Accès réservé</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Cette page est réservée à la propriétaire de l'instance Quasar. ${incidents?.error ? escapeHtml(incidents.error) : ''}
                </p>
            </div>`;
        return;
    }

    _breachState.incidents = incidents;
    if (_breachState.selectedId && !incidents.find(i => i.id === _breachState.selectedId)) {
        _breachState.selectedId = null;
    }

    renderBreachLayout();
}

function renderBreachLayout() {
    const root = document.getElementById('breach-root');
    if (!root) return;
    root.innerHTML = `
        <div style="display:grid;grid-template-columns:320px 1fr;gap:1.5rem;align-items:start" id="breach-grid">
            <div class="card">
                <div class="card-title">📁 Incidents</div>
                <div style="margin-bottom:1rem">
                    <input class="input" id="breach-new-title" maxlength="200" placeholder="Titre interne du nouvel incident">
                    <button class="btn btn-primary" style="margin-top:.5rem;width:100%" onclick="createBreachIncident()">➕ Créer un incident</button>
                </div>
                <div id="breach-list"></div>
            </div>
            <div id="breach-detail"></div>
        </div>
    `;
    renderBreachList();
    renderBreachDetail();
}

function renderBreachList() {
    const list = document.getElementById('breach-list');
    if (!list) return;

    if (!_breachState.incidents.length) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">Aucun incident enregistré.</p>';
        return;
    }

    list.innerHTML = _breachState.incidents.map((inc) => {
        const active = inc.id === _breachState.selectedId;
        const t = inc.totals || { sent: 0, failed: 0, pending: 0 };
        const phases = (inc.messages || []).length;
        return `
            <button type="button" onclick="selectBreachIncident(${inc.id})"
                style="display:block;width:100%;text-align:left;margin-bottom:.5rem;padding:.6rem .75rem;
                       background:${active ? 'var(--accent)' : 'var(--bg-card)'};
                       color:${active ? '#fff' : 'var(--text-primary)'};
                       border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer">
                <div style="font-weight:600;font-size:.85rem;display:flex;justify-content:space-between;gap:.5rem;align-items:center">
                    <span>${escapeHtml(inc.title || `Incident #${inc.id}`)}</span>
                    ${inc.status === 'open' ? '<span style="font-size:.65rem;opacity:.85">● ouvert</span>' : '<span style="font-size:.65rem;opacity:.6">clôturé</span>'}
                </div>
                <div style="font-size:.7rem;opacity:${active ? '.9' : '.6'};margin-top:.25rem">
                    ${phases} phase${phases > 1 ? 's' : ''} · ✅ ${t.sent} · ⏳ ${t.pending} · ❌ ${t.failed}
                </div>
            </button>`;
    }).join('');
}

// ─── Détail d'un incident ────────────────────────────────────────────────────

function renderBreachDetail() {
    const detail = document.getElementById('breach-detail');
    if (!detail) return;

    const inc = _breachState.incidents.find(i => i.id === _breachState.selectedId);
    if (!inc) {
        detail.innerHTML = `
            <div class="card">
                <div class="card-title">Notification de violation de données</div>
                <p style="color:var(--text-secondary);font-size:.9rem;line-height:1.6">
                    Sélectionne un incident à gauche, ou crées-en un nouveau, pour rédiger une notification.
                    Chaque incident regroupe une notification initiale (phase 1) et ses éventuels compléments
                    (phases suivantes), conformément à la notification progressive de l'art. 33.4.
                </p>
                <p style="color:var(--text-muted);font-size:.82rem;margin-top:.75rem">
                    Venacity s'engage à notifier sous <strong>24 heures</strong>. Rien n'est envoyé sans prévisualisation
                    puis confirmation explicite.
                </p>
            </div>`;
        return;
    }

    const isOpen = inc.status === 'open';
    const nextPhase = (inc.messages || []).reduce((mx, m) => Math.max(mx, m.phase), 0) + 1;

    detail.innerHTML = `
        <div class="card">
            <div class="card-title" style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                <span>${escapeHtml(inc.title || `Incident #${inc.id}`)}</span>
                ${breachStatusBadge(inc.status)}
                <span style="margin-left:auto;font-size:.72rem;color:var(--text-muted)">Créé le ${fmtBreachDate(inc.created_at)}</span>
            </div>

            ${renderBreachPhases(inc)}

            ${isOpen ? renderBreachComposer(inc, nextPhase) : `
                <p style="color:var(--text-muted);font-size:.85rem;margin-top:1rem">
                    Incident clôturé — aucune nouvelle notification ne peut y être ajoutée.
                </p>`}

            <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--border)">
                <button class="btn" onclick="loadBreachDeliveries(${inc.id})">📊 Voir la traçabilité détaillée</button>
                ${isOpen ? `<button class="btn" style="border-color:var(--danger);color:var(--danger)" onclick="closeBreachIncident(${inc.id})">Clôturer l'incident</button>` : ''}
            </div>
            <div id="breach-deliveries" style="margin-top:1rem"></div>
        </div>
    `;
}

function renderBreachPhases(inc) {
    const messages = inc.messages || [];
    if (!messages.length) {
        return `<p style="color:var(--text-muted);font-size:.85rem;margin-bottom:.5rem">Aucune notification envoyée pour cet incident.</p>`;
    }
    return `
        <div style="margin-bottom:1rem">
            <div style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.5rem">Notifications envoyées</div>
            ${messages.map((m) => {
                const d = m.deliveries || { sent: 0, failed: 0, pending: 0 };
                return `
                    <div style="padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
                        <div style="display:flex;justify-content:space-between;gap:.5rem;font-size:.8rem">
                            <strong>Phase ${m.phase}${m.phase === 1 ? ' — initiale' : ' — complément'}</strong>
                            <span style="color:var(--text-muted)">${fmtBreachDate(m.created_at)}</span>
                        </div>
                        <div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem">
                            ✅ ${d.sent} reçu(s) · ⏳ ${d.pending} en attente · ❌ ${d.failed} en échec
                        </div>
                        <details style="margin-top:.4rem">
                            <summary style="cursor:pointer;font-size:.72rem;color:var(--text-muted)">Voir le texte</summary>
                            <pre style="white-space:pre-wrap;font-family:inherit;font-size:.78rem;color:var(--text-secondary);margin:.4rem 0 0;line-height:1.5">${escapeHtml(m.body)}</pre>
                        </details>
                    </div>`;
            }).join('')}
        </div>`;
}

function renderBreachComposer(inc, nextPhase) {
    return `
        <div style="margin-top:.5rem">
            <div style="font-size:.85rem;color:var(--text-secondary);margin-bottom:.5rem">
                ✏️ Rédiger la <strong>phase ${nextPhase}</strong> ${nextPhase === 1 ? '(notification initiale)' : '(complément)'}
            </div>
            <div style="display:grid;grid-template-columns:1fr 300px;gap:1rem;align-items:start" class="breach-compose-grid">
                <div>
                    <textarea class="input" id="breach-body" rows="16"
                        style="resize:vertical;font-size:.85rem;line-height:1.55;width:100%"
                        placeholder="Rédige librement la notification...">${escapeHtml(nextPhase === 1 ? BREACH_DEFAULT_DRAFT : '')}</textarea>
                    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
                        <button class="btn btn-primary" onclick="previewBreach(${inc.id})">👁️ Prévisualiser</button>
                        <button class="btn" onclick="resetBreachDraft()">↺ Réinitialiser le canevas</button>
                        <button class="btn" onclick="clearBreachDraft()">🗑️ Vider</button>
                    </div>
                </div>
                ${renderBreachAideMemoire()}
            </div>
            <div id="breach-preview" style="margin-top:1rem"></div>
        </div>`;
}

// Aide-mémoire des 4 mentions de l'art. 33.3, avec les catégories propres à Quasar.
// Purement informatif : aucun champ, aucune structure imposée sur la rédaction.
function renderBreachAideMemoire() {
    return `
        <aside style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.85rem 1rem">
            <div style="font-size:.8rem;font-weight:600;margin-bottom:.5rem">📋 Aide-mémoire — art. 33.3</div>
            <p style="font-size:.74rem;color:var(--text-secondary);line-height:1.5;margin:0 0 .5rem">
                La notification doit au minimum :
            </p>
            <ol style="font-size:.74rem;color:var(--text-secondary);line-height:1.5;margin:0 0 .6rem;padding-left:1.1rem">
                <li>décrire la <strong>nature</strong> de la violation, avec les <strong>catégories</strong> et le <strong>nombre approximatif</strong> de personnes concernées et d'enregistrements concernés ;</li>
                <li>indiquer le <strong>point de contact</strong> (contact@vena.city) ;</li>
                <li>décrire les <strong>conséquences probables</strong> ;</li>
                <li>décrire les <strong>mesures prises ou proposées</strong>.</li>
            </ol>
            <div style="font-size:.72rem;color:var(--text-muted);line-height:1.5;border-top:1px solid var(--border);padding-top:.5rem">
                <strong>Catégories traitées par Quasar :</strong>
                identifiants Discord (serveurs, salons, rôles, membres, modérateurs) ·
                sanctions (type, motif, durée, auteur, destinataire) ·
                métadonnées de tickets · configurations de serveur.
                <em>Les transcriptions ne sont plus stockées.</em>
            </div>
        </aside>`;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function createBreachIncident() {
    const input = document.getElementById('breach-new-title');
    const title = (input?.value || '').trim();
    const incident = await API.post('/api/breach/incidents', { title });
    if (incident?.id) {
        showToast('Incident créé');
        if (input) input.value = '';
        _breachState.selectedId = incident.id;
        await loadBreach(document.getElementById('content'));
    } else {
        showToast(incident?.error || 'Erreur à la création', 'error');
    }
}

function selectBreachIncident(id) {
    _breachState.selectedId = id;
    _breachState.preview = null;
    renderBreachList();
    renderBreachDetail();
}

function resetBreachDraft() {
    const ta = document.getElementById('breach-body');
    if (ta) ta.value = BREACH_DEFAULT_DRAFT;
    const prev = document.getElementById('breach-preview');
    if (prev) prev.innerHTML = '';
    _breachState.preview = null;
}

function clearBreachDraft() {
    const ta = document.getElementById('breach-body');
    if (ta) ta.value = '';
    const prev = document.getElementById('breach-preview');
    if (prev) prev.innerHTML = '';
    _breachState.preview = null;
}

async function previewBreach(incidentId) {
    const ta = document.getElementById('breach-body');
    const body = (ta?.value || '').trim();
    if (!body) { showToast('Le message est vide', 'error'); return; }

    const preview = await API.post(`/api/breach/incidents/${incidentId}/preview`, { body });
    if (preview?.error) { showToast(preview.error, 'error'); return; }

    // Snapshot : on confirmera l'envoi de CE texte précis, pas d'un textarea modifié après coup.
    _breachState.preview = { incidentId, body };

    const targetsRows = (preview.targets || []).map(t => `
        <tr>
            <td style="padding:.35rem .5rem">${escapeHtml(t.guildName || t.guildId)}</td>
            <td style="padding:.35rem .5rem;text-align:center">${t.recipientCount}</td>
            <td style="padding:.35rem .5rem;text-align:center">${t.reachable ? '🟢 joignable' : '🔴 hors ligne'}</td>
        </tr>`).join('');

    const warn = preview.botOnline
        ? ''
        : `<p style="font-size:.78rem;color:var(--danger);margin:.5rem 0 0">
              ⚠️ Le bot semble hors ligne : aucun destinataire MP n'a pu être estimé. Les serveurs concernés
              recevront un repli salon dès que le bot sera en ligne, et la bannière dashboard reste active.
           </p>`;
    const unreachableNote = preview.unreachableGuilds > 0
        ? `<p style="font-size:.76rem;color:var(--text-muted);margin:.4rem 0 0">
              ${preview.unreachableGuilds} serveur(s) actuellement injoignable(s) : repli salon prévu à l'envoi.
           </p>`
        : '';

    document.getElementById('breach-preview').innerHTML = `
        <div class="card" style="border-color:var(--accent)">
            <div class="card-title">👁️ Prévisualisation — phase ${preview.phase}</div>
            <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.75rem">
                <div><div style="font-size:1.5rem;font-weight:700;color:var(--accent)">${preview.estimatedRecipients}</div><div style="font-size:.72rem;color:var(--text-muted)">destinataires estimés (MP)</div></div>
                <div><div style="font-size:1.5rem;font-weight:700">${(preview.targets || []).length}</div><div style="font-size:.72rem;color:var(--text-muted)">serveur(s) ciblé(s)</div></div>
            </div>
            ${(preview.targets || []).length ? `
                <table style="width:100%;border-collapse:collapse;font-size:.78rem;margin-bottom:.75rem">
                    <thead><tr style="color:var(--text-muted);text-align:left">
                        <th style="padding:.35rem .5rem">Serveur</th>
                        <th style="padding:.35rem .5rem;text-align:center">Destinataires</th>
                        <th style="padding:.35rem .5rem;text-align:center">État</th>
                    </tr></thead>
                    <tbody>${targetsRows}</tbody>
                </table>` : '<p style="font-size:.8rem;color:var(--text-muted)">Aucun serveur connecté non suspendu à notifier.</p>'}
            ${warn}
            ${unreachableNote}

            <div style="font-size:.8rem;color:var(--text-secondary);margin:.75rem 0 .35rem">Texte final envoyé</div>
            <pre style="white-space:pre-wrap;font-family:inherit;font-size:.8rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:.75rem;margin:0;line-height:1.5;max-height:280px;overflow:auto">${escapeHtml(preview.finalText)}</pre>

            <div style="margin-top:1rem;padding:.85rem 1rem;background:rgba(237,66,69,.08);border:1px solid var(--danger);border-radius:var(--radius-sm)">
                <p style="font-size:.82rem;color:var(--text-primary);margin:0 0 .6rem;font-weight:600">
                    ⚠️ Un message parti ne se rattrape pas.
                </p>
                <p style="font-size:.76rem;color:var(--text-secondary);margin:0 0 .75rem">
                    En confirmant, la notification est enfilée pour envoi à tous les destinataires listés ci-dessus
                    (message privé, avec repli salon en cas d'échec). Vérifiez le texte une dernière fois.
                </p>
                <button class="btn" id="breach-confirm-btn" style="background:var(--danger);color:#fff;border-color:var(--danger)" onclick="confirmSendBreach()">
                    ✅ Confirmer l'envoi (phase ${preview.phase})
                </button>
            </div>
        </div>`;
}

async function confirmSendBreach() {
    // Anti double-envoi. On consomme le snapshot AVANT tout await : un second clic
    // (API.post est un fetch nu, sans garde in-flight) ne trouvera plus rien à
    // envoyer et sortira aussitôt. Le snapshot n'est restauré qu'en cas d'échec.
    const snap = _breachState.preview;
    if (!snap) return;
    _breachState.preview = null;

    // Garde in-flight visible : on désactive le bouton dès le clic.
    const btn = document.getElementById('breach-confirm-btn');
    const originalLabel = btn ? btn.textContent : '';
    if (btn) {
        btn.disabled = true;
        btn.style.opacity = '.6';
        btn.style.cursor = 'not-allowed';
        btn.textContent = 'Envoi en cours…';
    }

    const res = await API.post(`/api/breach/incidents/${snap.incidentId}/send`, { body: snap.body });
    if (res?.message) {
        const parts = [`${res.enqueued} MP enfilé(s)`];
        if (res.guildFallbacks) parts.push(`${res.guildFallbacks} repli(s) salon`);
        showToast(`Notification enfilée (phase ${res.phase}) — ${parts.join(', ')}`);
        // Succès : loadBreach re-rend toute la page (le bouton disparaît).
        await loadBreach(document.getElementById('content'));
    } else {
        // Échec : on restaure le snapshot et on réactive le bouton pour permettre
        // une nouvelle tentative sans avoir à re-prévisualiser.
        _breachState.preview = snap;
        if (btn) {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
            btn.textContent = originalLabel;
        }
        showToast(res?.error || 'Erreur à l\'envoi', 'error');
    }
}

async function closeBreachIncident(id) {
    if (!confirm('Clôturer cet incident ? Aucune nouvelle notification ne pourra y être ajoutée.')) return;
    const res = await API.post(`/api/breach/incidents/${id}/close`, {});
    if (res?.success) {
        showToast('Incident clôturé');
        await loadBreach(document.getElementById('content'));
    } else {
        showToast(res?.error || 'Erreur', 'error');
    }
}

async function loadBreachDeliveries(id) {
    const zone = document.getElementById('breach-deliveries');
    if (!zone) return;
    zone.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem">Chargement de la traçabilité...</p>';

    const rows = await API.get(`/api/breach/incidents/${id}/deliveries`);
    if (!Array.isArray(rows)) {
        zone.innerHTML = `<p style="color:var(--danger);font-size:.82rem">${escapeHtml(rows?.error || 'Erreur')}</p>`;
        return;
    }
    if (!rows.length) {
        zone.innerHTML = '<p style="color:var(--text-muted);font-size:.82rem">Aucune livraison enregistrée pour cet incident.</p>';
        return;
    }

    const statusLabel = { sent: '✅ Reçu', failed: '❌ Échec', pending: '⏳ En attente' };
    const channelLabel = { dm: 'MP', guild_channel: 'Salon serveur' };

    zone.innerHTML = `
        <div class="card">
            <div class="card-title">📊 Traçabilité (art. 33.5) — qui a reçu, qui n'a pas reçu</div>
            <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:.76rem">
                    <thead><tr style="color:var(--text-muted);text-align:left">
                        <th style="padding:.35rem .5rem">Phase</th>
                        <th style="padding:.35rem .5rem">Serveur</th>
                        <th style="padding:.35rem .5rem">Destinataire</th>
                        <th style="padding:.35rem .5rem">Canal</th>
                        <th style="padding:.35rem .5rem">État</th>
                        <th style="padding:.35rem .5rem;text-align:center">Tentatives</th>
                        <th style="padding:.35rem .5rem">Reçu le</th>
                        <th style="padding:.35rem .5rem">Erreur</th>
                    </tr></thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr style="border-top:1px solid var(--border)">
                                <td style="padding:.35rem .5rem">${r.phase}</td>
                                <td style="padding:.35rem .5rem">${escapeHtml(r.guild_name || r.guild_id)}</td>
                                <td style="padding:.35rem .5rem;font-family:monospace">${r.recipient_id ? escapeHtml(r.recipient_id) : '—'}</td>
                                <td style="padding:.35rem .5rem">${channelLabel[r.channel] || escapeHtml(r.channel)}</td>
                                <td style="padding:.35rem .5rem">${statusLabel[r.status] || escapeHtml(r.status)}</td>
                                <td style="padding:.35rem .5rem;text-align:center">${r.attempts}</td>
                                <td style="padding:.35rem .5rem">${r.delivered_at ? fmtBreachDate(r.delivered_at) : '—'}</td>
                                <td style="padding:.35rem .5rem;color:var(--text-muted);max-width:220px">${r.error ? escapeHtml(r.error) : '—'}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
}

// Expose globalement (cohérent avec les autres pages dashboard).
window.loadBreach = loadBreach;
window.createBreachIncident = createBreachIncident;
window.selectBreachIncident = selectBreachIncident;
window.previewBreach = previewBreach;
window.confirmSendBreach = confirmSendBreach;
window.closeBreachIncident = closeBreachIncident;
window.loadBreachDeliveries = loadBreachDeliveries;
window.resetBreachDraft = resetBreachDraft;
window.clearBreachDraft = clearBreachDraft;
