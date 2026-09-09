// Garde-fou de démarrage — la configuration est contrôlée AVANT de démarrer.
//
// Raison d'être : Quasar démarrait quelle que soit sa configuration, et chaque
// variable manquante se payait plus tard, ailleurs, sous une forme qui ne la
// désignait pas — TokenInvalid en boucle, page d'erreur Discord opaque,
// invalid_client au retour d'OAuth. Le cas le plus grave ne produisait RIEN du
// tout : sans JWT_SECRET, le middleware d'authentification retombait sur une
// constante écrite dans un dépôt public, et acceptait donc des jetons forgés
// jusque sur requireOwner. Ce test rend le retour en arrière impossible.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const express = require('express');

const {
    verifierConfig,
    formaterProblemes,
    ecouter,
    VARIABLES_REQUISES,
    JWT_SECRET_MIN,
} = require('../index.js');

// Environnement complet et valide, dont on retire une pièce à la fois. Les tests
// passent toujours un objet explicite : le .env de la machine qui exécute la
// suite ne doit jamais changer leur résultat.
const SECRET_VALIDE = 'a'.repeat(JWT_SECRET_MIN);
function envValide(surcharges = {}) {
    return {
        DISCORD_TOKEN: 'MTA0.jeton.factice',
        DISCORD_CLIENT_ID: '123456789012345678',
        DISCORD_CLIENT_SECRET: 'secret-client-factice',
        CALLBACK_URL: 'http://localhost:3000/callback',
        JWT_SECRET: SECRET_VALIDE,
        ...surcharges,
    };
}

function variablesEnDefaut(mode, env) {
    return verifierConfig(mode, env).problemes.map(p => p.variable);
}

// ── Le mode décide de ce qui est exigé ───────────────────────────────────────

test('une configuration complète passe, dans les trois modes', () => {
    for (const mode of ['bot', 'public', 'site']) {
        const verdict = verifierConfig(mode, envValide());
        assert.equal(verdict.ok, true, `refusée à tort en mode ${mode}`);
        assert.deepEqual(verdict.problemes, []);
    }
});

test('le mode site n\'exige aucune variable du bot', () => {
    // Régression à ne jamais introduire : la vitrine ne lance ni bot, ni API
    // métier, ni base. Exiger DISCORD_TOKEN ici casserait l'instance publique,
    // qui tourne précisément dans ce mode.
    const verdict = verifierConfig('site', {});
    assert.equal(verdict.ok, true);
    assert.deepEqual(VARIABLES_REQUISES.site, []);
});

test('les modes bot et public exigent exactement les mêmes variables', () => {
    // Ils démarrent la même chose : bot + API + dashboard. Seule la vitrine les
    // distingue, et elle ne lit aucune de ces variables.
    assert.deepEqual(VARIABLES_REQUISES.public, VARIABLES_REQUISES.bot);
});

test('un mode inconnu retombe sur les exigences du mode par défaut', () => {
    // resolveMode replie déjà sur "bot" : la vérification doit suivre le même
    // repli, sinon une valeur mal orthographiée démarrerait sans aucun contrôle.
    assert.deepEqual(variablesEnDefaut('nawak', {}), VARIABLES_REQUISES.bot);
});

// ── La liste complète, d'un seul coup ────────────────────────────────────────

test('toutes les variables manquantes sont rendues ensemble, pas la première', () => {
    // Une relance par variable manquante, c'est cinq relances pour un premier
    // démarrage : la liste part en une fois.
    assert.deepEqual(variablesEnDefaut('bot', {}), [
        'DISCORD_TOKEN',
        'DISCORD_CLIENT_ID',
        'DISCORD_CLIENT_SECRET',
        'CALLBACK_URL',
        'JWT_SECRET',
    ]);
});

test('chaque problème explique ce que la variable rend possible', () => {
    for (const probleme of verifierConfig('bot', {}).problemes) {
        assert.ok(probleme.cause.length > 40, `cause trop pauvre pour ${probleme.variable}`);
        assert.ok(probleme.motif, `motif manquant pour ${probleme.variable}`);
    }
});

// ── Cas de rejet du garde JWT ────────────────────────────────────────────────

test('JWT_SECRET absent est refusé', () => {
    assert.deepEqual(variablesEnDefaut('bot', envValide({ JWT_SECRET: undefined })), ['JWT_SECRET']);
});

test('JWT_SECRET vide ou blanc est refusé', () => {
    for (const valeur of ['', '   ', '\t']) {
        const problemes = verifierConfig('bot', envValide({ JWT_SECRET: valeur })).problemes;
        assert.deepEqual(problemes.map(p => p.variable), ['JWT_SECRET'], `accepté à tort : ${JSON.stringify(valeur)}`);
        assert.equal(problemes[0].motif, 'absente');
    }
});

test('les valeurs d\'exemple publiées sont refusées', () => {
    // Elles sont sur GitHub : ce ne sont pas des secrets. « quasar-secret » est
    // l'ancienne valeur de repli du middleware d'authentification.
    for (const valeur of ['change_this_to_a_random_string', 'quasar-secret']) {
        const problemes = verifierConfig('bot', envValide({ JWT_SECRET: valeur })).problemes;
        assert.deepEqual(problemes.map(p => p.variable), ['JWT_SECRET'], `accepté à tort : ${valeur}`);
        assert.equal(problemes[0].motif, 'exemple');
    }
    for (const [variable, valeur] of [
        ['DISCORD_TOKEN', 'your_bot_token_here'],
        ['DISCORD_CLIENT_ID', 'your_client_id_here'],
        ['DISCORD_CLIENT_SECRET', 'your_client_secret_here'],
    ]) {
        const problemes = verifierConfig('bot', envValide({ [variable]: valeur })).problemes;
        assert.deepEqual(problemes.map(p => p.variable), [variable], `accepté à tort : ${valeur}`);
        assert.equal(problemes[0].motif, 'exemple');
    }
});

test('un JWT_SECRET plus court que la longueur minimale est refusé', () => {
    const court = 'a'.repeat(JWT_SECRET_MIN - 1);
    const problemes = verifierConfig('bot', envValide({ JWT_SECRET: court })).problemes;
    assert.deepEqual(problemes.map(p => p.variable), ['JWT_SECRET']);
    assert.equal(problemes[0].motif, 'trop courte');
    assert.match(problemes[0].cause, new RegExp(`${JWT_SECRET_MIN}`));
});

test('la sortie de openssl rand -hex 32 est acceptée', () => {
    const secret = 'f'.repeat(64);
    assert.equal(verifierConfig('bot', envValide({ JWT_SECRET: secret })).ok, true);
});

test('les espaces autour d\'une valeur ne la sauvent pas', () => {
    // Un `JWT_SECRET= ` recopié depuis un tutoriel n'est pas un secret.
    assert.deepEqual(variablesEnDefaut('bot', envValide({ JWT_SECRET: '  quasar-secret  ' })), ['JWT_SECRET']);
});

test('CALLBACK_URL par défaut du .env.example reste acceptée', () => {
    // C'est une valeur de travail légitime en auto-hébergement, pas un
    // marqueur laissé en place : la refuser casserait l'installation locale.
    assert.equal(verifierConfig('bot', envValide({ CALLBACK_URL: 'http://localhost:3000/callback' })).ok, true);
});

// ── Le message de refus ──────────────────────────────────────────────────────

test('le message de refus donne la commande de génération du secret', () => {
    const lignes = formaterProblemes(verifierConfig('bot', {}).problemes, 'bot').join('\n');
    assert.match(lignes, /openssl rand -hex 32/);
    assert.match(lignes, /JWT_SECRET/);
    assert.match(lignes, /mode « bot »/);
    // Vouvoiement : l'émetteur parle en « je », jamais en « on » ni « nous ».
    assert.match(lignes, /Renseignez/);
});

test('la commande openssl n\'est proposée que si JWT_SECRET est en cause', () => {
    const problemes = verifierConfig('bot', envValide({ DISCORD_TOKEN: '' })).problemes;
    const lignes = formaterProblemes(problemes, 'bot').join('\n');
    assert.doesNotMatch(lignes, /openssl/);
    assert.match(lignes, /DISCORD_TOKEN/);
});

// ── Erreur d'écoute ──────────────────────────────────────────────────────────

test('un port déjà occupé produit le message soigné, pas une pile d\'appel', async () => {
    // Le piège : sur express 5, le callback de app.listen est enregistré à la
    // fois sur 'listening' et sur 'error'. Passer la bannière de démarrage en
    // callback la ferait donc afficher juste avant le message d'échec — et rien
    // ne garantit ce comportement d'une version d'express à l'autre. Ce test
    // monte un vrai squatteur de port et vérifie l'issue : le message soigné,
    // une sortie en 1, et AUCUNE bannière de démarrage.
    const squatteur = net.createServer();
    await new Promise((resolve) => squatteur.listen(0, '127.0.0.1', resolve));
    const port = squatteur.address().port;

    const lignes = [];
    const codes = [];
    let banniere = 0;
    const server = ecouter(express(), {
        port,
        host: '127.0.0.1',
        onListening: () => { banniere += 1; },
        journal: { log: () => {}, error: (l) => lignes.push(l) },
        sortir: (code) => codes.push(code),
    });

    await new Promise((resolve) => server.once('error', () => setImmediate(resolve)));

    const texte = lignes.join('\n');
    assert.match(texte, /le port est déjà utilisé/);
    assert.match(texte, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.match(texte, /PORT dans le fichier \.env/);
    assert.deepEqual(codes, [1]);
    assert.equal(banniere, 0, 'la bannière de démarrage ne doit pas s\'afficher sur un échec d\'écoute');

    await new Promise((resolve) => squatteur.close(resolve));
});
