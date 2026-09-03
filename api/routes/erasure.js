// ═══════════════════════════════════════════════════════════════
//  Demandes de suppression — Droit à l'effacement (RGPD art. 17)
//
//  Venacity est sous-traitant (art. 28) : une demande d'effacement est ROUTÉE à
//  l'administrateur responsable du serveur, qui DÉCIDE. Venacity ne fait qu'EXÉCUTER
//  sa décision (art. 28.3.e : assister le responsable, pas se substituer à lui).
//
//  Aucune suppression automatique : rien n'est effacé sans une décision `erase`
//  explicite de l'admin. Un refus (légitime pour une sanction active, art. 21)
//  exige une motivation. La trace de la décision et de sa motivation est TOUJOURS
//  conservée après exécution — seul l'objet des données est supprimé, jamais
//  l'entrée `erasure_requests` qui documente le traitement de la demande.
//
//  Traitement PAR CATÉGORIE, jamais en bloc (cf. règles ci-dessous).
//  Délai légal de réponse : 1 mois (art. 12.3) = 30 jours.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');

const router = express.Router({ mergeParams: true });

// Délai légal de réponse : 1 mois (art. 12.3 RGPD), matérialisé en 30 jours.
const RESPONSE_WINDOW_DAYS = 30;
const RESPONSE_WINDOW_SECONDS = RESPONSE_WINDOW_DAYS * 24 * 60 * 60;

// Catégories de demande valides (cf. colonne `category` de erasure_requests + DA).
const VALID_CATEGORIES = ['active_sanction', 'expired_sanction', 'non_moderation', 'mixed'];

// Statuts pouvant servir de filtre à la liste.
const VALID_STATUSES = ['pending', 'decided', 'executed', 'refused', 'no_response'];

// Horodatage unixepoch en secondes, cohérent avec le reste des colonnes du lot 2.
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ─── Règles d'effacement par catégorie ─────────────────────────────────────────
//
// L'exécution ne supprime QUE les lignes nominatives de `subjectId` dans `guildId`,
// catégorie par catégorie. Les tables et lignes visées sont explicites et limitées.
//
// Sécurité « ban en vigueur » : la colonne `active` de `sanctions` ne suffit pas à
// elle seule à dire qu'un ban court encore (un /unban ne la remet pas à 0 — cf.
// bot/modules/retention/sanctions.js, qui interroge Discord pour trancher). Ici, dans
// une route HTTP, on n'a pas le client Discord sous la main : on applique donc une
// règle DB-only volontairement PRUDENTE — on ne supprime JAMAIS une sanction
// `type = 'ban' AND active = 1`. Dans le doute, on conserve. Toutes les autres
// sanctions (warn / mute / kick, ou bans déjà levés `active = 0`) sont considérées
// comme n'étant plus en vigueur, donc effaçables au titre d'une sanction expirée.

/**
 * Efface les sanctions expirées / levées du membre, en préservant les bans encore
 * en vigueur (`type = 'ban' AND active = 1`).
 * @returns {{ deleted: number, keptActiveBans: number }}
 */
function eraseExpiredSanctions(db, guildId, subjectId) {
    // Bans en vigueur conservés : comptés pour la traçabilité de l'exécution.
    const keptActiveBans = db.prepare(
        "SELECT COUNT(*) AS c FROM sanctions WHERE guild_id = ? AND user_id = ? AND type = 'ban' AND active = 1"
    ).get(guildId, subjectId).c;

    const res = db.prepare(
        "DELETE FROM sanctions WHERE guild_id = ? AND user_id = ? AND NOT (type = 'ban' AND active = 1)"
    ).run(guildId, subjectId);

    return { deleted: res.changes, keptActiveBans };
}

/**
 * Efface les données NOMINATIVES du membre hors modération, dans ce serveur :
 *   - tempvoice_preferences : préférences de salons vocaux temporaires ;
 *   - tickets              : métadonnées des tickets ouverts PAR le membre
 *                            (le contenu des conversations n'est jamais stocké).
 *
 * Volontairement exclus (documenté) :
 *   - tempvoice_active     : état runtime éphémère d'un salon actif (owner_id),
 *                            auto-nettoyé quand le salon se vide ; le supprimer
 *                            orphelinerait un salon vivant.
 *   - scheduled_messages   : `created_by` est l'admin auteur d'une config de
 *                            serveur, pas une donnée « du membre » au sens de la
 *                            demande d'effacement.
 *
 * @returns {Object<string, number>} lignes supprimées par table
 */
function eraseNonModeration(db, guildId, subjectId) {
    const perTable = {};

    const prefs = db.prepare(
        'DELETE FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ?'
    ).run(guildId, subjectId);
    if (prefs.changes > 0) perTable.tempvoice_preferences = prefs.changes;

    const tickets = db.prepare(
        'DELETE FROM tickets WHERE guild_id = ? AND user_id = ?'
    ).run(guildId, subjectId);
    if (tickets.changes > 0) perTable.tickets = tickets.changes;

    return perTable;
}

/**
 * Exécute l'effacement selon la catégorie de la demande.
 *
 * ⚠️ Ne PAS wrapper dans une transaction ici : l'appelant (route) englobe
 *    l'effacement ET la mise à jour du statut dans une seule transaction, pour
 *    garantir qu'on n'efface jamais des données sans tracer l'exécution.
 *
 * @returns {{ total: number, perTable: Object, keptActiveBans: number, warning: string|null }}
 */
function executeErasure(db, guildId, subjectId, category) {
    const perTable = {};
    let keptActiveBans = 0;
    let warning = null;

    let effectiveCategory = category;

    // active_sanction + erase : ne devrait pas arriver sans avoir d'abord levé la
    // sanction. Par sécurité on traite comme expired_sanction — les bans en vigueur
    // restent protégés — et on signale l'écart à l'admin.
    if (category === 'active_sanction') {
        effectiveCategory = 'expired_sanction';
        warning = "Catégorie « sanction active » exécutée comme « sanction expirée » : "
            + "les sanctions encore en vigueur (bans actifs) ont été conservées. "
            + "Pour tout supprimer, lever d'abord la sanction puis relancer l'effacement.";
    }

    if (effectiveCategory === 'expired_sanction' || effectiveCategory === 'mixed') {
        const r = eraseExpiredSanctions(db, guildId, subjectId);
        if (r.deleted > 0) perTable.sanctions = r.deleted;
        keptActiveBans += r.keptActiveBans;
    }

    if (effectiveCategory === 'non_moderation' || effectiveCategory === 'mixed') {
        Object.assign(perTable, eraseNonModeration(db, guildId, subjectId));
    }

    const total = Object.values(perTable).reduce((a, b) => a + b, 0);
    return { total, perTable, keptActiveBans, warning };
}

// ─── Routes ─────────────────────────────────────────────────────────────────────
// Toutes guild-scoped, réservées à l'admin du serveur (requireAuth + requireGuildAdmin).

// GET / — liste des demandes de la guild (toutes, ou filtrées par ?status=…),
// triées par échéance (due_at) croissante : les plus urgentes d'abord.
router.get('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const { status } = req.query;

    let sql = 'SELECT * FROM erasure_requests WHERE guild_id = ?';
    const params = [req.params.guildId];

    if (status) {
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: 'Statut de filtre invalide', valides: VALID_STATUSES });
        }
        sql += ' AND status = ?';
        params.push(status);
    }
    sql += ' ORDER BY due_at ASC';

    res.json(db.prepare(sql).all(...params));
});

// POST / — enregistre une demande reçue (ex. via contact@vena.city). La voie
// /mes-donnees (sous-lot F) insère directement, hors du périmètre de cette route.
router.post('/', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;

    const subjectId = (req.body?.subject_id ?? '').toString().trim();
    const category = (req.body?.category ?? '').toString().trim();
    const details = req.body?.details != null ? String(req.body.details).trim() : '';

    if (!subjectId) {
        return res.status(400).json({ error: 'subject_id requis (identifiant Discord de la personne concernée)' });
    }
    if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'Catégorie invalide', valides: VALID_CATEGORIES });
    }

    const requestedAt = nowSeconds();
    const dueAt = requestedAt + RESPONSE_WINDOW_SECONDS;

    try {
        const info = db.prepare(`
            INSERT INTO erasure_requests
                (guild_id, subject_id, category, details, requested_at, due_at, status, source)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', 'manual')
        `).run(guildId, subjectId, category, details || null, requestedAt, dueAt);

        const row = db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(info.lastInsertRowid);
        res.status(201).json(row);
    } catch (err) {
        // Ex. contrainte FK : guild_id absent de la table `guilds` (serveur non
        // encore initialisé en base). On renvoie une erreur claire plutôt qu'un 500.
        console.error('[Quasar Effacement] Création de demande échouée :', err.message);
        res.status(400).json({ error: "Impossible d'enregistrer la demande pour ce serveur." });
    }
});

// POST /:id/decision — décision de l'admin responsable sur une demande 'pending'.
//   { decision: 'refuse', decision_reason } → refus MOTIVÉ (art. 21). N'efface rien.
//   { decision: 'erase',  decision_reason? } → exécute l'effacement par catégorie.
router.post('/:id/decision', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const guildId = req.params.guildId;
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Identifiant de demande invalide' });
    }

    const decision = (req.body?.decision ?? '').toString().trim();
    const decisionReason = req.body?.decision_reason != null ? String(req.body.decision_reason).trim() : '';

    if (!['erase', 'refuse'].includes(decision)) {
        return res.status(400).json({ error: "Décision invalide (attendu : 'erase' ou 'refuse')" });
    }

    const request = db.prepare('SELECT * FROM erasure_requests WHERE id = ? AND guild_id = ?').get(id, guildId);
    if (!request) {
        return res.status(404).json({ error: 'Demande introuvable pour ce serveur' });
    }
    if (request.status !== 'pending') {
        return res.status(409).json({ error: `Cette demande a déjà été traitée (statut : ${request.status}).` });
    }

    const decidedAt = nowSeconds();

    // ─── Refus (art. 21) : motivation obligatoire, aucune donnée effacée ───
    if (decision === 'refuse') {
        if (!decisionReason) {
            return res.status(400).json({ error: 'Un refus doit être motivé (decision_reason obligatoire).' });
        }
        db.prepare(`
            UPDATE erasure_requests
            SET status = 'refused', decision = 'refuse', decision_reason = ?, decided_by = ?, decided_at = ?
            WHERE id = ?
        `).run(decisionReason, req.user.id, decidedAt, id);

        return res.json(db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(id));
    }

    // ─── Effacement : exécution + traçabilité, atomiquement ───
    // On efface les données ET on marque 'executed' dans une seule transaction :
    // impossible de supprimer des données sans laisser la trace de l'exécution, et
    // inversement. En cas d'erreur, rien n'est supprimé (rollback).
    let report;
    try {
        const runErase = db.transaction(() => {
            const r = executeErasure(db, guildId, request.subject_id, request.category);
            db.prepare(`
                UPDATE erasure_requests
                SET status = 'executed', decision = 'erase', decision_reason = ?,
                    decided_by = ?, decided_at = ?, executed_at = ?
                WHERE id = ?
            `).run(decisionReason || null, req.user.id, decidedAt, decidedAt, id);
            return r;
        });
        report = runErase();
    } catch (err) {
        console.error(`[Quasar Effacement] Exécution échouée (demande #${id}) :`, err.message);
        return res.status(500).json({ error: "L'effacement a échoué, aucune donnée n'a été supprimée." });
    }

    const row = db.prepare('SELECT * FROM erasure_requests WHERE id = ?').get(id);
    // `report` détaille les tables/lignes supprimées + bans conservés + avertissement.
    res.json({ ...row, report });
});

module.exports = router;

// Exportés pour les tests unitaires. La valeur exportée reste le routeur Express
// (mountable tel quel) ; on lui attache seulement des helpers, sans effet de bord.
module.exports.executeErasure = executeErasure;
module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.RESPONSE_WINDOW_DAYS = RESPONSE_WINDOW_DAYS;
