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
//   3. le CLOISONNEMENT par serveur est écrit une fois. Voir la section
//      « Résolution SCELLÉE au serveur de l'URL » plus bas : c'est la plus
//      importante de ce fichier.
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
 * Définit la présence du bot (statut + activité), ou déclare qu'elle n'est pas
 * définissable.
 *
 * ⚠️ Seconde et DERNIÈRE lecture native de `api/`, pour la même raison que
 * `guildeNative` : le contrat ne couvre pas la présence. Ni la DA §4.3 ni les
 * deux adaptateurs n'exposent de méthode, et l'objet de présence — un statut et
 * un type d'activité NUMÉROTÉ — est une forme propre à Discord.
 *
 * Elle est ici, et non dans la route, pour que `api/routes/**` n'ait nulle part
 * à nommer `adaptateur.client`.
 *
 * Signature qui manque au contrat, pour la retirer :
 *     adaptateur.definirPresence({ statut, activite: { nom, type } | null })
 *
 * @returns {boolean} `false` si la plateforme ne sait pas faire — l'appelant
 *   doit alors REFUSER, jamais enregistrer un réglage qui ne s'applique pas.
 */
function definirPresenceNative(req, presence) {
    const utilisateur = adaptateur(req)?.client?.user;
    if (typeof utilisateur?.setPresence !== 'function') return false;
    utilisateur.setPresence(presence);
    return true;
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

// ═══════════════════════════════════════════════════════════════
//  Résolution SCELLÉE au serveur de l'URL
//
//  ⚠️ LA section de sécurité de ce fichier. À lire avant d'écrire la moindre
//  résolution par identifiant dans une route.
//
//  Jusqu'en v4.10.0, une route résolvait ses salons dans le cache du SERVEUR :
//  `guild.channels.cache.get(id)`. Le cloisonnement par serveur n'était donc
//  écrit nulle part — il était PORTÉ par la forme de l'appel, et un identifiant
//  étranger rendait simplement `undefined`.
//
//  Le client REST normalisé, lui, est global à l'instance : `api.obtenirCanal(id)`
//  résout n'importe quel salon de n'importe quel serveur où le bot est présent.
//  La migration a donc emporté un contrôle d'accès sans que rien ne le signale,
//  et la conséquence était immédiate : administratrice du serveur A, j'appelais
//  `DELETE /api/guilds/A/tempvoice/active/<salon de B>` et le salon de B était
//  détruit. Trois autres routes fuyaient par la même cause, en lecture (nom d'un
//  salon privé d'un autre serveur, permissions du bot dedans).
//
//  D'où ces fonctions, et la règle qui va avec :
//
//    ⚠️ AUCUNE route ne doit appeler `api.obtenirCanal`, `api.obtenirRole`,
//       `api.obtenirMembre` ni `api.obtenirMessage` directement. Elle passe par
//       `canalDuServeur`, `roleDuServeur` ou `messageDuServeur`, qui comparent
//       l'entité résolue à `req.params.guildId` et rendent `null` sinon.
//       `test/authz-cloisonnement.test.js` balaie `api/routes/**` et échoue sur
//       tout appel direct : la règle ne dépend pas de la mémoire de qui code.
//
//  Fail CLOSED : une requête sans `req.params.guildId` ne résout rien. Un
//  routeur monté hors d'un chemin `/:guildId` n'a par construction aucun
//  serveur auquel sceller, et « pas de serveur » ne peut pas valoir « tous ».
// ═══════════════════════════════════════════════════════════════

/** Identifiant de serveur de l'URL, ou `null`. */
function guildeDeLUrl(req) {
    const id = req?.params?.guildId;
    return typeof id === 'string' && id ? id : null;
}

/**
 * Salon du serveur de l'URL, ou `null`.
 *
 * `null` couvre trois cas que l'appelant n'a aucune raison de distinguer — le
 * salon n'existe pas, il appartient à un AUTRE serveur, la lecture a échoué —
 * et c'est volontaire : les trois se traitent de la même façon, « ce salon
 * n'est pas à vous ». Distinguer le deuxième reviendrait à confirmer
 * l'existence d'un salon d'un serveur tiers.
 *
 * @param {object} req
 * @param {string} canalId
 * @param {{type?: string}} [options] `type` exige en plus un type canonique
 *   (`'categorie'`, `'vocal'`…). Un salon du bon serveur mais du mauvais type
 *   rend `null`.
 * @returns {Promise<object|null>} salon NORMALISÉ
 */
async function canalDuServeur(req, canalId, { type = null } = {}) {
    const guildeId = guildeDeLUrl(req);
    const client = apiPlateforme(req);
    if (!guildeId || !client || !canalId) return null;

    const canal = await client.obtenirCanal(String(canalId)).catch(() => null);
    if (!canal) return null;
    // LE contrôle. `guildeId` d'un salon normalisé est `null` pour un message
    // privé : la comparaison échoue alors, ce qui est exact.
    if (String(canal.guildeId) !== String(guildeId)) return null;
    if (type && canal.type !== type) return null;
    return canal;
}

/**
 * Rôle du serveur de l'URL, ou `null`.
 *
 * `api.obtenirRole(guildeId, roleId)` est déjà scellé par sa signature — il
 * cherche le rôle DANS ce serveur. La comparaison qui suit est une seconde
 * ligne : elle ne coûte rien, et elle rend cette fonction interchangeable avec
 * les deux autres pour qui relit le fichier.
 */
async function roleDuServeur(req, roleId) {
    const guildeId = guildeDeLUrl(req);
    const client = apiPlateforme(req);
    if (!guildeId || !client || !roleId) return null;

    const role = await client.obtenirRole(guildeId, String(roleId)).catch(() => null);
    if (!role) return null;
    if (role.guildeId && String(role.guildeId) !== String(guildeId)) return null;
    return role;
}

/**
 * Message d'un salon du serveur de l'URL, ou `null`.
 *
 * Le salon est scellé d'abord : un message n'est pas plus cloisonné que le
 * salon qui le porte, et `api.obtenirMessage(canalId, messageId)` ne connaît
 * aucun serveur.
 */
async function messageDuServeur(req, canalId, messageId) {
    if (!canalId || !messageId) return null;
    const canal = await canalDuServeur(req, canalId);
    if (!canal) return null;
    const client = apiPlateforme(req);
    return client.obtenirMessage(String(canalId), String(messageId)).catch(() => null);
}

// ═══════════════════════════════════════════════════════════════
//  Validation à l'ÉCRITURE
//
//  Sceller les lectures ferme la fuite, pas la porte : un identifiant étranger
//  stocké en base reste une configuration qui pointe ailleurs, et c'est le BOT
//  qui l'emprunte ensuite (un salon de journaux d'un autre serveur reçoit alors
//  les journaux de modération de celui-ci). On refuse donc à l'entrée.
//
//  ⚠️ Une valeur INCHANGÉE est acceptée sans vérification. Ce n'est pas un
//  relâchement : le dashboard renvoie le formulaire entier à chaque
//  enregistrement, et refuser une valeur déjà en base rendrait toute la
//  configuration insauvegardable pendant une reconnexion du bot. Rien de
//  NOUVEAU ne peut entrer sans avoir été vérifié, ce qui est l'invariant qui
//  compte.
// ═══════════════════════════════════════════════════════════════

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Valide un identifiant de salon destiné à être STOCKÉ pour ce serveur.
 *
 * @param {object} req
 * @param {*} brut  valeur reçue du corps de requête
 * @param {object} options
 * @param {string} options.champ    libellé affiché dans le refus
 * @param {*} [options.actuel]      valeur déjà en base ; une valeur identique
 *   passe sans vérification (cf. l'en-tête de section)
 * @param {string} [options.type]   type canonique exigé
 * @returns {Promise<{value: string|null}|{error: string, status?: number}>}
 */
async function exigerCanalDuServeur(req, brut, { champ, actuel = undefined, type = null } = {}) {
    if (brut === undefined || brut === null || brut === '') return { value: null };
    const id = String(brut).trim();
    if (!SNOWFLAKE.test(id)) return { error: `${champ} : identifiant de salon invalide.` };

    // Valeur inchangée : rien de nouveau n'entre.
    if (actuel !== undefined && actuel !== null && String(actuel) === id) return { value: id };

    if (!apiPlateforme(req)) {
        return {
            status: 503,
            error: `${champ} : je ne suis pas connecté à ce serveur pour le moment, je ne peux pas vérifier que ce salon lui appartient.`,
        };
    }

    const canal = await canalDuServeur(req, id, { type });
    if (!canal) {
        return {
            error: type === 'categorie'
                ? `${champ} : cette catégorie n'existe pas sur ce serveur.`
                : `${champ} : ce salon n'existe pas sur ce serveur.`,
        };
    }
    return { value: id };
}

/**
 * Même contrôle pour un identifiant de rôle.
 * @returns {Promise<{value: string|null}|{error: string, status?: number}>}
 */
async function exigerRoleDuServeur(req, brut, { champ, actuel = undefined } = {}) {
    if (brut === undefined || brut === null || brut === '') return { value: null };
    const id = String(brut).trim();
    if (!SNOWFLAKE.test(id)) return { error: `${champ} : identifiant de rôle invalide.` };

    if (actuel !== undefined && actuel !== null && String(actuel) === id) return { value: id };

    if (!apiPlateforme(req)) {
        return {
            status: 503,
            error: `${champ} : je ne suis pas connecté à ce serveur pour le moment, je ne peux pas vérifier que ce rôle lui appartient.`,
        };
    }

    const role = await roleDuServeur(req, id);
    if (!role) return { error: `${champ} : ce rôle n'existe pas sur ce serveur.` };
    return { value: id };
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
    definirPresenceNative,
    guildeDeLUrl,
    canalDuServeur,
    roleDuServeur,
    messageDuServeur,
    exigerCanalDuServeur,
    exigerRoleDuServeur,
    CAPACITES_INCONNUES,
};
