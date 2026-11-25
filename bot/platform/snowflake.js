// ═══════════════════════════════════════════════════════════════
//  Snowflakes — partie neutre
//
//  Un identifiant porte sa date d'émission dans ses bits hauts. C'est une
//  convention de PLATEFORME, pas de code métier : l'âge d'un compte ou d'un
//  message se lit ici, sans aucun appel réseau.
//
//  ─── Pourquoi un seul module pour deux plateformes ──────────────────────────
//
//  Les deux adaptateurs portaient ce fichier à l'identique, ligne pour ligne.
//  Ce n'était pas un hasard : Discord et Fluxer partagent le format ET l'époque.
//
//    Discord : 2015-01-01T00:00:00.000Z, décalage de 22 bits
//    Fluxer  : « The epoch is 1420070400000 milliseconds after the Unix epoch.
//               Every Fluxer instance uses the same value. »
//               (fluxer_docs/src/content/docs/snowflakes.md)
//              « timestamp_ms = (snowflake >> 22) + 1420070400000 »
//
//  Deux copies d'une même arithmétique finissent par diverger d'un décalage, et
//  le symptôme serait un âge de compte faux — donc un anti-raid qui laisse
//  passer, ou qui bloque des arrivées légitimes. La fonction est écrite une
//  fois ; l'ÉPOQUE, elle, reste paramétrable, parce que c'est la seule chose
//  qu'une troisième plateforme changerait.
// ═══════════════════════════════════════════════════════════════

// Époque partagée par Discord et Fluxer, en millisecondes depuis l'époque Unix.
const EPOQUE_SNOWFLAKE = 1420070400000n;

// Les 22 bits bas portent l'identifiant de travailleur et la séquence. Le
// décalage est le même sur les deux plateformes.
const DECALAGE_HORODATAGE = 22n;

/**
 * Horodatage d'émission porté par un snowflake.
 *
 * @param {string|number|bigint} id
 * @param {bigint} [epoque] époque de la plateforme, celle que les deux
 *   partagent par défaut
 * @returns {number|null} millisecondes, ou `null` si l'identifiant est illisible
 *
 * ⚠️ `null` et non une date inventée. Rendre « maintenant » ou 1970 pour un
 * identifiant absent ferait conclure un âge de compte à l'anti-raid, et « je ne
 * sais pas » est la seule réponse exacte.
 */
function dateDuSnowflake(id, epoque = EPOQUE_SNOWFLAKE) {
    try {
        return Number((BigInt(id) >> DECALAGE_HORODATAGE) + epoque);
    } catch {
        return null;
    }
}

/**
 * Le plus petit snowflake d'un instant donné.
 *
 * Sert de borne de pagination : « tous les messages depuis telle date » se dit
 * en identifiants, jamais en dates, sur les deux plateformes.
 */
function snowflakeDepuisDate(millisecondes, epoque = EPOQUE_SNOWFLAKE) {
    return ((BigInt(Math.trunc(millisecondes)) - epoque) << DECALAGE_HORODATAGE).toString();
}

/**
 * Horloge d'une plateforme : la même fonction, son époque déjà fixée.
 *
 * Les adaptateurs l'appellent au chargement et exposent le résultat. Ils
 * partagent ainsi RÉELLEMENT l'implémentation — un test le vérifie par identité
 * de référence — tout en gardant une époque déclarée chez eux, à côté de la
 * source qui l'établit.
 */
function creerHorloge(epoque = EPOQUE_SNOWFLAKE) {
    return {
        EPOQUE_SNOWFLAKE: epoque,
        dateDuSnowflake: (id) => dateDuSnowflake(id, epoque),
        snowflakeDepuisDate: (ms) => snowflakeDepuisDate(ms, epoque),
    };
}

module.exports = {
    EPOQUE_SNOWFLAKE,
    DECALAGE_HORODATAGE,
    dateDuSnowflake,
    snowflakeDepuisDate,
    creerHorloge,
};
