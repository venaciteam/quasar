// ═══════════════════════════════════════════════════════════════
//  Codes d'erreur neutres
//
//  `err.code` d'une erreur d'API porte un NUMÉRO propre à la plateforme :
//  50013, 10026, 10004. Ces numéros se sont retrouvés dans du code métier censé
//  devenir neutre (`describeError` de punishments.js, le balayeur de
//  bannissements), où ils ne voudront rien dire sur Fluxer — qui a ses propres
//  codes, et pas les mêmes.
//
//  L'adaptateur pose donc `err.codeNeutre` sur toute erreur qui traverse
//  `api.*`, SANS toucher à `err.code` : le code historique continue de lire le
//  numéro natif tant qu'il n'est pas migré, et le code neutre lit le nom.
//
//  Chaque adaptateur reproduit cette table avec ses propres codes : la table
//  Discord vit dans `bot/platform/discord/erreurs.js`.
// ═══════════════════════════════════════════════════════════════

/**
 * Le vocabulaire, et ce que chaque terme engage pour l'appelant.
 *
 * Il est volontairement court : ce ne sont pas des catégories d'erreur, ce sont
 * les quatre DÉCISIONS qu'un appelant peut prendre sans connaître la
 * plateforme. Une erreur qui n'en relève pas est `inconnu`, et se traite comme
 * une panne — c'est-à-dire qu'elle remonte.
 */
const CODES_NEUTRES = Object.freeze({
    // Le bot n'a pas le droit. Réessayer à l'identique ne servira à rien tant
    // que les permissions n'auront pas changé — mais l'échéance en base, elle,
    // doit être conservée pour un nouvel essai plus tard.
    permission: 'permission',

    // La ressource visée n'existe pas ou plus : salon, membre, message, rôle,
    // utilisateur. L'action n'a plus d'objet, et il n'y a rien à réessayer.
    introuvable: 'introuvable',

    // L'état visé est DÉJÀ celui qu'on voulait obtenir (lever un bannissement
    // qui n'existe plus). C'est un succès, pas un échec : le distinguer
    // d'`introuvable` évite de journaliser une panne là où le travail est fait.
    deja_fait: 'deja_fait',

    // Le bot n'est plus sur ce serveur. Se distingue d'une panne réseau, et
    // c'est capital : c'est le seul cas où une échéance en base doit être
    // OUBLIÉE. La confondre avec une coupure transformerait un bannissement
    // temporaire en bannissement définitif.
    guilde_inconnue: 'guilde_inconnue',

    // Tout le reste, panne réseau comprise. Ne jamais en déduire qu'une action
    // a réussi ni qu'elle est devenue inutile.
    inconnu: 'inconnu',
});

const NOMS_CODES_NEUTRES = Object.freeze(Object.keys(CODES_NEUTRES));

function estCodeNeutre(valeur) {
    return typeof valeur === 'string' && valeur in CODES_NEUTRES;
}

/**
 * Lecture sûre du code neutre d'une erreur.
 *
 * Rend `'inconnu'` pour tout ce qui n'a pas traversé `api.*` — une erreur de
 * base de données, une exception de logique métier. C'est le bon défaut : sans
 * marquage, on ne sait rien, et « on ne sait rien » se traite comme une panne.
 */
function codeNeutre(err) {
    return estCodeNeutre(err?.codeNeutre) ? err.codeNeutre : CODES_NEUTRES.inconnu;
}

module.exports = { CODES_NEUTRES, NOMS_CODES_NEUTRES, estCodeNeutre, codeNeutre };
