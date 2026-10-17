const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { embed } = require('../../bot/platform/embed');
const plateforme = require('../services/plateforme');
const router = express.Router({ mergeParams: true });
const { describeRefusal } = require('../../bot/utils/assignableRole');

// Accent des panneaux de rôles. Même valeur qu'avant migration ; la couleur
// vivait en dur dans les deux constructions d'embed de ce fichier.
const ACCENT_PANNEAU = 0xc86e8e;

/**
 * Les rôles automatiques (autorôles, rôles vocaux, panneaux) passent tous par la
 * même vérification. Elle vit désormais dans le contrat —
 * `api.verifierRoleAttribuable` — et non plus dans le cache discord.js : c'est ce
 * qui a libéré le pont `describeForApi` de bot/utils/assignableRole.js, dont
 * cette route était le seul appelant.
 *
 * @returns {Promise<{role: object}|{status: number, error: string}>}
 */
async function resolveAssignableRole(req, roleId) {
    const api = plateforme.api(req);
    if (!api) return { status: 404, error: 'Ce serveur est introuvable pour le bot.' };

    const refus = await api.verifierRoleAttribuable(req.params.guildId, roleId);
    if (refus) {
        // Le nom du rôle n'est lu que pour le motif « trop haut dans la
        // hiérarchie », le seul qui le cite. Un échec de lecture n'empêche pas
        // de refuser : la phrase perd un nom, pas son sens.
        const role = refus === 'hierarchy'
            ? await plateforme.roleDuServeur(req, roleId)
            : null;
        const { cause, action } = describeRefusal(refus, role);
        return { status: 400, error: `${cause} ${action}` };
    }

    const role = await plateforme.roleDuServeur(req, roleId);
    return { role };
}

// Autoroles
router.get('/autoroles', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').all(req.params.guildId));
});

// Les mêmes gardes que `/autorole add`, qui manquaient ici : un rôle
// inattribuable s'insérait sans broncher et n'échouait qu'à l'arrivée du premier
// membre, dans un `console.error` que personne ne lit. Depuis la v4.6.1 les
// autorôles s'appliquent sur tous les serveurs, plus seulement ceux qui ont un
// message de bienvenue : autant refuser tout de suite, avec un motif.
router.post('/autoroles', requireAuth, requireGuildAdmin, async (req, res) => {
    const roleId = typeof req.body?.role_id === 'string' ? req.body.role_id.trim() : '';
    if (!roleId) return res.status(400).json({ error: 'Aucun rôle fourni.' });

    const resolved = await resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)').run(req.params.guildId, roleId);
    res.json({ success: true });
});

router.delete('/autoroles/:roleId', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM autoroles WHERE guild_id = ? AND role_id = ?').run(req.params.guildId, req.params.roleId);
    res.json({ success: true });
});

// Voice roles
router.get('/voiceroles', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    try {
        res.json(db.prepare('SELECT channel_id, role_id FROM voice_roles WHERE guild_id = ?').all(req.params.guildId));
    } catch { res.json([]); }
});

// Mêmes gardes que pour les autorôles : un rôle vocal inattribuable échoue à
// chaque connexion en vocal, en silence côté administrateur.
router.post('/voiceroles', requireAuth, requireGuildAdmin, async (req, res) => {
    const channelId = typeof req.body?.channel_id === 'string' ? req.body.channel_id.trim() : '';
    const roleId = typeof req.body?.role_id === 'string' ? req.body.role_id.trim() : '';
    if (!channelId || !roleId) return res.status(400).json({ error: 'Salon ou rôle manquant.' });

    const resolved = await resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    // Le salon doit exister et être vocal : la table est indexée dessus, une
    // ligne pointant un salon textuel ne se déclencherait jamais. Les noms
    // canoniques viennent de bot/platform/channels.js — « conference » est le
    // salon de conférence, vocal lui aussi.
    // SCELLÉ au serveur de l'URL : `api.obtenirCanal` est global à l'instance, et
    // la garde à la main qui vivait ici est désormais dans le helper, avec les
    // huit autres.
    const channel = await plateforme.canalDuServeur(req, channelId);
    if (!channel) {
        return res.status(400).json({ error: 'Ce salon n\'existe pas sur ce serveur.' });
    }
    if (channel.type !== 'vocal' && channel.type !== 'conference') {
        return res.status(400).json({ error: 'Ce salon n\'est pas un salon vocal.' });
    }

    // `voice_roles` appartient au schéma (api/services/database.js) depuis la
    // consolidation : la créer à la volée ici n'aurait servi qu'à masquer une
    // migration manquante.
    getDb().prepare(`INSERT INTO voice_roles (guild_id, channel_id, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET role_id = ?`)
        .run(req.params.guildId, channelId, roleId, roleId);
    res.json({ success: true });
});

router.delete('/voiceroles/:channelId', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM voice_roles WHERE guild_id = ? AND channel_id = ?').run(req.params.guildId, req.params.channelId);
    res.json({ success: true });
});

// Panels
router.get('/panels', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const panels = db.prepare('SELECT * FROM reaction_panels WHERE guild_id = ?').all(req.params.guildId);
    if (panels.length === 0) return res.json([]);

    const panelIds = panels.map(p => p.id);
    const placeholders = panelIds.map(() => '?').join(',');
    const allEntries = db.prepare(`SELECT * FROM reaction_roles WHERE panel_id IN (${placeholders}) ORDER BY rowid ASC`).all(...panelIds);

    const entriesByPanel = {};
    for (const e of allEntries) {
        (entriesByPanel[e.panel_id] ||= []).push(e);
    }

    res.json(panels.map(p => ({ ...p, entries: entriesByPanel[p.id] || [] })));
});

// Vérifier le statut des panels (message encore existant ?)
router.get('/panels/status', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panels = db.prepare('SELECT id, channel_id, message_id FROM reaction_panels WHERE guild_id = ?').all(req.params.guildId);

    const status = {};
    for (const p of panels) {
        // `messageDuServeur` scelle le salon puis lit le message, et absorbe
        // l'échec : « supprimé », « pas à ce serveur » et « injoignable » se
        // traitent tous en « missing », comme le faisait le `catch` du cache
        // avant migration. L'affichage se corrige au rafraîchissement suivant.
        const msg = await plateforme.messageDuServeur(req, p.channel_id, p.message_id);
        status[p.id] = msg ? 'active' : 'missing';
    }
    res.json(status);
});

// Créer un panel
router.post('/panels', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { channel_id, title, description, mode } = req.body;
    if (!channel_id || !title) return res.status(400).json({ error: 'channel_id et title requis' });

    const api = plateforme.api(req);
    const channel = await plateforme.canalDuServeur(req, channel_id);
    if (!channel) {
        return res.status(400).json({ error: 'Channel introuvable' });
    }

    const result = db.prepare('INSERT INTO reaction_panels (guild_id, channel_id, title, mode) VALUES (?, ?, ?, ?)')
        .run(req.params.guildId, channel_id, title, mode || 'multiple');
    const panelId = result.lastInsertRowid;

    // Poster l'embed
    const corps = embed({
        titre: title,
        description: (description || 'Cliquez sur un emoji pour obtenir le rôle correspondant.') + '\n\n*(Aucun rôle configuré)*',
        couleur: ACCENT_PANNEAU,
        pied: { texte: `Panel #${panelId} • Mode ${mode || 'multiple'}` },
    });

    try {
        const msg = await api.envoyerMessage(channel_id, corps);
        db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
        res.json({ success: true, id: panelId, message_id: msg.id });
    } catch (e) {
        res.status(500).json({ error: 'Erreur envoi message: ' + e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
//  Validation de l'emoji d'un panneau de rôles
//
//  Ce champ n'était vérifié NULLE PART. C'est la cause racine du XSS stocké
//  corrigé côté rendu en v4.8.0 : la valeur repartait telle quelle vers
//  `innerHTML` dans le dashboard, si bien qu'un `<img src=x onerror=…>`
//  enregistré comme « emoji » s'exécutait au simple affichage de la page. La
//  commande `/reactionrole` étant ouverte à `ManageRoles`, n'importe quel membre
//  de l'équipe de modération pouvait le poser.
//
//  L'échappement côté page ferme la faille ; cette garde ferme la porte par
//  laquelle la donnée entrait. Les deux valent mieux qu'une seule : la valeur
//  finit aussi dans une description d'embed Discord et dans un appel à
//  `msg.react()`.
//
//  Choix assumé : je ne cherche PAS à prouver que la chaîne est un emoji. Les
//  définir par une expression rationnelle est un piège — les emojis composés
//  d'un chiffre et d'une enceinte (1️⃣), les drapeaux formés de deux indicateurs
//  régionaux, les familles assemblées par jointeurs de largeur nulle échappent
//  aux propriétés Unicode évidentes, et refuser un emoji que Discord accepte
//  serait un défaut plus visible que celui qu'on corrige. Je vérifie donc qu'elle
//  est COURTE et INOFFENSIVE. `msg.react()` rejettera de lui-même ce qui n'est
//  pas un emoji valide, et c'est déjà le cas aujourd'hui.
// ═══════════════════════════════════════════════════════════════

// Format des emojis personnalisés de Discord : <:nom:id> ou <a:nom:id> animé.
const EMOJI_PERSONNALISE = /^<a?:\w{2,32}:\d{17,20}>$/;
// Tout ce qui permettrait de sortir d'un attribut HTML, d'une balise, ou
// d'injecter dans une description d'embed.
const CARACTERES_INTERDITS = /[<>"'`&\\\r\n\t]/;
const MAX_POINTS_DE_CODE = 8;
const MAX_DESCRIPTION = 100;

function validerEmoji(valeur) {
    if (typeof valeur !== 'string') return { error: "L'emoji doit être du texte." };
    const v = valeur.trim();
    if (!v) return { error: 'Aucun emoji fourni.' };

    // Le format personnalisé contient des chevrons : il est testé en premier, et
    // ses classes `\w` et `\d` n'admettent ni guillemet ni chevron supplémentaire.
    if (EMOJI_PERSONNALISE.test(v)) return { value: v };

    if (CARACTERES_INTERDITS.test(v)) {
        return { error: "Cet emoji contient des caractères qui ne peuvent pas être affichés en toute sécurité. Utilisez un emoji, ou un emoji personnalisé du serveur." };
    }
    // Compté en points de code et non en octets : un seul emoji peut peser une
    // dizaine d'octets.
    if ([...v].length > MAX_POINTS_DE_CODE) {
        return { error: "Cet emoji est trop long. Utilisez un emoji unique, ou un emoji personnalisé du serveur." };
    }
    // Un emoji n'est jamais purement ASCII. Les seules exceptions, les touches
    // numériques, portent toujours leur enceinte U+20E3, hors ASCII.
    if (!/[^\x00-\x7F]/.test(v)) {
        return { error: "Cette valeur n'est pas un emoji." };
    }
    return { value: v };
}

function validerDescription(valeur) {
    if (valeur === undefined || valeur === null || valeur === '') return { value: null };
    if (typeof valeur !== 'string') return { error: 'La description doit être du texte.' };
    if (valeur.length > MAX_DESCRIPTION) {
        return { error: `La description d'une entrée est limitée à ${MAX_DESCRIPTION} caractères.` };
    }
    return { value: valeur };
}

// Ajouter un emoji → rôle à un panel
router.post('/panels/:panelId/entries', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { emoji, role_id, description } = req.body;
    const panelId = req.params.panelId;

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    // Mêmes gardes que les autorôles et les rôles vocaux : sans elles, un rôle
    // inattribuable n'échoue qu'au premier clic sur l'emoji.
    const roleId = typeof role_id === 'string' ? role_id.trim() : '';
    if (!roleId) return res.status(400).json({ error: 'Aucun rôle fourni.' });
    const resolved = await resolveAssignableRole(req, roleId);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const emojiLu = validerEmoji(emoji);
    if (emojiLu.error) return res.status(400).json({ error: emojiLu.error });
    const descriptionLue = validerDescription(description);
    if (descriptionLue.error) return res.status(400).json({ error: descriptionLue.error });

    db.prepare(`INSERT INTO reaction_roles (panel_id, emoji, role_id, description) VALUES (?, ?, ?, ?)
        ON CONFLICT(panel_id, emoji) DO UPDATE SET role_id = ?, description = ?`)
        .run(panelId, emojiLu.value, roleId, descriptionLue.value, roleId, descriptionLue.value);

    // Refresh le panel Discord
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Retirer un emoji d'un panel
router.delete('/panels/:panelId/entries/:emoji', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;
    const emoji = decodeURIComponent(req.params.emoji);

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    db.prepare('DELETE FROM reaction_roles WHERE panel_id = ? AND emoji = ?').run(panelId, emoji);
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Re-poster un panel dont le message a été supprimé
router.post('/panels/:panelId/repost', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;
    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.status(404).json({ error: 'Panel introuvable' });

    // Forcer le refresh (qui re-poste automatiquement si le message est absent)
    await refreshPanelFromApi(req, panel, panelId, db);
    res.json({ success: true });
});

// Supprimer un panel entier
router.delete('/panels/:panelId', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const panelId = req.params.panelId;

    const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, req.params.guildId);
    if (!panel) return res.json({ success: true });

    // Supprimer le message du panneau. `api.supprimerMessage` est global à
    // l'instance : le salon est SCELLÉ d'abord, sans quoi une ligne dont le
    // `channel_id` désigne un autre serveur y ferait supprimer un message.
    try {
        const api = plateforme.api(req);
        const canal = await plateforme.canalDuServeur(req, panel.channel_id);
        if (api && canal && panel.message_id) await api.supprimerMessage(panel.channel_id, panel.message_id);
    } catch {} // Message ou salon déjà supprimé

    db.prepare('DELETE FROM reaction_panels WHERE id = ?').run(panelId);
    res.json({ success: true });
});

async function refreshPanelFromApi(req, panel, panelId, db) {
    try {
        const api = plateforme.api(req);
        if (!api) return;
        const entries = db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY rowid ASC').all(panelId);
        // SCELLÉ : un panneau dont le salon n'appartient pas à ce serveur ne se
        // rafraîchit pas — et surtout, on n'y poste pas.
        const channel = await plateforme.canalDuServeur(req, panel.channel_id);
        if (!channel) return;

        const p = db.prepare('SELECT * FROM reaction_panels WHERE id = ?').get(panelId);

        let description = 'Cliquez sur un emoji pour obtenir le rôle correspondant.\n\n';
        if (entries.length === 0) {
            description += '*(Aucun rôle configuré)*';
        } else {
            description += entries.map(e =>
                `${e.emoji} → <@&${e.role_id}>${e.description ? ` — *${e.description}*` : ''}`
            ).join('\n');
        }

        const corps = embed({
            titre: p.title,
            description,
            couleur: ACCENT_PANNEAU,
            pied: { texte: `Panel #${panelId} • Mode ${p.mode}` },
        });

        // Tenter de récupérer le message existant. Le message NORMALISÉ porte ses
        // réactions, `parMoi` compris : c'est ce qui permet de ne reposer que les
        // emojis manquants au lieu de tous les reposer.
        let msg = await plateforme.messageDuServeur(req, panel.channel_id, panel.message_id);

        if (!msg) {
            // Message supprimé par un admin → re-poster
            console.log(`[Quasar] Panel #${panelId} : message supprimé, re-post...`);
            msg = await api.envoyerMessage(panel.channel_id, corps);
            db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(msg.id, panelId);
        } else {
            await api.modifierMessage(panel.channel_id, msg.id, corps);
        }

        // Ajouter les réactions manquantes
        // `emoji.cle` est la forme STOCKÉE EN BASE (`🎮`, `<:nom:id>`,
        // `<a:nom:id>`), pas l'identifiant : comparer autre chose ferait reposer
        // chaque emoji personnalisé à chaque rafraîchissement.
        const posees = new Set((msg.reactions || []).filter(r => r.parMoi).map(r => r.emoji?.cle));
        for (const entry of entries) {
            if (posees.has(entry.emoji)) continue;
            await api.ajouterReaction(panel.channel_id, msg.id, entry.emoji).catch(() => {});
        }
    } catch (e) {
        console.error('[Quasar] Erreur refresh panel API:', e.message);
    }
}

module.exports = router;
module.exports.validerEmoji = validerEmoji;
module.exports.validerDescription = validerDescription;

