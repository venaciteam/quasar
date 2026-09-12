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
//
//  ─── Le paramètre `state`, et pourquoi il n'est pas optionnel ───────────────
//
//  ⚠️ FAILLE RÉELLE, corrigée au lot 8a. Aucun des deux flux ne posait ni ne
//  vérifiait de `state` : ni celui de Discord, hérité de la v4.10.0, ni celui de
//  Fluxer écrit au lot 7.
//
//  Sans `state`, `/auth/callback` accepte n'importe quel code d'autorisation,
//  d'où qu'il vienne. Une page tierce qui déclenche
//  `GET /auth/callback?code=<code de l'attaquant>` dans le navigateur de la
//  victime fait échanger CE code, et la réponse redirige vers
//  `/dashboard/app.html?token=<jwt>` — jeton que `app.js` range aussitôt dans
//  `localStorage`. La victime se retrouve connectée au COMPTE DE L'ATTAQUANT,
//  sur son propre navigateur, sans l'avoir demandé : tout ce qu'elle configure
//  ensuite part dans les serveurs de quelqu'un d'autre. C'est la forme
//  « login CSRF » de la classe, et le dashboard y était entièrement exposé.
//
//  La correction tient en une phrase : `/auth/login` tire un nonce de 32 octets,
//  le pose dans un cookie `HttpOnly` de dix minutes ET le passe en `state` ;
//  `/auth/callback` EXIGE que les deux correspondent, en temps constant, avant
//  de toucher au code. Le cookie est consommé dans tous les cas.
//
//  Aucune branche par plateforme : le `state` est ajouté aux paramètres communs,
//  les deux entrées de `FOURNISSEURS` le transportent sans le savoir. OAuth2 le
//  renvoie à l'identique sur la redirection de retour, des deux côtés — c'est
//  dans la spécification, et la documentation de Fluxer le confirme
//  explicitement (« The value is returned unchanged after normalisation, on both
//  the success redirect and the error redirect »).
//
//  ⚠️ `SameSite=Lax` est bien le bon réglage, et c'est le point qu'il ne faut pas
//  se tromper : le retour de `discord.com` / `fluxer.app` est une NAVIGATION de
//  premier niveau en GET, cas que `Lax` autorise explicitement. `Strict`
//  casserait le retour — le cookie ne serait pas envoyé et personne ne pourrait
//  plus se connecter. `None` rouvrirait la porte aux requêtes tierces.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
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

// ═══════════════════════════════════════════════════════════════
//  Le nonce anti-CSRF du flux OAuth2
//
//  Forme de la valeur : `<nonce base64url>.<émission en base 36>`.
//
//  Le nonce seul suffirait à lier le retour à la navigatrice — c'est le cookie
//  qui fait autorité, et lui seul est infalsifiable. L'horodatage est là pour
//  que l'EXPIRATION soit tenue par le serveur et pas par le navigateur : un
//  `Max-Age` est une consigne, pas une garantie, et un client qui garde son
//  cookie plus longtemps que demandé ne doit pas allonger la fenêtre pendant
//  laquelle un code volé reste rejouable. Le lire depuis la valeur ne présente
//  aucun risque : on ne le lit qu'APRÈS avoir constaté qu'elle est identique à
//  celle qu'on a nous-mêmes émise.
// ═══════════════════════════════════════════════════════════════

const COOKIE_ETAT = 'quasar_oauth_state';

// Dix minutes. Assez pour lire un écran de consentement sans se presser, assez
// court pour que la fenêtre de rejeu d'un code intercepté reste étroite. C'est
// aussi la durée de vie d'un code d'autorisation côté Fluxer.
const ETAT_DUREE_MS = 10 * 60 * 1000;

const OCTETS_NONCE = 32;

/** Valeur d'état neuve, à poser en cookie ET à passer en paramètre. */
function creerEtat(maintenant = Date.now()) {
    return `${crypto.randomBytes(OCTETS_NONCE).toString('base64url')}.${maintenant.toString(36)}`;
}

/**
 * Pose le cookie d'état et rend sa valeur.
 *
 * `secure` suit `req.secure` plutôt qu'un `NODE_ENV` : c'est la même règle que
 * l'en-tête HSTS d'`api/index.js`, et pour la même raison — une instance
 * auto-hébergée joignable en HTTP sur un réseau local ne doit pas se retrouver
 * avec un cookie que le navigateur refuse d'envoyer, donc avec une connexion
 * impossible. Derrière Cloudflare et Traefik, `req.secure` lit
 * `X-Forwarded-Proto` (cf. TRUST_PROXY), et vaut donc `true` en production.
 *
 * `path: '/'` et non `/auth` : le retour du fournisseur arrive parfois sur
 * `/callback` à la racine, qui redirige ensuite vers `/auth/callback`. Un cookie
 * limité à `/auth` ne serait pas envoyé au premier saut.
 */
function poserEtat(req, res) {
    const etat = creerEtat();
    res.cookie(COOKIE_ETAT, etat, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: ETAT_DUREE_MS,
        path: '/',
    });
    return etat;
}

/**
 * Efface le cookie d'état. Appelé sur TOUS les chemins de retour, que l'état
 * corresponde ou non : un nonce qui survit à un refus se rejoue, et un nonce qui
 * survit à un succès rend un second code échangeable sur la même session.
 *
 * Les options répétées ne sont pas décoratives : un navigateur n'efface un
 * cookie que si le nom, le domaine ET le chemin correspondent.
 */
function effacerEtat(req, res) {
    res.clearCookie(COOKIE_ETAT, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        path: '/',
    });
}

// ─── Usage unique, tenu par le SERVEUR ──────────────────────────────────────
//
// Effacer le cookie ne suffit pas à garantir l'usage unique : un `Set-Cookie`
// est une consigne, et rien n'oblige un client à l'honorer. Sans registre côté
// serveur, une navigatrice qui conserve son cookie laisse le même état valider
// PLUSIEURS retours — donc plusieurs codes.
//
// D'où cette table, sur le modèle du limiteur de débit du relais de signalement
// (api/index.js) : en mémoire, sans dépendance, bornée. Elle n'a pas besoin de
// survivre à un redémarrage — celui-ci invalide de toute façon tous les états en
// vol, puisque la fenêtre est de dix minutes — et Quasar tourne en un seul
// processus.
//
// Ce qui est retenu est la valeur du COOKIE, pas celle de la requête : c'est
// nous qui l'avons émise, elle est donc inforgeable, et personne ne peut « brûler »
// l'état d'autrui en envoyant un `state` de son choix.

/** @type {Map<string, number>} état -> instant d'expiration */
const etatsConsommes = new Map();

// Plafond dur, même motif que la table du limiteur de débit : une entrée par
// connexion initiée, ça se remplit tout seul sous un flood de `/auth/login`.
// Sans borne, le code qui protège le flux devient la fuite mémoire qui tue le
// processus — et avec lui le bot, sur tous les serveurs à la fois.
const MAX_ETATS_CONSOMMES = 10000;

function purgerEtatsConsommes(maintenant) {
    for (const [etat, expire] of etatsConsommes) {
        if (expire <= maintenant) etatsConsommes.delete(etat);
    }
    // Si rien n'a expiré, on évince les plus anciennes entrées vues. Un état
    // oublié redevient rejouable pendant sa fenêtre, ce qui est moins grave
    // qu'une table sans fin — et il faut déjà dix mille connexions en dix
    // minutes pour y arriver.
    for (const etat of etatsConsommes.keys()) {
        if (etatsConsommes.size <= MAX_ETATS_CONSOMMES) break;
        etatsConsommes.delete(etat);
    }
}

function dejaConsomme(etat, maintenant = Date.now()) {
    const expire = etatsConsommes.get(etat);
    if (expire === undefined) return false;
    if (expire <= maintenant) { etatsConsommes.delete(etat); return false; }
    return true;
}

function consommer(etat, maintenant = Date.now()) {
    etatsConsommes.set(etat, maintenant + ETAT_DUREE_MS);
    if (etatsConsommes.size > MAX_ETATS_CONSOMMES) purgerEtatsConsommes(maintenant);
}

/** Comparaison en temps constant de deux valeurs d'état. */
function memeEtat(attendu, recu) {
    if (typeof attendu !== 'string' || typeof recu !== 'string') return false;
    const a = Buffer.from(attendu, 'utf8');
    const b = Buffer.from(recu, 'utf8');
    // `timingSafeEqual` LÈVE sur deux longueurs différentes : le contrôle est
    // obligatoire, et il ne révèle rien — la longueur d'un état est constante
    // par construction.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/** L'état a-t-il été émis il y a moins de `ETAT_DUREE_MS` ? */
function etatFrais(etat, maintenant = Date.now()) {
    const emission = Number.parseInt(String(etat).split('.')[1] || '', 36);
    if (!Number.isFinite(emission)) return false;
    // Une émission dans le futur est aussi suspecte qu'une émission trop vieille
    // (horloge reculée, valeur bricolée) : on refuse les deux.
    const age = maintenant - emission;
    return age >= 0 && age <= ETAT_DUREE_MS;
}

/**
 * Vérifie le retour du fournisseur. Consomme le cookie dans tous les cas.
 *
 * @returns {null|string} `null` si le retour est légitime, sinon le MOTIF du
 *   refus — destiné au journal, jamais à l'URL de redirection.
 */
function refuserEtat(req, res) {
    const attendu = req.cookies?.[COOKIE_ETAT];
    const recu = req.query?.state;

    // Consommé AVANT toute comparaison : aucun chemin de sortie ne peut
    // l'oublier, pas même une exception.
    effacerEtat(req, res);

    if (!attendu) return 'aucun cookie d\'état (flux non initié ici, ou expiré côté navigateur)';

    // Usage unique, avant les comparaisons : un état déjà présenté ne vaut plus
    // rien, même s'il correspond et qu'il est encore frais.
    if (dejaConsomme(attendu)) return 'state déjà consommé (rejeu)';
    consommer(attendu);

    if (!recu) return 'paramètre state absent du retour';
    if (!memeEtat(attendu, recu)) return 'state différent de celui posé à la connexion';
    if (!etatFrais(attendu)) return 'state expiré (plus de 10 minutes)';
    return null;
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
        // Lié à CE navigateur par le cookie posé juste avant. Les deux
        // fournisseurs le renvoient inchangé sur la redirection de retour.
        state: poserEtat(req, res),
    });
    res.redirect(`${valeur(f.autorisation, process.env)}?${params}`);
});

// ⚠️ Aucune destination de retour n'est acceptée en paramètre de `/auth/login`.
// Le flux redirige toujours vers `/dashboard/app.html`, et c'est volontaire : un
// paramètre de redirection libre est une redirection ouverte, c'est-à-dire
// exactement le vecteur qu'on vient de fermer. Si une page demandée avant
// connexion devait être restituée un jour, elle passerait par un SECOND cookie
// `HttpOnly` posé ici, jamais par la chaîne de requête.

// Callback OAuth2
router.get('/callback', async (req, res) => {
    const f = fournisseur();

    // ⚠️ AVANT TOUT LE RESTE, et avant de toucher au code : un retour dont
    // l'état ne correspond pas n'est pas un retour, c'est une requête tierce.
    const refus = refuserEtat(req, res);
    if (refus) {
        // Journalisé avec sa cause, et SANS le code d'autorisation ni l'état
        // reçu. Un code recopié dans les journaux du serveur — donc chez
        // l'hébergeur, donc dans les sauvegardes — reste échangeable jusqu'à son
        // expiration : un refus ne doit pas transformer une tentative en fuite.
        console.error(`[Quasar] Retour OAuth2 refusé (${f.libelle}) : ${refus}.`);
        return res.redirect('/?error=state_invalid');
    }

    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

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
// Exposés pour être testés sans navigateur : la comparaison en temps constant et
// la fenêtre de fraîcheur sont les deux moitiés du garde-fou.
module.exports.COOKIE_ETAT = COOKIE_ETAT;
module.exports.ETAT_DUREE_MS = ETAT_DUREE_MS;
module.exports.creerEtat = creerEtat;
module.exports.memeEtat = memeEtat;
module.exports.etatFrais = etatFrais;
module.exports.etatsConsommes = etatsConsommes;
module.exports.MAX_ETATS_CONSOMMES = MAX_ETATS_CONSOMMES;
