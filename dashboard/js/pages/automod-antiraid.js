// ═══════════════════════════════════════════════════════════════
//  Onglet « Anti-raid »
//
//  Le seul module de modération automatique que Quasar met en œuvre lui-même :
//  l'AutoMod natif de Discord ne sait rien de la vague d'arrivées. Cet onglet
//  règle la détection (N arrivées en X secondes, âge de compte minimum), ce qui
//  en découle (sanctions composables), et le mode panique.
//
//  Quatre partis pris d'interface :
//   1. AUCUN RÉGLAGE DE PORTÉE. Une personne qui vient de rejoindre n'a aucun
//      rôle et n'écrit dans aucun salon : « rôles exemptés » ne pourrait
//      correspondre à personne. Afficher la case quand même serait pire que son
//      absence — l'onglet le dit en une phrase, plutôt que de laisser un vide
//      inexpliqué là où les autres onglets ont une section.
//   2. LE MODE « ALERTE SEULE » EST LA CONFIGURATION RECOMMANDÉE POUR DÉMARRER,
//      pas un formulaire incomplet. Un anti-raid mal réglé expulse des personnes
//      légitimes : commencer par observer est un choix, et il est présenté comme
//      tel.
//   3. LE RÉGLAGE DU SEUIL EST ACCOMPAGNÉ D'ORDRES DE GRANDEUR. « 10 arrivées
//      en 60 secondes » n'a pas le même sens sur un serveur de 50 membres et sur
//      un serveur qui grandit vite ; l'interface donne des repères au lieu de
//      laisser deviner.
//   4. LA SYNTAXE DES SANCTIONS EST VÉRIFIÉE PENDANT LA SAISIE, avec les
//      messages du serveur. La vérification prévient, elle ne bloque pas : le
//      serveur revalide et a le dernier mot.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab. Le titre et le sous-titre de la page sont déjà rendus,
//  ce fichier commence au niveau des cartes.
// ═══════════════════════════════════════════════════════════════

const _arState = {
    guildId: null,
    data: null,     // dernière réponse de GET /antiraid
    channels: [],   // salons écrits (journaux)
};

// Miroir de la syntaxe de durée de bot/utils/punishments.js, pour l'aide à la
// saisie uniquement. Le serveur revalide tout.
const AR_DURATION_RE = /^(\d+[smhdjw])+$/i;

// ─── Utilitaires locaux ─────────────────────────────────────────────────────

function arLimits() {
    return _arState.data?.catalog?.limits || {};
}

function arActions() {
    return _arState.data?.catalog?.actions || [];
}

function arActionLabel(key) {
    return arActions().find(a => a.key === key)?.label || key;
}

/** Une réponse d'API en erreur, rendue lisible sans avaler le conseil associé. */
function arReportError(res, fallback) {
    const message = res?.error || fallback;
    showToast(res?.hint ? `${message} ${res.hint}` : message, 'error');
}

/** Durée en secondes → formulation française lisible (« 5 min », « 1 h 30 »). */
function arFormatSeconds(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!total) return '0 seconde';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const parts = [];
    if (hours) parts.push(`${hours} h`);
    if (minutes) parts.push(`${minutes} min`);
    if (rest) parts.push(`${rest} s`);
    return parts.join(' ');
}

/** Échéance absolue, dans le fuseau de la personne qui regarde. */
function arFormatDeadline(epochSeconds) {
    if (!epochSeconds) return '';
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        dateStyle: 'short', timeStyle: 'short',
    });
}

/**
 * Analyse une chaîne de sanctions côté navigateur, pour l'aide à la saisie.
 * Reprend les règles de parsePunishments() : actions séparées par des virgules,
 * durée obligatoire pour certaines, interdite pour les autres, pas de doublon.
 * @returns {{ errors: string[], actions: string[] }}
 */
function arParsePunishments(raw) {
    const errors = [];
    const actions = [];
    const seen = new Set();
    const known = arActions();

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
            if (!AR_DURATION_RE.test(argument)) { errors.push(`Durée invalide pour « ${key} » : « ${argument} ».`); continue; }
        } else if (argument) {
            errors.push(`L'action « ${key} » ne prend pas de durée : « ${argument} » serait ignoré.`);
        }

        seen.add(key);
        actions.push(key);
    }
    return { errors, actions };
}

// ─── Rendu principal ────────────────────────────────────────────────────────

async function renderAutomodAntiraid(container, guildId) {
    _arState.guildId = guildId;

    const [data, channels] = await Promise.all([
        API.get(`/api/guilds/${guildId}/antiraid`),
        API.get(`/api/guilds/${guildId}/channels`).then(r => r || []),
    ]);

    _arState.channels = channels.filter(c => c.type === 0); // salons écrits

    if (!data || data.error) {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">L'anti-raid n'a pas pu être chargé</div>
                <p style="color:var(--text-secondary);font-size:.9rem;margin:0">
                    ${escapeHtml(data?.error || 'Réessayez dans un instant.')}
                </p>
                ${data?.hint ? `<p style="color:var(--text-muted);font-size:.8rem;margin:.5rem 0 0">${escapeHtml(data.hint)}</p>` : ''}
            </div>
        `;
        return;
    }

    _arState.data = data;

    container.innerHTML = `
        <div id="ar-intro"></div>
        <div id="ar-panic"></div>
        <div id="ar-form"></div>
    `;

    arRenderIntro();
    arRenderPanic();
    arRenderForm();
}

function arField(label, help, inner) {
    return `
        <div>
            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">${label}</label>
            ${inner}
            ${help ? `<p style="font-size:.72rem;color:var(--text-muted);margin:.25rem 0 0">${help}</p>` : ''}
        </div>
    `;
}

/**
 * Carte d'introduction : ce que fait le module, et ce qu'il ne fait pas.
 * La phrase sur l'absence de portée est ici, une fois, et pas répétée dans le
 * formulaire : c'est une propriété du module, pas d'un champ.
 */
function arRenderIntro() {
    const host = document.getElementById('ar-intro');
    if (!host) return;

    const problems = _arState.data.problems || [];

    host.innerHTML = `
        <div class="card">
            <div class="card-title">🚨 Anti-raid sur les arrivées</div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:0 0 .5rem">
                Je surveille le rythme des arrivées. Au-delà du seuil que vous fixez, j'applique les
                sanctions configurées à l'ensemble de la vague — pas seulement à la dernière personne
                arrivée — et je peux mettre les invitations du serveur en pause le temps que ça passe.
            </p>
            <p style="color:var(--text-muted);font-size:.78rem;margin:0 0 .5rem">
                C'est de la détection de seuil, pas de la détection « intelligente » : distinguer un raid
                d'un pic de popularité demanderait de comparer plusieurs serveurs entre eux, ce que Quasar,
                auto-hébergeable, ne fait pas et ne fera pas. Le réglage du seuil vous appartient donc entièrement.
            </p>
            <p style="color:var(--text-muted);font-size:.78rem;margin:0">
                Ce module n'a pas de réglage de rôles ni de salons, contrairement aux autres onglets :
                une personne qui vient de rejoindre n'a encore aucun rôle, et une arrivée ne se produit
                dans aucun salon. Une exemption ne pourrait correspondre à personne.
            </p>
            ${problems.length ? `
                <div style="border-top:1px solid var(--border);margin-top:.85rem;padding-top:.85rem">
                    <p style="color:var(--danger);font-size:.8rem;margin:0 0 .25rem;font-weight:600">
                        Configuration inexploitable : je n'applique rien pour l'instant.
                    </p>
                    ${problems.map(p => `<p style="color:var(--danger);font-size:.78rem;margin:0 0 .2rem">${escapeHtml(p)}</p>`).join('')}
                    <p style="color:var(--text-muted);font-size:.75rem;margin:.35rem 0 0">
                        Corrigez les valeurs ci-dessous puis enregistrez : la protection reprendra aussitôt.
                    </p>
                </div>
            ` : ''}
        </div>
    `;
}

// ─── Mode panique ───────────────────────────────────────────────────────────

function arRenderPanic() {
    const host = document.getElementById('ar-panic');
    if (!host) return;

    const panic = _arState.data.panic || { active: false };
    const config = _arState.data.config || {};
    const configured = Number(config.panic_duration_seconds) > 0;

    host.innerHTML = `
        <div class="card">
            <div class="card-title-row">
                <div class="card-title">🛑 Mode panique</div>
                <span class="badge ${panic.active ? 'badge-active' : 'badge-inactive'}">
                    ${panic.active ? 'En cours' : 'Inactif'}
                </span>
            </div>
            <p style="color:var(--text-secondary);font-size:.85rem;margin:.5rem 0">
                Le mode panique met les <strong>invitations du serveur en pause</strong> : plus personne ne peut
                rejoindre le temps qu'il dure. Rien d'autre n'est touché — ni les permissions des salons,
                ni les membres déjà présents. La levée est automatique à l'échéance, et elle survit à un
                redémarrage de Quasar.
            </p>
            ${panic.active ? `
                <p style="color:var(--warning);font-size:.82rem;margin:0 0 .75rem">
                    Levée automatique prévue le <strong>${escapeHtml(arFormatDeadline(panic.expiresAt))}</strong>.
                    ${panic.triggeredBy && panic.triggeredBy !== 'detection'
                        ? 'Activé manuellement depuis ce tableau de bord.'
                        : 'Activé par la détection automatique.'}
                </p>
                <button class="btn btn-danger" onclick="arLiftPanic(this)">Lever le mode panique maintenant</button>
            ` : `
                <p style="color:var(--text-muted);font-size:.78rem;margin:0 0 .75rem">
                    ${configured
                        ? `Durée réglée : <strong>${escapeHtml(arFormatSeconds(config.panic_duration_seconds))}</strong>.
                           Vous pouvez aussi l'activer tout de suite, sans attendre une détection.`
                        : 'Le mode panique est désactivé (durée réglée à 0). Indiquez une durée plus bas pour pouvoir l\'utiliser.'}
                </p>
                <button class="btn btn-primary" ${configured ? '' : 'disabled'} onclick="arStartPanic(this)">
                    Activer le mode panique maintenant
                </button>
            `}
        </div>
    `;
}

function arStartPanic(btn) {
    if (!window.confirm('Mettre les invitations du serveur en pause maintenant ? Plus personne ne pourra rejoindre jusqu\'à la levée.')) return;
    withDebounce(btn, async () => {
        const res = await API.post(`/api/guilds/${_arState.guildId}/antiraid/panic`, {});
        if (!res?.success) return arReportError(res, 'Le mode panique n\'a pas pu être activé.');
        showToast('Mode panique activé : les invitations sont en pause.');
        await arRefresh();
    });
}

function arLiftPanic(btn) {
    withDebounce(btn, async () => {
        const res = await API.delete(`/api/guilds/${_arState.guildId}/antiraid/panic`);
        if (!res?.success) return arReportError(res, 'Le mode panique n\'a pas pu être levé.');
        showToast('Mode panique levé : les invitations sont rouvertes.');
        await arRefresh();
    });
}

// ─── Formulaire ─────────────────────────────────────────────────────────────

function arChannelOptions(selected) {
    return _arState.channels
        .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>#${escapeHtml(c.name)}</option>`)
        .join('');
}

function arRenderForm() {
    const host = document.getElementById('ar-form');
    if (!host) return;

    const config = _arState.data.config || {};
    const limits = arLimits();

    // Boutons d'insertion : ils écrivent la syntaxe exacte attendue, durée
    // d'exemple comprise. Personne n'a à deviner qu'on écrit « 1d » et pas « 1 jour ».
    const actionButtons = arActions().map(action => `
        <button type="button" class="btn" style="padding:.3rem .6rem;font-size:.75rem"
                title="${escapeHtml(action.summary || '')}"
                onclick="arInsertAction('${action.key}',${action.duration})">
            ${escapeHtml(action.label)}
        </button>
    `).join('');

    host.innerHTML = `
        <div class="card">
            <div class="card-title">📈 Détection</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                <div style="display:flex;gap:.85rem;flex-wrap:wrap">
                    ${arField('Nombre d\'arrivées', '',
                        `<input class="input" type="number" id="ar-join-count" style="width:110px"
                                min="${limits.MIN_JOIN_COUNT}" max="${limits.MAX_JOIN_COUNT}"
                                value="${Number(config.join_count) || 10}" oninput="arValidate()">`)}
                    ${arField('En moins de (secondes)', '',
                        `<input class="input" type="number" id="ar-window" style="width:130px"
                                min="${limits.MIN_WINDOW_SECONDS}" max="${limits.MAX_WINDOW_SECONDS}"
                                value="${Number(config.join_window_seconds) || 60}" oninput="arValidate()">`)}
                </div>
                <div id="ar-threshold-feedback"></div>
                <p style="color:var(--text-muted);font-size:.75rem;margin:0;line-height:1.55">
                    <strong>Repères.</strong> Un serveur calme reçoit quelques arrivées par heure : 5 arrivées en 60 secondes
                    y sont déjà anormales. Un serveur actif, ou qui vient d'être cité quelque part, peut en recevoir
                    des dizaines par minute sans qu'aucune ne soit malveillante — un seuil bas y produirait des
                    expulsions de personnes parfaitement légitimes. En cas de doute, montez le seuil et commencez
                    en alerte seule : vous verrez ce que votre serveur reçoit réellement avant de sanctionner quoi que ce soit.
                </p>

                ${arField('Âge de compte minimum (heures)',
                    'Un compte Discord créé il y a moins longtemps que cette valeur est traité comme une arrivée suspecte, '
                    + 'indépendamment de toute vague. C\'est le signal le plus fiable disponible sans comparer plusieurs serveurs. '
                    + '<code>0</code> désactive ce contrôle.',
                    `<input class="input" type="number" id="ar-account-age" style="width:130px"
                            min="${limits.MIN_ACCOUNT_AGE_HOURS}" max="${limits.MAX_ACCOUNT_AGE_HOURS}"
                            value="${Number(config.min_account_age_hours) || 0}" oninput="arValidate()">`)}
                <div id="ar-age-feedback"></div>
            </div>
        </div>

        <div class="card">
            <div class="card-title">⚖️ Sanctions</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${arField('Sanctions appliquées à chaque compte de la vague',
                    'Séparez les actions par des virgules. Exemple : <code>tempban 1d</code>. '
                    + 'Les durées s\'écrivent <code>30s</code>, <code>20m</code>, <code>3h42m</code>, <code>7d</code>, <code>1w</code>. '
                    + 'Laissez le champ vide pour une alerte seule.',
                    `<input class="input" id="ar-punishments" maxlength="${limits.MAX_PUNISHMENTS_LENGTH}"
                            placeholder="tempban 1d"
                            value="${escapeHtml(config.punishments || '')}" oninput="arValidate()">`)}
                <div style="display:flex;flex-wrap:wrap;gap:.35rem">${actionButtons}</div>
                <div id="ar-punishments-feedback"></div>
                <p style="color:var(--text-muted);font-size:.75rem;margin:0;line-height:1.55">
                    Les sanctions s'appliquent à <strong>toute la fenêtre</strong>, pas seulement à la dernière personne
                    arrivée : les comptes qui l'ont précédée sont justement le raid. Au-delà de
                    ${limits.MAX_PUNISHED_PER_WAVE || 100} comptes pour une même vague, je m'arrête et je m'en remets
                    à la mise en pause des invitations, qui coupe l'arrivée à la source.
                </p>
            </div>
        </div>

        <div class="card">
            <div class="card-title">🛑 Durée du mode panique</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${arField('Durée (secondes)',
                    `Temps pendant lequel les invitations restent en pause après une détection. `
                    + `<code>0</code> désactive le mode panique. Maximum ${limits.MAX_PANIC_SECONDS || 86400} secondes `
                    + `(24 heures), plafond imposé par Discord.`,
                    `<input class="input" type="number" id="ar-panic-seconds" style="width:140px"
                            min="${limits.MIN_PANIC_SECONDS}" max="${limits.MAX_PANIC_SECONDS}"
                            value="${Number(config.panic_duration_seconds) || 0}" oninput="arValidate()">`)}
                <div id="ar-panic-feedback"></div>
                <p style="color:var(--text-muted);font-size:.75rem;margin:0;line-height:1.55">
                    Le mode panique est indépendant des sanctions : même en alerte seule, il s'active si sa durée
                    est supérieure à 0. C'est un geste réversible sur le serveur, pas une sanction contre une personne —
                    et c'est souvent la seule mesure qu'un serveur souhaite au départ.
                </p>
            </div>
        </div>

        <div class="card">
            <div class="card-title">✉️ Messages et journaux</div>
            <div style="display:flex;flex-direction:column;gap:.85rem">
                ${arField('Message envoyé à la personne',
                    `Utilisé par l'action « ${escapeHtml(arActionLabel('dm'))} ». Sans texte, j'envoie mon message par défaut. `
                    + `${limits.MAX_RESPONSE_MESSAGE} caractères au maximum.`,
                    `<input class="input" id="ar-response" maxlength="${limits.MAX_RESPONSE_MESSAGE}"
                            placeholder="Ce serveur limite temporairement les nouvelles arrivées."
                            value="${escapeHtml(config.response_message || '')}">`)}
                ${arField('Salon des journaux de l\'anti-raid',
                    'Sans choix, j\'utilise le salon de logs du serveur.',
                    `<select class="select" id="ar-log">
                        <option value="">Salon de logs du serveur</option>
                        ${arChannelOptions(config.log_channel || '')}
                    </select>`)}
            </div>
        </div>

        <div class="card">
            <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.9rem;cursor:pointer">
                <input type="checkbox" id="ar-enabled" ${config.enabled ? 'checked' : ''} style="accent-color:var(--accent)">
                Activer l'anti-raid sur ce serveur
            </label>
            <p style="color:var(--text-muted);font-size:.78rem;margin:.5rem 0 1rem">
                Tant que cette case est décochée, aucune arrivée n'est évaluée et rien n'est journalisé.
            </p>
            <button class="btn btn-primary" onclick="arSave(this)">Enregistrer les réglages</button>
        </div>
    `;

    arValidate();
}

/** Ajoute une action à la fin du champ, avec une durée d'exemple si elle en prend une. */
function arInsertAction(key, needsDuration) {
    const field = document.getElementById('ar-punishments');
    if (!field) return;
    const current = field.value.trim();
    // « 1d » plutôt que « 20m » : sur un anti-raid, une exclusion de vingt
    // minutes n'a pas de sens, et l'exemple proposé oriente le réglage.
    const snippet = needsDuration ? `${key} 1d` : key;
    field.value = current ? `${current}, ${snippet}` : snippet;
    field.focus();
    arValidate();
}

function arNotices(hostId, notices) {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = notices.map(n => `
        <p style="color:var(--${n.tone});font-size:.78rem;margin:0 0 .25rem">${escapeHtml(n.text)}</p>
    `).join('');
}

function arReadInt(id) {
    const raw = document.getElementById(id)?.value ?? '';
    const value = parseInt(raw, 10);
    return Number.isInteger(value) ? value : null;
}

/**
 * Vérification pendant la saisie. Elle prévient, elle ne bloque pas : le bouton
 * d'enregistrement reste actif et le serveur revalide tout. Une interface qui
 * refuse d'envoyer sur son propre verdict finit par empêcher d'enregistrer une
 * configuration pourtant valide, le jour où les deux règles divergent.
 */
function arValidate() {
    const limits = arLimits();

    // ─── Seuil de détection ───
    const count = arReadInt('ar-join-count');
    const windowSeconds = arReadInt('ar-window');
    const seuil = [];

    if (count === null) {
        seuil.push({ tone: 'danger', text: 'Indiquez un nombre entier d\'arrivées.' });
    } else if (count < (limits.MIN_JOIN_COUNT || 2)) {
        seuil.push({
            tone: 'danger',
            text: `Le seuil doit valoir au moins ${limits.MIN_JOIN_COUNT}. À une seule arrivée, la règle ne décrirait `
                + 'plus une vague mais chaque personne qui rejoint ce serveur.',
        });
    } else if (count > (limits.MAX_JOIN_COUNT || 100)) {
        seuil.push({ tone: 'danger', text: `Le seuil ne peut pas dépasser ${limits.MAX_JOIN_COUNT} arrivées.` });
    }

    if (windowSeconds === null) {
        seuil.push({ tone: 'danger', text: 'Indiquez une fenêtre en secondes.' });
    } else if (windowSeconds < (limits.MIN_WINDOW_SECONDS || 5)) {
        seuil.push({
            tone: 'danger',
            text: `La fenêtre doit valoir au moins ${limits.MIN_WINDOW_SECONDS} secondes : en dessous, elle est plus `
                + 'courte que le délai de propagation des événements de Discord et se déclencherait au hasard.',
        });
    } else if (windowSeconds > (limits.MAX_WINDOW_SECONDS || 3600)) {
        seuil.push({ tone: 'danger', text: `La fenêtre ne peut pas dépasser ${limits.MAX_WINDOW_SECONDS} secondes.` });
    }

    if (!seuil.length && count !== null && windowSeconds !== null) {
        seuil.push({
            tone: 'text-muted',
            text: `Règle actuelle : ${count} arrivées en moins de ${arFormatSeconds(windowSeconds)} déclenchent l'anti-raid.`,
        });
        // Un seuil très permissif en fréquence est le principal générateur de
        // faux positifs : mieux vaut le dire au moment du réglage qu'après la
        // première vague de personnes légitimes expulsées.
        if (count / windowSeconds >= 0.5) {
            seuil.push({
                tone: 'warning',
                text: 'Ce réglage est très sensible : une invitation partagée dans un salon actif peut suffire à le déclencher. '
                    + 'Vérifiez-le en alerte seule avant d\'y associer une sanction.',
            });
        }
    }
    arNotices('ar-threshold-feedback', seuil);

    // ─── Âge de compte ───
    const age = arReadInt('ar-account-age');
    const ageNotices = [];
    if (age === null) {
        ageNotices.push({ tone: 'danger', text: 'Indiquez un nombre entier d\'heures, ou 0 pour désactiver ce contrôle.' });
    } else if (age < 0 || age > (limits.MAX_ACCOUNT_AGE_HOURS || 8760)) {
        ageNotices.push({ tone: 'danger', text: `L'âge de compte doit être compris entre 0 et ${limits.MAX_ACCOUNT_AGE_HOURS} heures.` });
    } else if (age === 0) {
        ageNotices.push({ tone: 'text-muted', text: 'Contrôle d\'âge désactivé : seule la vague d\'arrivées est surveillée.' });
    } else if (age > 720) {
        ageNotices.push({
            tone: 'warning',
            text: 'Au-delà d\'un mois, ce contrôle touche beaucoup de comptes récents mais parfaitement ordinaires.',
        });
    }
    arNotices('ar-age-feedback', ageNotices);

    // ─── Mode panique ───
    const panicSeconds = arReadInt('ar-panic-seconds');
    const panicNotices = [];
    if (panicSeconds === null) {
        panicNotices.push({ tone: 'danger', text: 'Indiquez une durée en secondes, ou 0 pour désactiver le mode panique.' });
    } else if (panicSeconds < 0 || panicSeconds > (limits.MAX_PANIC_SECONDS || 86400)) {
        panicNotices.push({ tone: 'danger', text: `La durée doit être comprise entre 0 et ${limits.MAX_PANIC_SECONDS} secondes.` });
    } else if (panicSeconds === 0) {
        panicNotices.push({ tone: 'text-muted', text: 'Mode panique désactivé : les invitations ne seront jamais mises en pause automatiquement.' });
    } else {
        panicNotices.push({ tone: 'text-muted', text: `Les invitations resteront en pause ${arFormatSeconds(panicSeconds)} après une détection.` });
    }
    arNotices('ar-panic-feedback', panicNotices);

    // ─── Sanctions ───
    const value = document.getElementById('ar-punishments')?.value ?? '';
    const { errors, actions } = arParsePunishments(value);

    if (errors.length) {
        arNotices('ar-punishments-feedback', errors.map(text => ({ tone: 'danger', text })));
        return;
    }

    const remarks = [];
    if (!value.trim()) {
        remarks.push('Alerte seule : je signale la vague dans les journaux sans sanctionner personne. '
            + 'C\'est une configuration valide, et c\'est celle que je recommande pour commencer — elle vous montre '
            + 'ce que votre seuil détecte réellement avant de le laisser agir.');
    }
    if (actions.includes('ban')) {
        remarks.push('« ' + arActionLabel('ban') + ' » est définitif : sur un faux positif, il faudra lever chaque bannissement à la main. '
            + '« ' + arActionLabel('tempban') + ' » se lève tout seul et protège tout autant le temps de la vague.');
    }
    if (actions.includes('defer')) {
        remarks.push('Avec « ' + arActionLabel('defer') + ' », aucune sanction n\'est appliquée : un cas est ouvert par compte '
            + 'dans le salon d\'arbitrage. Sur une vague, cela peut représenter beaucoup de messages d\'un coup.');
    }
    if (actions.includes('delete')) {
        remarks.push('« ' + arActionLabel('delete') + ' » reste sans effet ici : une arrivée n\'est pas un message.');
    }
    if (actions.includes('dm')) {
        remarks.push('Le message privé part avant l\'expulsion ou le bannissement seulement si vous placez '
            + '« ' + arActionLabel('dm') + ' » en premier dans la liste.');
    }

    arNotices('ar-punishments-feedback', remarks.map(text => ({ tone: 'text-muted', text })));
}

function arCollectPayload() {
    return {
        enabled: !!document.getElementById('ar-enabled')?.checked,
        join_count: document.getElementById('ar-join-count')?.value ?? '',
        join_window_seconds: document.getElementById('ar-window')?.value ?? '',
        min_account_age_hours: document.getElementById('ar-account-age')?.value ?? '',
        panic_duration_seconds: document.getElementById('ar-panic-seconds')?.value ?? '',
        punishments: document.getElementById('ar-punishments')?.value.trim() || '',
        log_channel: document.getElementById('ar-log')?.value || null,
        response_message: document.getElementById('ar-response')?.value.trim() || null,
    };
}

function arSave(btn) {
    withDebounce(btn, async () => {
        const res = await API.put(`/api/guilds/${_arState.guildId}/antiraid`, arCollectPayload());
        if (!res?.success) return arReportError(res, 'Les réglages n\'ont pas pu être enregistrés.');

        showToast('Anti-raid enregistré.');
        // La réponse porte déjà l'état complet : on la réutilise plutôt que de
        // refaire un aller-retour pour lire ce qu'on vient d'écrire.
        _arState.data = res;
        arRenderIntro();
        arRenderPanic();
        arRenderForm();
    });
}

/** Recharge l'état après une action sur le mode panique. */
async function arRefresh() {
    const data = await API.get(`/api/guilds/${_arState.guildId}/antiraid`);
    if (!data || data.error) return arReportError(data, 'L\'anti-raid n\'a pas pu être rechargé.');
    _arState.data = data;
    arRenderIntro();
    arRenderPanic();
    arRenderForm();
}

registerAutomodTab({
    id: 'antiraid',
    label: 'Anti-raid',
    order: 30,
    render: renderAutomodAntiraid,
});

window.arInsertAction = arInsertAction;
window.arValidate = arValidate;
window.arSave = arSave;
window.arStartPanic = arStartPanic;
window.arLiftPanic = arLiftPanic;
