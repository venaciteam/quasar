// ═══════════════════════════════════════════════════════════════
//  OAuth2 du dashboard — Discord ou Fluxer, selon QUASAR_PLATFORM
//
//  Le parcours est le MÊME des deux côtés, et c'est voulu : même CALLBACK_URL,
//  même route `/callback`, même session JWT, même cookie, même redirection
//  finale. Seuls changent les trois points où les deux plateformes diffèrent
//  réellement — l'adresse d'autorisation, celle de l'échange de jeton, et les
//  deux lectures qui suivent (identité, liste des serveurs).
//
//  ⚠️ Le fournisseur est choisi par `resolvePlatformName()`, PAS par
//  l'adaptateur. La différence compte : cette route doit fonctionner en mode
//  `site` comme avant que le bot ne soit connecté, et `resolvePlatformName` lit
//  une variable d'environnement sans rien instancier.
//
//  ⚠️ Aucune valeur secrète ici. Les identifiants d'application se lisent dans
//  l'environnement, variable par variable, et le garde de configuration
//  d'`index.js` refuse de démarrer si celles de la plateforme active manquent.
//
//  ─── Ce qui NE change pas entre les deux ────────────────────────────────────
//
//  Les droits d'administration se vérifient exactement comme avant : le masque
//  `permissions` que la plateforme renvoie sur chaque serveur de la personne,
//  testé contre le bit ADMINISTRATOR (1 << 3), identique des deux côtés. C'est
//  `api/routes/guilds.js` et `middleware/auth.js` qui l'appliquent, à partir de
//  la liste stockée dans le jeton de session — ils n'ont pas été touchés.
//
//  ⚠️ PIÈGE Fluxer, vérifié dans la documentation : parmi les routes de
//  permissions, SEULE « List guild roles » accepte un bearer utilisateur. Les
//  autres répondent 403. Le dashboard ne lit donc JAMAIS les rôles d'un serveur
//  avec le jeton de la personne : il passe par `adaptateur.api`, c'est-à-dire
//  par le jeton du BOT (cf. api/routes/guilds.js).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { generateToken } = require('../middleware/auth');
const { resolvePlatformName } = require('../../bot/platform');
const router = express.Router();

// ─── Fournisseurs ───────────────────────────────────────────────────────────
//
// Une entrée par plateforme. `scopes` reprend, du côté Fluxer, l'équivalent
// exact des deux scopes Discord : lire l'identité, lire la liste des serveurs.
// Aucun scope de plus — un dashboard n'a pas besoin de l'adresse e-mail ni des
// connexions, et les demander ferait peur à juste titre sur l'écran de consentement.

const FOURNISSEURS = Object.freeze({
    discord: {
        autorisation: 'https://discord.com/oauth2/authorize',
        jeton: 'https://discord.com/api/v10/oauth2/token',
        identite: 'https://discord.com/api/v10/users/@me',
        serveurs: 'https://discord.com/api/v10/users/@me/guilds',
        scopes: 'identify guilds',
        // Scopes du lien d'INVITATION du bot (cf. routes/bot.js).
        scopesBot: 'bot applications.commands',
        clientId: (env) => env.DISCORD_CLIENT_ID,
        clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
        libelle: 'Discord',
    },
    fluxer: {
        // Toutes les routes OAuth2 de Fluxer vivent sous l'API : `authorize`
        // répond par une redirection vers l'interface de consentement.
        autorisation: (env) => `${baseFluxer(env)}/oauth2/authorize`,
        jeton: (env) => `${baseFluxer(env)}/oauth2/token`,
        // `userinfo` est la route de l'identité déléguée (scope `identify`).
        identite: (env) => `${baseFluxer(env)}/oauth2/userinfo`,
        // `limit=100` n'est pas décoratif : au-delà de 100 serveurs, Fluxer
        // OMET `permissions` de TOUTES les entrées de la page, et la personne
        // n'apparaîtrait administratrice de nulle part.
        serveurs: (env) => `${baseFluxer(env)}/users/@me/guilds?limit=100`,
        scopes: 'identify guilds',
        // `applications.commands` n'existe PAS au registre de scopes de Fluxer,
        // et un scope inconnu fait rejeter toute la demande d'autorisation : le
        // lien d'invitation serait mort. Le scope `bot` suffit — il n'y a pas de
        // commande d'application à autoriser.
        scopesBot: 'bot',
        clientId: (env) => env.FLUXER_CLIENT_ID,
        clientSecret: (env) => env.FLUXER_CLIENT_SECRET,
        libelle: 'Fluxer',
    },
});

/** Base REST de l'instance Fluxer visée, sans barre oblique finale. */
function baseFluxer(env) {
    return (env.FLUXER_API_BASE || 'https://api.fluxer.app/v1').replace(/\/+$/, '');
}

/** Résout une entrée du fournisseur, qu'elle soit littérale ou calculée. */
function valeur(entree, env) {
    return typeof entree === 'function' ? entree(env) : entree;
}

/**
 * Fournisseur de la plateforme active.
 *
 * Une valeur de `QUASAR_PLATFORM` illisible ne doit pas faire tomber la route
 * en 500 : `main()` refuse déjà de démarrer dans ce cas, et si on en est là
 * c'est un mode `site`. On retombe sur Discord, le défaut de tout le projet.
 */
function fournisseur(env = process.env) {
    let nom;
    try {
        nom = resolvePlatformName(env);
    } catch {
        nom = 'discord';
    }
    return { nom, ...FOURNISSEURS[nom] };
}

// Redirect vers la page de consentement de la plateforme
router.get('/login', (req, res) => {
    const f = fournisseur();
    const params = new URLSearchParams({
        client_id: valeur(f.clientId, process.env),
        redirect_uri: process.env.CALLBACK_URL,
        response_type: 'code',
        scope: f.scopes,
    });
    res.redirect(`${valeur(f.autorisation, process.env)}?${params}`);
});

// Callback OAuth2
router.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    const f = fournisseur();

    try {
        // Échanger le code contre un token
        const tokenRes = await fetch(valeur(f.jeton, process.env), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: valeur(f.clientId, process.env),
                client_secret: valeur(f.clientSecret, process.env),
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.CALLBACK_URL
            })
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            // Tracé, et pas seulement redirigé : sans cette ligne, l'échec de
            // l'échange était totalement muet côté serveur — l'utilisatrice
            // atterrissait sur la page d'accueil et les logs ne montraient rien.
            // `tokenData.error` porte la raison de la plateforme (invalid_grant,
            // invalid_client…) et ne contient aucun secret.
            console.error(`[Quasar] Échange du code OAuth2 refusé par ${f.libelle} :`,
                tokenData.error || 'réponse sans access_token', tokenData.error_description || '');
            return res.redirect('/?error=token_failed');
        }

        const bearer = { Authorization: `Bearer ${tokenData.access_token}` };

        // Récupérer l'utilisateur
        const userRes = await fetch(valeur(f.identite, process.env), { headers: bearer });
        const user = await userRes.json();

        // Récupérer les serveurs de la personne
        const guildsRes = await fetch(valeur(f.serveurs, process.env), { headers: bearer });
        const guilds = await guildsRes.json();

        // La plateforme ne répond pas toujours un tableau : une limite de débit
        // (429) ou un jeton révoqué entre-temps donne un objet d'erreur. Sans
        // cette garde, le `.map()` ci-dessous lève, et l'utilisatrice se
        // retrouve sur `/?error=auth_failed` — un message qui désigne
        // l'authentification alors que celle-ci a parfaitement réussi.
        if (!Array.isArray(guilds)) {
            console.error(`[Quasar] Réponse inattendue de la liste des serveurs (${f.libelle}) :`,
                guilds && guilds.message ? guilds.message : 'format non reconnu');
            return res.redirect('/?error=guilds_failed');
        }

        // Générer JWT
        const jwt = generateToken({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            guilds: guilds.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                // Masque de permissions de la personne sur ce serveur. Les deux
                // plateformes le rendent sous la même forme (entier sérialisé
                // en chaîne) et le bit ADMINISTRATOR y vaut 1 << 3 de part et
                // d'autre. `'0'` plutôt qu'`undefined` quand il manque : le
                // middleware fait un `BigInt(g.permissions)`, qui lèverait.
                permissions: g.permissions ?? '0'
            }))
        });

        // Cookie sécurisé + redirect
        // Passer le token via URL pour stockage en localStorage (évite les problèmes de cookie avec Cloudflare)
        res.redirect(`/dashboard/app.html?token=${jwt}`);
    } catch (error) {
        console.error('[Quasar] Erreur OAuth2:', error);
        res.redirect('/?error=auth_failed');
    }
});

// Déconnexion
router.get('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/');
});

// Info utilisateur connecté
router.get('/me', (req, res) => {
    const token = req.cookies?.token
        || req.headers.authorization?.replace('Bearer ', '');

    // 401 et non 200 sur un échec. Deux raisons : un 401 n'est jamais mis en
    // cache par défaut, là où un 200 l'est dès qu'un intermédiaire applique son
    // heuristique ; et un échec d'authentification devient visible dans l'onglet
    // réseau au lieu de se confondre avec une réponse normale. Le corps
    // `{ authenticated: false }` est conservé : les appelants qui le lisent
    // (dashboard/index.html) continuent de fonctionner à l'identique, et
    // `app.js` intercepte déjà les 401.
    if (!token) return res.status(401).json({ authenticated: false });

    const { verifyToken } = require('../middleware/auth');
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ authenticated: false });

    res.json({ authenticated: true, user });
});

module.exports = router;
module.exports.FOURNISSEURS = FOURNISSEURS;
module.exports.fournisseur = fournisseur;
module.exports.valeur = valeur;
