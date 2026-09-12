// ═══════════════════════════════════════════════════════════════
//  La plateforme, vue depuis l'API
//
//  `createApi` ne reçoit plus le client natif mais l'ADAPTATEUR (DA §4). Ce
//  module est le seul endroit de `api/` qui sait comment le lire : les routes
//  demandent « le client REST normalisé de cette requête » ou « les capacités
//  de la plateforme active », jamais `req.app.get(...)` suivi d'un chemin
//  d'objet. Deux raisons, et la seconde est la vraie :
//
//   1. une doublure de test peut être un objet vide — c'est ce que passent
//      `http-cache`, `error-body`, `feedback-relay` et les quatre autres — et
//      chaque route n'a pas à écrire sa propre garde ;
//   2. une seule lecture NATIVE subsiste — `guildeNative`, pour l'AutoMod, qui
//      n'a aucun équivalent portable — et elle est ici, où elle se compte.
//      Semée dans quinze routes, elle serait introuvable.
//
//  ⚠️ Rien de ce fichier n'importe `discord.js`, et rien ne doit le faire : il
//  est chargé dans un processus Fluxer comme dans un processus Discord.
// ═══════════════════════════════════════════════════════════════

const { creerCapacites } = require('../../bot/platform/capabilities');

// Capacités d'une plateforme qui ne s'est pas déclarée : toutes fausses. C'est
// le défaut de `creerCapacites`, et c'est le bon ici aussi — le dashboard
// masquera ce qu'il ne sait pas offrir plutôt que de proposer un bouton qui
// échoue. Ne concerne en pratique que les tests, qui montent l'API sans bot.
const CAPACITES_INCONNUES = creerCapacites({});


/** Adaptateur de la requête, ou `null` si l'API tourne sans bot (tests). */
function adaptateur(req) {
    return req.app.get('plateforme') || null;
}

/**
 * Client REST normalisé, ou `null`.
 *
 * Le `null` n'est pas une commodité : une route qui l'obtient doit répondre
 * « le bot n'est pas connecté à ce serveur », pas tomber en 500.
 */
function apiPlateforme(req) {
    const a = adaptateur(req);
    return a && a.api && typeof a.api.envoyerMessage === 'function' ? a.api : null;
}

function capacites(req) {
    return adaptateur(req)?.capacites || CAPACITES_INCONNUES;
}

function nom(req) {
    return adaptateur(req)?.nom || null;
}

/**
 * Préfixe des commandes texte, ou `null` quand la plateforme a des commandes
 * d'application. C'est cette valeur que le dashboard affiche devant un nom de
 * commande : `/warn` côté Discord, `!warn` côté Fluxer.
 */
function prefixe(req) {
    const a = adaptateur(req);
    if (!a || a.capacites?.interactions) return null;
    // `prefixe` est posé en non énumérable par l'adaptateur Fluxer (plomberie
    // interne, invisible au test de miroir) : il se lit, il ne s'énumère pas.
    return a.prefixe || null;
}

/**
 * Portée d'écriture neutre d'un serveur — le format que `bot/utils/errors.js`
 * reconnaît (`resoudrePorteeNeutre`) et que consomment `enterPanic`,
 * `liftPanic`, `sendAutomodLog` et `sendModLog`.
 *
 * `capacites` en fait partie : c'est ce qui permet au mode panique de répondre
 * « cette plateforme ne sait pas suspendre ses invitations » au lieu d'essayer.
 *
 * @returns {object|null} `null` si le bot n'est pas joignable.
 */
function portee(req, guildeId) {
    const a = adaptateur(req);
    const client = apiPlateforme(req);
    if (!a || !client) return null;
    return { guildeId: String(guildeId), api: client, moiId: a.moi?.id ?? null, capacites: a.capacites };
}

/**
 * Identité de la plateforme, telle que le dashboard la consomme.
 * @see api/routes/plateforme.js
 */
function description(adaptateurActif) {
    const a = adaptateurActif || null;
    return {
        nom: a?.nom || null,
        capacites: { ...(a?.capacites || CAPACITES_INCONNUES) },
        prefixe: a && !a.capacites?.interactions ? (a.prefixe || null) : null,
    };
}

// ═══════════════════════════════════════════════════════════════
//  Inventaires d'un serveur
//
//  Les quatre lecteurs ci-dessous étaient des REPLIS : ils lisaient le cache
//  discord.js quand le contrat ne publiait pas la méthode, et rendaient une
//  liste VIDE sur toute autre plateforme. Côté Fluxer, les sélecteurs de salons,
//  de rôles et d'emojis du dashboard étaient donc vides — sans erreur, sans
//  journal, et sans rien qui distingue « ce serveur n'a pas d'emoji » de « je ne
//  sais pas les lire ».
//
//  Le contrat les publie désormais (lot 0.8) et ces fonctions se réduisent à un
//  appel. Ce qu'elles gardent est la traduction d'un `null` :
//
//      null  ->  « je ne vois pas ce serveur »
//      []    ->  « il n'a rien »
//
//  Les trois sélecteurs aplatissent les deux cas, parce qu'un sélecteur vide est
//  la seule chose qu'ils sachent afficher. `listerMembres`, lui, les distingue :
//  la notification de violation (RGPD art. 33) doit pouvoir dire à la
//  propriétaire combien de serveurs n'ont PAS été atteints, et compter un
//  serveur illisible comme « zéro destinataire » serait un mensonge.
// ═══════════════════════════════════════════════════════════════

/**
 * Serveur NATIF vu par le client de la plateforme, ou `undefined`.
 *
 * ⚠️ Dernière lecture native de `api/`, et voie NOMINALE d'un seul appelant :
 * `api/routes/automod.js`. L'AutoMod natif n'a aucun équivalent hors Discord
 * (DA §2.2), `bot/utils/automodSync.js` est une exception nommée du test
 * d'étanchéité, et cette route est gardée par `capacites.automod`. Lui faire
 * traverser un contrat neutre reviendrait à inventer un vocabulaire portable
 * pour une fonctionnalité qui ne l'est pas.
 */
function guildeNative(req, guildeId) {
    return adaptateur(req)?.client?.guilds?.cache?.get(String(guildeId));
}

/**
 * Salons d'un serveur, normalisés : `{ id, nom, type, typeNatif, parentId, position }`.
 * @returns {Promise<object[]>} liste vide si le serveur n'est pas joignable.
 */
async function listerCanaux(req, guildeId) {
    const client = apiPlateforme(req);
    if (!client) return [];
    return (await client.listerCanaux(String(guildeId))) || [];
}

/**
 * Rôles d'un serveur : `{ id, nom, couleur, position, gere, parDefaut }`.
 * @returns {Promise<object[]>} liste vide si le serveur n'est pas joignable.
 */
async function listerRoles(req, guildeId) {
    const client = apiPlateforme(req);
    if (!client) return [];
    return (await client.listerRoles(String(guildeId))) || [];
}

/**
 * Emojis personnalisés d'un serveur : `{ id, nom, anime, identifiant, url }`.
 * @returns {Promise<object[]>} liste vide si le serveur n'est pas joignable.
 */
async function listerEmojis(req, guildeId) {
    const client = apiPlateforme(req);
    if (!client) return [];
    return (await client.listerEmojis(String(guildeId))) || [];
}

/**
 * Membres d'un serveur, pour les rares lectures qui ont besoin de la LISTE
 * (destinataires d'une notification de violation).
 *
 * @returns {Promise<{joignable: boolean, membres: object[]}>}
 *   `joignable: false` signifie « je ne vois pas ce serveur », jamais « il est
 *   vide » : la notification de l'article 33 en dépend pour dire à la
 *   propriétaire combien de serveurs elle n'a pas pu atteindre.
 */
async function listerMembres(req, guildeId) {
    const client = apiPlateforme(req);
    if (!client) return { joignable: false, membres: [] };
    const membres = await client.listerMembres(String(guildeId));
    return { joignable: membres !== null, membres: membres || [] };
}

module.exports = {
    adaptateur,
    api: apiPlateforme,
    capacites,
    nom,
    prefixe,
    portee,
    description,
    listerCanaux,
    listerRoles,
    listerEmojis,
    listerMembres,
    guildeNative,
    CAPACITES_INCONNUES,
};
