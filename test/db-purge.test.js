// Tests de la purge de serveur (rétention) sur une base jetable en mémoire.
//
// Raison d'être : la table erasure_requests porte une FK vers guilds sans
// ON DELETE CASCADE. Absente de PURGE_STEPS, elle faisait échouer le DELETE
// final de guilds — et donc TOUTE la transaction de purge, rejouée en échec
// toutes les heures, indéfiniment. Le serveur le plus susceptible d'être purgé
// (celui où quelqu'un a exercé son droit à l'effacement) était précisément
// celui qui ne pouvait plus l'être. Ce test reproduit le scénario.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { purgeGuildData, INSTANCE_ROW_ID } = require('../bot/modules/retention/purge');

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

function seedGuild(db, guildId) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(guildId, `Serveur ${guildId}`);
    db.prepare('INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, '333', '444', 'warn', 'test');
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run(guildId, `chan-${guildId}`, '333');
    db.prepare('INSERT INTO modules (guild_id, module_name, enabled) VALUES (?, ?, 1)')
        .run(guildId, 'moderation');
}

test('purge de serveur — avec une demande d\'effacement en attente (le bug FK)', () => {
    const db = getDb();
    seedGuild(db, GUILD_A);
    seedGuild(db, GUILD_B);

    // La ligne qui bloquait tout : une demande art. 17 sur le serveur A.
    db.prepare(`INSERT INTO erasure_requests (guild_id, subject_id, category, requested_at, due_at)
                VALUES (?, ?, 'non_moderation', ?, ?)`)
        .run(GUILD_A, '555', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 2_592_000);

    // Avant le correctif : SQLITE_CONSTRAINT_FOREIGNKEY, transaction annulée.
    const report = purgeGuildData(GUILD_A);
    assert.ok(report.total > 0);

    // Tout le serveur A est parti, y compris la demande elle-même.
    for (const table of ['guilds', 'sanctions', 'tickets', 'modules', 'erasure_requests']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(GUILD_A);
        assert.equal(row.n, 0, `${table} : lignes résiduelles du serveur purgé`);
    }
});

test('purge de serveur — cloisonnement : le serveur B est intact', () => {
    const db = getDb();
    for (const table of ['guilds', 'sanctions', 'tickets', 'modules']) {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(GUILD_B);
        assert.ok(row.n >= 1, `${table} : le serveur B a été touché par la purge du serveur A`);
    }
});

test('purge — refuse l\'identifiant réservé de l\'instance', () => {
    assert.throws(() => purgeGuildData(INSTANCE_ROW_ID));
    assert.throws(() => purgeGuildData(''));
});

test('intégrité référentielle — aucune FK orpheline après purge', () => {
    const db = getDb();
    const violations = db.pragma('foreign_key_check');
    assert.deepEqual(violations, [], 'PRAGMA foreign_key_check remonte des orphelins');
});
