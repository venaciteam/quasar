// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des codes d'erreur — Fluxer
//
//  Même rôle que `discord/erreurs.js`, avec UNE différence de nature : le `code`
//  d'une erreur Fluxer est une CHAÎNE, pas un numéro.
//
//    Discord : { "code": 50013, "message": "Missing Permissions" }
//    Fluxer  : { "code": "MISSING_PERMISSIONS", "message": "You don't have …" }
//
//  Source : `fluxer_docs/src/content/docs/http-api/errors.md`, § « API error
//  code registry » — « These codes appear in the top-level `code` field of an
//  error response, sent as the exact JSON string shown. The registry is closed. »
//  La documentation insiste : « Match on `code` alone », le statut HTTP ne
//  suffit pas parce que plusieurs codes partagent un statut.
//
//  ⚠️ `err.code` n'est JAMAIS modifié, exactement comme côté Discord. La
//  distinction compte davantage encore ici : du code de transition teste
//  `err.code === 10026`, ce qui sera toujours faux sur Fluxer. C'est
//  `err.codeNeutre` qui porte la réponse, et rien d'autre.
// ═══════════════════════════════════════════════════════════════

const { CODES_NEUTRES, estCodeNeutre } = require('../erreurs');

// Code d'erreur de l'API Fluxer -> code neutre.
const TABLE = Object.freeze({
    // ── Le bot n'a pas le droit ──────────────────────────────────────────────
    // « You don't have the permissions required to perform this action ».
    // Couvre aussi le refus de HIÉRARCHIE : « Fluxer enforces hierarchy
    // independently of MANAGE_ROLES. A caller who holds the permission without
    // outranking the target role receives 403 MISSING_PERMISSIONS »
    // (permissions.mdx). Les deux causes partagent un code : c'est pourquoi
    // `verifierMembreSanctionnable` existe et se prononce AVANT l'appel.
    MISSING_PERMISSIONS: CODES_NEUTRES.permission,
    // « You don't have access to this resource or feature ». Sert aussi au
    // serveur qu'un opérateur a marqué indisponible (guild-members.mdx).
    MISSING_ACCESS: CODES_NEUTRES.permission,
    ACCESS_DENIED: CODES_NEUTRES.permission,
    // Repli de statut 403 quand aucun code plus précis n'est nommé
    // (errors.md, § « HTTP status fallback codes »).
    FORBIDDEN: CODES_NEUTRES.permission,
    // Refus d'un salon soumis à vérification d'âge. Réessayer à l'identique ne
    // servira à rien : c'est bien un refus de droit, pas une absence.
    NSFW_CONTENT_AGE_RESTRICTED: CODES_NEUTRES.permission,
    // Le bot est lui-même sous timeout — il ne peut pas écrire. Même décision
    // pour l'appelant qu'une permission manquante : ne pas réessayer tel quel.
    COMMUNICATION_DISABLED: CODES_NEUTRES.permission,

    // ── La ressource visée n'existe pas ou plus ──────────────────────────────
    UNKNOWN_CHANNEL: CODES_NEUTRES.introuvable,
    UNKNOWN_MEMBER: CODES_NEUTRES.introuvable,
    UNKNOWN_MESSAGE: CODES_NEUTRES.introuvable,
    UNKNOWN_ROLE: CODES_NEUTRES.introuvable,
    UNKNOWN_USER: CODES_NEUTRES.introuvable,
    UNKNOWN_EMOJI: CODES_NEUTRES.introuvable,
    UNKNOWN_WEBHOOK: CODES_NEUTRES.introuvable,
    UNKNOWN_INVITE: CODES_NEUTRES.introuvable,
    CHANNEL_NOT_FOUND: CODES_NEUTRES.introuvable,
    CHANNEL_DOES_NOT_EXIST: CODES_NEUTRES.introuvable,
    // Repli de statut 404. « Also the code a request that matches no route
    // receives, so an unrouted path and an unreadable resource are
    // indistinguishable from the body alone » (errors.md) : on choisit
    // « introuvable », qui est le cas de très loin le plus fréquent, et un
    // chemin fautif se verrait de toute façon sur TOUS les appels de la méthode.
    NOT_FOUND: CODES_NEUTRES.introuvable,

    // ── L'état visé est DÉJÀ celui qu'on voulait ─────────────────────────────
    // « This user isn't banned » — équivalent exact de l'Unknown Ban (10026) de
    // Discord. Il n'y a plus rien à lever : c'est un succès, pas un échec, et
    // les distinguer évite de journaliser une panne là où le travail est fait.
    USER_IS_NOT_BANNED: CODES_NEUTRES.deja_fait,

    // ── Le bot n'est plus sur ce serveur ─────────────────────────────────────
    // « A guild that no Gateway process serves returns 404 UNKNOWN_GUILD »
    // (messages.mdx, § Channel resolution). C'est le SEUL code sur lequel une
    // échéance en base doit être oubliée : le confondre avec une coupure
    // transformerait un bannissement temporaire en bannissement définitif.
    UNKNOWN_GUILD: CODES_NEUTRES.guilde_inconnue,
});

/** @returns {string} un code de `CODES_NEUTRES`, jamais undefined */
function codeNeutrePour(err) {
    const natif = err?.code;
    // La table est indexée par chaîne. Un `code` numérique ne peut venir que
    // d'une erreur qui n'est pas une erreur d'API Fluxer (une DiscordAPIError
    // égarée, une erreur système) : elle ressort en 'inconnu', ce qui est exact.
    return (typeof natif === 'string' && TABLE[natif]) || CODES_NEUTRES.inconnu;
}

/**
 * Pose `err.codeNeutre` et rend l'erreur, pour un `throw marquerErreur(err)`.
 *
 * Idempotent et non destructif, comme côté Discord : un marquage déjà posé est
 * conservé, `err.code` n'est pas touché, et l'écriture est défensive parce
 * qu'une erreur n'est pas toujours extensible — échouer À POSER LE MARQUEUR
 * masquerait l'erreur d'origine, qui est la seule qui compte.
 */
function marquerErreur(err) {
    if (!err || typeof err !== 'object') return err;
    if (estCodeNeutre(err.codeNeutre)) return err;
    try {
        Object.defineProperty(err, 'codeNeutre', {
            value: codeNeutrePour(err),
            enumerable: false,
            writable: true,
            configurable: true,
        });
    } catch {
        // Erreur non extensible : `codeNeutre()` rendra 'inconnu', ce qui est
        // exactement le bon repli.
    }
    return err;
}

/**
 * Enveloppe toutes les méthodes d'un client REST pour que chaque rejet ressorte
 * marqué. Fait en un point plutôt que dans chaque méthode : trente-trois
 * try/catch recopiés finiraient par diverger, et la méthode oubliée serait
 * précisément celle dont personne ne comprendrait le comportement.
 */
function marquerErreursApi(api) {
    for (const [nom, methode] of Object.entries(api)) {
        if (typeof methode !== 'function') continue;
        api[nom] = async (...args) => {
            try {
                return await methode(...args);
            } catch (err) {
                throw marquerErreur(err);
            }
        };
    }
    return api;
}

module.exports = { TABLE, codeNeutrePour, marquerErreur, marquerErreursApi };
