// Fonctions pures des modules de conformité : normalisation de la durée de
// conservation (rétention des sanctions) et backoff des notifications de
// violation. Petites fonctions, mais elles gouvernent des obligations légales —
// leur comportement aux bornes doit être figé.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeRetentionMonths,
    DEFAULT_RETENTION_MONTHS,
    MIN_RETENTION_MONTHS,
    MAX_RETENTION_MONTHS,
} = require('../bot/modules/retention/sanctions');

const { backoffSeconds, MAX_ATTEMPTS } = require('../bot/modules/breach');

test('normalizeRetentionMonths — absence de valeur = défaut', () => {
    assert.equal(normalizeRetentionMonths(undefined), DEFAULT_RETENTION_MONTHS);
    assert.equal(normalizeRetentionMonths(null), DEFAULT_RETENTION_MONTHS);
    assert.equal(normalizeRetentionMonths(''), DEFAULT_RETENTION_MONTHS);
    assert.equal(normalizeRetentionMonths('abc'), DEFAULT_RETENTION_MONTHS);
});

test('normalizeRetentionMonths — 0 et négatif = conservation illimitée (choix explicite)', () => {
    // ⚠️ Comportement assumé par le code mais absent des documents publics
    // (contrat art. 7, PDC §4.9 : « 1 à 120 mois »). Si ce test casse un jour
    // parce que le 0 a été retiré, c'est l'alignement doc/code attendu par
    // l'audit 2026-09-07 — mettre à jour ce test ET les documents ensemble.
    assert.equal(normalizeRetentionMonths(0), 0);
    assert.equal(normalizeRetentionMonths(-5), 0);
    assert.equal(normalizeRetentionMonths('-1'), 0);
});

test('normalizeRetentionMonths — bornage dans [MIN, MAX]', () => {
    assert.equal(normalizeRetentionMonths(1), Math.max(1, MIN_RETENTION_MONTHS));
    assert.equal(normalizeRetentionMonths('24'), 24);
    assert.equal(normalizeRetentionMonths(9999), MAX_RETENTION_MONTHS);
    assert.equal(normalizeRetentionMonths(12.9), 12); // parseInt, pas d'arrondi
});

test('backoffSeconds — exponentiel borné à une heure', () => {
    assert.equal(backoffSeconds(1), 30);
    assert.equal(backoffSeconds(2), 60);
    assert.equal(backoffSeconds(3), 120);
    assert.equal(backoffSeconds(0), 30);   // jamais moins que la base
    assert.equal(backoffSeconds(-3), 30);
    assert.equal(backoffSeconds(20), 3600); // plafond : une heure
    assert.ok(Number.isInteger(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0);
});
