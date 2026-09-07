// Tests de la grammaire des punitions composables (bot/utils/punishments.js).
// C'est la logique la plus dupliquée du projet (3 copies navigateur dans les
// pages automod du dashboard) : cette suite fige le comportement de référence,
// celui du serveur, qui fait autorité.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseDuration,
    formatDuration,
    parsePunishments,
    validatePunishments,
    stringifyPunishments,
} = require('../bot/utils/punishments');

test('parseDuration — unités simples et composées', () => {
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('20m'), 20 * 60_000);
    assert.equal(parseDuration('3h42m'), (3 * 60 + 42) * 60_000);
    assert.equal(parseDuration('1w2d'), 9 * 24 * 60 * 60_000);
    // « j » (jours) accepté : compat avec le /mute historique.
    assert.equal(parseDuration('2j'), parseDuration('2d'));
    // Les espaces internes sont tolérés (la saisie « 1 d » vaut « 1d »).
    assert.equal(parseDuration('1 d'), 24 * 60 * 60_000);
});

test('parseDuration — refus des entrées invalides', () => {
    // La chaîne doit être INTÉGRALEMENT composée de paires nombre+unité :
    // « 20mn » ou « 5 bananes » ne doivent pas passer en ne lisant que le début.
    assert.equal(parseDuration('20mn'), null);
    assert.equal(parseDuration('5 bananes'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('   '), null);
    assert.equal(parseDuration('m'), null);
    assert.equal(parseDuration('0s'), null); // un total nul n'est pas une durée
    assert.equal(parseDuration(42), null); // pas une chaîne
    assert.equal(parseDuration(null), null);
    // Au-delà du plafond (10 ans) : refusé, pas tronqué.
    assert.equal(parseDuration('11y'), null); // unité inconnue de toute façon
    assert.equal(parseDuration('4000d'), null);
});

test('formatDuration — forme compacte et bornes', () => {
    assert.equal(formatDuration(24 * 60 * 60_000 + 60 * 60_000 + 60_000 + 1000), '1d1h1m1s');
    assert.equal(formatDuration(20 * 60_000), '20m');
    assert.equal(formatDuration(0), '');
    assert.equal(formatDuration(-5), '');
    assert.equal(formatDuration(NaN), '');
    // Moins d'une seconde : plancher explicite, pas une chaîne vide.
    assert.equal(formatDuration(500), '0s');
});

test('parseDuration/formatDuration — aller-retour stable', () => {
    for (const s of ['30s', '20m', '3h42m', '7d', '1w2d']) {
        const ms = parseDuration(s);
        assert.equal(parseDuration(formatDuration(ms)), ms, `aller-retour cassé pour « ${s} »`);
    }
});

test('parsePunishments — chaîne nominale', () => {
    const { punishments, errors } = parsePunishments('delete, tempmute 20m, defer');
    assert.deepEqual(errors, []);
    assert.deepEqual(punishments, [
        { action: 'delete' },
        { action: 'tempmute', durationMs: 20 * 60_000 },
        { action: 'defer' },
    ]);
});

test('parsePunishments — ne lève jamais, décrit les fautes', () => {
    // Action inconnue : écartée avec explication, le reste survit.
    let r = parsePunishments('frapper, ban');
    assert.equal(r.punishments.length, 1);
    assert.equal(r.punishments[0].action, 'ban');
    assert.equal(r.errors.length, 1);

    // Durée manquante sur une action qui l'exige.
    r = parsePunishments('tempmute');
    assert.equal(r.punishments.length, 0);
    assert.equal(r.errors.length, 1);

    // Durée invalide.
    r = parsePunishments('tempban 3 bananes');
    assert.equal(r.punishments.length, 0);
    assert.equal(r.errors.length, 1);

    // Durée fournie à une action qui n'en prend pas : signalée, action gardée.
    r = parsePunishments('ban 3d');
    assert.equal(r.punishments.length, 1);
    assert.equal(r.punishments[0].action, 'ban');
    assert.equal(r.punishments[0].durationMs, undefined);
    assert.equal(r.errors.length, 1);

    // Doublon : première occurrence gardée, doublon signalé.
    r = parsePunishments('warn, warn');
    assert.equal(r.punishments.length, 1);
    assert.equal(r.errors.length, 1);

    // Entrées non-chaîne : erreur décrite, jamais d'exception.
    assert.equal(parsePunishments(42).errors.length, 1);
    assert.deepEqual(parsePunishments(null), { punishments: [], errors: [] });
    assert.deepEqual(parsePunishments(undefined), { punishments: [], errors: [] });
});

test('validatePunishments — la chaîne vide est le mode « alerte seule »', () => {
    assert.equal(validatePunishments('').valid, true);
    assert.equal(validatePunishments('   ').valid, true);
    // Une chaîne non vide qui ne produit rien n'a rien de valide.
    assert.equal(validatePunishments(', ,').valid, false);
    assert.equal(validatePunishments('delete, tempmute 20m').valid, true);
    assert.equal(validatePunishments('frapper').valid, false);
});

test('stringifyPunishments — reconstruit la forme canonique', () => {
    const { punishments } = parsePunishments('delete,  TEMPMUTE 20m , defer');
    assert.equal(stringifyPunishments(punishments), 'delete, tempmute 20m, defer');
    assert.equal(stringifyPunishments([]), '');
    assert.equal(stringifyPunishments(null), '');
});
