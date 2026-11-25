// ═══════════════════════════════════════════════════════════════
//  Snowflakes — Fluxer
//
//  L'arithmétique vit dans `bot/platform/snowflake.js`, partagée avec Discord.
//  Ce fichier ne déclare plus que l'ÉPOQUE, à côté de la source qui l'établit.
//
//  Source : `fluxer_docs/src/content/docs/snowflakes.md`
//    « The epoch is 1420070400000 milliseconds after the Unix epoch. Every
//      Fluxer instance uses the same value. »
//    « timestamp_ms = (snowflake >> 22) + 1420070400000 »
//
//  C'est EXACTEMENT l'époque et le décalage de Discord. Le fichier reste pour
//  que cette source soit citée quelque part : le jour où une instance Fluxer
//  changerait d'époque, c'est ici qu'on le verrait, et `creerHorloge` est déjà
//  paramétrée pour l'accueillir.
// ═══════════════════════════════════════════════════════════════

const { EPOQUE_SNOWFLAKE, dateDuSnowflake, snowflakeDepuisDate } = require('../snowflake');

module.exports = { EPOQUE_SNOWFLAKE, dateDuSnowflake, snowflakeDepuisDate };
