// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des codes d'erreur — Discord
//
//  Traduit le `code` numérique d'une `DiscordAPIError` en code neutre
//  (cf. `bot/platform/erreurs.js`). Même rôle que `discord/permissions.js` et
//  `discord/channels.js` : la plateforme parle son dialecte, la couche traduit.
//
//  ⚠️ `err.code` n'est JAMAIS modifié. Le code pas encore migré le lit toujours
//  — `punishments.js` teste encore `err.code === 10026` sur sa voie historique —
//  et l'écraser casserait la moitié du dépôt d'un coup.
// ═══════════════════════════════════════════════════════════════

const { CODES_NEUTRES, estCodeNeutre } = require('../erreurs');

// Code d'erreur JSON de l'API Discord -> code neutre.
// https://discord.com/developers/docs/topics/opcodes-and-status-codes
const TABLE = Object.freeze({
    50013: CODES_NEUTRES.permission,       // Missing Permissions
    50001: CODES_NEUTRES.permission,       // Missing Access — refus de droit sur un salon ou un membre, même famille

    10003: CODES_NEUTRES.introuvable,      // Unknown Channel
    10007: CODES_NEUTRES.introuvable,      // Unknown Member
    10008: CODES_NEUTRES.introuvable,      // Unknown Message
    10011: CODES_NEUTRES.introuvable,      // Unknown Role
    10013: CODES_NEUTRES.introuvable,      // Unknown User

    10026: CODES_NEUTRES.deja_fait,        // Unknown Ban — il n'y a plus rien à lever
    10004: CODES_NEUTRES.guilde_inconnue,  // Unknown Guild — le bot n'y est plus
});

/** @returns {string} un code de `CODES_NEUTRES`, jamais undefined */
function codeNeutrePour(err) {
    const natif = err?.code;
    return TABLE[natif] || CODES_NEUTRES.inconnu;
}

/**
 * Pose `err.codeNeutre` et rend l'erreur, pour un `throw marquerErreur(err)`.
 *
 * Idempotent, et non destructif : un marquage déjà posé est conservé (une
 * erreur peut traverser deux appels `api.*` imbriqués), et `err.code` n'est pas
 * touché. L'écriture est défensive parce qu'une erreur n'est pas toujours
 * extensible — un objet gelé, ou une valeur primitive lancée par une
 * bibliothèque tierce — et qu'échouer À POSER LE MARQUEUR masquerait l'erreur
 * d'origine, qui est la seule qui compte.
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
        // Erreur non extensible : tant pis pour le marqueur, `codeNeutre()`
        // rendra 'inconnu', ce qui est exactement le bon repli.
    }
    return err;
}

/**
 * Enveloppe toutes les méthodes d'un client REST pour que chaque rejet ressorte
 * marqué.
 *
 * Fait ici, en un point, plutôt que dans chaque méthode : vingt-cinq try/catch
 * recopiés finiraient par diverger, et la méthode oubliée serait précisément
 * celle dont personne ne comprendrait le comportement.
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
