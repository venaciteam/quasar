// ═══════════════════════════════════════════════════════════════
//  Rétention — Purge des données d'un serveur
//
//  Quand Quasar est retiré d'un serveur, il n'a plus aucune raison de conserver
//  les données de ce serveur : sanctions nominatives, tickets, configurations.
//  Le RGPD (article 5.1.e) impose de ne pas conserver des données personnelles
//  au-delà de ce que la finalité justifie, et la finalité disparaît avec le retrait.
//  La Discord Developer Policy va dans le même sens de façon indirecte (point 15 :
//  ne pas utiliser les données de l'API au-delà de ce qui est nécessaire à la
//  fonctionnalité annoncée) — mais c'est bien le RGPD qui fonde cette purge.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');

// Ligne technique de la table `guilds` : identifiant de l'instance, hérité de la
// migration atom→quasar. Ce n'est pas un serveur Discord, elle ne doit jamais être purgée.
const INSTANCE_ROW_ID = '__quasar_instance_id';

// Ordre imposé par les clés étrangères (`foreign_keys = ON` dans database.js) :
//  - reaction_roles dépend de reaction_panels ;
//  - custom_commands et scheduled_messages référencent embeds(id) SANS ON DELETE CASCADE,
//    ils doivent donc partir AVANT embeds ;
//  - guilds en dernier, tout le reste la référence.
// Modifier cet ordre au petit bonheur casse la purge avec une erreur de contrainte.
const PURGE_STEPS = [
    // Enfant de reaction_panels : supprimé explicitement (plutôt qu'en cascade) pour
    // pouvoir compter les lignes réellement effacées.
    {
        table: 'reaction_roles',
        sql: 'DELETE FROM reaction_roles WHERE panel_id IN (SELECT id FROM reaction_panels WHERE guild_id = ?)',
    },
    { table: 'custom_commands', sql: 'DELETE FROM custom_commands WHERE guild_id = ?' },
    { table: 'scheduled_messages', sql: 'DELETE FROM scheduled_messages WHERE guild_id = ?' },
    { table: 'embeds', sql: 'DELETE FROM embeds WHERE guild_id = ?' },
    { table: 'reaction_panels', sql: 'DELETE FROM reaction_panels WHERE guild_id = ?' },
    { table: 'sanctions', sql: 'DELETE FROM sanctions WHERE guild_id = ?' },
    { table: 'welcome_config', sql: 'DELETE FROM welcome_config WHERE guild_id = ?' },
    { table: 'autoroles', sql: 'DELETE FROM autoroles WHERE guild_id = ?' },
    { table: 'music_config', sql: 'DELETE FROM music_config WHERE guild_id = ?' },
    { table: 'ticket_config', sql: 'DELETE FROM ticket_config WHERE guild_id = ?' },
    { table: 'tickets', sql: 'DELETE FROM tickets WHERE guild_id = ?' },
    { table: 'tempvoice_triggers', sql: 'DELETE FROM tempvoice_triggers WHERE guild_id = ?' },
    { table: 'tempvoice_preferences', sql: 'DELETE FROM tempvoice_preferences WHERE guild_id = ?' },
    { table: 'tempvoice_active', sql: 'DELETE FROM tempvoice_active WHERE guild_id = ?' },
    { table: 'modules', sql: 'DELETE FROM modules WHERE guild_id = ?' },
    { table: 'guilds', sql: 'DELETE FROM guilds WHERE guild_id = ?' },
];

/**
 * Supprime toutes les données d'un serveur, dans toutes les tables qui portent un guild_id.
 * Opération atomique : en cas d'erreur, rien n'est supprimé.
 *
 * @param {string} guildId
 * @returns {{ total: number, perTable: Object<string, number> }}
 */
function purgeGuildData(guildId) {
    if (!guildId || guildId === INSTANCE_ROW_ID) {
        throw new Error(`Refus de purger l'identifiant réservé "${guildId}"`);
    }

    const db = getDb();
    const perTable = {};
    let total = 0;

    const run = db.transaction(() => {
        for (const step of PURGE_STEPS) {
            const result = db.prepare(step.sql).run(guildId);
            if (result.changes > 0) {
                perTable[step.table] = result.changes;
                total += result.changes;
            }
        }
        // La purge accomplie, la demande n'a plus lieu d'être.
        db.prepare('DELETE FROM pending_guild_purges WHERE guild_id = ?').run(guildId);
    });

    run();

    return { total, perTable };
}

/**
 * Programme la purge d'un serveur après le délai de grâce.
 * Idempotent : si une purge est déjà programmée, la date initiale est conservée
 * (un retrait suivi d'un autre retrait ne repousse pas indéfiniment l'échéance).
 *
 * @param {string} guildId
 * @param {number} graceDays — 0 = purge immédiate au prochain passage du job
 */
function schedulePurge(guildId, graceDays) {
    if (!guildId || guildId === INSTANCE_ROW_ID) return null;

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const purgeAfter = now + Math.max(0, graceDays) * 24 * 60 * 60;

    db.prepare(`
        INSERT INTO pending_guild_purges (guild_id, left_at, purge_after)
        VALUES (?, ?, ?)
        ON CONFLICT(guild_id) DO NOTHING
    `).run(guildId, now, purgeAfter);

    return db.prepare('SELECT purge_after FROM pending_guild_purges WHERE guild_id = ?')
        .get(guildId)?.purge_after ?? purgeAfter;
}

/**
 * Annule une purge programmée — le bot a été réinvité avant l'échéance.
 * @returns {boolean} true si une purge était effectivement en attente
 */
function cancelPurge(guildId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM pending_guild_purges WHERE guild_id = ?').run(guildId);
    return result.changes > 0;
}

/**
 * Exécute les purges dont le délai de grâce est écoulé.
 * @returns {Array<{ guildId: string, total: number, perTable: Object }>}
 */
function runDuePurges() {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const due = db.prepare('SELECT guild_id FROM pending_guild_purges WHERE purge_after <= ?').all(now);

    const done = [];
    for (const row of due) {
        try {
            const result = purgeGuildData(row.guild_id);
            done.push({ guildId: row.guild_id, ...result });
        } catch (err) {
            // Une purge qui échoue ne doit pas empêcher les suivantes. L'entrée reste
            // en attente et sera retentée au prochain passage.
            console.error(`[Quasar Rétention] Purge du serveur ${row.guild_id} échouée :`, err.message);
        }
    }
    return done;
}

/**
 * Formate le détail d'une purge pour les logs. Ne journalise que des noms de tables
 * et des compteurs — aucune donnée personnelle (ni user_id, ni motif, ni contenu).
 */
function formatPurgeReport(perTable) {
    const entries = Object.entries(perTable);
    if (entries.length === 0) return 'aucune donnée à supprimer';
    return entries.map(([table, count]) => `${table}=${count}`).join(', ');
}

module.exports = {
    purgeGuildData,
    schedulePurge,
    cancelPurge,
    runDuePurges,
    formatPurgeReport,
    INSTANCE_ROW_ID,
    PURGE_STEPS,
};
