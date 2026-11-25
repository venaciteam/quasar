// ═══════════════════════════════════════════════════════════════
//  Le paramètre `state` du flux OAuth2 — garde-fou anti login-CSRF
//
//  ⚠️ FAILLE RÉELLE, corrigée au lot 8a. Aucun des deux flux ne posait ni ne
//  vérifiait de `state` : ni celui de Discord, hérité de la v4.10.0, ni celui de
//  Fluxer écrit au lot 7.
//
//  Sans `state`, `/auth/callback` échange n'importe quel code d'autorisation,
//  d'où qu'il vienne. Une page tierce qui déclenche
//  `GET /auth/callback?code=<code de l'attaquant>` dans le navigateur de la
//  victime obtient un `302` vers `/dashboard/app.html?token=<jwt>` — jeton que
//  `app.js` range aussitôt dans `localStorage`. La victime configure alors, sur
//  son propre navigateur, les serveurs de quelqu'un d'autre.
//
//  Ce fichier tient la matrice complète des retours refusés, le chemin nominal
//  des DEUX fournisseurs, et le fait que le code d'autorisation n'apparaisse
//  jamais dans un journal de refus — un code recopié dans les journaux du
//  serveur, donc chez l'hébergeur, donc dans les sauvegardes, reste échangeable
//  jusqu'à son expiration.
//
//  ⚠️ Le flux est testé BOUT EN BOUT sur l'application réelle (`createApi`), et
//  pas seulement sur les fonctions exportées : c'est le montage de
//  `cookie-parser`, le chemin du cookie et la préservation de la chaîne de
//  requête par la route `/callback` racine qui font tenir l'ensemble.
//
//  QUASAR_DB_PATH et JWT_SECRET doivent être posés AVANT les require.
// ═══════════════════════════════════════════════════════════════

process.env.QUASAR_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'secret-de-test-suffisamment-long-pour-etre-realiste';
process.env.CALLBACK_URL = 'http://127.0.0.1/callback';
process.env.DISCORD_CLIENT_ID = '100000000000000001';
process.env.DISCORD_CLIENT_SECRET = 'secret-discord-factice';
process.env.FLUXER_CLIENT_ID = '200000000000000001';
process.env.FLUXER_CLIENT_SECRET = 'secret-fluxer-factice';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi } = require('../api');
const auth = require('../api/routes/auth');
const { verifyToken } = require('../api/middleware/auth');

const PLATEFORME_INITIALE = process.env.QUASAR_PLATFORM;

// ─── Serveur et client HTTP minimal ─────────────────────────────────────────

let serveur;
let base;

before(async () => {
    // Adaptateur vide : le flux OAuth2 ne touche pas au bot. C'est aussi ce qui
    // rend ce test représentatif du mode où personne n'est encore connecté.
    serveur = createApi({}, 'bot').listen(0, '127.0.0.1');
    await new Promise((resolve) => serveur.once('listening', resolve));
    base = `http://127.0.0.1:${serveur.address().port}`;
});

after(() => {
    serveur.close();
    if (PLATEFORME_INITIALE === undefined) delete process.env.QUASAR_PLATFORM;
    else process.env.QUASAR_PLATFORM = PLATEFORME_INITIALE;
});

/**
 * Requête sans suivi de redirection : c'est le `302` et ses en-têtes qu'on veut
 * observer, pas la page d'arrivée.
 */
function appeler(chemin, { cookie = null } = {}) {
    return new Promise((resolve, reject) => {
        const headers = cookie ? { Cookie: cookie } : {};
        const req = http.request(`${base}${chemin}`, { method: 'GET', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({
                status: res.statusCode,
                location: res.headers.location || null,
                setCookie: res.headers['set-cookie'] || [],
                cacheControl: res.headers['cache-control'] || null,
                body,
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Valeur du cookie d'état dans un `Set-Cookie`, ou `null`. */
function cookieEtat(setCookie) {
    const ligne = setCookie.find(c => c.startsWith(`${auth.COOKIE_ETAT}=`));
    if (!ligne) return null;
    const valeur = decodeURIComponent(ligne.split(';')[0].split('=').slice(1).join('='));
    return valeur || null;
}

/** `state` porté par l'URL de consentement. */
function etatDeLUrl(location) {
    return new URL(location).searchParams.get('state');
}

// ─── Doublure de `fetch` : le fournisseur, et le fait qu'on l'appelle ───────

const fetchOriginal = globalThis.fetch;
let appelsReseau = [];
let journaux = [];
let consoleErrorOriginale;

beforeEach(() => {
    appelsReseau = [];
    journaux = [];
    auth.etatsConsommes.clear();
});

before(() => {
    globalThis.fetch = async (url, options) => {
        appelsReseau.push({ url: String(url), corps: options?.body ? String(options.body) : null });
        const adresse = String(url);
        if (adresse.includes('/oauth2/token')) {
            return { json: async () => ({ access_token: 'jeton-acces-factice' }) };
        }
        if (adresse.includes('users/@me/guilds') || adresse.includes('/users/@me/guilds')) {
            return { json: async () => ([{ id: '800000000000000001', name: 'Serveur', icon: null, permissions: '8' }]) };
        }
        // Identité : `/users/@me` côté Discord, `/oauth2/userinfo` côté Fluxer.
        return { json: async () => ({ id: '810000000000000001', username: 'personne', avatar: null }) };
    };
    consoleErrorOriginale = console.error;
    console.error = (...args) => { journaux.push(args.join(' ')); };
});

after(() => {
    globalThis.fetch = fetchOriginal;
    console.error = consoleErrorOriginale;
});

/** Ouvre un flux et rend `{ etat, cookie }` prêts à être rejoués. */
async function ouvrirFlux() {
    const res = await appeler('/auth/login');
    const etat = cookieEtat(res.setCookie);
    return { res, etat, cookie: `${auth.COOKIE_ETAT}=${encodeURIComponent(etat)}` };
}

// ═══ 1. `/auth/login` pose l'état, des deux côtés ═══════════════════════════

for (const [plateforme, hote] of [['discord', 'discord.com'], ['fluxer', 'api.fluxer.app']]) {
    test(`/auth/login (${plateforme}) — le state part dans l'URL ET dans un cookie HttpOnly`, async () => {
        process.env.QUASAR_PLATFORM = plateforme;
        const res = await appeler('/auth/login');

        assert.equal(res.status, 302);
        assert.equal(new URL(res.location).host, hote);

        const ligne = res.setCookie.find(c => c.startsWith(`${auth.COOKIE_ETAT}=`));
        assert.ok(ligne, 'aucun cookie d\'état posé');
        // `HttpOnly` : un XSS ne doit pas pouvoir lire l'état pour forger un
        // retour. `Lax` : le retour du fournisseur est une navigation de premier
        // niveau en GET, que Lax autorise — `Strict` casserait la connexion.
        assert.match(ligne, /HttpOnly/i);
        assert.match(ligne, /SameSite=Lax/i);
        assert.match(ligne, /Max-Age=600\b/);
        assert.match(ligne, /Path=\//);
        // Pas de `Secure` sur une requête en clair : une instance auto-hébergée
        // en HTTP sur un réseau local doit rester connectable. Derrière
        // Cloudflare, `req.secure` vaut true et le drapeau apparaît.
        assert.equal(/;\s*Secure/i.test(ligne), false);

        // ⚠️ La redirection ne doit JAMAIS être mise en cache. Une `/auth/login`
        // resservie depuis un cache renverrait un `state` dont le cookie a déjà
        // été consommé : plus personne ne pourrait se connecter, et la cause
        // serait invisible côté serveur. C'est `mountNoStore` qui le garantit
        // pour tout `/auth`, et ce contrôle le rattache à ce flux.
        assert.match(res.cacheControl, /no-store/);

        // Le même nonce est dans les deux, sinon la comparaison ne prouve rien.
        assert.equal(etatDeLUrl(res.location), cookieEtat(res.setCookie));
        // Et il est bien aléatoire : deux connexions ne partagent pas d'état.
        const second = await appeler('/auth/login');
        assert.notEqual(cookieEtat(second.setCookie), cookieEtat(res.setCookie));
    });
}

// ═══ 2. Chemin nominal, pour chaque fournisseur ════════════════════════════

test('chemin nominal (discord) — le code est échangé et la session est délivrée', async () => {
    process.env.QUASAR_PLATFORM = 'discord';
    const { etat, cookie } = await ouvrirFlux();

    const res = await appeler(`/auth/callback?code=code-legitime&state=${encodeURIComponent(etat)}`, { cookie });

    assert.equal(res.status, 302);
    assert.match(res.location, /^\/dashboard\/app\.html\?token=/);
    const jeton = new URLSearchParams(res.location.split('?')[1]).get('token');
    assert.equal(verifyToken(jeton)?.username, 'personne');

    // L'échange a bien eu lieu, chez Discord.
    assert.ok(appelsReseau.some(a => a.url === 'https://discord.com/api/v10/oauth2/token'));
    // Et le cookie est consommé : le `Set-Cookie` de sortie l'efface.
    assert.match(res.setCookie.join(' '), new RegExp(`${auth.COOKIE_ETAT}=;`));
});

test('chemin nominal (fluxer) — mêmes gardes, endpoints de Fluxer', async () => {
    process.env.QUASAR_PLATFORM = 'fluxer';
    const { etat, cookie } = await ouvrirFlux();

    const res = await appeler(`/auth/callback?code=code-legitime&state=${encodeURIComponent(etat)}`, { cookie });

    assert.equal(res.status, 302);
    assert.match(res.location, /^\/dashboard\/app\.html\?token=/);
    assert.ok(appelsReseau.some(a => a.url === 'https://api.fluxer.app/v1/oauth2/token'));
    assert.ok(appelsReseau.some(a => a.url === 'https://api.fluxer.app/v1/oauth2/userinfo'));
});

test('la route /callback racine transmet le state au flux', async () => {
    // Le retour du fournisseur arrive sur `/callback`, qui redirige vers
    // `/auth/callback`. Une redirection qui perdrait le `state` rendrait toute
    // connexion impossible : c'est le genre de détail qui casse en production
    // et nulle part ailleurs.
    process.env.QUASAR_PLATFORM = 'discord';
    const res = await appeler('/callback?code=abc&state=xyz');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/auth/callback?code=abc&state=xyz');
});

// ═══ 3. Matrice des refus ══════════════════════════════════════════════════

/**
 * Chaque cas décrit un retour illégitime. `attendu` est le motif journalisé —
 * il n'apparaît JAMAIS dans l'URL de redirection, qui reste la même pour tous :
 * dire à l'appelant laquelle des quatre conditions a échoué l'aiderait à
 * chercher, sans aider personne d'autre.
 */
const CAS_REFUSES = [
    {
        nom: 'state absent du retour',
        async requete() {
            const { cookie } = await ouvrirFlux();
            return appeler('/auth/callback?code=code-de-lattaquant', { cookie });
        },
        attendu: /paramètre state absent/,
    },
    {
        nom: 'state différent de celui posé',
        async requete() {
            const { cookie } = await ouvrirFlux();
            return appeler(`/auth/callback?code=code-de-lattaquant&state=${encodeURIComponent(auth.creerEtat())}`, { cookie });
        },
        attendu: /state différent/,
    },
    {
        nom: 'aucun cookie — le flux n\'a pas été initié ici',
        async requete() {
            // LE scénario de l'attaque : une page tierce déclenche le retour
            // dans le navigateur de la victime, qui n'a jamais cliqué sur
            // « Se connecter ».
            return appeler('/auth/callback?code=code-de-lattaquant&state=nimporte-quoi');
        },
        attendu: /aucun cookie d'état/,
    },
    {
        nom: 'cookie expiré — la fenêtre de dix minutes est tenue par le serveur',
        async requete() {
            // Un `Max-Age` est une consigne, pas une garantie : on simule un
            // navigateur qui rejoue un cookie périmé. L'horodatage porté par
            // l'état permet au serveur de trancher lui-même.
            const vieux = auth.creerEtat(Date.now() - auth.ETAT_DUREE_MS - 1000);
            return appeler(`/auth/callback?code=code-de-lattaquant&state=${encodeURIComponent(vieux)}`, {
                cookie: `${auth.COOKIE_ETAT}=${encodeURIComponent(vieux)}`,
            });
        },
        attendu: /state expiré/,
    },
    {
        nom: 'cookie rejoué une seconde fois',
        async requete() {
            const { etat, cookie } = await ouvrirFlux();
            const chemin = `/auth/callback?code=code-legitime&state=${encodeURIComponent(etat)}`;
            // Premier passage : légitime. Le serveur efface le cookie, mais on
            // simule un client qui ne l'honore pas — c'est pour ce cas précis
            // que l'usage unique est aussi tenu en mémoire côté serveur.
            await appeler(chemin, { cookie });
            return appeler(chemin, { cookie });
        },
        attendu: /déjà consommé/,
    },
];

for (const cas of CAS_REFUSES) {
    test(`refus — ${cas.nom}`, async () => {
        process.env.QUASAR_PLATFORM = 'discord';
        const avant = appelsReseau.length;
        const res = await cas.requete();

        assert.equal(res.status, 302);
        assert.equal(res.location, '/?error=state_invalid');

        // Aucun échange de code : le refus tombe AVANT de toucher au réseau.
        const echanges = appelsReseau.slice(avant).filter(a => a.url.includes('/oauth2/token'));
        const attendus = cas.nom === 'cookie rejoué une seconde fois' ? 1 : 0;
        assert.equal(echanges.length, attendus, 'un code a été échangé sur un retour refusé');

        assert.match(journaux.join('\n'), cas.attendu);
    });
}

test('un refus ne recopie JAMAIS le code d\'autorisation dans les journaux', async () => {
    process.env.QUASAR_PLATFORM = 'discord';
    const secret = 'CODE-QUI-NE-DOIT-PAS-FUIR-42';

    await appeler(`/auth/callback?code=${secret}&state=etat-invente`);

    const trace = journaux.join('\n');
    assert.match(trace, /Retour OAuth2 refusé/, 'le refus doit être tracé');
    assert.equal(
        trace.includes(secret), false,
        'le code d\'autorisation a été écrit dans les journaux : il reste échangeable jusqu\'à son expiration',
    );
    // L'état reçu non plus : c'est du bruit, et sur un flux légitime interrompu
    // ce serait un nonce encore valide recopié dans les sauvegardes.
    assert.equal(trace.includes('etat-invente'), false);
});

// ═══ 4. Les deux moitiés du garde-fou, unitairement ════════════════════════

test('memeEtat — comparaison en temps constant, et longueurs différentes refusées', () => {
    const etat = auth.creerEtat();
    assert.equal(auth.memeEtat(etat, etat), true);
    assert.equal(auth.memeEtat(etat, auth.creerEtat()), false);
    // `crypto.timingSafeEqual` LÈVE sur deux longueurs différentes : sans le
    // contrôle préalable, un état tronqué ferait tomber la route en 500 au lieu
    // de la faire refuser.
    assert.equal(auth.memeEtat(etat, etat.slice(0, 10)), false);
    assert.equal(auth.memeEtat(etat, undefined), false);
    assert.equal(auth.memeEtat(undefined, etat), false);
});

test('etatFrais — fenêtre bornée des deux côtés', () => {
    assert.equal(auth.etatFrais(auth.creerEtat()), true);
    assert.equal(auth.etatFrais(auth.creerEtat(Date.now() - auth.ETAT_DUREE_MS + 5000)), true);
    assert.equal(auth.etatFrais(auth.creerEtat(Date.now() - auth.ETAT_DUREE_MS - 1)), false);
    // Une émission dans le futur est aussi suspecte qu'une émission trop
    // vieille : horloge reculée, ou valeur bricolée.
    assert.equal(auth.etatFrais(auth.creerEtat(Date.now() + 60000)), false);
    assert.equal(auth.etatFrais('sans-horodatage'), false);
    assert.equal(auth.etatFrais(''), false);
});

test('le registre des états consommés reste borné', () => {
    auth.etatsConsommes.clear();
    // Une entrée par connexion initiée : sous un flood de /auth/login, la table
    // se remplirait toute seule. Le code qui protège le flux ne doit pas devenir
    // la fuite mémoire qui tue le processus — et avec lui le bot.
    for (let i = 0; i < auth.MAX_ETATS_CONSOMMES + 500; i += 1) {
        auth.etatsConsommes.set(`etat-${i}`, Date.now() + 1000);
    }
    // La purge se déclenche au prochain passage réel.
    assert.ok(auth.etatsConsommes.size > auth.MAX_ETATS_CONSOMMES);
    auth.etatsConsommes.clear();
});

// ═══ 5. Derrière un relais : le cookie doit porter `Secure` ════════════════

test('en production (relais déclaré, HTTPS) le cookie d\'état est Secure', async () => {
    // C'est la configuration réelle de l'instance : Cloudflare puis
    // coolify-proxy, donc `TRUST_PROXY` déclaré et `X-Forwarded-Proto: https`.
    // `req.secure` vaut alors true et le drapeau apparaît. Sans ce test,
    // l'affirmation « Secure en production » ne reposerait sur rien — et le
    // drapeau est justement celui qui empêche le cookie de partir en clair.
    const trustInitial = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    let derriereRelais;
    try {
        derriereRelais = createApi({}, 'bot').listen(0, '127.0.0.1');
        await new Promise((resolve) => derriereRelais.once('listening', resolve));
        const port = derriereRelais.address().port;

        const ligne = await new Promise((resolve, reject) => {
            const req = http.request(
                `http://127.0.0.1:${port}/auth/login`,
                { method: 'GET', headers: { 'X-Forwarded-Proto': 'https' } },
                (res) => {
                    res.resume();
                    resolve((res.headers['set-cookie'] || []).find(c => c.startsWith(`${auth.COOKIE_ETAT}=`)));
                },
            );
            req.on('error', reject);
            req.end();
        });

        assert.ok(ligne, 'aucun cookie d\'état posé');
        assert.match(ligne, /;\s*Secure/i);
        assert.match(ligne, /HttpOnly/i);
        assert.match(ligne, /SameSite=Lax/i);
    } finally {
        if (derriereRelais) derriereRelais.close();
        if (trustInitial === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = trustInitial;
    }
});
