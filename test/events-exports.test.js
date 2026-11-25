// Contrat d'export des handlers d'événements.
//
// Raison d'être : jusqu'à la v4.7.0, voiceStateUpdate.js posait deux exports
// AVANT l'affectation de module.exports — qui les écrasait. bot/index.js lisait
// alors `undefined` et le rechargement des salons TempVoice échouait à chaque
// démarrage, silencieusement. Ce test rend la régression impossible.
//
// Pendant la migration multiplateforme, DEUX formats coexistent, et le chargeur
// (`chargerEvenements`) les accepte tous les deux. Un fichier qui ne respecte ni
// l'un ni l'autre n'est pas branché DU TOUT, sans erreur ni journal : c'est
// exactement ce que ce test attrape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EVENTS_DIR = path.join(__dirname, '..', 'bot', 'events');

test('chaque event exporte un handler dans l\'un des deux formats', () => {
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.js'));
    assert.ok(files.length > 0, 'aucun fichier d\'event trouvé');

    for (const file of files) {
        const mod = require(path.join(EVENTS_DIR, file));
        const neutre = typeof mod.nom === 'string' && typeof mod.executer === 'function';
        const historique = typeof mod.name === 'string' && typeof mod.execute === 'function';

        assert.ok(
            neutre || historique,
            `${file} : ni { nom, executer } (neutre) ni { name, execute } (historique). `
            + 'Le chargeur ignorerait ce fichier en silence.',
        );
        // Une migration à moitié faite est pire que pas de migration : le
        // chargeur prendrait la voie neutre et laisserait `execute` mort.
        assert.ok(!(neutre && historique), `${file} : porte les DEUX formats à la fois.`);
    }
});

test('un event neutre nomme un événement du contrat', () => {
    // `nom: 'guildCreate'` au lieu de `'guildeRejointe'` passerait la validation
    // de format ci-dessus, et le handler ne serait jamais appelé : discord.js
    // n'émet pas d'événement portant un nom neutre.
    const { EVENEMENTS_NEUTRES } = require('../bot/platform/events');
    const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.js'));

    for (const file of files) {
        const mod = require(path.join(EVENTS_DIR, file));
        if (typeof mod.executer !== 'function') continue;
        assert.ok(
            EVENEMENTS_NEUTRES.includes(mod.nom),
            `${file} : « ${mod.nom} » n'est pas un événement du contrat (${EVENEMENTS_NEUTRES.join(', ')}).`,
        );
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
    assert.ok(typeof mod.execute === 'function' || typeof mod.executer === 'function');
});
