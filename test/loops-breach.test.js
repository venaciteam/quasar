// File des notifications de violation : ordre des écritures.
//
// Le verrou de ré-entrance de ce module existait déjà et servait de modèle aux
// trois autres boucles. Ce qui manquait, c'est l'ordre : le message privé partait
// AVANT le marquage en base. Un arrêt du service entre les deux (redéploiement)
// faisait repartir la notification au redémarrage — une personne recevait deux
// fois l'annonce d'une violation de ses données personnelles.
//
// L'arbitrage retenu ici n'est PAS celui du planificateur : marquer « fait »
// avant l'envoi échangerait le doublon contre un non-envoi silencieux, ce qu'une
// obligation d'information (art. 34) ne permet pas. D'où l'état intermédiaire
// 'sending', qui garde la reprise possible sans la rendre automatique.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { processPending, MAX_ATTEMPTS } = require('../bot/modules/breach');

const GUILD = '111111111111111111';
const ADMIN = '333333333333333333';

const nowSec = () => Math.floor(Date.now() / 1000);

function seedDelivery(db) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
    const incidentId = db.prepare(
        'INSERT INTO breach_incidents (title, created_at, created_by) VALUES (?, ?, ?)'
    ).run('Incident de test', nowSec(), ADMIN).lastInsertRowid;
    const messageId = db.prepare(
        'INSERT INTO breach_messages (incident_id, phase, body, created_at, created_by) VALUES (?, 1, ?, ?, ?)'
    ).run(incidentId, 'Corps de la notification', nowSec(), ADMIN).lastInsertRowid;
    return db.prepare(`
        INSERT INTO breach_deliveries (message_id, guild_id, recipient_id, channel, status, attempts)
        VALUES (?, ?, ?, 'dm', 'pending', 0)
    `).run(messageId, GUILD, ADMIN).lastInsertRowid;
}

/**
 * Adaptateur de plateforme minimal : seul le message privé est nécessaire ici.
 *
 * La boucle reçoit l'ADAPTATEUR depuis la consolidation, plus le client
 * discord.js. Le garde « connexion incomplète » lit `moi.id` — et non plus le
 * cache de serveurs, qui ne distinguait pas « pas encore connecté » de « sur
 * aucun serveur ».
 */
function makeClient(onSend = null) {
    const sends = [];
    return {
        client: {
            moi: { id: '222222222222222222', nom: 'Quasar#0000' },
            api: {
                async ouvrirMessagePrive() { return 'dm-canal'; },
                async envoyerMessage(canalId, contenu) {
                    sends.push(contenu);
                    if (onSend) await onSend();
                    return { id: '1', canalId };
                },
            },
        },
        sends,
    };
}

function delivery(db, id) {
    return db.prepare('SELECT * FROM breach_deliveries WHERE id = ?').get(id);
}

test('envoi nominal : la ligne passe par \'sending\' puis \'sent\'', async () => {
    const db = getDb();
    const id = seedDelivery(db);

    let seenDuringSend = null;
    const { client, sends } = makeClient(() => {
        // Pendant l'envoi, le marquage doit DÉJÀ être en base.
        seenDuringSend = delivery(db, id).status;
    });

    await processPending(client);

    assert.equal(sends.length, 1);
    assert.equal(seenDuringSend, 'sending', 'la ligne doit être marquée avant l\'appel Discord');
    assert.equal(delivery(db, id).status, 'sent');
});

test('arrêt du service pendant l\'envoi : la ligne est déjà \'sending\', jamais restée \'pending\'', async () => {
    const db = getDb();
    const id = seedDelivery(db);

    // L'envoi reste suspendu : c'est l'état exact de la base à l'instant où un
    // SIGTERM tomberait, avant toute écriture postérieure à l'envoi.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client } = makeClient(() => gate);
    const inFlight = processPending(client);
    await new Promise((resolve) => setImmediate(resolve));

    const row = delivery(db, id);
    assert.equal(row.status, 'sending', 'l\'issue est inconnue : surtout pas \'pending\', qui ferait renvoyer');
    assert.equal(row.attempts, 1, 'la tentative est comptée avant l\'envoi, pas après');

    release();
    await inFlight;
});

test('reprise après un arrêt : une ligne \'sending\' trop vieille est retentée, jamais deux fois de suite', async () => {
    const db = getDb();
    const id = seedDelivery(db);
    db.prepare("UPDATE breach_deliveries SET status = 'sending', attempts = 1, last_attempt_at = ? WHERE id = ?")
        .run(nowSec() - 10, id);

    // Trop récente pour être considérée comme interrompue : rien ne bouge.
    const fresh = makeClient();
    await processPending(fresh.client);
    assert.equal(fresh.sends.length, 0, 'un envoi peut-être encore en cours n\'est pas doublé');
    assert.equal(delivery(db, id).status, 'sending');

    // Vieille de plus de STALE_SENDING_S : le doute est tranché en faveur de la
    // personne à informer, avec une trace explicite.
    db.prepare('UPDATE breach_deliveries SET last_attempt_at = ? WHERE id = ?').run(nowSec() - 3600, id);
    const retry = makeClient();
    await processPending(retry.client);

    assert.equal(retry.sends.length, 1, 'la notification est retentée');
    assert.equal(delivery(db, id).status, 'sent');
});

test('reprise épuisée : la ligne est close en échec, avec la mention du doute', async () => {
    const db = getDb();
    const id = seedDelivery(db);
    db.prepare("UPDATE breach_deliveries SET status = 'sending', attempts = ?, last_attempt_at = ? WHERE id = ?")
        .run(MAX_ATTEMPTS, nowSec() - 3600, id);

    const { client, sends } = makeClient();
    await processPending(client);

    const row = delivery(db, id);
    assert.equal(sends.length, 0, 'plus aucune tentative disponible');
    assert.equal(row.status, 'failed');
    assert.match(row.error, /incertain/, 'la traçabilité doit dire que l\'issue est inconnue');
});

test('un traitement lent n\'est pas doublé par le suivant', async () => {
    const db = getDb();
    const id = seedDelivery(db);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, sends } = makeClient(() => gate);

    const slow = processPending(client);
    const second = await processPending(client);
    release();
    await slow;

    assert.equal(second.reentrant, true);
    assert.equal(sends.length, 1);
    assert.equal(delivery(db, id).status, 'sent');
});

test('une exception dans un traitement ne bloque pas la boucle pour toujours', async () => {
    const db = getDb();
    const id = seedDelivery(db);

    const poison = { get moi() { throw new Error('adaptateur indisponible'); } };
    await assert.rejects(() => processPending(poison));

    const { client, sends } = makeClient();
    await processPending(client);
    assert.equal(sends.length, 1, 'le tour suivant doit fonctionner normalement');
    assert.equal(delivery(db, id).status, 'sent');
});
