// ═══════════════════════════════════════════════════════════════
//  Rétention — Durée de conservation des sanctions
//
//  Les sanctions sont des données nominatives (membre visé, modérateur, motif).
//  Le RGPD (article 5.1.e) impose de ne pas les garder indéfiniment. Quasar
//  n'impose pas de durée : c'est l'administrateur du serveur qui est responsable
//  de traitement, à lui de fixer sa durée. Quasar fournit un défaut raisonnable
//  (12 mois) et applique le réglage.
//
//  ⚠️ Cette durée commande AUSSI la fenêtre d'escalade automatique des warns :
//  un warn trop ancien pour être conservé ne peut pas continuer à peser dans le
//  déclenchement d'un auto-kick ou d'un auto-ban. Les deux notions sont tenues
//  ensemble pour rester compréhensibles — un seul réglage, pas deux.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');

const DEFAULT_RETENTION_MONTHS = 12;

// Un timeout Discord ne peut pas dépasser 28 jours. En imposant au moins un mois de
// conservation, on garantit qu'une sanction hors fenêtre a forcément cessé de produire
// ses effets — sauf les bans, qui sont vérifiés séparément auprès de Discord.
const MIN_RETENTION_MONTHS = 1;
const MAX_RETENTION_MONTHS = 120;

/**
 * Normalise une valeur de rétention saisie par un administrateur.
 * @returns {number} nombre de mois, ou 0 pour « conservation sans limite »
 */
function normalizeRetentionMonths(value) {
    if (value === null || value === undefined || value === '') return DEFAULT_RETENTION_MONTHS;

    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_RETENTION_MONTHS;
    if (parsed <= 0) return 0; // 0 = purge désactivée, choix explicite de l'admin
    return Math.min(Math.max(parsed, MIN_RETENTION_MONTHS), MAX_RETENTION_MONTHS);
}

/**
 * Durée de conservation des sanctions pour un serveur, en mois. 0 = illimitée.
 */
function getRetentionMonths(guildId) {
    try {
        const db = getDb();
        const mod = db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = ?')
            .get(guildId, 'moderation');
        if (!mod) return DEFAULT_RETENTION_MONTHS;

        const config = JSON.parse(mod.config || '{}');
        return normalizeRetentionMonths(config.sanctionRetentionMonths);
    } catch {
        return DEFAULT_RETENTION_MONTHS;
    }
}

/**
 * Compte les avertissements d'un membre qui pèsent encore dans l'escalade automatique.
 * Bornée par la durée de conservation du serveur : au-delà, le warn n'existe plus,
 * il ne peut donc pas déclencher de sanction.
 */
function countWarnsInEscalationWindow(guildId, userId) {
    const db = getDb();
    const months = getRetentionMonths(guildId);

    if (months === 0) {
        // Conservation illimitée : comptage sur tout l'historique (comportement d'origine).
        return db.prepare(`
            SELECT COUNT(*) AS count FROM sanctions
            WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1
        `).get(guildId, userId).count;
    }

    return db.prepare(`
        SELECT COUNT(*) AS count FROM sanctions
        WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1
          AND created_at >= datetime('now', ?)
    `).get(guildId, userId, `-${months} months`).count;
}

/**
 * Le bannissement d'une personne produit-il encore ses effets ?
 *
 * La colonne `active` de la table ne le dit PAS : `/unban` ne la remet pas à 0.
 * La seule source fiable est la plateforme.
 *
 * ⚠️ Trois issues, et la troisième est celle qui compte : `null` signifie « je
 * ne sais pas » — permission « Bannir des membres » absente, API injoignable —
 * et dans ce cas la sanction est CONSERVÉE. Confondre « je ne sais pas » et
 * « plus bannie » effacerait la trace d'un bannissement en vigueur.
 *
 * Le plafond de 1000 entrées par requête, qui faisait renoncer la lecture en
 * bloc, n'a plus d'objet : la question est posée personne par personne.
 *
 * @returns {Promise<boolean|null>} true = encore banni, false = ne l'est plus,
 *   null = indéterminable.
 */
async function banEncoreActif(api, guildeId, utilisateurId) {
    try {
        return (await api.obtenirBannissement(guildeId, utilisateurId)) !== null;
    } catch {
        return null;
    }
}

/**
 * Supprime les sanctions d'un serveur qui ont dépassé sa durée de conservation.
 * Les bannissements encore en vigueur sont préservés : ils produisent leurs effets.
 *
 * @param {string} guildeId
 * @param {object} api  client REST normalisé (`adaptateur.api`)
 * @returns {Promise<{ deleted: number, keptActiveBans: number, skipped: string|null }>}
 */
async function purgeGuildSanctions(guildeId, api) {
    const db = getDb();
    const months = getRetentionMonths(guildeId);

    if (months === 0) {
        return { deleted: 0, keptActiveBans: 0, skipped: 'conservation illimitée (réglage du serveur)' };
    }

    const cutoff = `-${months} months`;
    const candidates = db.prepare(`
        SELECT id, type, user_id FROM sanctions
        WHERE guild_id = ? AND created_at < datetime('now', ?)
    `).all(guildeId, cutoff);

    if (candidates.length === 0) {
        return { deleted: 0, keptActiveBans: 0, skipped: null };
    }

    // Une seule question par PERSONNE, pas par sanction : plusieurs bans échus
    // d'un même compte ne valent pas plusieurs appels.
    const aVerifier = [...new Set(candidates.filter(s => s.type === 'ban').map(s => s.user_id))];
    const verdicts = new Map();
    for (const userId of aVerifier) {
        verdicts.set(userId, await banEncoreActif(api, guildeId, userId));
    }

    const toDelete = [];
    let keptActiveBans = 0;

    for (const sanction of candidates) {
        if (sanction.type === 'ban') {
            const encoreBanni = verdicts.get(sanction.user_id);
            // `null` (indéterminable) et `true` (banni) conservent tous les deux.
            if (encoreBanni !== false) {
                keptActiveBans++;
                continue;
            }
        }
        toDelete.push(sanction.id);
    }

    if (toDelete.length === 0) {
        return { deleted: 0, keptActiveBans, skipped: null };
    }

    const remove = db.prepare('DELETE FROM sanctions WHERE id = ?');
    const runAll = db.transaction((ids) => {
        for (const id of ids) remove.run(id);
    });
    runAll(toDelete);

    return { deleted: toDelete.length, keptActiveBans, skipped: null };
}

/**
 * Applique la rétention des sanctions sur tous les serveurs où le bot est présent.
 *
 * @param {object} adaptateur  adaptateur de plateforme
 */
async function purgeAllSanctions(adaptateur) {
    const api = adaptateur?.api;
    if (!api) return [];

    // `listerGuildes()` rend `null` quand la connexion n'est pas établie : on ne
    // purge alors RIEN. `[]` veut dire « connecté, aucun serveur ».
    const guildes = await api.listerGuildes().catch(() => null);
    if (!guildes) return [];

    const results = [];
    for (const guildeId of guildes) {
        try {
            const result = await purgeGuildSanctions(guildeId, api);
            if (result.deleted > 0 || result.keptActiveBans > 0) {
                results.push({ guildId: guildeId, ...result });
            }
        } catch (err) {
            console.error(`[Quasar Rétention] Purge des sanctions du serveur ${guildeId} échouée :`, err.message);
        }
    }
    return results;
}

module.exports = {
    DEFAULT_RETENTION_MONTHS,
    MIN_RETENTION_MONTHS,
    MAX_RETENTION_MONTHS,
    normalizeRetentionMonths,
    getRetentionMonths,
    countWarnsInEscalationWindow,
    banEncoreActif,
    purgeGuildSanctions,
    purgeAllSanctions,
};
