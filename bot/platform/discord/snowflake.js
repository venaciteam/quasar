// ═══════════════════════════════════════════════════════════════
//  Snowflakes — Discord
//
//  L'arithmétique vit dans `bot/platform/snowflake.js`, partagée avec Fluxer :
//  les deux plateformes utilisent le même format et la même époque, et deux
//  copies finiraient par diverger d'un décalage — un âge de compte faux, donc
//  un anti-raid qui se trompe.
//
//  Ce fichier ne déclare plus que l'ÉPOQUE, à côté de la source qui l'établit,
//  et réexporte pour les appelants historiques (`api.js`, `context.js`,
//  `events.js`).
// ═══════════════════════════════════════════════════════════════

const { EPOQUE_SNOWFLAKE, dateDuSnowflake, snowflakeDepuisDate } = require('../snowflake');

// 2015-01-01T00:00:00Z, époque des snowflakes Discord.
// https://discord.com/developers/docs/reference#snowflakes
module.exports = { EPOQUE_SNOWFLAKE, dateDuSnowflake, snowflakeDepuisDate };
