// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des permissions — Fluxer
//
//  Traduit les noms canoniques de `platform/permissions.js` (DA §7.1) en
//  bitfields Fluxer. Les valeurs ne sont PAS recopiées de Discord : chacune est
//  lue dans `fluxer_docs/src/content/docs/http-api/permissions.mdx`, table
//  « Permissions », qui déclare « Every bit Fluxer defines appears below ».
//
//  Il se trouve que les vingt-deux bits dont Quasar a besoin occupent la même
//  position que chez Discord. C'est une coïncidence d'héritage, pas une règle :
//  Fluxer place PIN_MESSAGES à 1<<51 et VIEW_CHANNEL_MEMBERS à 1<<54, et
//  n'attribue pas 1<<19 ni 1<<31 à 1<<36. Aucun bit ne doit donc être déduit
//  d'une table Discord — seulement lu dans la documentation.
//
//  ⚠️ `MODERATE_MEMBERS` vaut 1<<40 : au-delà de 2^53, donc INEXPRIMABLE en
//  `number` JavaScript. Toute la table est en BigInt, et tout ce qui part vers
//  l'API est sérialisé en chaîne (« allow and deny are decimal strings because a
//  permission mask exceeds the range a JSON number preserves », channels.mdx).
// ═══════════════════════════════════════════════════════════════

const { PERMISSIONS, versBitfield, serialiserBitfield } = require('../permissions');

// Nom canonique -> bit Fluxer. Source : permissions.mdx, table « Permissions ».
// La table est vérifiée exhaustive au chargement, juste en dessous.
const BITS = Object.freeze({
    KICK_MEMBERS: 1n << 1n,           // « Remove a member from the guild »
    BAN_MEMBERS: 1n << 2n,            // « Create and revoke a guild ban »
    ADMINISTRATOR: 1n << 3n,          // « Hold every permission and bypass every channel permission overwrite »
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_GUILD: 1n << 5n,
    ADD_REACTIONS: 1n << 6n,
    VIEW_AUDIT_LOG: 1n << 7n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_MESSAGES: 1n << 13n,       // supprimer le message d'autrui, suppression en lot, retirer la réaction d'autrui
    EMBED_LINKS: 1n << 14n,
    ATTACH_FILES: 1n << 15n,
    READ_MESSAGE_HISTORY: 1n << 16n,
    MENTION_EVERYONE: 1n << 17n,
    CONNECT: 1n << 20n,
    MUTE_MEMBERS: 1n << 22n,
    DEAFEN_MEMBERS: 1n << 23n,
    MOVE_MEMBERS: 1n << 24n,
    MANAGE_NICKNAMES: 1n << 27n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_WEBHOOKS: 1n << 29n,
    MODERATE_MEMBERS: 1n << 40n,      // « Apply and clear a member communication timeout »
});

const manquantes = PERMISSIONS.filter(nom => typeof BITS[nom] !== 'bigint');
if (manquantes.length > 0) {
    throw new Error(
        `Table des permissions Fluxer incomplète : ${manquantes.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/fluxer/permissions.js.'
    );
}

// Masque complet 64 bits, celui que Fluxer attribue au propriétaire du serveur :
// « The guild owner receives the complete 64-bit mask. » (permissions.mdx,
// § Permission computation). Bit 63 exclu — « Bit 63 is always zero, so an
// issued snowflake fits a signed 64-bit integer » vaut pour les identifiants, et
// le masque est déclaré non signé sur 64 bits ; on prend donc les 64 bits.
const MASQUE_COMPLET = (1n << 64n) - 1n;

/** @param {string[]|string} noms @returns {bigint} */
const bitfield = (noms) => versBitfield(noms, BITS);

/** Bitfield sérialisé en chaîne, forme attendue par l'API REST. */
const bitfieldChaine = (noms) => serialiserBitfield(bitfield(noms));

/**
 * Normalise en BigInt tout ce qui peut porter un masque de permissions.
 *
 * Cinq formes circulent dans le dépôt et dans l'API : un BigInt, un entier, une
 * chaîne décimale (la forme de l'API Fluxer), `null`, et l'objet « porteur »
 * façon discord.js qui expose `.has()`. Les cinq sont acceptées pour que
 * `aPermission` ait exactement la même signature des deux côtés.
 */
function masqueDe(valeur) {
    if (valeur === null || valeur === undefined) return null;
    if (typeof valeur === 'bigint') return valeur;
    if (typeof valeur === 'number' || typeof valeur === 'string') {
        try { return BigInt(valeur); } catch { return null; }
    }
    if (typeof valeur === 'object' && typeof valeur.bitfield !== 'undefined') {
        try { return BigInt(valeur.bitfield); } catch { return null; }
    }
    return null;
}

/**
 * Le porteur de permissions a-t-il la permission canonique demandée ?
 *
 * Même contrat que `discord/permissions.js` : en l'absence d'un masque
 * exploitable on répond « non ». Transformer un « je ne sais pas » en droit
 * accordé serait le pire des replis — c'est par là que `accesParDefaut: false`
 * laisserait passer n'importe qui.
 *
 * ⚠️ ADMINISTRATOR n'est PAS traité ici : « If the result contains ADMINISTRATOR
 * at that point, Fluxer returns the complete 64-bit mask » (permissions.mdx).
 * L'élargissement est fait UNE FOIS, au calcul du masque (`masqueMembre`), pour
 * que le masque stocké soit déjà le masque effectif. Le refaire ici masquerait
 * un masque mal calculé.
 */
function aPermission(porteur, nom) {
    const bit = BITS[nom];
    if (typeof bit !== 'bigint') {
        throw new Error(`Permission inconnue côté Fluxer : "${nom}".`);
    }
    // Porteur façon discord.js, pour les doublures qui en fournissent un.
    if (porteur && typeof porteur.has === 'function') return Boolean(porteur.has(bit));
    const masque = masqueDe(porteur);
    if (masque === null) return false;
    return (masque & bit) === bit;
}

/**
 * Masque effectif d'un membre AU NIVEAU DU SERVEUR.
 *
 * Reproduit exactement l'algorithme de permissions.mdx § « Permission
 * computation », et dans son ordre :
 *
 *   1. le propriétaire reçoit le masque 64 bits complet ;
 *   2. sinon on part des permissions du rôle @everyone, dont le snowflake est
 *      celui du serveur ;
 *   3. on ajoute par union les permissions de chaque rôle assigné ;
 *   4. si ADMINISTRATOR est présent à ce stade, le résultat est le masque
 *      complet et rien d'autre n'est évalué.
 *
 * Cette fonction existe parce que le membre Fluxer, LUI, ne porte aucun champ
 * `permissions` (guild-members.mdx, « Guild member object ») : contrairement à
 * discord.js, rien ne calcule le masque à notre place. Sans elle, `estAdmin`
 * vaudrait toujours false et `accesParDefaut: false` n'ouvrirait la commande à
 * personne — ou, si on avait replié sur « true », à tout le monde.
 *
 * @param {object} params
 * @param {string}  params.membreId
 * @param {string[]} params.rolesMembre     identifiants des rôles assignés
 * @param {Map<string, {permissions: string|bigint}>|object} params.roles
 *   rôles du serveur, indexés par identifiant
 * @param {string}  params.guildeId         sert à retrouver le rôle @everyone
 * @param {string}  [params.proprietaireId]
 * @returns {bigint}
 */
function masqueMembre({ membreId, rolesMembre = [], roles, guildeId, proprietaireId = null }) {
    if (proprietaireId && membreId && String(membreId) === String(proprietaireId)) return MASQUE_COMPLET;

    const lire = (id) => {
        const role = roles instanceof Map ? roles.get(id) : roles?.[id];
        return masqueDe(role?.permissions) ?? 0n;
    };

    // « Fluxer starts from the permissions of the everyone role, whose snowflake
    // equals the guild snowflake ». Le rôle @everyone n'est JAMAIS dans
    // `member.roles` (guild-members.mdx, note 2) : il faut l'ajouter à la main.
    let masque = guildeId ? lire(guildeId) : 0n;
    for (const roleId of rolesMembre || []) masque |= lire(roleId);

    if ((masque & BITS.ADMINISTRATOR) === BITS.ADMINISTRATOR) return MASQUE_COMPLET;
    return masque;
}

/**
 * Masque effectif d'un membre DANS UN SALON, overwrites appliqués.
 *
 * Suite de l'algorithme de permissions.mdx, dans son ordre exact :
 *   1. l'overwrite du rôle @everyone : refus d'abord, autorisations ensuite ;
 *   2. les overwrites des rôles du membre, fusionnés en UN seul allow et UN seul
 *      deny appliqués en une étape — « An allow on any one of the member's roles
 *      defeats a deny on another » ;
 *   3. l'overwrite du membre, refus puis autorisations.
 *
 * ADMINISTRATOR court-circuite tout : « No deny overwrite in any channel
 * restricts a member who holds the bit. »
 *
 * @param {bigint} masqueServeur  résultat de `masqueMembre`
 * @param {Array<{id: string, type: number, allow: string, deny: string}>} overwrites
 */
function masqueSurCanal(masqueServeur, overwrites, { membreId, rolesMembre = [], guildeId }) {
    if ((masqueServeur & BITS.ADMINISTRATOR) === BITS.ADMINISTRATOR) return MASQUE_COMPLET;
    if (!Array.isArray(overwrites) || overwrites.length === 0) return masqueServeur;

    let masque = masqueServeur;
    const trouver = (id) => overwrites.find(o => String(o.id) === String(id));

    const everyone = guildeId ? trouver(guildeId) : null;
    if (everyone) {
        masque &= ~(masqueDe(everyone.deny) ?? 0n);
        masque |= masqueDe(everyone.allow) ?? 0n;
    }

    let allowRoles = 0n;
    let denyRoles = 0n;
    for (const roleId of rolesMembre || []) {
        const o = trouver(roleId);
        if (!o) continue;
        allowRoles |= masqueDe(o.allow) ?? 0n;
        denyRoles |= masqueDe(o.deny) ?? 0n;
    }
    masque &= ~denyRoles;
    masque |= allowRoles;

    const membre = membreId ? trouver(membreId) : null;
    if (membre) {
        masque &= ~(masqueDe(membre.deny) ?? 0n);
        masque |= masqueDe(membre.allow) ?? 0n;
    }
    return masque;
}

module.exports = {
    BITS,
    MASQUE_COMPLET,
    bitfield,
    bitfieldChaine,
    aPermission,
    masqueDe,
    masqueMembre,
    masqueSurCanal,
};
