// Garde de configuration dépendant de la plateforme active.
//
// Raison d'être : les deux jeux de secrets ne se mélangent pas. Exiger
// DISCORD_TOKEN d'un déploiement Fluxer obligerait chaque instance à porter les
// secrets de l'autre plateforme — exactement ce que la ségrégation des deux
// déploiements doit empêcher (DA §9.4 et §10). Et un démarrage Fluxer sans
// FLUXER_TOKEN doit échouer en NOMMANT la variable, pas en boucle de
// redémarrage sur une connexion refusée.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    verifierConfig,
    formaterProblemes,
    variablesRequises,
    resoudrePlateformeOuDefaut,
    VARIABLES_PLATEFORME,
    VARIABLES_COMMUNES,
    JWT_SECRET_MIN,
} = require('../index.js');

const SECRET_VALIDE = 'a'.repeat(JWT_SECRET_MIN);
const COMMUN = { CALLBACK_URL: 'http://localhost:3000/callback', JWT_SECRET: SECRET_VALIDE };

const envFluxer = (surcharges = {}) => ({
    QUASAR_PLATFORM: 'fluxer',
    FLUXER_TOKEN: 'jeton-fluxer-factice',
    FLUXER_CLIENT_ID: '123456789012345678',
    FLUXER_CLIENT_SECRET: 'secret-client-factice',
    ...COMMUN,
    ...surcharges,
});

const manquantes = (mode, env) => verifierConfig(mode, env).problemes.map(p => p.variable);

// ── La plateforme décide de ce qui est exigé ─────────────────────────────────

test('en mode fluxer, l\'absence de DISCORD_TOKEN n\'est pas une erreur', () => {
    const verdict = verifierConfig('bot', envFluxer());
    assert.equal(verdict.ok, true, `refusée à tort : ${JSON.stringify(verdict.problemes)}`);
});

test('en mode discord, l\'absence de FLUXER_TOKEN n\'est pas une erreur', () => {
    const verdict = verifierConfig('bot', {
        DISCORD_TOKEN: 'MTA0.jeton.factice',
        DISCORD_CLIENT_ID: '123456789012345678',
        DISCORD_CLIENT_SECRET: 'secret-client-factice',
        ...COMMUN,
    });
    assert.equal(verdict.ok, true);
});

test('un démarrage fluxer sans FLUXER_TOKEN échoue en nommant la variable', () => {
    const problemes = verifierConfig('bot', envFluxer({ FLUXER_TOKEN: undefined })).problemes;
    assert.deepEqual(problemes.map(p => p.variable), ['FLUXER_TOKEN']);
    assert.equal(problemes[0].motif, 'absente');

    const lignes = formaterProblemes(problemes, 'bot', 'fluxer').join('\n');
    assert.match(lignes, /FLUXER_TOKEN/);
    assert.match(lignes, /plateforme « fluxer »/);
    // Aucune variable Discord ne doit apparaître : elle n'a rien à faire là et
    // enverrait chercher au mauvais endroit.
    assert.doesNotMatch(lignes, /DISCORD_/);
});

test('toutes les variables Fluxer manquantes sont rendues ensemble', () => {
    assert.deepEqual(manquantes('bot', { QUASAR_PLATFORM: 'fluxer' }), [
        'FLUXER_TOKEN',
        'FLUXER_CLIENT_ID',
        'FLUXER_CLIENT_SECRET',
        'CALLBACK_URL',
        'JWT_SECRET',
    ]);
});

test('chaque variable de plateforme explique ce qu\'elle rend possible', () => {
    for (const probleme of verifierConfig('bot', { QUASAR_PLATFORM: 'fluxer' }).problemes) {
        assert.ok(probleme.cause.length > 40, `cause trop pauvre pour ${probleme.variable}`);
        assert.ok(probleme.motif, `motif manquant pour ${probleme.variable}`);
    }
});

test('le mode site n\'exige rien, quelle que soit la plateforme', () => {
    // La vitrine ne démarre ni bot ni base : exiger un jeton la casserait, et
    // c'est le mode dans lequel tourne quasar.vena.city.
    for (const plateforme of ['discord', 'fluxer']) {
        assert.equal(verifierConfig('site', { QUASAR_PLATFORM: plateforme }).ok, true);
        assert.deepEqual(variablesRequises('site', plateforme), []);
    }
});

test('le mode public exige exactement la même chose que le mode bot', () => {
    for (const plateforme of ['discord', 'fluxer']) {
        assert.deepEqual(variablesRequises('public', plateforme), variablesRequises('bot', plateforme));
    }
});

test('les variables communes ne dépendent pas de la plateforme', () => {
    // CALLBACK_URL et JWT_SECRET servent le dashboard, qui est le même des deux
    // côtés. Les dupliquer par plateforme les ferait diverger.
    for (const plateforme of ['discord', 'fluxer']) {
        for (const variable of VARIABLES_COMMUNES.bot) {
            assert.ok(variablesRequises('bot', plateforme).includes(variable));
        }
    }
});

test('les deux jeux de secrets sont disjoints', () => {
    const croisement = VARIABLES_PLATEFORME.discord.filter(v => VARIABLES_PLATEFORME.fluxer.includes(v));
    assert.deepEqual(croisement, []);
});

// ── Repli sur la plateforme par défaut ───────────────────────────────────────

test('une plateforme illisible ne fait pas échouer le garde de configuration', () => {
    // Le refus de démarrer pour QUASAR_PLATFORM inconnue est prononcé par main(),
    // avec son propre message. Ici, une valeur illisible ne doit pas empêcher
    // d'énumérer les AUTRES problèmes — le principe étant de tous les rendre
    // d'un seul coup.
    assert.equal(resoudrePlateformeOuDefaut({ QUASAR_PLATFORM: 'irc' }), 'discord');
    assert.deepEqual(manquantes('bot', { QUASAR_PLATFORM: 'irc' }), [
        'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'CALLBACK_URL', 'JWT_SECRET',
    ]);
});

test('une plateforme explicite l\'emporte sur celle de l\'environnement', () => {
    // C'est ce dont main() se sert : la plateforme est résolue une fois, puis
    // transmise, pour que le contrôle porte sur celle qui va réellement démarrer.
    const problemes = verifierConfig('bot', { ...COMMUN }, 'fluxer').problemes;
    assert.deepEqual(problemes.map(p => p.variable), ['FLUXER_TOKEN', 'FLUXER_CLIENT_ID', 'FLUXER_CLIENT_SECRET']);
});
