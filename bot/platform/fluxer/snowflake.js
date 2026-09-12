// ═══════════════════════════════════════════════════════════════
//  Snowflakes — Fluxer
//
//  Source : fluxer_docs/src/content/docs/snowflakes.md, § « Format » et
//  § « Extracting a timestamp » :
//
//    | Timestamp | 62 à 22 | millisecondes depuis 2015-01-01T00:00:00.000Z |
//    timestamp_ms = (snowflake >> 22) + 1420070400000
//
//  L'époque est donc EXACTEMENT celle de Discord, et le décalage aussi. Ce
//  fichier est par conséquent identique, ligne pour ligne, à
//  `bot/platform/discord/snowflake.js`.
//
//  ⚠️ Il est recopié VOLONTAIREMENT, et pas requis depuis l'adaptateur Discord :
//  l'adaptateur Fluxer ne doit dépendre d'aucun fichier de `discord/`, sans quoi
//  un `require('discord.js')` finirait par remonter dans un processus qui ne
//  parle pas à Discord. C'est un doublon SIGNALÉ, pas un oubli : la convention
//  de snowflake appartient au contrat commun (cf. compte-rendu du lot 6), et ce
//  fichier disparaîtra le jour où `bot/platform/snowflake.js` existera — les
//  deux plateformes partagent la même époque, seule la SOURCE de la valeur
//  diffère.
// ═══════════════════════════════════════════════════════════════

// 2015-01-01T00:00:00Z. « The epoch is 1420070400000 milliseconds after the
// Unix epoch. Every Fluxer instance uses the same value. » (snowflakes.md)
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
