// ═══════════════════════════════════════════════════════════════
//  Snowflakes
//
//  Un identifiant Discord porte sa date d'émission dans ses bits hauts. C'est
//  la plateforme qui connaît cette convention, pas le code métier : l'âge d'un
//  compte ou d'un message se lit ici, sans aucun appel réseau.
//
//  Fluxer utilise le même format (DA §8), avec sa propre époque le jour venu.
//  Fichier séparé pour être partagé par `api.js` (filtrage des messages de plus
//  de 14 jours) et `context.js` (âge d'un compte) sans créer de cycle entre eux.
// ═══════════════════════════════════════════════════════════════

// 2015-01-01T00:00:00Z, époque des snowflakes Discord.
const EPOQUE_SNOWFLAKE = 1420070400000n;

/**
 * Horodatage d'émission porté par un snowflake.
 * @returns {number|null} millisecondes, ou null si l'identifiant est illisible
 */
function dateDuSnowflake(id) {
    try {
        return Number((BigInt(id) >> 22n) + EPOQUE_SNOWFLAKE);
    } catch {
        // Identifiant absent ou non numérique : rendre une date inventée serait
        // pire que rendre « je ne sais pas » — l'anti-raid en déduirait un âge
        // de compte.
        return null;
    }
}

module.exports = { EPOQUE_SNOWFLAKE, dateDuSnowflake };
