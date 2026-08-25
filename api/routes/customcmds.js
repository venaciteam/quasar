const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb, CUSTOM_CMD_ACCESS_MODES, CUSTOM_CMD_ACCESS_DEFAULT, effectiveAccessMode } = require('../services/database');
const { SNOWFLAKE } = require('../services/mentions');
// Noyau partagé avec `/cmd` : validation des noms, écriture transactionnelle et
// synchronisation Discord. Le dashboard et la commande du bot doivent se
// comporter à l'identique — une seule implémentation, pas deux copies.
const {
    validateCustomCommandRename,
    updateCustomCommand,
    deployCustomCommand,
    removeCustomCommand,
    syncCustomCommandRename,
} = require('../../bot/commands/customcmd');
const router = express.Router({ mergeParams: true });

// Un corps de requête peut contenir n'importe quoi, y compris un objet dont la
// conversion en texte lève une exception (`{ toString: 1 }`) : un `String(...)`
// naïf y fait tomber la route en 500. Seules les valeurs réellement scalaires
// sont acceptées, tout le reste est traité comme invalide.
function asText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

// Contrôle d'accès d'une commande personnalisée : corps de requête (non fiable)
// → { mode, roleId } prêts à écrire, ou { error } explicite.
//
// Rien n'est deviné ni « réparé » en silence : un mode hors liste blanche et un
// mode 'role' sans identifiant valide sont refusés, pas transformés. Une
// commande dont l'accès serait secrètement retombé sur « tout le monde » alors
// que l'admin croyait l'avoir restreinte serait pire qu'une erreur 400 — les
// mentions de son embed sont désormais réellement envoyées à chaque appel.
//
// `fallback` est le mode à retenir quand le corps ne parle pas d'accès du tout
// (création : 'everyone', le comportement historique ; modification : le mode
// déjà en base, pour qu'un simple changement de texte ne rouvre rien).
function parseAccess(body = {}, fallback = CUSTOM_CMD_ACCESS_DEFAULT, fallbackRoleId = null) {
    if (body.access_mode === undefined || body.access_mode === null || body.access_mode === '') {
        return { mode: fallback, roleId: fallback === 'role' ? fallbackRoleId : null };
    }

    const mode = asText(body.access_mode);
    if (mode === null || !CUSTOM_CMD_ACCESS_MODES.includes(mode)) {
        return { error: `Mode d'accès invalide. Valeurs acceptées : ${CUSTOM_CMD_ACCESS_MODES.join(', ')}.` };
    }
    if (mode !== 'role') return { mode, roleId: null };

    const roleId = asText(body.access_role_id);
    if (roleId === null || !SNOWFLAKE.test(roleId)) {
        return { error: 'Le mode « rôle » exige un identifiant de rôle Discord valide (17 à 20 chiffres).' };
    }
    return { mode, roleId };
}

router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const cmds = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ?').all(req.params.guildId);
    // Ajouter le nom de l'embed si lié
    const result = cmds.map(c => {
        if (c.embed_id) {
            const embed = db.prepare('SELECT name FROM embeds WHERE id = ?').get(c.embed_id);
            c.embed_name = embed?.name || null;
        }
        // Le dashboard reçoit le mode RÉELLEMENT appliqué par le bot, pas la
        // valeur brute : sur une ligne incohérente, afficher « tout le monde »
        // alors que le bot restreint à « administrateurs » serait un mensonge.
        c.access_mode = effectiveAccessMode(c.access_mode);
        c.access_role_id = c.access_mode === 'role' ? (c.access_role_id || null) : null;
        return c;
    });
    res.json(result);
});

// Créer une commande custom
router.post('/', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { name, response, embed_name } = req.body;
    const cmdName = name?.trim().toLowerCase().replace(/\s+/g, '-');

    if (!cmdName) return res.status(400).json({ error: 'Nom requis' });
    if (!response && !embed_name) return res.status(400).json({ error: 'Réponse ou embed requis' });

    const existing = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(req.params.guildId, cmdName);
    if (existing) return res.status(400).json({ error: `La commande /${cmdName} existe déjà` });

    let embed_id = null;
    if (embed_name) {
        const embed = db.prepare('SELECT id FROM embeds WHERE guild_id = ? AND name = ?').get(req.params.guildId, embed_name);
        if (!embed) return res.status(400).json({ error: `Embed "${embed_name}" introuvable` });
        embed_id = embed.id;
    }

    // Absence de champ = 'everyone', le défaut de la colonne et le comportement
    // historique des commandes personnalisées.
    const access = parseAccess(req.body);
    if (access.error) return res.status(400).json({ error: access.error });

    db.prepare('INSERT INTO custom_commands (guild_id, name, response, embed_id, access_mode, access_role_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.params.guildId, cmdName, response || null, embed_id, access.mode, access.roleId);

    // Déployer la commande slash sur Discord — même chemin que `/cmd create`,
    // pour que les deux surfaces posent exactement la même commande.
    await deployCustomCommand(req.params.guildId, cmdName, response || null);

    res.json({ success: true });
});

// Modifier une commande custom — contenu, accès, et/ou nom.
//
// Le renommage passe par un champ `new_name` du corps plutôt que par une route
// dédiée (POST /:name/rename), et ce n'est pas un détail de style : le
// formulaire du dashboard envoie une seule fois « voici l'état voulu »
// (nom + réponse + accès). Deux endpoints, ce serait deux requêtes dont
// l'échec de la seconde laisserait la commande à moitié modifiée — exactement
// l'incohérence que la transaction plus bas existe pour interdire. `:name`
// reste l'identifiant de la ressource, `new_name` fait partie de l'état
// souhaité, au même titre que `response` ou `access_mode`.
//
// Absence de `new_name` = aucun renommage : une modification qui n'envoie pas
// ce champ se comporte exactement comme avant.
router.put('/:name', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    const { response, embed_name } = req.body;

    const existing = db.prepare('SELECT access_mode, access_role_id FROM custom_commands WHERE guild_id = ? AND name = ?')
        .get(req.params.guildId, req.params.name);
    if (!existing) return res.status(404).json({ error: 'Commande introuvable' });

    let embed_id = null;
    if (embed_name) {
        const embed = db.prepare('SELECT id FROM embeds WHERE guild_id = ? AND name = ?').get(req.params.guildId, embed_name);
        if (!embed) return res.status(400).json({ error: `Embed "${embed_name}" introuvable` });
        embed_id = embed.id;
    }

    // Pas de champ d'accès dans le corps = on conserve la configuration en base.
    const access = parseAccess(req.body, effectiveAccessMode(existing.access_mode), existing.access_role_id);
    if (access.error) return res.status(400).json({ error: access.error });

    // ─── Renommage : tout est validé AVANT la moindre écriture ───────────────
    // Le corps n'est jamais digne de confiance : `asText` écarte les objets, les
    // tableaux et les valeurs dont la conversion en texte lèverait une exception,
    // puis le noyau partagé applique la normalisation de la création, la règle de
    // nommage de Discord, les noms réservés par Quasar et les collisions.
    let newName = null;
    if (req.body.new_name !== undefined && req.body.new_name !== null) {
        const brut = asText(req.body.new_name);
        if (brut === null) return res.status(400).json({ error: 'Le nouveau nom doit être du texte.' });

        const verdict = validateCustomCommandRename(db, req.params.guildId, req.params.name, brut);
        if (verdict.error) return res.status(400).json({ error: `${verdict.error.cause} ${verdict.error.action}` });
        // `unchanged` : le nom demandé est déjà celui de la commande. Ce n'est
        // pas une erreur, il n'y a simplement rien à renommer.
        if (!verdict.unchanged) newName = verdict.name;
    }

    const ecriture = updateCustomCommand(db, req.params.guildId, req.params.name, {
        fields: { response: response || null, embed_id, access_mode: access.mode, access_role_id: access.roleId },
        newName,
    });
    if (ecriture.error) {
        // Commande disparue entre la lecture et l'écriture = 404 ; collision
        // apparue entre la validation et la transaction = 400.
        const status = ecriture.error.code === 'INTROUVABLE' ? 404 : 400;
        return res.status(status).json({ error: `${ecriture.error.cause} ${ecriture.error.action}` });
    }

    // Base d'abord, Discord ensuite : le renommage est déjà commité, un échec
    // réseau ici ne l'annule pas. Voir le bloc « ordre des opérations » de
    // bot/commands/customcmd.js.
    let warning = null;
    if (newName) {
        ({ warning } = await syncCustomCommandRename(req.params.guildId, req.params.name, newName, response || null));
    }

    res.json({ success: true, name: ecriture.name, ...(warning ? { warning } : {}) });
});

// Supprimer une commande custom
router.delete('/:name', requireAuth, requireGuildAdmin, async (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?').run(req.params.guildId, req.params.name);

    // Retirer la commande slash de Discord — même chemin que `/cmd delete`.
    await removeCustomCommand(req.params.guildId, req.params.name);

    res.json({ success: true });
});

module.exports = router;
