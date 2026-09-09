// Garde-fou de démarrage — un bot sans base n'a rien à faire en ligne.
//
// Raison d'être : getDb(), l'enregistrement des serveurs et le déploiement des
// commandes étaient les trois seules parties du handler `clientReady` sans
// try/catch, et le handler n'avait aucun .catch. Un échec de getDb() — volume
// monté appartenant à root après un redéploiement, le piège Coolify déjà
// rencontré — partait donc dans le filet global du processus, qui journalise et
// LAISSE VIVRE. Le bot restait en ligne, répondait aux commandes, et n'avait
// plus aucun de ses balayages : aucun rappel programmé, aucun bannissement
// temporaire levé (un tempban devenait définitif), aucun mode panique levé (un
// serveur restait fermé indéfiniment), aucune purge de rétention. Rien ne le
// signalait.
//
// Ce fichier pointe volontairement une base IMPOSSIBLE à ouvrir : il doit rester
// séparé des suites qui travaillent sur ':memory:', la connexion étant mise en
// cache pour tout le processus.
const os = require('node:os');
const path = require('node:path');
process.env.QUASAR_DB_PATH = path.join(os.tmpdir(), `quasar-dossier-absent-${process.pid}`, 'quasar.db');

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { demarrerServices } = require('../bot');

// Le démarrage des services ne touche au client que pour l'afficher et lister
// ses serveurs : de quoi s'en tenir à un objet minimal.
const clientFactice = {
    user: { tag: 'Quasar#0000' },
    guilds: { cache: new Map() },
};

test('une base inaccessible au démarrage rejette au lieu de laisser le bot en ligne', async () => {
    await assert.rejects(
        () => demarrerServices(clientFactice),
        (err) => {
            assert.ok(err instanceof Error);
            // C'est bien l'ouverture de la base qui échoue, pas autre chose.
            assert.match(String(err.message), /database|base|open/i);
            return true;
        },
    );
});
