// Garde-fou des en-têtes de sécurité et de la politique de sécurité du contenu.
//
// Raison d'être : le projet n'en posait aucun. Zéro résultat pour CSP,
// X-Frame-Options, HSTS ou Referrer-Policy dans tout le dépôt, les seuls
// `setHeader` étant des `Cache-Control`.
//
// Ce que ces tests protègent vraiment. Le jeton de session vit dans
// localStorage et vaut sept jours sans révocation possible : la valeur d'un XSS
// tient donc entièrement dans sa capacité à faire SORTIR ce jeton. `connect-src`
// et `img-src` ferment cette sortie. `frame-ancestors` ferme le clickjacking,
// dont le scénario concret est une administratrice qui valide un effacement de
// données en cliquant sur une iframe transparente.
//
// Ce qu'ils ne protègent pas, et c'est assumé : `script-src` porte
// 'unsafe-inline', imposé par la centaine de gestionnaires en ligne du
// dashboard. Un XSS s'exécute encore. Le test le VÉRIFIE explicitement plus bas,
// pour que le jour où ces gestionnaires disparaissent, l'échec du test rappelle
// qu'il faut resserrer la directive.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi, createSiteApi, construireCsp } = require('../api');

const apps = {};
const bases = {};

// Le rappel de `listen` plutot que l evenement `listening` : demarrer deux
// serveurs puis attendre leurs evenements l un apres l autre laisse passer le
// second, qui a deja emis quand on se met a l ecouter. Le test se bloquait la.
function ecouter(app) {
    return new Promise((resolve) => {
        const serveur = app.listen(0, () => resolve(serveur));
    });
}

before(async () => {
    apps.dashboard = await ecouter(createApi({}, 'bot'));
    apps.vitrine = await ecouter(createSiteApi('site'));
    for (const [nom, serveur] of Object.entries(apps)) {
        bases[nom] = `http://127.0.0.1:${serveur.address().port}`;
    }
});

after(() => Object.values(apps).forEach((s) => s.close()));

function get(base, chemin = '/') {
    return new Promise((resolve, reject) => {
        http.get(`${base}${chemin}`, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        }).on('error', reject);
    });
}

function directives(csp) {
    return Object.fromEntries(csp.split(';').map((d) => {
        const [nom, ...valeurs] = d.trim().split(/\s+/);
        return [nom, valeurs];
    }));
}

test('les deux applications posent la CSP et les en-têtes de securite', async () => {
    for (const nom of ['dashboard', 'vitrine']) {
        const res = await get(bases[nom]);
        assert.ok(res.headers['content-security-policy'], `${nom} : CSP absente`);
        assert.equal(res.headers['x-frame-options'], 'DENY', nom);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', nom);
        assert.ok(res.headers['referrer-policy'], `${nom} : Referrer-Policy absente`);
    }
});

test('la version d Express n est plus annoncee', async () => {
    for (const nom of ['dashboard', 'vitrine']) {
        const res = await get(bases[nom]);
        assert.equal(res.headers['x-powered-by'], undefined, nom);
    }
});

test('HSTS absent sur une requete en clair', async () => {
    // Une instance auto-hebergee joignable en HTTP sur un reseau local ne doit
    // pas se verrouiller sur un en-tete qu'elle ne peut plus honorer.
    const res = await get(bases.dashboard);
    assert.equal(res.headers['strict-transport-security'], undefined);
});

test('le clickjacking est ferme des deux cotes', async () => {
    for (const nom of ['dashboard', 'vitrine']) {
        const d = directives((await get(bases[nom])).headers['content-security-policy']);
        assert.deepEqual(d['frame-ancestors'], ["'none'"], nom);
    }
});

test('l exfiltration du jeton est fermee : connect-src et img-src sans joker', () => {
    for (const vitrine of [false, true]) {
        const d = directives(construireCsp({ vitrine }));
        for (const nom of ['connect-src', 'img-src', 'default-src']) {
            assert.ok(!d[nom].includes('*'), `${nom} ne doit pas contenir de joker`);
            assert.ok(!d[nom].some((v) => v === 'https:' || v === 'http:'),
                `${nom} ne doit pas autoriser un schema entier`);
        }
        assert.equal(d['object-src'][0], "'none'");
        assert.deepEqual(d['base-uri'], ["'self'"]);
    }
});

test('le dashboard laisse passer ce dont il a reellement besoin', () => {
    const d = directives(construireCsp({ vitrine: false }));
    assert.ok(d['img-src'].includes('https://cdn.discordapp.com'), 'avatars et icones Discord');
    assert.ok(d['style-src'].includes('https://fonts.googleapis.com'), 'import de la police Inter');
    assert.ok(d['font-src'].includes('https://fonts.gstatic.com'), 'fichiers de police');
});

test('la vitrine autorise le design system, et le dashboard non', () => {
    const vitrine = directives(construireCsp({ vitrine: true }));
    const dashboard = directives(construireCsp({ vitrine: false }));
    assert.ok(vitrine['script-src'].includes('https://design.vena.city'));
    // Le dashboard tourne sur sa copie locale : lui ouvrir le DS distant
    // elargirait la surface sans aucun usage.
    assert.ok(!dashboard['script-src'].includes('https://design.vena.city'));
});

test('les origines externes suivent la configuration, jamais codees en dur', () => {
    // Sans cela, toute personne qui auto-heberge avec son propre design system
    // verrait sa vitrine se briser sans message d erreur exploitable.
    const avant = process.env.VNCT_DS_BASE_URL;
    process.env.VNCT_DS_BASE_URL = 'https://ds.exemple.test/quelque/chemin';
    try {
        const d = directives(construireCsp({ vitrine: true }));
        assert.ok(d['script-src'].includes('https://ds.exemple.test'), 'origine attendue');
        assert.ok(!d['script-src'].includes('https://design.vena.city'), 'defaut ne doit pas subsister');
        // Seule l origine compte : un chemin dans une source CSP serait ignore.
        assert.ok(!d['script-src'].some((v) => v.includes('/quelque')));
    } finally {
        if (avant === undefined) delete process.env.VNCT_DS_BASE_URL;
        else process.env.VNCT_DS_BASE_URL = avant;
    }
});

test('script-src tolere encore l inline, et ce test doit echouer quand ce ne sera plus vrai', () => {
    // Rappel volontaire. Le dashboard compte une centaine de gestionnaires
    // `onclick=` : tant qu ils existent, une CSP stricte le rendrait
    // inutilisable. Quand ils auront disparu, retirer 'unsafe-inline' de
    // script-src ET mettre a jour ce test.
    const d = directives(construireCsp({ vitrine: false }));
    assert.ok(d['script-src'].includes("'unsafe-inline'"),
        "si cette assertion tombe, c est que script-src a ete resserre : verifier que les gestionnaires en ligne ont bien tous disparu");
});
