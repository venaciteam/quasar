// Validation côté serveur des deux surfaces qui n'en avaient pas.
//
// Raison d'être : le dashboard échappe désormais ce qu'il affiche, mais
// l'échappement est la dernière ligne, pas la première. Deux routes laissaient
// entrer n'importe quoi en base —
//   • PUT /welcome/config ne vérifiait ni type, ni longueur, ni forme de
//     `welcome_embed` : un objet arbitraire y entrait, et un message trop long
//     n'échouait qu'au moment où un membre rejoignait le serveur, dans un catch
//     du bot, sans que personne ne le sache ;
//   • POST /customcmds ne faisait qu'un `toLowerCase()` sur le nom, là où le
//     renommage passait par la règle de nommage de Discord et les noms réservés.
//     Un nom porteur de balises était accepté, stocké, puis rendu — et Discord
//     refusant un lot de commandes dès qu'UNE entrée est invalide, ce nom
//     pouvait aussi priver la guild de toutes ses commandes au redéploiement.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { validateWelcomeConfig } = require('../api/routes/welcome');
const { validateNewCommandName } = require('../api/routes/customcmds');

const GUILD = '123456789012345678';
const SALON = '987654321098765432';

// ── Welcome / Leave ──────────────────────────────────────────────────────────

test('welcome : une configuration normale passe intacte', () => {
    const verdict = validateWelcomeConfig({
        welcome_enabled: true,
        welcome_channel: SALON,
        welcome_message: 'Bienvenue {user} sur {server} !',
        welcome_embed: { title: 'Bienvenue', description: 'Bonne visite', color: '#c86e8e', thumbnail: 'avatar' },
        leave_enabled: false,
        leave_channel: null,
        leave_message: null,
        leave_embed: null,
    });
    assert.equal(verdict.error, undefined);
    assert.equal(verdict.value.welcome_channel, SALON);
    assert.equal(verdict.value.welcome_enabled, 1);
    assert.equal(verdict.value.leave_enabled, 0);
    assert.deepEqual(verdict.value.welcome_embed, {
        title: 'Bienvenue', description: 'Bonne visite', color: '#c86e8e', thumbnail: 'avatar',
    });
    assert.equal(verdict.value.leave_embed, null);
});

test('welcome : un message qui n\'est pas du texte est refusé', () => {
    for (const valeur of [{ toString: 1 }, ['a'], 42, true]) {
        const verdict = validateWelcomeConfig({ welcome_message: valeur });
        assert.ok(verdict.error, `accepté à tort : ${JSON.stringify(valeur)}`);
    }
});

test('welcome : un message plus long que la limite Discord est refusé', () => {
    const verdict = validateWelcomeConfig({ welcome_message: 'a'.repeat(2001) });
    assert.match(verdict.error, /2000 caractères/);
});

test('welcome : un salon qui n\'est pas un identifiant Discord est refusé', () => {
    assert.ok(validateWelcomeConfig({ welcome_channel: 'salon-general' }).error);
    assert.ok(validateWelcomeConfig({ leave_channel: '12' }).error);
    // Vide ou absent = pas de salon, et c'est légitime.
    assert.equal(validateWelcomeConfig({ welcome_channel: '' }).value.welcome_channel, null);
});

test('welcome : l\'embed refuse les champs inconnus et les valeurs hors format', () => {
    assert.match(validateWelcomeConfig({ welcome_embed: { onload: 'alert(1)' } }).error, /ne connaît pas le champ/);
    assert.ok(validateWelcomeConfig({ welcome_embed: 'pas un objet' }).error);
    assert.ok(validateWelcomeConfig({ welcome_embed: ['title'] }).error);
    assert.match(validateWelcomeConfig({ welcome_embed: { color: 'rouge' } }).error, /hexadécimale/);
    assert.ok(validateWelcomeConfig({ welcome_embed: { title: 'x'.repeat(257) } }).error);
});

test('welcome : une vignette ou une image doit être http(s), pas un javascript:', () => {
    assert.ok(validateWelcomeConfig({ welcome_embed: { thumbnail: 'javascript:alert(1)' } }).error);
    assert.ok(validateWelcomeConfig({ welcome_embed: { image: 'javascript:alert(1)' } }).error);
    assert.equal(
        validateWelcomeConfig({ welcome_embed: { thumbnail: 'avatar' } }).value.welcome_embed.thumbnail,
        'avatar'
    );
    assert.equal(
        validateWelcomeConfig({ welcome_embed: { image: 'https://exemple.test/a.png' } }).value.welcome_embed.image,
        'https://exemple.test/a.png'
    );
});

test('welcome : un embed entièrement vide vaut absence d\'embed', () => {
    // Sinon la base garderait `{}`, que le bot rendrait en embed sans contenu.
    assert.equal(validateWelcomeConfig({ welcome_embed: { title: '', description: '' } }).value.welcome_embed, null);
});

// ── Commandes personnalisées ─────────────────────────────────────────────────

test('commandes custom : un nom porteur de balises est refusé à la création', () => {
    const db = getDb();
    const verdict = validateNewCommandName(db, GUILD, '<img src=x onerror=alert(1)>');
    assert.ok(verdict.error, 'ce nom doit être refusé');
    assert.match(verdict.error.cause, /Discord refuse ce nom/);
});

test('commandes custom : la création applique les mêmes règles que le renommage', () => {
    const db = getDb();
    // Vide, espaces seuls, valeur non textuelle.
    assert.ok(validateNewCommandName(db, GUILD, '   ').error);
    assert.ok(validateNewCommandName(db, GUILD, null).error);
    assert.ok(validateNewCommandName(db, GUILD, { toString: 1 }).error);
    // Plus de 32 caractères, apostrophe : refusés par la règle Discord.
    assert.ok(validateNewCommandName(db, GUILD, 'a'.repeat(33)).error);
    assert.ok(validateNewCommandName(db, GUILD, "aujourd'hui").error);
    // Un nom déjà pris par une commande livrée par Quasar.
    const reserve = validateNewCommandName(db, GUILD, 'warn');
    assert.match(reserve.error.cause, /déjà une commande de Quasar/);
});

test('commandes custom : un nom valide est normalisé comme à l\'édition', () => {
    const db = getDb();
    assert.deepEqual(validateNewCommandName(db, GUILD, '  Mes Règles  '), { name: 'mes-règles' });
    assert.deepEqual(validateNewCommandName(db, GUILD, 'socials'), { name: 'socials' });
});

test('commandes custom : une collision sur le serveur est refusée', () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILD, 'Serveur de test');
    db.prepare('INSERT INTO custom_commands (guild_id, name, response) VALUES (?, ?, ?)')
        .run(GUILD, 'regles', 'Les règles du serveur');

    const verdict = validateNewCommandName(db, GUILD, 'Regles');
    assert.match(verdict.error.cause, /existe déjà sur ce serveur/);
    // …et pas sur un autre serveur : la contrainte est par guild.
    assert.deepEqual(validateNewCommandName(db, '111111111111111111', 'regles'), { name: 'regles' });
});
