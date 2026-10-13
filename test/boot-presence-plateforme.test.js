// Démarrage des services sur une plateforme qui ne sait pas définir la présence.
//
// Raison d'être : `demarrerServices` appelait `client.user.setPresence` et
// `client.user.setActivity` sans condition, y compris dans le `catch` censé
// rattraper le premier appel. Ce sont des méthodes de discord.js ; le client
// Fluxer porte l'utilisateur tel que la passerelle l'envoie, sans elles.
// L'exception sortait donc de la fonction, et le handler `clientReady` arrête le
// processus sur tout rejet : sur Fluxer, le bot redémarrait en boucle dès la
// connexion. Le défaut n'est apparu qu'au premier démarrage avec un vrai jeton
// (2026-10-13) — les démarrages réels précédents s'arrêtaient au refus 4004 de
// la passerelle, avant `clientReady`.
//
// Fichier séparé de boot-services-fatal.test.js, qui pointe une base
// impossible à ouvrir : la connexion est mise en cache pour tout le processus.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { demarrerServices } = require('../bot');
const database = require('../api/services/database');

after(() => { database.closeDb?.(); });

test('un client sans setPresence (Fluxer) ne fait pas échouer le démarrage', async () => {
    // Forme réelle de l'utilisateur rendu par la passerelle Fluxer : des
    // données, aucune méthode, et pas de `tag`.
    const clientFluxer = {
        user: { id: '1559523995672387585', username: 'Quasar' },
        guilds: { cache: new Map() },
    };
    await assert.doesNotReject(() => demarrerServices(clientFluxer));
});

test('un client qui sait définir la présence reçoit la présence par défaut', async () => {
    const appels = [];
    const clientDiscord = {
        user: { tag: 'Quasar#0000', setPresence: (p) => appels.push(p) },
        guilds: { cache: new Map() },
    };
    await demarrerServices(clientDiscord);
    assert.equal(appels.length, 1);
    assert.equal(appels[0].activities[0].name, 'atlas.vena.city');
    assert.equal(appels[0].activities[0].type, 3);
});

test('une présence qui lève n\'arrête pas le démarrage', async () => {
    const clientCasse = {
        user: { tag: 'Quasar#0000', setPresence: () => { throw new Error('passerelle fermée'); } },
        guilds: { cache: new Map() },
    };
    await assert.doesNotReject(() => demarrerServices(clientCasse));
});
