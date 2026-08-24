// ═══════════════════════════════════════════════════════════════
//  Page Embeds Custom — builder + aperçu + liste
// ═══════════════════════════════════════════════════════════════

// Rôles du serveur, chargés une fois pour le bloc Mentions (même source que la
// page Rappels : GET /api/guilds/:id/roles).
let _embedsState = {
    guildId: null,
    roles: []
};

async function loadEmbeds(container, guildId) {
    container.innerHTML = `
        <div class="main-header">
            <h1 class="main-title">📝 Embeds Custom</h1>
            <p class="main-subtitle">Crée et gère tes embeds Discord personnalisés</p>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">
            <!-- Builder -->
            <div class="card">
                <div class="card-title">✏️ Builder</div>
                <div style="display:flex;flex-direction:column;gap:.75rem">
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Nom (identifiant)</label>
                        <input class="input" id="embed-name" placeholder="ex: regles, annonce...">
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Titre</label>
                        <input class="input" id="embed-title" placeholder="Titre de l'embed" oninput="updatePreview()">
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Description</label>
                        <textarea class="input" id="embed-desc" rows="4" placeholder="Contenu de l'embed..." style="resize:vertical" oninput="updatePreview()"></textarea>
                    </div>
                    <div style="display:flex;gap:.75rem">
                        <div style="flex:1">
                            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Couleur</label>
                            <input class="input" type="color" id="embed-color" value="#c86e8e" oninput="updatePreview()" style="height:38px;padding:.2rem">
                        </div>
                        <div style="flex:2">
                            <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Footer</label>
                            <input class="input" id="embed-footer" placeholder="Texte de pied de page" oninput="updatePreview()">
                        </div>
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Image (URL)</label>
                        <input class="input" id="embed-image" placeholder="https://..." oninput="updatePreview()">
                    </div>
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Thumbnail (URL, petit coin haut droite)</label>
                        <input class="input" id="embed-thumbnail" placeholder="https://..." oninput="updatePreview()">
                    </div>
                    <p style="font-size:.75rem;color:var(--text-muted)">💡 Astuce : poste une image dans Discord, clic droit → Copier le lien de l'image.</p>

                    <hr style="border:none;border-top:1px solid var(--border-default);margin:.25rem 0">

                    <!-- Mentions : postées en contenu du message, au-dessus de l'embed -->
                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Mentions — Rôles</label>
                        <div id="embed-roles" style="display:flex;flex-wrap:wrap;gap:.4rem">
                            <p style="color:var(--text-muted);font-size:.8rem">Chargement des rôles...</p>
                        </div>
                    </div>

                    <div>
                        <label style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.3rem;display:block">Mentions — Utilisateurs (IDs Discord séparés par virgules)</label>
                        <input class="input" id="embed-users" placeholder="123456789012345678, 987654321098765432" oninput="updatePreview()">
                        <p style="font-size:.7rem;color:var(--text-muted);margin-top:.2rem">Active le mode développeur dans Discord → clic droit sur un user → Copier l'ID.</p>
                    </div>

                    <div style="display:flex;gap:1rem;flex-wrap:wrap">
                        <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                            <input type="checkbox" id="embed-everyone" onchange="updatePreview()">
                            @everyone
                        </label>
                        <label style="display:inline-flex;align-items:center;gap:.3rem;font-size:.85rem;cursor:pointer">
                            <input type="checkbox" id="embed-here" onchange="updatePreview()">
                            @here
                        </label>
                    </div>
                    <p style="font-size:.7rem;color:var(--text-muted);margin:0">Ces mentions sont postées au-dessus de l'embed à chaque envoi (<code>/embed send</code>). Un rappel qui a ses propres mentions garde les siennes.</p>

                    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
                        <button class="btn btn-primary" onclick="saveEmbed()">💾 Sauvegarder</button>
                        <button class="btn" onclick="clearEmbedForm()">Effacer</button>
                    </div>
                </div>
            </div>

            <!-- Preview -->
            <div>
                <div class="card" style="margin-bottom:1.5rem">
                    <div class="card-title">👁️ Aperçu</div>
                    <div id="embed-preview" style="background:#313338;border-radius:8px;padding:1rem;min-height:80px">
                        <p style="color:rgba(255,255,255,.3);font-size:.85rem">L'aperçu apparaît ici au fur et à mesure...</p>
                    </div>
                </div>

                <!-- Liste embeds -->
                <div class="card">
                    <div class="card-title">📋 Embeds sauvegardés</div>
                    <div id="embeds-list"><p style="color:var(--text-secondary)">Chargement...</p></div>
                </div>
            </div>
        </div>
    `;

    // Bloc commandes ajouté avant tout rendu dynamique : `+=` reconstruit tout
    // le DOM du conteneur et effacerait les listes rendues avant lui.
    container.innerHTML += renderCommandsBlock([
        ['/embed create [nom] [titre] [desc] [couleur]', 'Créer ou mettre à jour un embed'],
        ['/embed send [nom] #channel', 'Envoyer un embed dans un channel'],
        ['/embed edit [message_id] [nom]', 'Modifier un embed déjà envoyé'],
        ['/embed preview [nom]', 'Prévisualiser un embed (éphémère)'],
        ['/embed list', 'Voir les embeds sauvegardés'],
        ['/embed delete [nom]', 'Supprimer un embed'],
        ['/cmd create [nom] [reponse/embed]', 'Créer une commande custom'],
        ['/cmd edit [nom] [reponse/embed]', 'Modifier une commande'],
        ['/cmd delete [nom]', 'Supprimer une commande'],
        ['/cmd list', 'Lister les commandes custom']
    ]);

    window._guildId = guildId;
    _embedsState.guildId = guildId;

    // Rôles et embeds chargés en parallèle (un seul aller-retour chacun)
    const [roles] = await Promise.all([
        API.get(`/api/guilds/${guildId}/roles`).then(r => r || []),
        refreshEmbedsList()
    ]);
    _embedsState.roles = roles;
    renderEmbedRoles([]);
}

// ─── Mentions ─────────────────────────────────────────────────

// Cases à cocher des rôles du serveur (même ergonomie que la page Rappels).
function renderEmbedRoles(selectedIds = []) {
    const wrap = document.getElementById('embed-roles');
    if (!wrap) return;

    if (!_embedsState.roles.length) {
        wrap.innerHTML = '<p style="color:var(--text-muted);font-size:.8rem">Aucun rôle disponible</p>';
        return;
    }

    wrap.innerHTML = _embedsState.roles.map(r => {
        const checked = selectedIds.includes(r.id) ? 'checked' : '';
        const color = r.color && r.color !== '#000000' ? r.color : 'var(--text-secondary)';
        return `<label style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .5rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.8rem;cursor:pointer">
            <input type="checkbox" class="embed-role" value="${r.id}" ${checked} onchange="updatePreview()">
            <span style="color:${color}">@${escapeHtml(r.name)}</span>
        </label>`;
    }).join('');
}

// Lit le bloc Mentions du formulaire. Les IDs utilisateurs sont pré-filtrés sur
// le format snowflake côté client (l'API refiltre de toute façon).
function readEmbedMentions() {
    const usersRaw = document.getElementById('embed-users')?.value || '';
    return {
        mention_roles: Array.from(document.querySelectorAll('#embed-roles input.embed-role:checked')).map(el => el.value),
        mention_users: usersRaw.split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s)),
        mention_everyone: !!document.getElementById('embed-everyone')?.checked,
        mention_here: !!document.getElementById('embed-here')?.checked
    };
}

// Récap court pour la liste des embeds sauvegardés (esprit de celui des rappels).
function formatEmbedMentions(embed) {
    const parts = [];
    if (embed.mention_everyone) parts.push('@everyone');
    if (embed.mention_here) parts.push('@here');
    if (embed.mention_roles?.length) parts.push(`${embed.mention_roles.length} rôle${embed.mention_roles.length > 1 ? 's' : ''}`);
    if (embed.mention_users?.length) parts.push(`${embed.mention_users.length} user${embed.mention_users.length > 1 ? 's' : ''}`);
    return parts.length ? parts.join(', ') : '';
}

// Ligne de mentions telle qu'elle sera postée au-dessus de l'embed (pastilles
// façon Discord). Retourne du HTML déjà échappé.
function renderMentionsPreview(mentions) {
    const pill = label => `<span style="background:rgba(88,101,242,.3);color:#c9cdfb;padding:.05rem .25rem;border-radius:3px">${escapeHtml(label)}</span>`;
    const parts = [];
    if (mentions.mention_everyone) parts.push(pill('@everyone'));
    if (mentions.mention_here) parts.push(pill('@here'));
    for (const roleId of mentions.mention_roles) {
        const role = _embedsState.roles.find(r => r.id === roleId);
        parts.push(pill(`@${role ? role.name : roleId}`));
    }
    for (const userId of mentions.mention_users) parts.push(pill(`@${userId}`));
    return parts.join(' ');
}

// ─── Aperçu ───────────────────────────────────────────────────

function parseDiscordMd(text) {
    if (!text) return text;
    return text
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/__(.+?)__/g, '<u>$1</u>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>')
        .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,.1);padding:.1rem .3rem;border-radius:3px;font-size:.85em">$1</code>')
        .replace(/^> (.+)$/gm, '<div style="border-left:3px solid rgba(255,255,255,.2);padding-left:.6rem;color:var(--text-muted, #b9bbbe)">$1</div>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#00b0f4;text-decoration:none">$1</a>')
        .replace(/\n/g, '<br>');
}

function updatePreview() {
    const title = document.getElementById('embed-title').value;
    const desc = document.getElementById('embed-desc').value;
    const color = document.getElementById('embed-color').value;
    const footer = document.getElementById('embed-footer').value;
    const image = document.getElementById('embed-image').value;
    const thumbnail = document.getElementById('embed-thumbnail').value;
    const mentionsHtml = renderMentionsPreview(readEmbedMentions());

    const preview = document.getElementById('embed-preview');
    preview.innerHTML = `
        ${mentionsHtml ? `<div style="color:#dbdee1;font-size:.875rem;margin-bottom:.5rem">${mentionsHtml}</div>` : ''}
        <div style="border-left:4px solid ${color};padding-left:12px">
            ${thumbnail && /^https?:\/\//i.test(thumbnail) ? `<img src="${thumbnail}" style="float:right;max-width:80px;max-height:80px;border-radius:4px;margin-left:12px" onerror="this.style.display='none'">` : ''}
            ${title ? `<div style="font-weight:700;color:#fff;margin-bottom:.4rem;font-size:.95rem">${parseDiscordMd(title)}</div>` : ''}
            ${desc ? `<div style="color:#dbdee1;font-size:.875rem">${parseDiscordMd(desc)}</div>` : ''}
            ${image && /^https?:\/\//i.test(image) ? `<img src="${image}" style="max-width:100%;border-radius:4px;margin-top:.75rem;display:block" onerror="this.style.display='none'">` : ''}
            ${footer ? `<div style="color:#87898c;font-size:.75rem;margin-top:.75rem;border-top:1px solid rgba(255,255,255,.1);padding-top:.5rem">${footer}</div>` : ''}
        </div>
    `;
}

// ─── CRUD ─────────────────────────────────────────────────────

let _savingEmbed = false;
async function saveEmbed() {
    if (_savingEmbed) return;
    const name = document.getElementById('embed-name').value.trim();
    const title = document.getElementById('embed-title').value;
    const desc = document.getElementById('embed-desc').value;

    if (!name) return showToast('❌ Un nom est requis.', 'error');
    if (!title && !desc) return showToast('❌ Titre ou description requis.', 'error');
    _savingEmbed = true;

    // `data` = uniquement le contenu de l'embed. Les mentions sont des champs
    // à part, stockés dans leurs propres colonnes côté API.
    const data = {
        couleur: document.getElementById('embed-color').value,
        titre: title || undefined,
        description: desc || undefined,
        footer: document.getElementById('embed-footer').value || undefined,
        image: document.getElementById('embed-image').value || undefined,
        thumbnail: document.getElementById('embed-thumbnail').value || undefined
    };

    try {
        await API.post(`/api/guilds/${window._guildId}/embeds`, { name, data, ...readEmbedMentions() });
        showToast(`✅ Embed "${name}" sauvegardé !`);
        clearEmbedForm();
        refreshEmbedsList();
    } finally { _savingEmbed = false; }
}

async function refreshEmbedsList() {
    const embeds = await API.get(`/api/guilds/${window._guildId}/embeds`) || [];
    const list = document.getElementById('embeds-list');

    if (!embeds.length) {
        list.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">Aucun embed sauvegardé.</p>';
        return;
    }

    list.innerHTML = embeds.map(e => {
        const mentions = formatEmbedMentions(e);
        return `
        <div style="padding:.6rem .75rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:.5rem">
            <div style="display:flex;align-items:center;gap:.75rem">
                <span style="flex:1;font-size:.9rem;font-weight:500">📝 ${escapeHtml(e.name)}</span>
                <button class="btn" style="font-size:.75rem;padding:.3rem .6rem" onclick="loadEmbed(${JSON.stringify(e).replace(/"/g, '&quot;')})">Éditer</button>
                <button class="btn btn-danger" style="font-size:.75rem;padding:.3rem .6rem" onclick="deleteEmbed(${e.id}, ${JSON.stringify(e.name).replace(/"/g, '&quot;')})">🗑️</button>
            </div>
            ${mentions ? `<div style="font-size:.75rem;color:var(--text-muted);margin-top:.35rem">👥 Mentions : ${escapeHtml(mentions)}</div>` : ''}
        </div>
        `;
    }).join('');
}

function loadEmbed(embed) {
    document.getElementById('embed-name').value = embed.name;
    document.getElementById('embed-title').value = embed.data.titre || '';
    document.getElementById('embed-desc').value = embed.data.description || '';
    document.getElementById('embed-color').value = embed.data.couleur || '#c86e8e';
    document.getElementById('embed-footer').value = embed.data.footer || '';
    document.getElementById('embed-image').value = embed.data.image || '';
    document.getElementById('embed-thumbnail').value = embed.data.thumbnail || '';
    document.getElementById('embed-users').value = (embed.mention_users || []).join(', ');
    document.getElementById('embed-everyone').checked = !!embed.mention_everyone;
    document.getElementById('embed-here').checked = !!embed.mention_here;
    renderEmbedRoles(embed.mention_roles || []);
    updatePreview();
}

async function deleteEmbed(id, name) {
    if (!confirm(`Supprimer l'embed "${name}" ?`)) return;
    await API.delete(`/api/guilds/${window._guildId}/embeds/${id}`);
    showToast(`🗑️ Embed "${name}" supprimé.`);
    refreshEmbedsList();
}

function clearEmbedForm() {
    ['embed-name','embed-title','embed-desc','embed-footer','embed-image','embed-thumbnail','embed-users'].forEach(id => {
        document.getElementById(id).value = '';
    });
    document.getElementById('embed-color').value = '#c86e8e';
    document.getElementById('embed-everyone').checked = false;
    document.getElementById('embed-here').checked = false;
    renderEmbedRoles([]);
    document.getElementById('embed-preview').innerHTML = '<p style="color:rgba(255,255,255,.3);font-size:.85rem">L\'aperçu apparaît ici au fur et à mesure...</p>';
}

window.loadEmbeds = loadEmbeds;
window.updatePreview = updatePreview;
window.saveEmbed = saveEmbed;
window.loadEmbed = loadEmbed;
window.deleteEmbed = deleteEmbed;
window.clearEmbedForm = clearEmbedForm;
