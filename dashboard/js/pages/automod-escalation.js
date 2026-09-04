// ═══════════════════════════════════════════════════════════════
//  Onglet « Escalade »
//
//  Configuration des paliers d'avertissements : à partir de N avertissements
//  actifs, Quasar applique la suite de sanctions du palier. C'est Quasar qui
//  décide ici — contrairement à l'onglet AutoMod Discord, la portée fonctionne
//  donc dans les deux sens : « seulement ces rôles / salons » ET « jamais ces
//  rôles / salons ».
//
//  Trois partis pris d'interface :
//   1. LA SYNTAXE EST EXPLIQUÉE ET VÉRIFIÉE PENDANT LA SAISIE. Une chaîne de
//      punitions refusée à l'enregistrement, sans dire où est la faute, oblige à
//      deviner. Les boutons d'action écrivent la syntaxe correcte, et le champ
//      dit en direct ce qui ne va pas — avec les messages du serveur.
//   2. LE MODE « ALERTE SEULE » EST UNE CONFIGURATION, PAS UN OUBLI. Un palier
//      sans sanction journalise le franchissement : c'est présenté comme tel,
//      jamais comme un formulaire incomplet.
//   3. LA FENÊTRE DE COMPTAGE EST AFFICHÉE. Les avertissements plus anciens que
//      la durée de conservation du serveur ne comptent plus. Sans cette
//      mention, un palier réglé à 10 paraît cassé le jour où il ne se déclenche
//      pas.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab. Le titre et le sous-titre de la page sont déjà rendus,
//  ce fichier commence au niveau des cartes.
// ═══════════════════════════════════════════════════════════════

const _escState = {
    guildId: null,
    data: null,       // dernière réponse de GET /warn-escalation
    channels: [],     // salons écrits (journaux)
    allChannels: [],  // tous les salons sélectionnables (portée)
    roles: [],
    editing: null,    // { mode: 'create'|'edit', tier|null }
};

// Miroir de la syntaxe de durée de bot/utils/punishments.js. Il sert uniquement
// à prévenir pendant la saisie : le serveur revalide tout et a le dernier mot.
const ESC_DURATION_RE = /^(\d+[smhdjw])+$/i;

// ─── Utilitaires locaux ─────────────────────────────────────────────────────

function escLimits() {
    return _escState.data?.catalog?.limits || {};
}

function escActions() {
    return _escState.data?.catalog?.actions || [];
}

function escActionLabel(key) {
    return escActions().find(a => a.key === key)?.label || key;
}

function escChannelName(id) {
    if (!id) return null;
    const found = _escState.allChannels.find(c => c.id === id);
    return found ? `#${found.name}` : `#${id}`;
}

function escRoleName(id) {
    const found = _escState.roles.find(r => r.id === id);
    return found ? `@${found.name}` : `@${id}`;
}

/** Une réponse d'API en erreur, rendue lisible sans avaler le conseil associé. */
function escReportError(res, fallback) {
    const message = res?.error || fallback;
    showToast(res?.hint ? `${message} ${res.hint}` : message, 'error');
}

/**
 * Analyse une chaîne de punitions côté navigateur, pour l'aide à la saisie.
 * Reprend les règles de parsePunishments() : actions séparées par des virgules,
 * durée obligatoire pour certaines, interdite pour les autres, pas de doublon.
 * @returns {{ errors: string[], actions: string[] }}
 */
function escParsePunishments(raw) {
    const errors = [];
    const actions = [];
    const seen = new Set();
    const known = escActions();

    for (const chunk of String(raw || '').split(',')) {
        const entry = chunk.trim();
        if (!entry) continue;

        const [word, ...rest] = entry.split(/\s+/);
        const key = word.toLowerCase();
        const argument = rest.join('');
        const action = known.find(a => a.key === key);

        if (!action) { errors.push(`Action inconnue : « ${word} ».`); continue; }
        if (seen.has(key)) { errors.push(`L'action « ${key} » est indiquée plusieurs fois.`); continue; }

        if (action.duration) {
            if (!argument) { errors.push(`L'action « ${key} » a besoin d'une durée (par exemple « ${key} 20m »).`); continue; }
            if (!ESC_DURATION_RE.test(argument)) { errors.push(`Durée invalide pour « ${key} » : « ${argument} ».`); continue; }
        } else if (argument) {
            errors.push(`L'action « ${key} » ne prend pas de durée : « ${argument} » serait ignoré.`);
        }

        seen.add(key);
        actions.push(key);
    }
    return { errors, actions };
}

/** Résumé lisible d'une chaîne de punitions, pour la liste des paliers. */
function escSummarizePunishments(raw) {
    const text = String(raw || '').trim();
    if (!text) return 'Alerte seule — aucune sanction appliquée';
    return text
        .split(',')
        .map(entry => {
            const [word, ...rest] = entry.trim().split(/\s+/);
            const label = escActionLabel(word.toLowerCase());
            return rest.length ? `${label} (${rest.join(' ')})` : label;
        })
        .join(' · ');
}

// ─── Rendu principal ────────────────────────────────────────────────────────

async function renderAutomodEscalation(container, guildId) {
    _escState.guildId = guildId;
    _escState.editing = null;

    const [data, channels, roles] = await Promise.all([
        API.get(`/api/guilds/${guildId}/warn-escalation`),
        API.get(`/api/guilds/${guildId}/channels`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || []),
    ]);

    _escState.allChannels = channels.filter(c => c.type !== 4); // hors catégories
    _escState.channels = channels.filter(c => c.type === 0);    // salons écrits
    _escState.roles = roles;

    if (!data || data.error) {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Les paliers n'ont pas pu être chargés</div>
                <p style="color:var(--text-secondary);font-size:.9rem;margin:0">
                    ${escapeHtml(data?.error || 'Réessayez dans un instant.')}
                </p>
                ${data?.hint ? `<p style="color:var(--text-muted);font-size:.8rem;margin:.5rem 0 0">${escapeHtml(data.hint)}</p>` : ''}
            </div>
        `;
        return;
    }

    _escState.data = data;

    container.innerHTML = `
        <div id="esc-intro"></div>
        <div id="esc-editor"></div>
        <div class="card">
            <div class="card-title">📶 Paliers configurés</div>
            <div id="esc-list"></div>
        </div>
    `;

    escRenderIntro();
    escRenderList();
}

/**
 * Carte d'introduction : ce que fait le module, et la fenêtre de comptage.
 * La durée de conservation est reprise du réglage « Conservation des sanctions »
 * de la page Modération : un seul réglage, affiché aux deux endroits où il
 * compte, plutôt que deux réglages qui finiraient par se contredire.
 */
function escRenderIntro() {
    const host = document.getElementById('esc-intro');
    if (!host) return;

    const { months, unlimited } = _escState.data.retention || {};
    const limits = escLimits();
    const full = (_escState.data.tiers || []).length >= (limits.MAX_TIERS_PER_GUILD || 10);

    host.innerHTML = `
        <div class="card">
            <div class="card-title">⚡ Escalade des avertissements</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:0 0 .5rem">
                À partir d'un nombre d'avertissements actifs que vous fixez, j'applique automatiquement
                les sanctions du palier. Seul le palier le plus haut atteint s'applique : quelqu'un qui
                passe de 2 à 5 avertissements reçoit la sanction du palier 5, pas celles des paliers 3 et 5.
            </p>
            <p style="color:var(--text-muted);font-size:.8rem;margin:0 0 1rem">
                ${unlimited
                    ? 'Ce serveur conserve ses sanctions sans limite de durée : tous les avertissements comptent.'
                    : `Seuls les avertissements des <strong>${months} derniers mois</strong> comptent : c'est la durée de conservation
                       réglée sur la page Modération. Un avertissement plus ancien n'est plus conservé, il ne peut donc plus déclencher de sanction.`}
            </p>
            <button class="btn btn-primary" ${full ? 'disabled' : ''} onclick="escOpenEditor('create')">
                ${full ? `Maximum de ${limits.MAX_TIERS_PER_GUILD} paliers atteint` : 'Ajouter un palier'}
            </button>
        </div>
    `;
}

/** Résumé de portée d'un palier, en une phrase ou rien du tout. */
function escScopeSummary(tier) {
    const bits = [];
    if (tier.affected_roles.length) bits.push(`Seulement ${tier.affected_roles.map(escRoleName).join(', ')}`);
    if (tier.affected_channels.length) bits.push(`Seulement depuis ${tier.affected_channels.map(escChannelName).join(', ')}`);
    if (tier.ignored_roles.length) bits.push(`Jamais ${tier.ignored_roles.map(escRoleName).join(', ')}`);
    if (tier.ignored_channels.length) bits.push(`Jamais depuis ${tier.ignored_channels.map(escChannelName).join(', ')}`);
    return bits.join(' · ');
}

function escRenderList() {
    const host = document.getElementById('esc-list');
    if (!host) return;

    const tiers = _escState.data.tiers || [];
    if (!tiers.length) {
        host.innerHTML = `<p style="color:var(--text-secondary);font-size:.875rem;margin:0">
            Aucun palier pour le moment. Les avertissements sont enregistrés et consultables avec
            <code>/warns</code>, mais aucune sanction ne se déclenche toute seule.
        </p>`;
        return;
    }

    host.innerHTML = `<div style="display:flex;flex-direction:column;gap:.6rem">${tiers.map(tier => {
        const alertOnly = !tier.punishments;
        const scope = escScopeSummary(tier);

        const badges = [
            `<span class="badge ${tier.enabled ? 'badge-active' : 'badge-inactive'}">${tier.enabled ? 'Actif' : 'En pause'}</span>`,
            alertOnly ? '<span class="badge badge-inactive">Alerte seule</span>' : '',
        ].join(' ');

        return `
            <div class="sched-item card" style="margin-bottom:0">
                <div class="sched-item-row" style="flex-wrap:wrap">
                    <div class="sched-item-info">
                        <div class="sched-title">
                            À partir de ${tier.threshold} avertissement${tier.threshold > 1 ? 's' : ''} ${badges}
                        </div>
                        <div class="sched-meta">
                            <span>${escapeHtml(escSummarizePunishments(tier.punishments))}</span>
                        </div>
                        ${scope ? `<div class="sched-next">Portée : ${escapeHtml(scope)}</div>` : ''}
                        ${tier.log_channel ? `<div class="sched-next">Journaux : ${escapeHtml(escChannelName(tier.log_channel))}</div>` : ''}
                        ${tier.unreachable_after !== null ? `<div class="sched-next" style="color:var(--warning)">
                            Ce palier ne se déclenchera pas : le palier ${tier.unreachable_after} bannit déjà la personne,
                            qui ne peut plus accumuler d'avertissement tant qu'elle n'est pas revenue.
                        </div>` : ''}
                        ${tier.broken_scope?.length ? `<div class="sched-next" style="color:var(--danger)">
                            La portée de ce palier n'est plus lisible (${escapeHtml(tier.broken_scope.join(', '))}) :
                            par sécurité, je n'applique rien tant qu'elle n'est pas réenregistrée.
                        </div>` : ''}
                    </div>
                    <div class="sched-actions" style="flex-wrap:wrap">
                        <button class="btn" onclick="escOpenEditor('edit',${tier.id})">Modifier</button>
                        <button class="btn" onclick="escToggle(this,${tier.id},${tier.enabled ? 'false' : 'true'})">
                            ${tier.enabled ? 'Mettre en pause' : 'Activer'}
                        </button>
                        <button class="btn btn-danger" onclick="escDelete(this,${tier.id})">Supprimer</button>
                    </div>
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

// ─── Formulaire ─────────────────────────────────────────────────────────────

function escOpenEditor(mode, tierId = null) {
    const tier = tierId ? (_escState.data.tiers || []).find(t => t.id === tierId) : null;
    if (mode === 'edit' && !tier) return;

    _escState.editing = { mode, tier };
    escRenderEditor();
    document.getElementById('esc-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escCloseEditor() {
    _escState.editing = null;
    const host = document.getElementById('esc-editor');
    if (host) host.innerHTML = '';
}

function escCheckboxList(items, { name, selected, empty }) {
    if (!items.length) return `<p style="color:var(--text-muted);font-size:.8rem;margin:0">${escapeHtml(empty)}</p>`;
    return items.map(item => `
        <label style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.8rem;cursor:pointer">
            <input type="checkbox" class="${name}" value="${item.id}" ${selected.includes(item.id) ? 'checked' : ''} style="accent-color:var(--accent)">
            <span>${escapeHtml(item.label)}</span>
        </label>
    `).join('');
}

function escChannelOptions(selected) {
    return _escState.channels
        .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`)
        .join('');
}

function escRenderEditor() {
    const host = document.getElementById('esc-editor');
    if (!host || !_escState.editing) return;

    const { mode, tier } = _escState.editing;
    const limits = escLimits();

    const field = (label, help, inner) => `
        <div>
            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">${label}</label>
            ${inner}
            ${help ? `<p style="font-size:.72rem;color:var(--text-muted);margin:.25rem 0 0">${help}</p>` : ''}
        </div>
    `;

    // Boutons d'insertion : ils écrivent la syntaxe exacte attendue, y compris la
    // durée d'exemple. Personne n'a à deviner qu'on écrit « 20m » et pas « 20 min ».
    const actionButtons = escActions().map(action => `
        <button type="button" class="btn" style="padding:.3rem .6rem;font-size:.75rem"
                title="${escapeHtml(action.summary || '')}"
                onclick="escInsertAction('${action.key}',${action.duration})">
            ${escapeHtml(action.label)}
        </button>
    `).join('');

    const roleItems = _escState.roles.map(r => ({ id: r.id, label: `@${r.name}` }));
    const channelItems = _escState.allChannels.map(c => ({ id: c.id, label: `#${c.name}` }));

    host.innerHTML = `
        <div class="card">
            <div class="card-title">${mode === 'create' ? '➕ Nouveau palier' : '✏️ Modifier le palier'}</div>

            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${field('Seuil d\'avertissements',
                    `Le palier s'applique dès que la personne atteint ce nombre d'avertissements actifs. Entre ${limits.MIN_THRESHOLD} et ${limits.MAX_THRESHOLD}.`,
                    `<input class="input" type="number" id="esc-threshold" min="${limits.MIN_THRESHOLD}" max="${limits.MAX_THRESHOLD}"
                            style="width:120px" value="${tier?.threshold ?? 3}" oninput="escValidate()">`)}
                <div id="esc-threshold-warning"></div>

                ${field('Sanctions appliquées',
                    'Séparez les actions par des virgules. Exemple : <code>delete, tempmute 20m</code>. '
                    + 'Les durées s\'écrivent <code>30s</code>, <code>20m</code>, <code>3h42m</code>, <code>7d</code>, <code>1w</code>. '
                    + 'Laissez le champ vide pour une alerte seule : je journalise le franchissement sans sanctionner.',
                    `<input class="input" id="esc-punishments" maxlength="${limits.MAX_PUNISHMENTS_LENGTH}"
                            placeholder="delete, tempmute 20m"
                            value="${escapeHtml(tier?.punishments || '')}" oninput="escValidate()">`)}
                <div style="display:flex;flex-wrap:wrap;gap:.35rem">${actionButtons}</div>
                <div id="esc-punishments-feedback"></div>

                <div style="border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.7rem">
                    <div style="font-weight:600;font-size:.85rem">Portée</div>
                    <p style="color:var(--text-muted);font-size:.78rem;margin:0">
                        Sans rien cocher, le palier s'applique à tout le monde, quel que soit le salon.
                        Une exemption l'emporte toujours sur une restriction. Les salons sont évalués sur celui
                        d'où la commande <code>/warn</code> est utilisée.
                    </p>
                    ${field('Rôles concernés', 'Cochés : le palier ne s\'applique qu\'à ces rôles.',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${escCheckboxList(
                            roleItems, { name: 'esc-affected-role', selected: tier?.affected_roles || [], empty: 'Aucun rôle disponible.' }
                        )}</div>`)}
                    ${field('Rôles ignorés', 'Cochés : ces rôles ne déclenchent jamais ce palier.',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${escCheckboxList(
                            roleItems, { name: 'esc-ignored-role', selected: tier?.ignored_roles || [], empty: 'Aucun rôle disponible.' }
                        )}</div>`)}
                    ${field('Salons concernés', 'Cochés : seuls les avertissements donnés depuis ces salons déclenchent le palier.',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${escCheckboxList(
                            channelItems, { name: 'esc-affected-channel', selected: tier?.affected_channels || [], empty: 'Aucun salon disponible.' }
                        )}</div>`)}
                    ${field('Salons ignorés', 'Cochés : un avertissement donné depuis ces salons ne déclenche pas le palier.',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${escCheckboxList(
                            channelItems, { name: 'esc-ignored-channel', selected: tier?.ignored_channels || [], empty: 'Aucun salon disponible.' }
                        )}</div>`)}
                </div>

                <div style="border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.7rem">
                    <div style="font-weight:600;font-size:.85rem">Messages et journaux</div>
                    ${field('Message envoyé à la personne',
                        `Utilisé par l'action « ${escapeHtml(escActionLabel('dm'))} ». Sans texte, j'envoie mon message par défaut. ${limits.MAX_RESPONSE_MESSAGE} caractères au maximum.`,
                        `<input class="input" id="esc-response" maxlength="${limits.MAX_RESPONSE_MESSAGE}"
                                placeholder="Vous avez atteint le seuil d'avertissements de ce serveur."
                                value="${escapeHtml(tier?.response_message || '')}">`)}
                    ${field('Salon des journaux de ce palier',
                        'Sans choix, j\'utilise le salon de logs du serveur.',
                        `<select class="select" id="esc-log">
                            <option value="">Salon de logs du serveur</option>
                            ${escChannelOptions(tier?.log_channel || '')}
                        </select>`)}
                </div>

                <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;cursor:pointer">
                    <input type="checkbox" id="esc-enabled" ${(mode === 'create' ? false : tier?.enabled) ? 'checked' : ''} style="accent-color:var(--accent)">
                    ${mode === 'create' ? 'Activer ce palier tout de suite' : 'Palier actif'}
                </label>

                <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="escSave(this)">
                        ${mode === 'create' ? 'Créer le palier' : 'Enregistrer les modifications'}
                    </button>
                    <button class="btn" onclick="escCloseEditor()">Annuler</button>
                </div>
            </div>
        </div>
    `;

    escValidate();
}

/** Ajoute une action à la fin du champ, avec une durée d'exemple si elle en prend une. */
function escInsertAction(key, needsDuration) {
    const field = document.getElementById('esc-punishments');
    if (!field) return;
    const current = field.value.trim();
    const snippet = needsDuration ? `${key} 20m` : key;
    field.value = current ? `${current}, ${snippet}` : snippet;
    field.focus();
    escValidate();
}

/**
 * Vérification pendant la saisie. Elle prévient, elle ne bloque pas : le bouton
 * d'enregistrement reste actif et le serveur revalide tout. Une interface qui
 * refuse d'envoyer sur son propre verdict finit par empêcher d'enregistrer une
 * configuration pourtant valide, le jour où les deux règles divergent.
 */
function escValidate() {
    const limits = escLimits();
    const editing = _escState.editing;
    if (!editing) return;

    // ─── Seuil ───
    const host = document.getElementById('esc-threshold-warning');
    const raw = document.getElementById('esc-threshold')?.value ?? '';
    const threshold = parseInt(raw, 10);
    const notices = [];

    if (!Number.isInteger(threshold)) {
        notices.push({ tone: 'danger', text: 'Indiquez un nombre entier d\'avertissements.' });
    } else if (threshold < (limits.MIN_THRESHOLD || 1)) {
        notices.push({ tone: 'danger', text: `Le seuil doit valoir au moins ${limits.MIN_THRESHOLD}. Un palier à 0 s'appliquerait à toute personne, même sans aucun avertissement.` });
    } else if (threshold > (limits.MAX_THRESHOLD || 100)) {
        notices.push({ tone: 'danger', text: `Le seuil ne peut pas dépasser ${limits.MAX_THRESHOLD}.` });
    } else {
        const clash = (_escState.data.tiers || []).find(t => t.threshold === threshold && t.id !== editing.tier?.id);
        if (clash) {
            notices.push({ tone: 'danger', text: `Un palier existe déjà à ${threshold} avertissements. Deux paliers au même seuil seraient ambigus : modifiez celui qui existe, ou choisissez un autre seuil.` });
        }

        // Palier rendu inatteignable par un palier inférieur qui bannit.
        const blocker = (_escState.data.tiers || [])
            .filter(t => t.enabled && t.id !== editing.tier?.id && t.threshold < threshold)
            .find(t => /\b(ban|tempban)\b/i.test(t.punishments || ''));
        if (blocker) {
            notices.push({ tone: 'warning', text: `Le palier ${blocker.threshold} bannit déjà la personne : ce palier ne se déclenchera pas tant qu'elle n'est pas revenue sur le serveur.` });
        }
    }

    if (host) {
        host.innerHTML = notices.map(n => `
            <p style="color:var(--${n.tone});font-size:.78rem;margin:0 0 .25rem">${escapeHtml(n.text)}</p>
        `).join('');
    }

    // ─── Sanctions ───
    const feedback = document.getElementById('esc-punishments-feedback');
    if (!feedback) return;

    const value = document.getElementById('esc-punishments')?.value ?? '';
    const { errors, actions } = escParsePunishments(value);

    if (errors.length) {
        feedback.innerHTML = errors.map(e => `
            <p style="color:var(--danger);font-size:.78rem;margin:0 0 .25rem">${escapeHtml(e)}</p>
        `).join('');
        return;
    }

    const remarks = [];
    if (!value.trim()) {
        remarks.push('Alerte seule : je journalise le franchissement du palier, sans appliquer de sanction. C\'est une configuration valide.');
    }
    if (actions.includes('defer')) {
        remarks.push('Avec « ' + escActionLabel('defer') +' », aucune autre sanction n\'est appliquée : elles sont proposées dans le salon d\'arbitrage, et une personne tranche.');
    }
    if (actions.includes('warn')) {
        remarks.push('Attention : l\'avertissement ajouté par ce palier compte lui aussi dans le total de la personne.');
    }
    if (actions.includes('delete')) {
        remarks.push('« ' + escActionLabel('delete') + ' » reste sans effet ici : l\'escalade ne part pas d\'un message.');
    }

    feedback.innerHTML = remarks.map(r => `
        <p style="color:var(--text-muted);font-size:.78rem;margin:0 0 .25rem">${escapeHtml(r)}</p>
    `).join('');
}

/** Valeurs cochées d'une liste de cases, par classe. */
function escChecked(name) {
    return [...document.querySelectorAll(`.${name}:checked`)].map(el => el.value);
}

function escCollectPayload() {
    return {
        threshold: document.getElementById('esc-threshold')?.value ?? '',
        punishments: document.getElementById('esc-punishments')?.value.trim() || '',
        enabled: !!document.getElementById('esc-enabled')?.checked,
        affected_roles: escChecked('esc-affected-role'),
        ignored_roles: escChecked('esc-ignored-role'),
        affected_channels: escChecked('esc-affected-channel'),
        ignored_channels: escChecked('esc-ignored-channel'),
        log_channel: document.getElementById('esc-log')?.value || null,
        response_message: document.getElementById('esc-response')?.value.trim() || null,
    };
}

function escSave(btn) {
    const editing = _escState.editing;
    if (!editing) return;

    withDebounce(btn, async () => {
        const payload = escCollectPayload();
        const base = `/api/guilds/${_escState.guildId}/warn-escalation`;
        const res = editing.mode === 'create'
            ? await API.post(base, payload)
            : await API.put(`${base}/${editing.tier.id}`, payload);

        if (!res?.success) return escReportError(res, 'Le palier n\'a pas pu être enregistré.');

        showToast(editing.mode === 'create' ? 'Palier créé.' : 'Palier mis à jour.');
        escCloseEditor();
        await escRefresh();
    });
}

function escToggle(btn, tierId, enabled) {
    withDebounce(btn, async () => {
        const res = await API.put(`/api/guilds/${_escState.guildId}/warn-escalation/${tierId}/enabled`, { enabled });
        if (!res?.success) {
            escReportError(res, 'L\'état du palier n\'a pas pu être changé.');
            await escRefresh();
            return;
        }
        showToast(enabled ? 'Palier activé.' : 'Palier mis en pause.');
        await escRefresh();
    });
}

function escDelete(btn, tierId) {
    const tier = (_escState.data.tiers || []).find(t => t.id === tierId);
    // Suppression définitive d'une configuration : une confirmation s'impose,
    // il n'y a pas de corbeille.
    if (!window.confirm(`Supprimer le palier à ${tier?.threshold ?? '?'} avertissements ? Il cessera immédiatement de s'appliquer.`)) return;

    withDebounce(btn, async () => {
        const res = await API.delete(`/api/guilds/${_escState.guildId}/warn-escalation/${tierId}`);
        if (!res?.success) return escReportError(res, 'Le palier n\'a pas pu être supprimé.');
        showToast('Palier supprimé.');
        if (_escState.editing?.tier?.id === tierId) escCloseEditor();
        await escRefresh();
    });
}

/** Recharge l'état après une action. Un seul appel : tout vient de la même route. */
async function escRefresh() {
    const data = await API.get(`/api/guilds/${_escState.guildId}/warn-escalation`);
    if (!data || data.error) return escReportError(data, 'Les paliers n\'ont pas pu être rechargés.');
    _escState.data = data;
    escRenderIntro();
    escRenderList();
}

registerAutomodTab({
    id: 'escalation',
    label: 'Escalade',
    order: 20,
    render: renderAutomodEscalation,
});

window.escOpenEditor = escOpenEditor;
window.escCloseEditor = escCloseEditor;
window.escInsertAction = escInsertAction;
window.escValidate = escValidate;
window.escSave = escSave;
window.escToggle = escToggle;
window.escDelete = escDelete;
