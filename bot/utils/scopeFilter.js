// ═══════════════════════════════════════════════════════════════
//  Portée d'une règle de modération automatique
//
//  Chaque règle porte sa propre portée (modèle « à la Dyno ») : quatre listes
//  JSON stockées en base — affected_roles, affected_channels, ignored_roles,
//  ignored_channels. Les quatre modules (AutoMod Discord, escalade, anti-raid,
//  honeypot) posent exactement la même question — « cette règle s'applique-t-elle
//  à cette cible ? » — et doivent y répondre pareil. D'où un seul évaluateur, et
//  non quatre implémentations qui divergeront au premier cas limite.
//
//  Deux règles, dans cet ordre :
//    1. `ignored_*` l'emporte TOUJOURS. Une liste blanche qui saute parce qu'une
//       autre liste dit le contraire n'est pas une liste blanche.
//    2. `affected_*` vide (ou absente, ou NULL) signifie « tout ». C'est ce qui
//       rend une règle utilisable sans rien configurer.
//
//  Le JSON en base peut être illisible : édition manuelle, retour arrière de
//  version, migration interrompue. Dans ce cas on répond `false` — la règle ne
//  s'applique pas. Sanctionner sur la foi d'une configuration qu'on ne sait pas
//  lire est le seul comportement réellement irréversible ici.
// ═══════════════════════════════════════════════════════════════

/**
 * Lit une colonne JSON de liste d'identifiants.
 * @returns {{ readable: boolean, ids: string[] }} readable = false si la valeur
 *          est présente mais inexploitable (JSON cassé, type inattendu).
 */
function readIdList(raw) {
    if (raw === null || raw === undefined || raw === '') return { readable: true, ids: [] };
    if (Array.isArray(raw)) return { readable: true, ids: raw.map(String) };
    if (typeof raw !== 'string') return { readable: false, ids: [] };

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { readable: false, ids: [] };
    }
    if (parsed === null) return { readable: true, ids: [] };
    if (!Array.isArray(parsed)) return { readable: false, ids: [] };
    // Une entrée non scalaire (objet, tableau imbriqué) trahit une valeur qui
    // n'est pas une liste d'IDs : on ne devine pas ce qu'elle voulait dire.
    if (parsed.some(v => v !== null && typeof v === 'object')) return { readable: false, ids: [] };
    return { readable: true, ids: parsed.filter(v => v !== null && v !== undefined).map(String) };
}

/**
 * Identifiants de rôles d'un membre. Le membre arrive soit en objet discord.js
 * (roles = gestionnaire avec cache), soit en membre brut de l'API (roles =
 * tableau d'IDs) — les deux formes circulent déjà dans le projet (cf. bot/index.js).
 * @returns {string[] | null} null = rôles non déterminables.
 */
function memberRoleIds(member) {
    if (!member) return null;
    const roles = member.roles;
    if (Array.isArray(roles)) return roles.map(String);
    if (roles?.cache) return [...roles.cache.keys()].map(String);
    return null;
}

/**
 * Identifiants qui désignent un salon pour la portée : le salon lui-même et sa
 * catégorie parente. Exempter une catégorie exempte les salons qu'elle contient —
 * c'est ce que tout le monde attend en cochant une catégorie, et l'inverse
 * obligerait à re-cocher chaque salon créé ensuite.
 * @returns {string[] | null} null = salon non déterminable.
 */
function channelScopeIds(channel) {
    if (!channel) return null;
    const id = channel.id ?? channel;
    if (!id) return null;
    const ids = [String(id)];
    if (channel.parentId) ids.push(String(channel.parentId));
    return ids;
}

function intersects(a, b) {
    return a.some(id => b.includes(id));
}

/**
 * La règle décrite par `config` s'applique-t-elle à cette cible ?
 *
 * @param {object} config — une ligne de table de configuration. Les colonnes
 *        JSON (affected_* / ignored_*) sont parsées ICI, jamais par l'appelant.
 * @param {{ member?: object, channel?: object }} [target] — membre et/ou salon
 *        concernés. Une dimension absente n'est contrainte que si la règle la
 *        contraint (voir ci-dessous).
 * @returns {boolean}
 */
function isInScope(config, target = {}) {
    if (!config || typeof config !== 'object') return false;

    const affectedRoles = readIdList(config.affected_roles);
    const affectedChannels = readIdList(config.affected_channels);
    const ignoredRoles = readIdList(config.ignored_roles);
    const ignoredChannels = readIdList(config.ignored_channels);

    // Une seule colonne illisible suffit à refuser : on ne peut plus garantir
    // qu'une exemption ne vient pas d'être perdue.
    if (!affectedRoles.readable || !affectedChannels.readable
        || !ignoredRoles.readable || !ignoredChannels.readable) {
        return false;
    }

    const roleIds = memberRoleIds(target.member);
    const channelIds = channelScopeIds(target.channel);

    // ─── Exemptions d'abord ───
    if (ignoredRoles.ids.length && roleIds && intersects(roleIds, ignoredRoles.ids)) return false;
    if (ignoredChannels.ids.length && channelIds && intersects(channelIds, ignoredChannels.ids)) return false;

    // Une exemption qu'on ne peut pas évaluer (membre parti, salon supprimé) est
    // traitée comme peut-être applicable : on n'applique pas la règle plutôt que
    // de risquer de sanctionner une personne explicitement mise à l'abri.
    if (ignoredRoles.ids.length && !roleIds) return false;
    if (ignoredChannels.ids.length && !channelIds) return false;

    // ─── Restrictions ensuite. Liste vide = « tout », donc rien à vérifier. ───
    if (affectedRoles.ids.length) {
        if (!roleIds) return false;
        if (!intersects(roleIds, affectedRoles.ids)) return false;
    }
    if (affectedChannels.ids.length) {
        if (!channelIds) return false;
        if (!intersects(channelIds, affectedChannels.ids)) return false;
    }

    return true;
}

module.exports = { isInScope };
