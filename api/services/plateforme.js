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
//   2. les quelques lectures que le CONTRAT ne couvre pas encore sont
//      rassemblées ici, chacune marquée `TRANSITION` et nommant la méthode qui
//      la lèvera. Semées dans quinze routes, elles seraient introuvables ; ici,
//      elles se comptent.
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

// Bit ADMINISTRATOR, identique côté Discord et côté Fluxer (1 << 3). Écrit ici
// plutôt qu'importé de `PermissionFlagsBits` : ce fichier n'a pas le droit de
// charger discord.js, et `permissions.has()` accepte un BigInt.
const BIT_ADMINISTRATEUR = 1n << 3n;


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
//  Lectures que le contrat ne couvre pas encore
//
//  ⚠️ TRANSITION. Les quatre fonctions ci-dessous passent par `adaptateur.api`
//  dès que la méthode existe, et retombent sinon sur le client natif. Sur
//  Discord, la seconde voie est celle d'avant le chantier — comportement
//  strictement identique. Sur Fluxer, l'objet de serveur n'a pas cette forme :
//  les chaînes optionnelles rendent alors une liste VIDE, ce qui dégrade un
//  sélecteur au lieu de faire tomber une page.
//
//  Méthodes manquantes, avec leur signature proposée (cf. compte-rendu) :
//    api.listerCanaux(guildeId)  -> Promise<object[]|null>  canaux normalisés
//    api.listerRoles(guildeId)   -> Promise<object[]|null>  rôles normalisés
//    api.listerEmojis(guildeId)  -> Promise<object[]|null>  { id, nom, anime, identifiant, url }
//    api.listerMembres(guildeId) -> Promise<object[]|null>  membres normalisés
//
//  Le jour où elles sont livrées, le repli tombe et ces fonctions se réduisent
//  à un appel.
// ═══════════════════════════════════════════════════════════════

/**
 * Serveur NATIF vu par le client de la plateforme, ou `undefined`.
 *
 * Voie de repli des quatre lecteurs ci-dessous — et voie NOMINALE d'un seul
 * appelant : `api/routes/automod.js`. L'AutoMod natif n'a aucun équivalent hors
 * Discord (DA §2.2), `bot/utils/automodSync.js` est une exception nommée du test
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
    if (client && typeof client.listerCanaux === 'function') {
        return (await client.listerCanaux(String(guildeId))) || [];
    }
    // TRANSITION : en attente de `api.listerCanaux` (voir l'en-tête de section).
    const guilde = guildeNative(req, guildeId);
    const cache = guilde?.channels?.cache;
    if (!cache || typeof cache.values !== 'function') return [];
    return [...cache.values()].map(c => ({
        id: c.id,
        nom: c.name,
        typeNatif: c.type,
        parentId: c.parentId ?? null,
        position: c.position,
    }));
}

/**
 * Rôles d'un serveur : `{ id, nom, couleur, position, gere }`.
 * @returns {Promise<object[]>} liste vide si le serveur n'est pas joignable.
 */
async function listerRoles(req, guildeId) {
    const client = apiPlateforme(req);
    if (client && typeof client.listerRoles === 'function') {
        return (await client.listerRoles(String(guildeId))) || [];
    }
    // TRANSITION : en attente de `api.listerRoles`.
    const guilde = guildeNative(req, guildeId);
    const cache = guilde?.roles?.cache;
    if (!cache || typeof cache.values !== 'function') return [];
    return [...cache.values()].map(r => ({
        id: r.id,
        nom: r.name,
        couleur: r.hexColor,
        position: r.position,
        gere: Boolean(r.managed),
        // @everyone porte l'identifiant du serveur : c'est une connaissance de
        // plateforme, la route ne la reconstruit pas elle-même.
        parDefaut: r.id === guilde.id,
    }));
}

/**
 * Emojis personnalisés d'un serveur.
 * @returns {Promise<object[]>} liste vide si le serveur n'est pas joignable.
 */
async function listerEmojis(req, guildeId) {
    const client = apiPlateforme(req);
    if (client && typeof client.listerEmojis === 'function') {
        return (await client.listerEmojis(String(guildeId))) || [];
    }
    // TRANSITION : en attente de `api.listerEmojis`.
    const guilde = guildeNative(req, guildeId);
    const cache = guilde?.emojis?.cache;
    if (!cache || typeof cache.map !== 'function') return [];
    return cache.map(e => ({
        id: e.id,
        nom: e.name,
        anime: Boolean(e.animated),
        identifiant: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`,
        url: typeof e.imageURL === 'function' ? e.imageURL({ size: 32 }) : null,
    }));
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
    if (client && typeof client.listerMembres === 'function') {
        const membres = await client.listerMembres(String(guildeId));
        return { joignable: membres !== null, membres: membres || [] };
    }

    // TRANSITION : en attente de `api.listerMembres`.
    const guilde = guildeNative(req, guildeId);
    if (!guilde) return { joignable: false, membres: [] };

    const versNeutre = (m) => ({
        id: m.id,
        estBot: Boolean(m.user?.bot),
        estAdmin: Boolean(m.permissions?.has?.(BIT_ADMINISTRATEUR)),
        nom: m.displayName || m.user?.tag || m.id,
    });

    try {
        // `fetch()` peuple le cache avec tous les membres (intent GuildMembers
        // actif). Négligeable à l'échelle actuelle ; au-delà, voir la note de
        // scalabilité du compte-rendu de la conformité.
        const membres = await guilde.members.fetch();
        return { joignable: true, membres: [...membres.values()].map(versNeutre) };
    } catch {
        // Énumération impossible : on retombe sur le cache déjà chargé plutôt
        // que de rendre une liste vide.
        const cache = guilde.members?.cache;
        const valeurs = cache && typeof cache.values === 'function' ? [...cache.values()] : [];
        return { joignable: true, membres: valeurs.map(versNeutre) };
    }
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
    BIT_ADMINISTRATEUR,
};
