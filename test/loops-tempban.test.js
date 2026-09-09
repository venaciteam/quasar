// Balayage des bannissements temporaires : ré-entrance et ordre des écritures.
//
// Un tour doublé, c'est une seconde tentative de débannissement et surtout un
// second message « Fin de bannissement temporaire » dans le salon de logs.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { sweepExpiredBans } = require('../bot/utils/punishments');

const GUILD = '111111111111111111';
const USER = '333333333333333333';
const LOG_CHANNEL = '999999999999999999';

const nowSec = () => Math.floor(Date.now() / 1000);

function seedGuild(db) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
    db.prepare(`
        INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
        ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
    `).run(GUILD, JSON.stringify({ logChannel: LOG_CHANNEL }));
}

function seedTempBan(db) {
    db.prepare(`
        INSERT INTO temp_bans (guild_id, user_id, expires_at, reason, source)
        VALUES (?, ?, ?, 'test', 'automod')
        ON CONFLICT(guild_id, user_id) DO UPDATE SET expires_at = excluded.expires_at
    `).run(GUILD, USER, nowSec() - 5);
}

/**
 * Client Discord minimal. `onUnban` permet de bloquer ou de faire échouer la
 * levée, `onLog` l'envoi du message de fin de bannissement.
 */
function makeClient({ onUnban = null, onLog = null } = {}) {
    const unbans = [];
    const logs = [];
    const logChannel = {
        send: async (payload) => {
            logs.push(payload);
            if (onLog) await onLog();
        },
    };
    const guild = {
        id: GUILD,
        channels: { cache: new Map([[LOG_CHANNEL, logChannel]]) },
        bans: {
            remove: async (userId, reason) => {
                unbans.push({ userId, reason });
                if (onUnban) await onUnban();
            },
        },
    };
    return { client: { guilds: { cache: new Map([[GUILD, guild]]) } }, unbans, logs };
}

function banRow(db) {
    return db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(GUILD, USER);
}

test('un balayage lent n\'est pas doublé par le suivant', async () => {
    const db = getDb();
    seedGuild(db);
    seedTempBan(db);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, unbans, logs } = makeClient({ onUnban: () => gate });

    const slow = sweepExpiredBans(client);
    await sweepExpiredBans(client);
    release();
    await slow;

    assert.equal(unbans.length, 1, 'un seul débannissement');
    assert.equal(logs.length, 1, 'un seul message de fin de bannissement');
    assert.equal(banRow(db), undefined);
});

test('l\'échéance est supprimée AVANT le message : un arrêt du service ne le reposte pas', async () => {
    const db = getDb();
    seedGuild(db);
    seedTempBan(db);

    // Le message de log n'aboutit pas : équivalent observable d'un processus tué
    // juste après la levée.
    const dead = makeClient({ onLog: () => { throw new Error('service arrêté'); } });
    await sweepExpiredBans(dead.client);
    assert.equal(dead.unbans.length, 1);
    assert.equal(banRow(db), undefined, 'la ligne doit être supprimée avant le message');

    const restarted = makeClient();
    await sweepExpiredBans(restarted.client);
    assert.equal(restarted.unbans.length, 0, 'aucune seconde levée après un redémarrage');
    assert.equal(restarted.logs.length, 0, 'aucun second message de fin de bannissement');
});

test('permission manquante : l\'échéance est conservée pour une nouvelle tentative', async () => {
    const db = getDb();
    seedGuild(db);
    seedTempBan(db);

    const denied = makeClient({
        onUnban: () => { const e = new Error('Missing Permissions'); e.code = 50013; throw e; },
    });
    await sweepExpiredBans(denied.client);

    assert.ok(banRow(db), 'un bannissement non levé doit rester en base');
    assert.equal(denied.logs.length, 0, 'pas de message de fin si rien n\'a été levé');

    const ok = makeClient();
    await sweepExpiredBans(ok.client);
    assert.equal(banRow(db), undefined);
    assert.equal(ok.logs.length, 1);
});

test('une exception dans un balayage ne bloque pas la boucle pour toujours', async () => {
    const db = getDb();
    seedGuild(db);
    seedTempBan(db);

    const poison = { get guilds() { throw new Error('cache indisponible'); } };
    await assert.rejects(() => sweepExpiredBans(poison));

    const { client, unbans } = makeClient();
    await sweepExpiredBans(client);
    assert.equal(unbans.length, 1, 'le balayage suivant doit fonctionner normalement');
});

test('connexion incomplète : aucune échéance supprimée', async () => {
    const db = getDb();
    seedGuild(db);
    seedTempBan(db);

    // Sans garde-fou, la ligne serait supprimée comme si le bot avait été retiré
    // du serveur : le bannissement temporaire deviendrait définitif.
    await sweepExpiredBans({ guilds: { cache: new Map() } });
    assert.ok(banRow(db), 'l\'échéance doit survivre à une connexion incomplète');
});
