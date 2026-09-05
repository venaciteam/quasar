// ═══════════════════════════════════════════════════════════════
//  Onglet « Honeypot et arbitrage »
//
//  Deux sujets dans un même onglet, et c'est volontaire.
//
//   • LE SALON PIÈGE est un module de modération automatique comme les trois
//     autres : un salon, des sanctions composables, une portée, des journaux.
//   • L'ARBITRAGE n'est pas un réglage du salon piège : c'est la soupape des
//     QUATRE modules. L'action « Demander un arbitrage » est disponible dans les
//     sanctions de l'escalade, de l'anti-raid et du piège, et elle a besoin d'un
//     salon pour aboutir. Lui donner son propre onglet dans une page qui en
//     compte déjà quatre l'aurait noyée ; la laisser sans interface la rendait
//     inutilisable. Elle est donc ici, présentée pour ce qu'elle est.
//
//  Trois partis pris d'interface :
//   1. LES GARDE-FOUS SONT DITS, PAS CONFIGURÉS. L'équipe de modération est
//      exemptée d'office. Le dire rassure et évite qu'on cherche la case à
//      cocher correspondante — il n'y en a pas, et c'est le principal intérêt
//      de cette fonctionnalité.
//   2. LA MISE EN PLACE EST ACCOMPAGNÉE. Un salon piège mal posé ne piège que
//      l'équipe. Trois phrases suffisent à dire ce qui distingue les deux.
//   3. « DEMANDER UN ARBITRAGE » SANS SALON D'ARBITRAGE N'APPLIQUE RIEN DU TOUT.
//      C'est le comportement voulu par le socle, mais qui ne l'a pas lu le vivrait
//      comme une panne silencieuse : l'interface le signale au moment exact où la
//      combinaison est saisie.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab. Le titre et le sous-titre de la page sont déjà rendus,
//  ce fichier commence au niveau des cartes.
// ═══════════════════════════════════════════════════════════════

const _hpState = {
    guildId: null,
    data: null,      // dernière réponse de GET /honeypot
    defer: null,     // dernière réponse de GET /defer
    cases: [],       // derniers cas d'arbitrage
    channels: [],    // salons écrits
    roles: [],
};

// Miroir de la syntaxe de durée de bot/utils/punishments.js, pour l'aide à la
// saisie uniquement. Le serveur revalide tout.
const HP_DURATION_RE = /^(\d+[smhdjw])+$/i;

const HP_CASES_LIMIT = 20;

const HP_CASE_VIEW = {
    pending: { label: 'En attente', badge: 'badge-active' },
    approved: { label: 'Sanctions appliquées', badge: 'badge-inactive' },
    rejected: { label: 'Cas ignoré', badge: 'badge-inactive' },
};

// ─── Utilitaires locaux ─────────────────────────────────────────────────────

function hpLimits() {
    return _hpState.data?.catalog?.limits || {};
}

function hpActions() {
    return _hpState.data?.catalog?.actions || [];
}

function hpActionLabel(key) {
    return hpActions().find(a => a.key === key)?.label || key;
}

/** Une réponse d'API en erreur, rendue lisible sans avaler le conseil associé. */
function hpReportError(res, fallback) {
    const message = res?.error || fallback;
    showToast(res?.hint ? `${message} ${res.hint}` : message, 'error');
}

function hpField(label, help, inner) {
    return `
        <div>
            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">${label}</label>
            ${inner}
            ${help ? `<p style="font-size:.72rem;color:var(--text-muted);margin:.25rem 0 0">${help}</p>` : ''}
        </div>
    `;
}

function hpNotices(hostId, notices) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = notices.map(n => `
        <p style="color:var(--${n.tone});font-size:.78rem;margin:0 0 .25rem">${escapeHtml(n.text)}</p>
    `).join('');
}

function hpChannelOptions(selected) {
    return _hpState.channels
        .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`)
        .join('');
}

function hpCheckboxList(items, { name, selected, empty }) {
    if (!items.length) return `<p style="color:var(--text-muted);font-size:.8rem;margin:0">${escapeHtml(empty)}</p>`;
    return items.map(item => `
        <label style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.8rem;cursor:pointer">
            <input type="checkbox" class="${name}" value="${item.id}" ${selected.includes(item.id) ? 'checked' : ''} style="accent-color:var(--accent)">
            <span>${escapeHtml(item.label)}</span>
        </label>
    `).join('');
}

function hpChecked(className) {
    return [...document.querySelectorAll(`.${className}:checked`)].map(el => el.value);
}

function hpFormatDate(epochSeconds) {
    if (!epochSeconds) return '';
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Le salon d'arbitrage est-il utilisable en l'état ? */
function hpDeferReady() {
    return !!(_hpState.defer?.enabled && _hpState.defer?.channel_id);
}

/**
 * Analyse une chaîne de sanctions côté navigateur, pour l'aide à la saisie.
 * Reprend les règles de parsePunishments() : actions séparées par des virgules,
 * durée obligatoire pour certaines, interdite pour les autres, pas de doublon.
 * @returns {{ errors: string[], actions: string[] }}
 */
function hpParsePunishments(raw) {
    const errors = [];
    const actions = [];
    const seen = new Set();
    const known = hpActions();

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
            if (!argument) { errors.push(`L'action « ${key} » a besoin d'une durée (par exemple « ${key} 1d »).`); continue; }
            if (!HP_DURATION_RE.test(argument)) { errors.push(`Durée invalide pour « ${key} » : « ${argument} ».`); continue; }
        } else if (argument) {
            errors.push(`L'action « ${key} » ne prend pas de durée : « ${argument} » serait ignoré.`);
        }

        seen.add(key);
        actions.push(key);
    }
    return { errors, actions };
}

// ─── Rendu principal ────────────────────────────────────────────────────────

async function renderAutomodHoneypot(container, guildId) {
    _hpState.guildId = guildId;

    const [data, defer, cases, channels, roles] = await Promise.all([
        API.get(`/api/guilds/${guildId}/honeypot`),
        API.get(`/api/guilds/${guildId}/defer`),
        API.get(`/api/guilds/${guildId}/defer/cases?limit=${HP_CASES_LIMIT}`),
        API.get(`/api/guilds/${guildId}/channels`).then(r => r || []),
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || []),
    ]);

    if (!data || data.error) {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Le salon piège n'a pas pu être chargé</div>
                <p style="color:var(--text-secondary);font-size:.9rem;margin:0">
                    ${escapeHtml(data?.error || 'Réessayez dans un instant.')}
                </p>
                ${data?.hint ? `<p style="color:var(--text-muted);font-size:.8rem;margin:.5rem 0 0">${escapeHtml(data.hint)}</p>` : ''}
            </div>
        `;
        return;
    }

    _hpState.data = data;
    // L'arbitrage est secondaire dans cet onglet : s'il ne répond pas, sa section
    // le dira, mais le salon piège doit rester configurable.
    _hpState.defer = (defer && !defer.error) ? defer : null;
    _hpState.cases = Array.isArray(cases) ? cases : [];
    _hpState.channels = channels.filter(c => c.type === 0); // salons écrits
    _hpState.roles = roles;

    container.innerHTML = `
        <div id="hp-intro"></div>
        <div id="hp-form"></div>
        <div id="hp-defer"></div>
    `;

    hpRenderIntro();
    hpRenderForm();
    hpRenderDefer();
}

// ─── Présentation du module ─────────────────────────────────────────────────

function hpRenderIntro() {
    const host = document.getElementById('hp-intro');
    if (!host) return;

    const problems = _hpState.data.problems || [];
    const warnings = _hpState.data.warnings || [];

    host.innerHTML = `
        <div class="card">
            <div class="card-title">🍯 Salon piège</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:0 0 .5rem">
                Vous désignez un salon dans lequel personne n'a de raison d'écrire. Y publier un message est
                le seul signal : je ne lis jamais ce qui y est écrit, je ne compare rien à une liste de mots.
                Le fait d'avoir écrit suffit, et les sanctions que vous choisissez s'appliquent.
            </p>
            <p style="color:var(--text-muted);font-size:.78rem;margin:0 0 .5rem;line-height:1.55">
                <strong>Ce qui fait un piège efficace.</strong> Rendez le salon visible de tout le monde — un salon
                caché ne piège personne. Donnez-lui un nom sans le moindre intérêt pour une personne réelle
                (« ne-pas-ecrire », « salon-piege ») : un compte automatisé publie partout où il peut, alors
                qu'une personne n'a aucune raison d'y venir. Enfin, épinglez-y un message qui prévient
                clairement de ne rien y écrire : c'est ce qui sépare un piège à comptes automatisés d'un piège
                à membres distrait·es.
            </p>
            <p style="color:var(--text-muted);font-size:.78rem;margin:0;line-height:1.55">
                <strong>Qui n'est jamais sanctionné·e.</strong> Les membres ayant « Exclure temporairement des
                membres » ou « Administrateur », le propriétaire du serveur et moi-même sommes exempté·es
                d'office, sans réglage possible : inspecter son propre salon piège ne doit jamais pouvoir se
                retourner contre vous. Les bots et les webhooks sont ignorés eux aussi — ils ne sont présents
                que parce que quelqu'un les y a ajoutés, et un compte de raid n'est pas un bot au sens de
                Discord. Les messages publiés par Discord dans le salon (arrivée d'un membre, épinglage) ne
                déclenchent rien. Un fil ouvert dans le salon piège, en revanche, en fait partie.
            </p>
            ${problems.length ? `
                <div style="border-top:1px solid var(--border);margin-top:.85rem;padding-top:.85rem">
                    <p style="color:var(--danger);font-size:.8rem;margin:0 0 .25rem;font-weight:600">
                        Configuration inexploitable : je n'applique rien pour l'instant.
                    </p>
                    ${problems.map(p => `<p style="color:var(--danger);font-size:.78rem;margin:0 0 .2rem">${escapeHtml(p)}</p>`).join('')}
                    <p style="color:var(--text-muted);font-size:.75rem;margin:.35rem 0 0">
                        Corrigez les réglages ci-dessous puis enregistrez : la surveillance reprendra aussitôt.
                    </p>
                </div>
            ` : ''}
            ${warnings.length ? `
                <div style="border-top:1px solid var(--border);margin-top:.85rem;padding-top:.85rem">
                    <p style="color:var(--warning);font-size:.8rem;margin:0 0 .25rem;font-weight:600">
                        À vérifier côté serveur.
                    </p>
                    ${warnings.map(w => `<p style="color:var(--warning);font-size:.78rem;margin:0 0 .2rem">${escapeHtml(w)}</p>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

// ─── Formulaire du salon piège ──────────────────────────────────────────────

function hpRenderForm() {
    const host = document.getElementById('hp-form');
    if (!host) return;

    const config = _hpState.data.config || {};
    const limits = hpLimits();
    const roleItems = _hpState.roles.map(r => ({ id: r.id, label: `@${r.name}` }));

    // Boutons d'insertion : ils écrivent la syntaxe exacte attendue, durée
    // d'exemple comprise. Personne n'a à deviner qu'on écrit « 1d » et pas « 1 jour ».
    const actionButtons = hpActions().map(action => `
        <button type="button" class="btn" style="padding:.3rem .6rem;font-size:.75rem"
                title="${escapeHtml(action.summary || '')}"
                onclick="hpInsertAction('${action.key}',${action.duration})">
            ${escapeHtml(action.label)}
        </button>
    `).join('');

    host.innerHTML = `
        <div class="card">
            <div class="card-title">📍 Salon surveillé</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${hpField('Salon piège',
                    'Choisissez un salon écrit existant. Tant qu\'aucun salon n\'est choisi, rien n\'est surveillé.',
                    `<select class="select" id="hp-channel" onchange="hpValidate()">
                        <option value="">Aucun salon piège</option>
                        ${hpChannelOptions(config.channel_id || '')}
                    </select>`)}
                <div id="hp-channel-feedback"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">⚖️ Sanctions</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${hpField('Sanctions appliquées à qui écrit dans le salon piège',
                    'Séparez les actions par des virgules. Exemple : <code>delete, tempban 7d</code>. '
                    + 'Les durées s\'écrivent <code>30s</code>, <code>20m</code>, <code>3h42m</code>, <code>7d</code>, <code>1w</code>. '
                    + 'Laissez le champ vide pour une alerte seule.',
                    `<input class="input" id="hp-punishments" maxlength="${limits.MAX_PUNISHMENTS_LENGTH || 200}"
                            placeholder="delete, tempban 7d"
                            value="${escapeHtml(config.punishments || '')}" oninput="hpValidate()">`)}
                <div style="display:flex;flex-wrap:wrap;gap:.35rem">${actionButtons}</div>
                <div id="hp-punishments-feedback"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">🎯 Portée</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                <p style="color:var(--text-muted);font-size:.78rem;margin:0;line-height:1.55">
                    Sans rien cocher, la règle s'applique à tout le monde, à l'exception des personnes
                    exemptées d'office. Une exemption l'emporte toujours sur une restriction.
                    Ce module n'a pas de réglage de salons, contrairement à l'escalade des avertissements :
                    le seul salon qui le concerne est le salon piège lui-même, déjà choisi plus haut.
                </p>
                ${hpField('Rôles concernés', 'Cochés : seules les personnes portant ces rôles sont sanctionnées.',
                    `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${hpCheckboxList(
                        roleItems, { name: 'hp-affected-role', selected: config.affected_roles || [], empty: 'Aucun rôle disponible.' }
                    )}</div>`)}
                ${hpField('Rôles exemptés', 'Cochés : ces rôles ne déclenchent jamais le piège.',
                    `<div style="display:flex;flex-wrap:wrap;gap:.4rem;max-height:170px;overflow:auto">${hpCheckboxList(
                        roleItems, { name: 'hp-ignored-role', selected: config.ignored_roles || [], empty: 'Aucun rôle disponible.' }
                    )}</div>`)}
            </div>
        </div>

        <div class="card">
            <div class="card-title">✉️ Messages et journaux</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${hpField('Message envoyé à la personne',
                    `Utilisé par l'action « ${escapeHtml(hpActionLabel('dm'))} ». Sans texte, j'envoie mon message par défaut. `
                    + `${limits.MAX_RESPONSE_MESSAGE || 1000} caractères au maximum.`,
                    `<input class="input" id="hp-response" maxlength="${limits.MAX_RESPONSE_MESSAGE || 1000}"
                            placeholder="Ce salon est un piège : personne n'est censé y écrire."
                            value="${escapeHtml(config.response_message || '')}">`)}
                ${hpField('Salon des journaux du piège',
                    'Sans choix, j\'utilise le salon de logs du serveur.',
                    `<select class="select" id="hp-log" onchange="hpValidate()">
                        <option value="">Salon de logs du serveur</option>
                        ${hpChannelOptions(config.log_channel || '')}
                    </select>`)}
            </div>
        </div>

        <div class="card">
            <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.9rem;cursor:pointer">
                <input type="checkbox" id="hp-enabled" ${config.enabled ? "checked" : ""} onchange="hpValidate()" style="accent-color:var(--accent)">
                Activer le salon piège sur ce serveur
            </label>
            <p style="color:var(--text-muted);font-size:.78rem;margin:.5rem 0 1rem">
                Tant que cette case est décochée, aucun message n'est évalué et rien n'est journalisé.
            </p>
            <button class="btn btn-primary" onclick="hpSave(this)">Enregistrer les réglages</button>
        </div>
    `;

    hpValidate();
}

/** Ajoute une action à la fin du champ, avec une durée d'exemple si elle en prend une. */
function hpInsertAction(key, needsDuration) {
    const field = document.getElementById('hp-punishments');
    if (!field) return;
    const current = field.value.trim();
    // « 7d » plutôt que « 20m » : sur un salon piège, seul un compte automatisé
    // écrit, et l'exemple proposé oriente le réglage vers une mise à l'écart utile.
    const snippet = needsDuration ? `${key} 7d` : key;
    field.value = current ? `${current}, ${snippet}` : snippet;
    field.focus();
    hpValidate();
}

/**
 * Vérification pendant la saisie. Elle prévient, elle ne bloque pas : le bouton
 * d'enregistrement reste actif et le serveur revalide tout. Une interface qui
 * refuse d'envoyer sur son propre verdict finit par empêcher d'enregistrer une
 * configuration pourtant valide, le jour où les deux règles divergent.
 */
function hpValidate() {
    // ─── Salon ───
    const channelId = document.getElementById('hp-channel')?.value || '';
    const enabled = !!document.getElementById('hp-enabled')?.checked;
    const channelNotices = [];

    if (!channelId) {
        channelNotices.push({
            tone: enabled ? 'danger' : 'text-muted',
            text: enabled
                ? 'Choisissez un salon piège : activer la surveillance sans salon sera refusé à l\'enregistrement.'
                : 'Aucun salon piège choisi pour l\'instant.',
        });
    } else if (channelId === document.getElementById('hp-log')?.value) {
        channelNotices.push({
            tone: 'warning',
            text: 'Le salon piège et le salon des journaux sont le même : mes propres alertes y déclencheraient '
                + 'le piège si je n\'en étais pas exempté. Séparez-les, elles n\'ont pas le même public.',
        });
    }
    hpNotices('hp-channel-feedback', channelNotices);

    // ─── Sanctions ───
    const value = document.getElementById('hp-punishments')?.value ?? '';
    const { errors, actions } = hpParsePunishments(value);

    if (errors.length) {
        hpNotices('hp-punishments-feedback', errors.map(text => ({ tone: 'danger', text })));
        return;
    }

    const remarks = [];
    if (!value.trim()) {
        remarks.push({
            tone: 'text-muted',
            text: 'Alerte seule : je signale le passage dans les journaux sans sanctionner personne. C\'est une '
                + 'configuration valide, et c\'est celle que je recommande pour commencer — elle vous montre qui '
                + 'écrit réellement dans ce salon avant de laisser une sanction tomber.',
        });
    }
    if (actions.includes('defer')) {
        remarks.push(hpDeferReady()
            ? {
                tone: 'text-muted',
                text: 'Avec « ' + hpActionLabel('defer') + ' », aucune sanction n\'est appliquée automatiquement : '
                    + 'les autres actions de la liste sont proposées dans le salon d\'arbitrage, et une personne tranche.',
            }
            : {
                tone: 'danger',
                text: 'Aucun salon d\'arbitrage n\'est actif sur ce serveur : avec « ' + hpActionLabel('defer') + ' » '
                    + 'dans la liste, je n\'appliquerai AUCUNE sanction et aucun cas ne sera ouvert. Configurez '
                    + 'l\'arbitrage plus bas, ou retirez cette action.',
            });
    }
    if (actions.includes('ban')) {
        remarks.push({
            tone: 'text-muted',
            text: '« ' + hpActionLabel('ban') + ' » est définitif : sur un faux positif, il faudra lever le bannissement '
                + 'à la main. « ' + hpActionLabel('tempban') + ' » protège tout autant et se lève tout seul.',
        });
    }
    if (actions.includes('delete')) {
        remarks.push({
            tone: 'text-muted',
            text: '« ' + hpActionLabel('delete') + ' » agit bien ici, contrairement aux onglets Anti-raid et Escalade : '
                + 'le message qui a déclenché le piège est retiré du salon. J\'ai besoin de la permission '
                + '« Gérer les messages » dans ce salon.',
        });
    }
    if (actions.includes('dm')) {
        remarks.push({
            tone: 'text-muted',
            text: 'Le message privé part avant l\'expulsion ou le bannissement seulement si vous placez « '
                + hpActionLabel('dm') + ' » en premier dans la liste.',
        });
    }
    if (actions.includes('warn')) {
        remarks.push({
            tone: 'text-muted',
            text: 'L\'avertissement compte dans le total du membre : il peut donc déclencher en cascade un palier '
                + 'de l\'onglet « Escalade des avertissements ».',
        });
    }

    hpNotices('hp-punishments-feedback', remarks);
}

function hpCollectPayload() {
    return {
        enabled: !!document.getElementById('hp-enabled')?.checked,
        channel_id: document.getElementById('hp-channel')?.value || null,
        punishments: document.getElementById('hp-punishments')?.value.trim() || '',
        affected_roles: hpChecked('hp-affected-role'),
        ignored_roles: hpChecked('hp-ignored-role'),
        log_channel: document.getElementById('hp-log')?.value || null,
        response_message: document.getElementById('hp-response')?.value.trim() || null,
    };
}

function hpSave(btn) {
    withDebounce(btn, async () => {
        const res = await API.put(`/api/guilds/${_hpState.guildId}/honeypot`, hpCollectPayload());
        if (!res?.success) return hpReportError(res, 'Les réglages n\'ont pas pu être enregistrés.');

        showToast('Salon piège enregistré.');
        // La réponse porte déjà l'état complet : on la réutilise plutôt que de
        // refaire un aller-retour pour lire ce qu'on vient d'écrire.
        _hpState.data = res;
        hpRenderIntro();
        hpRenderForm();
    });
}

// ─── Arbitrage ──────────────────────────────────────────────────────────────

function hpRenderDefer() {
    const host = document.getElementById('hp-defer');
    if (!host) return;

    const defer = _hpState.defer;
    const ready = hpDeferReady();

    host.innerHTML = `
        <div class="card">
            <div class="card-title-row">
                <div class="card-title">⚖️ Salon d'arbitrage</div>
                <span class="badge ${ready ? 'badge-active' : 'badge-inactive'}">
                    ${ready ? 'Actif' : 'Inactif'}
                </span>
            </div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:.5rem 0">
                L'arbitrage ne concerne pas que le salon piège : l'action « ${escapeHtml(hpActionLabel('defer'))} »
                est disponible dans les sanctions de <strong>tous</strong> les modules de cette page. Quand une règle
                la contient, rien n'est appliqué automatiquement : je poste le cas ici, avec les sanctions proposées
                et deux boutons, et votre équipe tranche. Trancher un cas demande la permission
                « Exclure temporairement des membres ».
            </p>
            <p style="color:var(--${ready ? 'text-muted' : 'warning'});font-size:.8rem;margin:0 0 .75rem;line-height:1.55">
                Sans salon d'arbitrage actif, une règle contenant « ${escapeHtml(hpActionLabel('defer'))} »
                <strong>n'applique rien du tout</strong> : ni sanction, ni cas ouvert. C'est volontaire — la règle
                demandait qu'une personne décide, et me substituer à elle parce qu'un salon manque serait
                exactement l'inverse. Mais tant que ce salon n'est pas configuré, ces règles restent sans effet.
            </p>
            ${defer ? `
                <div style="display:flex;flex-direction:column;gap:.85rem">
                    ${hpField('Salon où les cas sont publiés',
                        'Choisissez un salon réservé à votre équipe : les cas nomment les personnes concernées.',
                        `<select class="select" id="hp-defer-channel">
                            <option value="">Aucun salon d'arbitrage</option>
                            ${hpChannelOptions(defer.channel_id || '')}
                        </select>`)}
                    <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.9rem;cursor:pointer">
                        <input type="checkbox" id="hp-defer-enabled" ${defer.enabled ? 'checked' : ''} style="accent-color:var(--accent)">
                        Activer l'arbitrage sur ce serveur
                    </label>
                    <div>
                        <button class="btn btn-primary" onclick="hpSaveDefer(this)">Enregistrer l'arbitrage</button>
                    </div>
                </div>
            ` : `
                <p style="color:var(--danger);font-size:.8rem;margin:0">
                    La configuration de l'arbitrage n'a pas pu être chargée. Rechargez la page ; si le problème
                    persiste, signalez-le avec le bouton de retour.
                </p>
            `}
        </div>

        <div class="card">
            <div class="card-title">🗂️ Derniers cas</div>
            ${hpRenderCases()}
        </div>
    `;
}

function hpRenderCases() {
    if (!_hpState.cases.length) {
        return `
            <p style="color:var(--text-muted);font-size:.8rem;margin:0">
                Aucun cas d'arbitrage pour l'instant. Ils apparaîtront ici dès qu'une règle contenant
                « ${escapeHtml(hpActionLabel('defer'))} » se déclenchera.
            </p>
        `;
    }

    return `
        <p style="color:var(--text-muted);font-size:.78rem;margin:0 0 .75rem">
            Les ${HP_CASES_LIMIT} derniers cas. Ils se tranchent dans Discord, depuis les boutons du salon
            d'arbitrage : cette liste est là pour suivre, pas pour décider.
        </p>
        <div style="display:flex;flex-direction:column;gap:.5rem">
            ${_hpState.cases.map(hpRenderCase).join('')}
        </div>
    `;
}

function hpRenderCase(row) {
    const view = HP_CASE_VIEW[row.status] || { label: row.status, badge: 'badge-inactive' };
    return `
        <div class="sched-item">
            <div class="sched-item-row">
                <div class="sched-item-info">
                    <div class="sched-title">
                        Cas #${row.id} — <span class="badge ${view.badge}">${escapeHtml(view.label)}</span>
                    </div>
                    <div class="sched-meta">
                        Membre <code>${escapeHtml(String(row.target_user_id))}</code>
                        · Ouvert le ${escapeHtml(hpFormatDate(row.created_at))}
                        ${row.resolved_at ? `· Tranché le ${escapeHtml(hpFormatDate(row.resolved_at))}` : ''}
                    </div>
                    <div class="sched-meta">
                        ${escapeHtml(row.reason || 'Aucun motif précisé')}
                    </div>
                    <div class="sched-next">
                        Sanctions proposées :
                        ${row.proposed_punishments
                            ? `<code>${escapeHtml(row.proposed_punishments)}</code>`
                            : 'aucune, signalement seul'}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function hpSaveDefer(btn) {
    withDebounce(btn, async () => {
        const payload = {
            enabled: !!document.getElementById('hp-defer-enabled')?.checked,
            channel_id: document.getElementById('hp-defer-channel')?.value || null,
        };
        const res = await API.put(`/api/guilds/${_hpState.guildId}/defer`, payload);
        if (!res?.success) return hpReportError(res, 'L\'arbitrage n\'a pas pu être enregistré.');

        showToast('Salon d\'arbitrage enregistré.');
        _hpState.defer = { channel_id: payload.channel_id, enabled: payload.enabled };
        hpRenderDefer();
        // Le verdict « defer sans salon d'arbitrage » de la carte des sanctions
        // dépend de ce qui vient d'être enregistré : il doit être rejoué.
        hpValidate();
    });
}

registerAutomodTab({
    id: 'honeypot',
    label: 'Honeypot et arbitrage',
    order: 40,
    render: renderAutomodHoneypot,
});

window.hpInsertAction = hpInsertAction;
window.hpValidate = hpValidate;
window.hpSave = hpSave;
window.hpSaveDefer = hpSaveDefer;
