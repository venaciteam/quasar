// Tests de computeNextRun (bot/modules/scheduler) — le calcul des échéances,
// avec un « maintenant » figé pour rester déterministe quel que soit le moment
// où la suite tourne. Les cas weekly multi-jours ne sont pas couverts ici :
// leur convention de numérotation des jours mérite d'être figée dans un test
// dédié, écrit en regard du dashboard qui produit schedule_days.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeNextRun, isValidTimezone, DEFAULT_TIMEZONE } = require('../bot/modules/scheduler');

// Jeudi 15 janvier 2026, 12:00 UTC — soit 13:00 à Paris (heure d'hiver, UTC+1).
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

test('isValidTimezone', () => {
    assert.equal(isValidTimezone('Europe/Paris'), true);
    assert.equal(isValidTimezone('America/New_York'), true);
    assert.equal(isValidTimezone('Mars/Olympus'), false);
    assert.equal(isValidTimezone(''), false);
});

test('once — dans le futur : l\'instant exact en zone', () => {
    const t = computeNextRun(
        { schedule_type: 'once', schedule_date: '2026-01-20', schedule_time: '10:00' },
        NOW, 'Europe/Paris'
    );
    // 10:00 à Paris en janvier = 09:00 UTC.
    assert.equal(t, Date.UTC(2026, 0, 20, 9, 0));
});

test('once — déjà passé : null, jamais de rattrapage', () => {
    const t = computeNextRun(
        { schedule_type: 'once', schedule_date: '2026-01-10', schedule_time: '10:00' },
        NOW, 'Europe/Paris'
    );
    assert.equal(t, null);
});

test('daily — l\'heure n\'est pas encore passée aujourd\'hui', () => {
    const t = computeNextRun(
        { schedule_type: 'daily', schedule_time: '14:00' },
        NOW, 'Europe/Paris'
    );
    // 14:00 Paris aujourd'hui = 13:00 UTC le 15.
    assert.equal(t, Date.UTC(2026, 0, 15, 13, 0));
});

test('daily — l\'heure est passée : demain', () => {
    const t = computeNextRun(
        { schedule_type: 'daily', schedule_time: '10:00' },
        NOW, 'Europe/Paris'
    );
    assert.equal(t, Date.UTC(2026, 0, 16, 9, 0));
});

test('entrées invalides — null plutôt qu\'une échéance devinée', () => {
    assert.equal(computeNextRun({ schedule_type: 'daily', schedule_time: '9:00' }, NOW), null);
    assert.equal(computeNextRun({ schedule_type: 'daily', schedule_time: null }, NOW), null);
    assert.equal(computeNextRun({ schedule_type: 'once', schedule_time: '10:00' }, NOW), null);
    assert.equal(computeNextRun(
        { schedule_type: 'once', schedule_date: '20/01/2026', schedule_time: '10:00' }, NOW
    ), null);
});

test('fuseau invalide — repli silencieux sur la zone par défaut', () => {
    const row = { schedule_type: 'daily', schedule_time: '14:00' };
    assert.equal(
        computeNextRun(row, NOW, 'Mars/Olympus'),
        computeNextRun(row, NOW, DEFAULT_TIMEZONE)
    );
});
