// Balayage des modes panique : ré-entrance et ordre des écritures.
//
// Le tick est de 15 s et une levée fait des appels réseau : la fenêtre de
// recouvrement est quatre fois plus large que celle du planificateur. Deux
// levées de la même ligne, c'est un second message « Mode panique levé » dans le
// salon de logs de modération.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { sweepExpiredPanics, liftPanic } = require('../bot/modules/antiraid/panic');

const GUILD = '111111111111111111';
const LOG_CHANNEL = '999999999999999999';

const nowSec = () => Math.floor(Date.now() / 1000);

function seedGuild(db) {
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
    // Salon de logs configuré : sans lui, le message de levée ne partirait nulle
    // part et le test ne prouverait rien.
    db.prepare(`
        INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
        ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
    `).run(GUILD, JSON.stringify({ logChannel: LOG_CHANNEL }));
}

function seedPanic(db, method = 'incident_actions') {
    db.prepare(`
        INSERT INTO antiraid_panic (guild_id, method, expires_at, previous_invites_disabled, reason)
        VALUES (?, ?, ?, 0, 'test')
        ON CONFLICT(guild_id) DO UPDATE SET
            method = excluded.method, expires_at = excluded.expires_at
    `).run(GUILD, method, nowSec() - 5);
}

/**
 * Adaptateur de plateforme minimal — la seule forme que ce module accepte
 * depuis que sa voie `Guild` discord.js est tombée (lot 7). `onLift` permet de
 * bloquer ou de faire échouer la levée, `onLog` l'envoi du message de levée.
 *
 * `portee` est ce que la route du dashboard passe pour une levée MANUELLE :
 * `{ guildeId, api, moiId, capacites }`, la portée neutre de bot/utils/errors.js.
 */
function makeClient({ onLift = null, onLog = null, guildes = [GUILD] } = {}) {
    const lifts = [];
    const logs = [];

    const api = {
        async envoyerMessage(canalId, contenu) {
            logs.push({ canalId, contenu });
            if (onLog) await onLog();
            return { id: '1' };
        },
        async mettreInvitationsEnPause(guildeId, jusquA, raison) {
            lifts.push({ guildeId, jusquA, raison });
            if (onLift) await onLift();
            return jusquA === null ? 'levee' : 'incident';
        },
        async obtenirEtatInvitations() {
            return { enPauseJusqua: null, desactiveesEnDur: false };
        },
        async obtenirMembre() {
            return { id: 'moi', aPermission: () => true };
        },
        async listerGuildes() {
            return guildes;
        },
    };

    const client = {
        nom: 'test',
        capacites: { pauseInvitations: true },
        moi: { id: 'moi' },
        api,
    };
    const portee = { guildeId: GUILD, api, moiId: 'moi', capacites: client.capacites };

    return { client, portee, lifts, logs };
}

function panicRow(db) {
    return db.prepare('SELECT * FROM antiraid_panic WHERE guild_id = ?').get(GUILD);
}

test('un balayage lent n\'est pas doublé par le suivant', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db);

    let release;
    let signalerEntree;
    const gate = new Promise((resolve) => { release = resolve; });
    const entree = new Promise((resolve) => { signalerEntree = resolve; });
    const { client, lifts, logs } = makeClient({
        onLift: () => { signalerEntree(); return gate; },
    });

    const slow = sweepExpiredPanics(client);
    // Le second tour ne doit partir qu'une fois le premier ENGAGÉ : c'est le
    // verrou de ré-entrance qu'on éprouve, pas l'ordonnancement des promesses.
    await entree;
    await sweepExpiredPanics(client);
    release();
    await slow;

    assert.equal(lifts.length, 1, 'une seule levée');
    assert.equal(logs.length, 1, 'un seul message de levée');
    assert.equal(panicRow(db), undefined);
});

test('une levée manuelle simultanée ne produit pas un second message', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db);

    let release;
    let signalerEntree;
    const gate = new Promise((resolve) => { release = resolve; });
    // Le balayage doit tenir le verrou AVANT que la levée manuelle ne parte,
    // sinon les deux s'attendent : `listerGuildes` est asynchrone, la course
    // n'est plus décidée par l'ordre des lignes.
    const entree = new Promise((resolve) => { signalerEntree = resolve; });
    const { client, portee, lifts, logs } = makeClient({
        onLift: () => { signalerEntree(); return gate; },
    });

    const sweeping = sweepExpiredPanics(client);
    await entree;
    const manual = await liftPanic(portee, { liftedBy: '424242424242424242' });
    release();
    await sweeping;

    assert.equal(manual.skipped, 'in_progress');
    assert.equal(lifts.length, 1);
    assert.equal(logs.length, 1);
});

test('l\'échéance est supprimée AVANT l\'appel : un arrêt du service ne reposte pas la levée', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db);

    // La levée n'aboutit pas : équivalent observable d'un processus tué pendant
    // l'appel à Discord. L'échéance native étant tenue par Discord, la ligne a
    // déjà été retirée.
    const dead = makeClient({ onLift: () => { throw new Error('service arrêté'); } });
    await sweepExpiredPanics(dead.client);
    assert.equal(panicRow(db), undefined, 'la ligne doit avoir été retirée avant l\'appel');

    const restarted = makeClient();
    await sweepExpiredPanics(restarted.client);
    assert.equal(restarted.logs.length, 0, 'aucun second message de levée après un redémarrage');
});

test('repli INVITES_DISABLED : la ligne est conservée tant que la levée échoue', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db, 'invites_disabled');

    const failing = makeClient({ onLift: () => { throw new Error('permission manquante'); } });
    await sweepExpiredPanics(failing.client);

    // Personne d'autre que le bot ne rouvrira les invitations : la reprise prime
    // sur le risque de doublon, la ligne reste.
    assert.ok(panicRow(db), 'l\'échéance doit rester pour une nouvelle tentative');
    assert.equal(failing.logs.length, 0, 'pas de message de levée si rien n\'a été levé');

    const ok = makeClient();
    await sweepExpiredPanics(ok.client);
    assert.equal(panicRow(db), undefined);
    assert.equal(ok.logs.length, 1);
});

test('une exception dans un balayage ne bloque pas la boucle pour toujours', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db);

    // Le client REST lève : c'est l'équivalent exact d'un cache illisible sur
    // l'ancienne voie — la question « quels serveurs ? » n'a pas de réponse.
    const poison = {
        capacites: { pauseInvitations: true },
        api: {
            envoyerMessage: async () => ({ id: '1' }),
            listerGuildes: async () => { throw new Error('passerelle indisponible'); },
        },
    };
    await assert.rejects(() => sweepExpiredPanics(poison));

    const { client, lifts } = makeClient();
    await sweepExpiredPanics(client);
    assert.equal(lifts.length, 1, 'le balayage suivant doit fonctionner normalement');
});

test('connexion incomplète : aucune échéance supprimée', async () => {
    const db = getDb();
    seedGuild(db);
    seedPanic(db);

    // `listerGuildes()` rend `null` : le bot n'a pas fini de se connecter, la
    // liste est INDÉTERMINABLE. Sans garde-fou, la ligne serait supprimée comme
    // si le bot avait été retiré du serveur, et un repli INVITES_DISABLED ne
    // serait jamais levé. `[]`, lui, veut dire « connecté, aucun serveur ».
    const { client } = makeClient({ guildes: null });
    await sweepExpiredPanics(client);
    assert.ok(panicRow(db), 'l\'échéance doit survivre à une connexion incomplète');
});
