// Garde-fou : le jeton de session n'est plus accepté dans la chaîne de requête,
// sauf sur l'unique route qui ne peut pas faire autrement.
//
// Raison d'être : `requireAuth` acceptait `req.query.token` sur TOUTES les
// routes. Deux conséquences. D'abord la fabrication d'URL porteuses de session :
// il suffisait d'envoyer un lien contenant son propre jeton pour que la cible
// consulte le dashboard sous une identité choisie par l'attaquant. Ensuite la
// fuite : une URL part dans les journaux du proxy et dans l'en-tête `Referer`
// des ressources tierces chargées par la page, dont le design system distant.
//
// L'exception était `/api/update`, dont le front consommait le flux SSE avec
// `EventSource`, la seule API du navigateur incapable de poser un en-tête
// `Authorization`. Elle a disparu : la route est passée en POST — un GET
// permettait de déclencher une mise à jour par simple préchargement de lien — et
// le front lit désormais le flux avec fetch + ReadableStream, en-tête compris.
// PLUS AUCUNE route ne lit le jeton dans l'URL, et le balayage ci-dessous le
// vérifie sur l'ensemble d'`api/`. `allowTokenInQuery` subsiste dans
// `middleware/auth.js` sans plus aucun appelant : le test tolère sa présence
// (sa suppression relève d'un autre fichier), mais interdit qu'une route s'en
// serve à nouveau.
//
// QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { generateToken, allowTokenInQuery } = require('../api/middleware/auth');
const { createApi } = require('../api');

const app = createApi({}, 'bot');
let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function get(path_, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${path_}`, { headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

const jeton = generateToken({ id: '1', username: 'test', avatar: null, guilds: [] });

test('un jeton valide en en-tete Authorization reste accepte', async () => {
    const res = await get('/auth/me', { authorization: `Bearer ${jeton}` });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).authenticated, true);
});

test('le meme jeton valide passe en chaine de requete est refuse', async () => {
    const res = await get(`/auth/me?token=${jeton}`);
    assert.equal(res.status, 401);
});

// Les deux tests unitaires suivants décrivent `allowTokenInQuery`, qui n'a plus
// aucun appelant. Ils se désactivent d'eux-mêmes le jour où la fonction sera
// retirée de middleware/auth.js : le garde-fou qui compte, c'est le balayage du
// code plus bas, pas la survie d'une fonction morte.
const middlewareEncorePresent = typeof allowTokenInQuery === 'function';

test('allowTokenInQuery promeut le jeton de la requete en en-tete', { skip: !middlewareEncorePresent }, () => {
    const req = { query: { token: 'abc' }, headers: {} };
    let suivant = false;
    allowTokenInQuery(req, {}, () => { suivant = true; });
    assert.equal(req.headers.authorization, 'Bearer abc');
    assert.equal(suivant, true);
});

test('allowTokenInQuery n ecrase jamais un en-tete Authorization existant', { skip: !middlewareEncorePresent }, () => {
    const req = { query: { token: 'usurpe' }, headers: { authorization: 'Bearer legitime' } };
    allowTokenInQuery(req, {}, () => {});
    assert.equal(req.headers.authorization, 'Bearer legitime');
});

test('aucune route de l API ne lit le jeton dans la chaine de requete', () => {
    // Balayage du code source : `req.query.token` ne doit subsister que dans la
    // definition de `allowTokenInQuery`, qui n a plus aucun appelant. Toute
    // reapparition ailleurs rouvre la fabrication d URL porteuses de session, sans
    // qu aucun test fonctionnel ne le voie passer.
    const racine = path.join(__dirname, '..', 'api');
    const trouvailles = [];
    const utilisateurs = [];

    (function parcourir(dossier) {
        for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
            const chemin = path.join(dossier, entree.name);
            if (entree.isDirectory()) { parcourir(chemin); continue; }
            if (!entree.name.endsWith('.js')) continue;
            const source = fs.readFileSync(chemin, 'utf8');
            source.split('\n').forEach((ligne, i) => {
                const repere = `${path.relative(racine, chemin)}:${i + 1}`;
                if (/req\.query\.token/.test(ligne)) trouvailles.push(repere);
                // Une route qui se remettrait a importer ou poser
                // `allowTokenInQuery` reviendrait au meme resultat sans jamais
                // ecrire `req.query.token` elle-meme.
                if (/allowTokenInQuery/.test(ligne)) utilisateurs.push(repere);
            });
        }
    })(racine);

    // On ne fige pas des numeros de ligne, qui deviendraient faux au premier
    // ajout de commentaire : c est le fichier porteur qui compte.
    const horsMiddleware = trouvailles.filter(t => !t.startsWith('middleware/auth.js:'));
    assert.deepEqual(horsMiddleware, [],
        `req.query.token attendu uniquement dans allowTokenInQuery, trouve aussi : ${horsMiddleware.join(', ')}`);

    // On ne verifie plus qu une occurrence SUBSISTE : la derniere route qui optait
    // pour la tolerance (`GET /api/update`) est passee en POST, donc
    // `allowTokenInQuery` est desormais du code mort dont la suppression est
    // souhaitable. L exigence qui reste est l inverse : plus personne ne s en sert.
    const horsDefinition = utilisateurs.filter(t => !t.startsWith('middleware/auth.js:'));
    assert.deepEqual(horsDefinition, [],
        `allowTokenInQuery ne doit plus etre utilise par aucune route, trouve : ${horsDefinition.join(', ')}`);
});
