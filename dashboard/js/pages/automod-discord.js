// ═══════════════════════════════════════════════════════════════
//  Onglet « AutoMod Discord »
//
//  Façade sur l'AutoMod NATIF de Discord : cet onglet crée, modifie et supprime
//  des règles chez Discord, qui les applique lui-même en amont du bot. Il ne
//  configure donc AUCUNE punition Quasar — les sanctions affichées ici sont
//  celles portées par la règle Discord.
//
//  Deux partis pris d'interface, tous deux délibérés :
//   1. Le vocabulaire est celui d'une personne qui modère, pas celui de l'API :
//      « Mots interdits et liens » plutôt que KEYWORD, « Empêcher les mentions en
//      masse » plutôt que MENTION_SPAM. Les clés techniques restent côté serveur.
//   2. Les quotas de Discord sont affichés AVANT la création, pas découverts au
//      refus. Six règles de mots-clés par serveur, une seule de chaque autre type :
//      autant le dire tout de suite.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab. Le titre et le sous-titre de la page sont déjà rendus,
//  ce fichier commence au niveau des cartes.
// ═══════════════════════════════════════════════════════════════

const _amdState = {
    guildId: null,
    data: null,        // dernière réponse de GET /automod
    channels: [],      // salons textuels (alerte, journaux)
    allChannels: [],   // tous les salons sélectionnables (exemptions)
    roles: [],
    editing: null,     // { mode: 'create'|'edit', triggerKey, rule|null }
};

// Durées d'exclusion proposées. Discord plafonne à 28 jours ; on propose la même
// gamme que son interface plutôt qu'une saisie libre en secondes, qui invite aux
// fautes de frappe à trois zéros près.
const AMD_TIMEOUT_CHOICES = [
    { seconds: 60, label: '1 minute' },
    { seconds: 300, label: '5 minutes' },
    { seconds: 600, label: '10 minutes' },
    { seconds: 3600, label: '1 heure' },
    { seconds: 86400, label: '1 jour' },
    { seconds: 604800, label: '1 semaine' },
    { seconds: 2419200, label: '28 jours' },
];

// ─── Utilitaires locaux ─────────────────────────────────────────────────────

function amdTrigger(key) {
    return _amdState.data?.catalog?.triggers?.find(t => t.key === key) || null;
}

function amdActionLabel(key) {
    return _amdState.data?.catalog?.actions?.find(a => a.key === key)?.label || key;
}

function amdPresetLabel(key) {
    return _amdState.data?.catalog?.presets?.find(p => p.key === key)?.label || key;
}

function amdLines(value) {
    return String(value || '').split('\n').map(l => l.trim()).filter(Boolean);
}

function amdDurationLabel(seconds) {
    return AMD_TIMEOUT_CHOICES.find(c => c.seconds === seconds)?.label || `${seconds} s`;
}

function amdChannelName(id) {
    if (!id) return null;
    const found = _amdState.allChannels.find(c => c.id === id);
    return found ? `#${found.name}` : `#${id}`;
}

/** Une réponse d'API en erreur, rendue lisible sans avaler le conseil associé. */
function amdReportError(res, fallback) {
    const message = res?.error || fallback;
    showToast(res?.hint ? `${message} ${res.hint}` : message, 'error');
}

// ─── Rendu principal ────────────────────────────────────────────────────────

async function renderAutomodDiscord(container, guildId) {
    _amdState.guildId = guildId;
    _amdState.editing = null;

    const [data, channels, roles] = await Promise.all([
        API.get(`/api/guilds/${guildId}/automod`),
        API.get(`/api/guilds/${guildId}/channels`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || []),
    ]);

    _amdState.allChannels = channels.filter(c => c.type !== 4); // hors catégories
    _amdState.channels = channels.filter(c => c.type === 0);    // salons écrits
    _amdState.roles = roles;

    if (!data || data.error) {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Les règles AutoMod n'ont pas pu être chargées</div>
                <p style="color:var(--text-secondary);font-size:.9rem;margin:0">
                    ${escapeHtml(data?.error || 'Discord n\'a pas répondu. Réessayez dans un instant.')}
                </p>
                ${data?.hint ? `<p style="color:var(--text-muted);font-size:.8rem;margin:.5rem 0 0">${escapeHtml(data.hint)}</p>` : ''}
            </div>
        `;
        return;
    }

    _amdState.data = data;

    container.innerHTML = `
        <div id="amd-notice"></div>
        <div id="amd-create"></div>
        <div id="amd-editor"></div>
        <div class="card">
            <div class="card-title">🛡️ Règles en place</div>
            <div id="amd-list"></div>
        </div>
    `;

    amdRenderNotice();
    amdRenderCreate();
    amdRenderList();
}

/**
 * Bandeau d'état. Il ne s'affiche que quand il a quelque chose à dire — une
 * permission manquante, essentiellement. Un bandeau permanent finit par ne plus
 * être lu.
 */
function amdRenderNotice() {
    const host = document.getElementById('amd-notice');
    if (!host) return;
    const { permissions, permission_hint: hint } = _amdState.data;

    if (permissions?.manage_guild) {
        host.innerHTML = permissions.moderate_members ? '' : `
            <div class="card" style="border-color:var(--warning)">
                <div class="card-title">⚠️ Exclusion temporaire indisponible</div>
                <p style="color:var(--text-secondary);font-size:.875rem;margin:0">
                    Quasar n'a pas la permission « Modérer les membres ». Vos règles peuvent bloquer et alerter,
                    mais pas exclure temporairement. Ajoutez cette permission au rôle de Quasar pour débloquer l'option.
                </p>
            </div>
        `;
        return;
    }

    host.innerHTML = `
        <div class="card" style="border-color:var(--danger)">
            <div class="card-title">🚫 Permission « Gérer le serveur » manquante</div>
            <p style="color:var(--text-secondary);font-size:.875rem;margin:0 0 .5rem">
                Discord réserve l'accès à l'AutoMod aux applications qui ont la permission « Gérer le serveur ».
                Sans elle, je ne peux ni lire, ni créer, ni modifier vos règles.
            </p>
            <p style="color:var(--text-muted);font-size:.8rem;margin:0">${escapeHtml(hint || '')}</p>
        </div>
    `;
}

/** Cartes de création, une par type de protection, avec son quota restant. */
function amdRenderCreate() {
    const host = document.getElementById('amd-create');
    if (!host) return;

    const { catalog, quotas, permissions } = _amdState.data;
    const locked = !permissions?.manage_guild;

    const cards = catalog.triggers.map(trigger => {
        const quota = quotas[trigger.key] || { used: 0, max: trigger.max_per_guild, remaining: 0 };
        const full = quota.remaining <= 0;
        const disabled = locked || full;
        const counter = trigger.max_per_guild > 1
            ? `${quota.used} règle${quota.used > 1 ? 's' : ''} sur ${quota.max}`
            : (quota.used ? 'Déjà en place' : 'Disponible');

        return `
            <div style="display:flex;flex-direction:column;gap:.5rem;padding:.85rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                <div style="font-weight:600;font-size:.9rem">${escapeHtml(trigger.label)}</div>
                <p style="color:var(--text-secondary);font-size:.8rem;margin:0;flex:1">${escapeHtml(trigger.summary)}</p>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap">
                    <span style="font-size:.75rem;color:${full ? 'var(--warning)' : 'var(--text-muted)'}">${escapeHtml(counter)}</span>
                    <button class="btn btn-primary" style="padding:.3rem .7rem;font-size:.75rem"
                            ${disabled ? 'disabled' : ''}
                            onclick="amdOpenEditor('create','${trigger.key}')">
                        ${full ? 'Quota atteint' : 'Ajouter cette règle'}
                    </button>
                </div>
            </div>
        `;
    }).join('');

    host.innerHTML = `
        <div class="card">
            <div class="card-title">➕ Ajouter une protection</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:0 0 .5rem">
                Ces filtres sont appliqués par Discord lui-même, avant que le message n'atteigne Quasar :
                aucun délai, et rien à surveiller de mon côté.
            </p>
            <p style="color:var(--text-muted);font-size:.8rem;margin:0 0 1rem">
                Discord ne sait qu'exempter : vous pouvez retirer des rôles ou des salons d'une règle,
                mais pas la restreindre à une liste de salons. Je préfère ne pas afficher un réglage qui serait ignoré.
            </p>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.75rem">${cards}</div>
        </div>
    `;
}

/** Résumé d'une règle en langage d'utilisateur, à partir de sa configuration vivante. */
function amdRuleSummary(rule) {
    const bits = [];
    const meta = rule.trigger_metadata;

    if (meta) {
        if (meta.keyword_filter?.length) bits.push(`${meta.keyword_filter.length} mot${meta.keyword_filter.length > 1 ? 's' : ''} interdit${meta.keyword_filter.length > 1 ? 's' : ''}`);
        if (meta.regex_patterns?.length) bits.push(`${meta.regex_patterns.length} expression${meta.regex_patterns.length > 1 ? 's' : ''} régulière${meta.regex_patterns.length > 1 ? 's' : ''}`);
        if (meta.presets?.length) bits.push(meta.presets.map(amdPresetLabel).join(', '));
        if (meta.mention_total_limit) bits.push(`${meta.mention_total_limit} mentions autorisées`);
        if (meta.mention_raid_protection_enabled) bits.push('protection contre les vagues de mentions');
        if (meta.allow_list?.length) bits.push(`${meta.allow_list.length} exception${meta.allow_list.length > 1 ? 's' : ''}`);
    }

    const actions = (rule.actions || []).map(a => {
        if (a.type === 'TIMEOUT' && a.duration_seconds) return `${amdActionLabel(a.type)} (${amdDurationLabel(a.duration_seconds)})`;
        if (a.type === 'SEND_ALERT_MESSAGE' && a.channel_id) return `${amdActionLabel(a.type)} ${amdChannelName(a.channel_id)}`;
        return amdActionLabel(a.type);
    });

    return { filters: bits, actions };
}

function amdRenderList() {
    const host = document.getElementById('amd-list');
    if (!host) return;

    const rules = _amdState.data.rules || [];
    if (!rules.length) {
        host.innerHTML = `<p style="color:var(--text-secondary);font-size:.875rem;margin:0">
            Aucune règle pour le moment. Choisissez une protection ci-dessus pour commencer.
        </p>`;
        return;
    }

    host.innerHTML = `<div style="display:flex;flex-direction:column;gap:.6rem">${rules.map(rule => {
        const trigger = amdTrigger(rule.trigger_type);
        const { filters, actions } = amdRuleSummary(rule);
        const canToggle = !rule.discord_missing && !!rule.discord_rule_id;

        const badges = [
            rule.discord_missing
                ? '<span class="badge badge-inactive" style="color:var(--warning)">Absente de Discord</span>'
                : `<span class="badge ${rule.enabled ? 'badge-active' : 'badge-inactive'}">${rule.enabled ? 'Active' : 'En pause'}</span>`,
        ].join('');

        return `
            <div class="sched-item card" style="margin-bottom:0">
                <!-- .sched-item-row ne passe pas à la ligne (elle vient des rappels,
                     qui ont deux boutons courts). Ici la barre d'actions en compte
                     trois, dont « Mettre en pause » : sans ce retour à la ligne, le
                     dernier bouton sortait de la carte en largeur mobile. Réglé en
                     local plutôt qu'en modifiant la classe partagée. -->
                <div class="sched-item-row" style="flex-wrap:wrap">
                    <div class="sched-item-info">
                        <div class="sched-title">
                            ${escapeHtml(rule.name || 'Règle sans nom')} ${badges}
                        </div>
                        <div class="sched-meta">
                            <span>${escapeHtml(trigger?.label || rule.trigger_type)}</span>
                            ${filters.length ? `<span>${escapeHtml(filters.join(' · '))}</span>` : ''}
                        </div>
                        ${actions.length ? `<div class="sched-next">Discord applique : ${escapeHtml(actions.join(' · '))}</div>` : ''}
                        ${rule.log_channel ? `<div class="sched-next">Journaux Quasar : ${escapeHtml(amdChannelName(rule.log_channel))}</div>` : ''}
                        ${rule.discord_missing ? `<div class="sched-next" style="color:var(--warning)">
                            Cette règle a été supprimée directement dans Discord. Sa configuration est conservée ici :
                            ouvrez-la pour la recréer, ou supprimez-la pour faire le ménage.
                        </div>` : ''}
                        ${!trigger ? `<div class="sched-next" style="color:var(--warning)">
                            Type de règle que je ne sais pas modifier. Passez par les réglages AutoMod de Discord.
                        </div>` : ''}
                    </div>
                    <div class="sched-actions" style="flex-wrap:wrap">
                        ${trigger ? `<button class="btn" onclick="amdOpenEditor('edit','${rule.trigger_type}',${rule.id})">Modifier</button>` : ''}
                        ${canToggle ? `<button class="btn" onclick="amdToggle(this,${rule.id},${rule.enabled ? 'false' : 'true'})">
                            ${rule.enabled ? 'Mettre en pause' : 'Activer'}
                        </button>` : ''}
                        <button class="btn btn-danger" onclick="amdDelete(this,${rule.id})">Supprimer</button>
                    </div>
                </div>
            </div>
        `;
    }).join('')}</div>`;
}

// ─── Formulaire ─────────────────────────────────────────────────────────────

function amdOpenEditor(mode, triggerKey, ruleId = null) {
    const rule = ruleId ? (_amdState.data.rules || []).find(r => r.id === ruleId) : null;
    if (mode === 'edit' && !rule) return;

    _amdState.editing = { mode, triggerKey, rule };
    amdRenderEditor();
    document.getElementById('amd-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function amdCloseEditor() {
    _amdState.editing = null;
    const host = document.getElementById('amd-editor');
    if (host) host.innerHTML = '';
}

function amdCheckboxList(items, { name, selected, empty }) {
    if (!items.length) return `<p style="color:var(--text-muted);font-size:.8rem;margin:0">${escapeHtml(empty)}</p>`;
    return items.map(item => `
        <label style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.8rem;cursor:pointer">
            <input type="checkbox" class="${name}" value="${item.id}" ${selected.includes(item.id) ? 'checked' : ''} style="accent-color:var(--accent)">
            <span>${escapeHtml(item.label)}</span>
        </label>
    `).join('');
}

function amdChannelOptions(selected) {
    return _amdState.channels
        .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`)
        .join('');
}

function amdRenderEditor() {
    const host = document.getElementById('amd-editor');
    if (!host || !_amdState.editing) return;

    const { mode, triggerKey, rule } = _amdState.editing;
    const trigger = amdTrigger(triggerKey);
    if (!trigger) { host.innerHTML = ''; return; }

    const limits = _amdState.data.catalog.limits;
    const meta = rule?.trigger_metadata || {};
    const actions = rule?.actions || [];
    const blockAction = actions.find(a => a.type === 'BLOCK_MESSAGE');
    const alertAction = actions.find(a => a.type === 'SEND_ALERT_MESSAGE');
    const timeoutAction = actions.find(a => a.type === 'TIMEOUT');

    const allows = key => trigger.allowed_actions.includes(key);
    const canTimeout = allows('TIMEOUT') && _amdState.data.permissions?.moderate_members;

    const field = (label, help, inner) => `
        <div>
            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">${label}</label>
            ${inner}
            ${help ? `<p style="font-size:.72rem;color:var(--text-muted);margin:.25rem 0 0">${help}</p>` : ''}
        </div>
    `;

    let triggerFields = '';

    if (trigger.fields.includes('keyword_filter')) {
        triggerFields += field(
            'Mots et expressions interdits',
            `Un par ligne. ${limits.KEYWORD_COUNT} au maximum, ${limits.KEYWORD_LENGTH} caractères chacun. Utilisez <code>*</code> en début ou en fin de mot pour attraper ses variantes.`,
            `<textarea class="input" id="amd-keywords" rows="4" style="resize:vertical" placeholder="arnaque&#10;*.gratuit-crypto.xyz">${escapeHtml((meta.keyword_filter || []).join('\n'))}</textarea>`
        );
        triggerFields += field(
            'Expressions régulières',
            `Une par ligne. ${limits.REGEX_COUNT} au maximum, ${limits.REGEX_LENGTH} caractères chacune. Attention : Discord attend la syntaxe <strong>Rust</strong>, une expression valide en JavaScript peut être refusée.`,
            `<textarea class="input" id="amd-regex" rows="3" style="resize:vertical" placeholder="(?i)discord\\.gift/\\w+">${escapeHtml((meta.regex_patterns || []).join('\n'))}</textarea>`
        );
    }

    if (trigger.fields.includes('presets')) {
        const selected = meta.presets || [];
        triggerFields += field(
            'Listes de mots de Discord',
            'Ces listes sont tenues à jour par Discord, vous n\'avez rien à y saisir.',
            `<div style="display:flex;flex-wrap:wrap;gap:.4rem">${amdCheckboxList(
                _amdState.data.catalog.presets.map(p => ({ id: p.key, label: p.label })),
                { name: 'amd-preset', selected, empty: 'Aucune liste disponible.' }
            )}</div>`
        );
    }

    if (trigger.allow_list_max > 0) {
        triggerFields += field(
            'Exceptions',
            `Mots qui ne doivent jamais déclencher cette règle. Un par ligne, ${trigger.allow_list_max} au maximum.`,
            `<textarea class="input" id="amd-allowlist" rows="2" style="resize:vertical">${escapeHtml((meta.allow_list || []).join('\n'))}</textarea>`
        );
    }

    if (trigger.fields.includes('mention_total_limit')) {
        triggerFields += field(
            'Mentions autorisées par message',
            `Au-delà de ce nombre de personnes ou de rôles mentionnés d'un coup, le message est traité par la règle. ${limits.MENTION_TOTAL} au maximum.`,
            `<input class="input" type="number" id="amd-mention-limit" min="1" max="${limits.MENTION_TOTAL}" style="width:120px"
                    value="${meta.mention_total_limit || 5}">`
        );
        triggerFields += `
            <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;cursor:pointer">
                <input type="checkbox" id="amd-mention-raid" ${meta.mention_raid_protection_enabled ? 'checked' : ''} style="accent-color:var(--accent)">
                Laisser Discord détecter aussi les vagues de mentions coordonnées
            </label>
        `;
    }

    // ─── Actions ───
    let actionFields = '';

    if (allows('BLOCK_MESSAGE')) {
        const checked = mode === 'create' ? true : !!blockAction;
        actionFields += `
            <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;cursor:pointer">
                <input type="checkbox" id="amd-block" ${checked ? 'checked' : ''} style="accent-color:var(--accent)"
                       onchange="amdToggleBlockMessage()">
                ${escapeHtml(amdActionLabel('BLOCK_MESSAGE'))}
            </label>
            <div id="amd-block-wrap" style="${checked ? '' : 'display:none'}">
                ${field(
                    'Message affiché à la personne',
                    `Facultatif. ${limits.CUSTOM_MESSAGE} caractères au maximum ; laissez vide pour le texte par défaut de Discord.`,
                    `<input class="input" id="amd-response" maxlength="${limits.CUSTOM_MESSAGE}"
                            placeholder="Ce message a été bloqué par le règlement du serveur."
                            value="${escapeHtml(rule?.response_message || '')}">`
                )}
            </div>
        `;
    }

    if (allows('SEND_ALERT_MESSAGE')) {
        actionFields += field(
            'Alerter dans un salon',
            'Discord y publie sa propre alerte, avec le contenu incriminé.',
            `<select class="input" id="amd-alert">
                <option value="">Aucune alerte</option>
                ${amdChannelOptions(alertAction?.channel_id || '')}
            </select>`
        );
    }

    if (allows('TIMEOUT')) {
        actionFields += field(
            'Exclure temporairement',
            canTimeout
                ? 'Discord exclut la personne pour cette durée, en plus des autres actions.'
                : 'Indisponible : la permission « Modérer les membres » manque au rôle de Quasar.',
            `<select class="input" id="amd-timeout" ${canTimeout ? '' : 'disabled'}>
                <option value="">Pas d'exclusion</option>
                ${AMD_TIMEOUT_CHOICES.map(c => `<option value="${c.seconds}" ${timeoutAction?.duration_seconds === c.seconds ? 'selected' : ''}>${c.label}</option>`).join('')}
            </select>`
        );
    }

    // Le filtrage de profil n'a ni message à bloquer ni salon d'où alerter :
    // Discord n'y propose qu'une action, inutile de faire cocher une case unique.
    if (allows('BLOCK_MEMBER_INTERACTION') && trigger.allowed_actions.length === 1) {
        actionFields += `<p style="font-size:.8rem;color:var(--text-secondary);margin:0">
            Discord empêche la personne d'interagir tant que son profil reste en infraction.
            C'est la seule action possible pour ce filtre.
        </p>`;
    }

    const roleItems = _amdState.roles.map(r => ({ id: r.id, label: `@${r.name}` }));
    const channelItems = _amdState.allChannels.map(c => ({ id: c.id, label: `#${c.name}` }));

    host.innerHTML = `
        <div class="card">
            <div class="card-title">
                ${mode === 'create' ? '➕ Nouvelle règle' : '✏️ Modifier la règle'} — ${escapeHtml(trigger.label)}
            </div>
            <p style="color:var(--text-secondary);font-size:.82rem;margin:0 0 1rem">${escapeHtml(trigger.summary)}</p>

            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${field('Nom de la règle', `Visible dans les réglages AutoMod de Discord. ${limits.NAME_MAX} caractères au maximum.`,
                    `<input class="input" id="amd-name" maxlength="${limits.NAME_MAX}" placeholder="ex : Liens d'arnaque"
                            value="${escapeHtml(rule?.name || '')}">`)}

                ${triggerFields}

                <div style="border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.7rem">
                    <div style="font-weight:600;font-size:.85rem">Ce que Discord fait quand la règle se déclenche</div>
                    ${actionFields}
                </div>

                <div style="border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.7rem">
                    <div style="font-weight:600;font-size:.85rem">Exemptions</div>
                    ${field(`Rôles exemptés (${limits.EXEMPT_ROLES} au maximum)`, '',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${amdCheckboxList(
                            roleItems, { name: 'amd-exempt-role', selected: rule?.exempt_roles || [], empty: 'Aucun rôle disponible.' }
                        )}</div>`)}
                    ${field(`Salons exemptés (${limits.EXEMPT_CHANNELS} au maximum)`, '',
                        `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${amdCheckboxList(
                            channelItems, { name: 'amd-exempt-channel', selected: rule?.exempt_channels || [], empty: 'Aucun salon disponible.' }
                        )}</div>`)}
                </div>

                <div style="border-top:1px solid var(--border);padding-top:.85rem;display:flex;flex-direction:column;gap:.7rem">
                    <div style="font-weight:600;font-size:.85rem">Journalisation Quasar</div>
                    ${field('Salon des journaux de cette règle',
                        'Distinct de l\'alerte de Discord : c\'est moi qui y écris, pour garder une trace dans l\'historique de modération. Sans choix, j\'utilise le salon de logs du serveur.',
                        `<select class="input" id="amd-log">
                            <option value="">Salon de logs du serveur</option>
                            ${amdChannelOptions(rule?.log_channel || '')}
                        </select>`)}
                </div>

                <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.85rem;cursor:pointer">
                    <input type="checkbox" id="amd-enabled" ${(mode === 'create' ? false : rule?.enabled) ? 'checked' : ''} style="accent-color:var(--accent)">
                    ${mode === 'create' ? 'Activer la règle tout de suite' : 'Règle active'}
                </label>

                <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="amdSave(this)">
                        ${mode === 'create' ? 'Créer la règle' : (rule?.discord_missing ? 'Recréer la règle' : 'Enregistrer les modifications')}
                    </button>
                    <button class="btn" onclick="amdCloseEditor()">Annuler</button>
                </div>
            </div>
        </div>
    `;
}

function amdToggleBlockMessage() {
    const box = document.getElementById('amd-block');
    const wrap = document.getElementById('amd-block-wrap');
    if (box && wrap) wrap.style.display = box.checked ? '' : 'none';
}

/** Valeurs cochées d'une liste de cases, par classe. */
function amdChecked(name) {
    return [...document.querySelectorAll(`.${name}:checked`)].map(el => el.value);
}

function amdCollectPayload(trigger) {
    const payload = {
        trigger_type: trigger.key,
        name: document.getElementById('amd-name')?.value.trim() || '',
        enabled: !!document.getElementById('amd-enabled')?.checked,
        exempt_roles: amdChecked('amd-exempt-role'),
        exempt_channels: amdChecked('amd-exempt-channel'),
        log_channel: document.getElementById('amd-log')?.value || null,
    };

    if (trigger.fields.includes('keyword_filter')) {
        payload.keyword_filter = amdLines(document.getElementById('amd-keywords')?.value);
        payload.regex_patterns = amdLines(document.getElementById('amd-regex')?.value);
    }
    if (trigger.fields.includes('presets')) payload.presets = amdChecked('amd-preset');
    if (trigger.allow_list_max > 0) payload.allow_list = amdLines(document.getElementById('amd-allowlist')?.value);
    if (trigger.fields.includes('mention_total_limit')) {
        payload.mention_total_limit = parseInt(document.getElementById('amd-mention-limit')?.value, 10);
        payload.mention_raid_protection_enabled = !!document.getElementById('amd-mention-raid')?.checked;
    }

    if (trigger.allowed_actions.includes('BLOCK_MESSAGE')) {
        payload.block_message = !!document.getElementById('amd-block')?.checked;
        payload.response_message = document.getElementById('amd-response')?.value.trim() || null;
    }
    if (trigger.allowed_actions.includes('SEND_ALERT_MESSAGE')) {
        payload.alert_channel_id = document.getElementById('amd-alert')?.value || null;
    }
    if (trigger.allowed_actions.includes('TIMEOUT')) {
        const seconds = parseInt(document.getElementById('amd-timeout')?.value, 10);
        payload.timeout_seconds = Number.isInteger(seconds) ? seconds : null;
    }
    if (trigger.allowed_actions.includes('BLOCK_MEMBER_INTERACTION') && trigger.allowed_actions.length === 1) {
        payload.block_member_interaction = true;
    }

    return payload;
}

function amdSave(btn) {
    const editing = _amdState.editing;
    const trigger = editing && amdTrigger(editing.triggerKey);
    if (!trigger) return;

    withDebounce(btn, async () => {
        const payload = amdCollectPayload(trigger);
        const base = `/api/guilds/${_amdState.guildId}/automod`;
        const res = editing.mode === 'create'
            ? await API.post(base, payload)
            : await API.put(`${base}/${editing.rule.id}`, payload);

        if (!res?.success) return amdReportError(res, 'La règle n\'a pas pu être enregistrée.');

        showToast(editing.mode === 'create' ? 'Règle créée dans Discord.' : 'Règle mise à jour.');
        amdCloseEditor();
        await amdRefresh();
    });
}

function amdToggle(btn, ruleId, enabled) {
    withDebounce(btn, async () => {
        const res = await API.put(`/api/guilds/${_amdState.guildId}/automod/${ruleId}/enabled`, { enabled });
        if (!res?.success) {
            amdReportError(res, 'L\'état de la règle n\'a pas pu être changé.');
            await amdRefresh();
            return;
        }
        showToast(enabled ? 'Règle activée.' : 'Règle mise en pause.');
        await amdRefresh();
    });
}

function amdDelete(btn, ruleId) {
    const rule = (_amdState.data.rules || []).find(r => r.id === ruleId);
    const label = rule?.name || 'cette règle';
    // Suppression définitive côté Discord : une confirmation explicite s'impose,
    // il n'y a pas de corbeille dans l'AutoMod.
    if (!window.confirm(`Supprimer « ${label} » ? La règle sera retirée de Discord et cessera immédiatement de filtrer.`)) return;

    withDebounce(btn, async () => {
        const res = await API.delete(`/api/guilds/${_amdState.guildId}/automod/${ruleId}`);
        if (!res?.success) return amdReportError(res, 'La règle n\'a pas pu être supprimée.');
        showToast(res.discord_deleted ? 'Règle supprimée de Discord.' : 'Configuration orpheline supprimée.');
        if (_amdState.editing?.rule?.id === ruleId) amdCloseEditor();
        await amdRefresh();
    });
}

/**
 * Recharge l'état après une action. Un seul appel : la route GET resynchronise
 * avec Discord au passage, il n'y a donc rien à interroger en plus — et rien qui
 * tourne en tâche de fond entre deux actions.
 */
async function amdRefresh() {
    const data = await API.get(`/api/guilds/${_amdState.guildId}/automod`);
    if (!data || data.error) return amdReportError(data, 'Les règles n\'ont pas pu être rechargées.');
    _amdState.data = data;
    amdRenderNotice();
    amdRenderCreate();
    amdRenderList();
}

registerAutomodTab({
    id: 'discord',
    label: 'AutoMod Discord',
    order: 10,
    render: renderAutomodDiscord,
});

window.amdOpenEditor = amdOpenEditor;
window.amdCloseEditor = amdCloseEditor;
window.amdToggleBlockMessage = amdToggleBlockMessage;
window.amdSave = amdSave;
window.amdToggle = amdToggle;
window.amdDelete = amdDelete;
