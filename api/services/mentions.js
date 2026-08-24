// ═══════════════════════════════════════════════════════════════
//  Mentions — logique partagée « qui doit être pingé ? »
//
//  Les rappels programmés (scheduled_messages) et les embeds personnalisés
//  (embeds) décrivent leurs mentions avec exactement les mêmes colonnes :
//    mention_roles / mention_users  → TEXT, JSON array d'IDs Discord
//    mention_everyone / mention_here → INTEGER 0|1
//
//  Ce module centralise les trois seules opérations faites dessus :
//    parseMentions       corps de requête HTTP (non fiable) → colonnes SQL
//    serializeMentions   ligne SQL → types JS pour le dashboard
//    buildMentionPayload ligne SQL → ligne de mentions + allowedMentions Discord
//
//  Volontairement sans dépendance (ni express, ni discord.js, ni base) : il est
//  requis aussi bien depuis les routes API que depuis le bot.
// ═══════════════════════════════════════════════════════════════

const SNOWFLAKE = /^\d{17,20}$/;

// Discord plafonne allowed_mentions.roles et .users à 100 entrées chacun :
// au-delà, l'API rejette le message entier. On tronque à l'écriture plutôt
// que de laisser un envoi échouer plus tard, au moment du ping.
const MAX_IDS = 100;

// Normalise une liste d'identifiants venue d'un corps de requête ou d'une
// colonne JSON : uniquement des snowflakes, sans doublon, plafonnée.
function normalizeIds(value) {
    let list = value;
    if (typeof list === 'string') {
        try { list = JSON.parse(list); } catch { return []; }
    }
    if (!Array.isArray(list)) return [];
    const clean = list.map(String).filter(id => SNOWFLAKE.test(id));
    return Array.from(new Set(clean)).slice(0, MAX_IDS);
}

// Corps de requête → valeurs prêtes à être écrites en base.
// Rien n'est fait confiance : un champ absent, mal typé ou hostile retombe
// sur la valeur sûre (aucune mention).
function parseMentions(body = {}) {
    return {
        mention_roles: JSON.stringify(normalizeIds(body.mention_roles)),
        mention_users: JSON.stringify(normalizeIds(body.mention_users)),
        mention_everyone: body.mention_everyone ? 1 : 0,
        mention_here: body.mention_here ? 1 : 0
    };
}

// Ligne SQL → types JS (arrays + booléens) pour les réponses API.
function serializeMentions(row = {}) {
    return {
        mention_roles: normalizeIds(row.mention_roles),
        mention_users: normalizeIds(row.mention_users),
        mention_everyone: !!row.mention_everyone,
        mention_here: !!row.mention_here
    };
}

// Vrai si la source décrit au moins une mention. Sert notamment à la règle de
// précédence rappel > embed dans le scheduler.
function hasMentions(source = {}) {
    return !!(
        source.mention_everyone ||
        source.mention_here ||
        normalizeIds(source.mention_roles).length ||
        normalizeIds(source.mention_users).length
    );
}

// Ligne SQL → { content, allowedMentions } prêt pour channel.send().
//
// Sécurité : allowedMentions part de `parse: []` (aucune mention implicite
// autorisée) et n'ouvre QUE les IDs explicitement configurés. 'everyone' n'est
// ajouté au parse que si @everyone ou @here est demandé. Une mention présente
// dans le texte mais absente de ces listes est rendue en clair, sans notifier.
function buildMentionPayload(source = {}) {
    const roles = normalizeIds(source.mention_roles);
    const users = normalizeIds(source.mention_users);

    const parts = [];
    if (source.mention_everyone) parts.push('@everyone');
    if (source.mention_here) parts.push('@here');
    for (const roleId of roles) parts.push(`<@&${roleId}>`);
    for (const userId of users) parts.push(`<@${userId}>`);

    const allowedMentions = { parse: [], roles, users };
    if (source.mention_everyone || source.mention_here) {
        allowedMentions.parse.push('everyone');
    }

    return { content: parts.join(' '), allowedMentions };
}

// Verrou total : aucune mention ne peut notifier. Utilisé pour les aperçus et
// les éditions, où le texte peut contenir des mentions à afficher sans pinger.
function silentMentions() {
    return { parse: [], roles: [], users: [] };
}

module.exports = {
    SNOWFLAKE,
    parseMentions,
    serializeMentions,
    hasMentions,
    buildMentionPayload,
    silentMentions
};
