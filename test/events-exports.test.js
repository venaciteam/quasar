// Contrat d'export des handlers d'événements Discord.
//
// Raison d'être : jusqu'à la v4.7.0, voiceStateUpdate.js posait deux exports
// AVANT l'affectation de module.exports — qui les écrasait. bot/index.js lisait
// alors `undefined` et le rechargement des salons TempVoice échouait à chaque
// démarrage, silencieusement. Ce test rend la régression impossible.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EVENTS_DIR = path.join(__dirname, '..', 'bot', 'events');

test('chaque event exporte { name, execute }', () => {
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.js'));
    assert.ok(files.length > 0, 'aucun fichier d\'event trouvé');
    for (const file of files) {
        const mod = require(path.join(EVENTS_DIR, file));
        assert.equal(typeof mod.name, 'string', `${file} : export "name" manquant`);
        assert.equal(typeof mod.execute, 'function', `${file} : export "execute" manquant`);
    }
});

test('voiceStateUpdate — les exports annexes survivent à module.exports', () => {
    const mod = require(path.join(EVENTS_DIR, 'voiceStateUpdate.js'));
    assert.ok(mod.tempvoiceChannelIds instanceof Set,
        'tempvoiceChannelIds doit être un Set (écrasé par module.exports ?)');
    assert.equal(typeof mod.isTempVoiceCreating, 'function');
    assert.equal(mod.isTempVoiceCreating(), false);
});

test('messageCreate — même contrat d\'exports annexes', () => {
    const mod = require(path.join(EVENTS_DIR, 'messageCreate.js'));
    // Les exports annexes documentés par le module honeypot.
    assert.equal(typeof mod.execute, 'function');
});
