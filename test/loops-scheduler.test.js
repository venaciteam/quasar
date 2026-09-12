// Boucle des rappels programmés : ré-entrance et ordre des écritures.
//
// Le défaut couvert ici a une conséquence très visible : le tick est de 60 s et
// `next_run` n'était avancé qu'APRÈS l'envoi. Quarante rappels réglés à la même
// heure, une limitation de débit Discord, et le tour dépasse la minute : le tick
// suivant relisait les mêmes lignes et renvoyait les mêmes messages, mentions
// @everyone comprises. Deux protections sont vérifiées séparément, parce
// qu'elles couvrent deux fenêtres différentes : le verrou ne vaut que dans un
// processus, l'ordre des écritures survit à un SIGTERM (redéploiement).
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { runDueMessages } = require('../bot/modules/scheduler');

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

const nowSec = () => Math.floor(Date.now() / 1000);

function seedGuild(db) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
}

/** Insère un rappel déjà dû. Renvoie son identifiant. */
function seedReminder(db, { type = 'daily', time = '12:00', date = null } = {}) {
    return db.prepare(`
        INSERT INTO scheduled_messages
            (guild_id, name, channel_id, content_type, content_text,
             mention_everyone, schedule_type, schedule_time, schedule_date, next_run, enabled)
        VALUES (?, ?, ?, 'text', ?, 1, ?, ?, ?, ?, 1)
    `).run(GUILD, 'Rappel de test', CHANNEL, 'Le message du rappel', type, time, date, nowSec() - 10).lastInsertRowid;
}

/**
 * Adaptateur de plateforme minimal. `onSend` permet de bloquer ou de faire
 * échouer l'envoi pour reproduire un tour lent ou un arrêt du service en plein
 * envoi.
 *
 * Le planificateur reçoit l'ADAPTATEUR depuis la consolidation, plus le client
 * discord.js : il poste par le client REST normalisé, et son garde « connexion
 * incomplète » lit `moi.id`.
 */
function makeClient(onSend = null) {
    const sends = [];
    return {
        client: {
            moi: { id: '222222222222222222', nom: 'Quasar#0000' },
            api: {
                async obtenirCanal(id) { return id === CHANNEL ? { id, nom: 'salon', type: 'texte' } : null; },
                async envoyerMessage(canalId, corps) {
                    sends.push(corps);
                    if (onSend) await onSend();
                    return { id: '1', canalId };
                },
            },
        },
        sends,
    };
}

function getRow(db, id) {
    return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}

test('un tour lent n\'est pas doublé par le suivant', async () => {
    const db = getDb();
    seedGuild(db);
    const id = seedReminder(db);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { client, sends } = makeClient(() => gate);

    const slow = runDueMessages(client);          // reste bloqué dans l'envoi
    const second = await runDueMessages(client);  // le tick suivant, pendant ce temps
    release();
    await slow;

    assert.equal(second.reentrant, true, 'le tick suivant doit repartir immédiatement');
    assert.equal(sends.length, 1, 'le rappel ne doit partir qu\'une seule fois');
    assert.ok(getRow(db, id).next_run > nowSec(), 'l\'échéance doit avoir été avancée');
});

test('l\'échéance est écrite AVANT l\'envoi : un arrêt du service ne fait pas repartir le rappel', async () => {
    const db = getDb();
    seedGuild(db);
    const id = seedReminder(db);

    // Envoi qui n'aboutit pas : c'est l'équivalent observable d'un processus tué
    // entre l'écriture et la remise du message à Discord.
    const dead = makeClient(() => { throw new Error('service arrêté en plein envoi'); });
    await runDueMessages(dead.client);
    assert.equal(dead.sends.length, 1);

    const after = getRow(db, id);
    assert.ok(after.next_run > nowSec(), 'l\'échéance doit être avancée même quand l\'envoi échoue');

    // Redémarrage : la boucle repart, la ligne ne doit plus être due.
    const restarted = makeClient();
    await runDueMessages(restarted.client);
    assert.equal(restarted.sends.length, 0, 'aucun renvoi après un redémarrage');
});

test('une exception dans un tour ne bloque pas la boucle pour toujours', async () => {
    const db = getDb();
    seedGuild(db);
    seedReminder(db);

    // Adaptateur dont la simple lecture explose : l'exception traverse la boucle.
    const poison = { get moi() { throw new Error('adaptateur indisponible'); } };
    await assert.rejects(() => runDueMessages(poison));

    // Le verrou doit avoir été relâché par le finally.
    const { client, sends } = makeClient();
    await runDueMessages(client);
    assert.equal(sends.length, 1, 'le tour suivant doit fonctionner normalement');
});

test('rappel « une seule fois » : désactivé avant l\'envoi, jamais rejoué', async () => {
    const db = getDb();
    seedGuild(db);
    const id = seedReminder(db, { type: 'once', date: '2020-01-01' });

    const { client, sends } = makeClient();
    await runDueMessages(client);
    assert.equal(sends.length, 1);

    const after = getRow(db, id);
    assert.equal(after.enabled, 0);
    assert.equal(after.next_run, null);

    await runDueMessages(client);
    assert.equal(sends.length, 1, 'un rappel ponctuel ne repart jamais');
});

test('connexion incomplète : aucun rappel consommé', async () => {
    const db = getDb();
    seedGuild(db);
    const id = seedReminder(db);
    const before = getRow(db, id).next_run;

    // Identité du bot inconnue : la connexion n'est pas faite.
    await runDueMessages({ moi: { id: null }, api: {} });

    assert.equal(getRow(db, id).next_run, before, 'l\'échéance ne doit pas bouger');
});

test('le fuseau du serveur est respecté au recalcul de l\'échéance, pas seulement au démarrage', async () => {
    // Bug préexistant, hors du finding traité ici et absent de l'audit :
    // `start()` passait le fuseau du serveur à computeNextRun, le tick non. Un
    // rappel récurrent sur un serveur hors Europe/Paris était donc posé à la
    // bonne heure au démarrage, puis recalculé en heure de Paris dès son premier
    // déclenchement. Le réglage « fuseau par serveur » ne tenait pas au-delà de
    // la première occurrence.
    const db = getDb();
    seedGuild(db);
    // Onze heures d'écart avec Paris : impossible de confondre les deux.
    db.prepare('UPDATE guilds SET timezone = ? WHERE guild_id = ?').run('Pacific/Auckland', GUILD);

    const id = seedReminder(db, { type: 'daily', time: '12:00' });
    const { client } = makeClient();
    await runDueMessages(client);

    const prochaine = getRow(db, id).next_run;
    assert.ok(prochaine > nowSec(), 'une échéance doit avoir été recalculée');

    // On relit l'heure locale de la nouvelle échéance DANS le fuseau du serveur :
    // elle doit retomber sur 12:00 là-bas, pas à Paris.
    const heureLocale = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(prochaine * 1000));
    assert.equal(heureLocale, '12:00', `échéance recalculée à ${heureLocale} heure locale du serveur`);
});
