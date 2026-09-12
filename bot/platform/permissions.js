// ═══════════════════════════════════════════════════════════════
//  Noms canoniques de permissions
//
//  Les 89 usages de `PermissionFlagsBits` passent par ces noms. La table qui
//  les traduit en bitfield vit dans chaque adaptateur (`discord/permissions.js`)
//  et jamais ici : ce fichier doit rester lisible par du code métier sans rien
//  charger de discord.js.
//
//  Le vocabulaire retenu est celui de l'API brute (SCREAMING_SNAKE_CASE), qui
//  se trouve être aussi celui de Fluxer. Discord expose la même notion en
//  PascalCase côté discord.js : c'est l'adaptateur qui fait la conversion, pas
//  l'appelant.
//
//  Toutes les permissions utilisées par Quasar ont un équivalent sur les deux
//  plateformes : la correspondance est sans perte (DA §7.1). Ajouter une entrée
//  ici sans l'ajouter à la table de CHAQUE adaptateur fait échouer le démarrage
//  de l'adaptateur incomplet — c'est voulu, un trou de table doit se voir.
// ═══════════════════════════════════════════════════════════════

const PERMISSIONS = Object.freeze([
    'ADMINISTRATOR',
    'MANAGE_GUILD',
    'MANAGE_ROLES',
    'MANAGE_CHANNELS',
    'MANAGE_MESSAGES',
    'MANAGE_NICKNAMES',
    'MANAGE_WEBHOOKS',
    'KICK_MEMBERS',
    'BAN_MEMBERS',
    'MODERATE_MEMBERS',
    'MOVE_MEMBERS',
    'MUTE_MEMBERS',
    'DEAFEN_MEMBERS',
    'VIEW_AUDIT_LOG',
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'EMBED_LINKS',
    'ATTACH_FILES',
    'ADD_REACTIONS',
    'READ_MESSAGE_HISTORY',
    'MENTION_EVERYONE',
    'CONNECT',
]);

const ENSEMBLE_PERMISSIONS = new Set(PERMISSIONS);

/** @returns {boolean} le nom fait-il partie du vocabulaire canonique */
function estPermissionCanonique(nom) {
    return typeof nom === 'string' && ENSEMBLE_PERMISSIONS.has(nom);
}

/**
 * Refuse un nom hors vocabulaire, avec un message qui nomme le fautif.
 *
 * Sans ce garde, `aPermission('MANAGE_ROLE')` (au singulier) rendrait
 * tranquillement `false` : la commande deviendrait inaccessible à tout le monde
 * et rien n'en dirait la cause.
 */
function exigerPermissionCanonique(nom) {
    if (!estPermissionCanonique(nom)) {
        throw new Error(
            `Permission inconnue : "${nom}". Noms acceptés : ${PERMISSIONS.join(', ')}.`
        );
    }
    return nom;
}

// ─── Bitfields ────────────────────────────────────────────────────────────────
//
// ⚠️ Les bitfields de permission sont des entiers 64 bits. Un `number`
// JavaScript en tronque silencieusement les bits hauts au-delà de 2^53 — et
// Discord y a déjà placé des permissions (USE_EXTERNAL_APPS vaut 1 << 50, et le
// bit 47 est atteint depuis 2024). On manipule donc des BigInt en interne, et on
// sérialise en CHAÎNE à l'émission : c'est la forme qu'attendent l'API REST de
// Discord (`allow`, `deny`, `default_member_permissions`) comme celle de Fluxer.
// Ne jamais renvoyer un `Number(bitfield)` vers une API.

/**
 * Combine des noms canoniques en un bitfield, à partir de la table d'une
 * plateforme.
 *
 * @param {string[]|string} noms
 * @param {Record<string, bigint>} table  nom canonique -> bit de la plateforme
 * @returns {bigint}
 */
function versBitfield(noms, table) {
    const liste = Array.isArray(noms) ? noms : [noms];
    let bits = 0n;
    for (const nom of liste) {
        exigerPermissionCanonique(nom);
        const bit = table[nom];
        if (typeof bit !== 'bigint') {
            throw new Error(`La plateforme active ne sait pas traduire la permission "${nom}".`);
        }
        bits |= bit;
    }
    return bits;
}

/**
 * Sérialise un bitfield pour l'émission REST. Accepte BigInt, number ou chaîne
 * — les trois formes circulent dans le dépôt — et rend toujours une chaîne.
 * `null` et `undefined` passent tels quels : « pas de restriction » n'est pas
 * la même chose que « aucune permission », et les confondre poserait un
 * `default_member_permissions: "0"` qui réserve la commande aux seuls
 * administrateurs.
 */
function serialiserBitfield(bits) {
    if (bits === null || bits === undefined) return bits;
    return BigInt(bits).toString();
}

module.exports = {
    PERMISSIONS,
    ENSEMBLE_PERMISSIONS,
    estPermissionCanonique,
    exigerPermissionCanonique,
    versBitfield,
    serialiserBitfield,
};
