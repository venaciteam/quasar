// ═══════════════════════════════════════════════════════════════
//  Quasar — Suspension d'un serveur (coupure ciblée, sous-lot E)
//
//  La suspension est un simple DRAPEAU RÉVERSIBLE porté par la table `guilds`
//  (colonnes `suspended`, `suspended_at`, `suspended_reason`, ajoutées par la
//  migration lot2_compliance_v1). Elle ne supprime AUCUNE donnée et ne retire
//  PAS le bot du serveur : elle sert uniquement à couper les fonctions de
//  Quasar sur CE serveur, sans affecter les autres.
//
//  Ce module est volontairement léger et SANS dépendance au client Discord :
//  il est appelé aussi bien côté bot (enforcement en tête d'interactionCreate)
//  que côté API (blocage de la configuration d'un serveur suspendu). La bascule
//  du drapeau, elle, se fait via la route owner `api/routes/owner.js`.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../api/services/database');

// True si le serveur est suspendu.
// Dégradation gracieuse (cf. Conventions de la DA) : si la table ou la colonne
// `suspended` n'existe pas encore (tout premier boot, avant la migration lot2),
// on renvoie false. Un doute technique ne doit jamais couper un serveur légitime.
function isSuspended(guildId) {
    if (!guildId) return false;
    try {
        const row = getDb()
            .prepare('SELECT suspended FROM guilds WHERE guild_id = ?')
            .get(guildId);
        return !!(row && row.suspended);
    } catch {
        return false;
    }
}

// Détail de la suspension : { suspended, reason }.
// `reason` vaut null si le serveur n'est pas suspendu ou si aucun motif n'a été
// enregistré. Même dégradation gracieuse que `isSuspended`.
function getSuspension(guildId) {
    if (!guildId) return { suspended: false, reason: null };
    try {
        const row = getDb()
            .prepare('SELECT suspended, suspended_reason FROM guilds WHERE guild_id = ?')
            .get(guildId);
        if (!row || !row.suspended) return { suspended: false, reason: null };
        return { suspended: true, reason: row.suspended_reason || null };
    } catch {
        return { suspended: false, reason: null };
    }
}

module.exports = { isSuspended, getSuspension };
