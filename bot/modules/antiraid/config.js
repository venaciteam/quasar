// ═══════════════════════════════════════════════════════════════
//  Anti-raid — lecture et normalisation de la configuration
//
//  Une seule lecture de `antiraid_config` dans tout le projet, et un seul
//  endroit qui décide ce qu'est une configuration exploitable. Trois raisons
//  d'isoler ça ici plutôt que de faire un SELECT à l'arrivée d'un membre :
//
//   1. LE COÛT. Ce module est appelé une fois par arrivée. Pendant un raid,
//      c'est plusieurs milliers de fois par minute, sur des instances qui
//      tournent parfois sur un Raspberry Pi. Un cache court évite de repayer
//      la lecture — et l'API invalide explicitement à l'enregistrement, pour
//      qu'un changement de réglage s'applique tout de suite et pas « dans
//      quinze secondes ».
//
//   2. LES VALEURS ABERRANTES. L'API refuse un seuil à 0 ou 1, mais la base
//      peut avoir été éditée à la main, ou provenir d'un retour arrière de
//      version. Un seuil de 1 arrivée signifierait « sanctionner toute personne
//      qui rejoint » : c'est exactement le contraire d'un anti-raid. Une valeur
//      hors bornes rend donc la configuration INEXPLOITABLE — je n'applique
//      rien et je le dis — plutôt que d'être ramenée au plus proche seuil
//      valide, ce qui reviendrait à deviner une intention.
//
//   3. LES PUNITIONS ILLISIBLES. Même posture : une chaîne non vide dont
//      aucune action n'est reconnue ne devient pas « alerte seule » en
//      silence. Elle est signalée comme illisible, et la vague n'est
//      qu'alertée. Le socle sait déjà valider (validatePunishments) ; ici on
//      décide seulement quoi faire du verdict.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');
const { parsePunishments, validatePunishments } = require('../../utils/punishments');

// Bornes des réglages. Elles sont exportées : l'API les applique à la saisie,
// et le dashboard les affiche. Les recopier ailleurs ferait diverger ce que
// l'interface promet de ce que le bot accepte réellement.
const LIMITS = Object.freeze({
    // 2 arrivées minimum : à 1, « N arrivées en X secondes » décrit chaque
    // arrivée prise isolément, plus une vague.
    MIN_JOIN_COUNT: 2,
    MAX_JOIN_COUNT: 100,
    // 5 secondes minimum : en dessous, la fenêtre est plus courte que le délai
    // de propagation des événements Discord et déclencherait au hasard.
    MIN_WINDOW_SECONDS: 5,
    MAX_WINDOW_SECONDS: 3600,
    MIN_ACCOUNT_AGE_HOURS: 0,          // 0 = contrôle d'âge désactivé
    MAX_ACCOUNT_AGE_HOURS: 8760,       // un an
    MIN_PANIC_SECONDS: 0,              // 0 = mode panique désactivé
    // Plafond imposé par Discord sur les actions d'incident (invitations mises
    // en pause) : 24 heures. Au-delà, l'API refuse la requête — autant refuser
    // la saisie plutôt que de laisser découvrir l'échec au moment du raid.
    MAX_PANIC_SECONDS: 86400,
    MAX_PUNISHMENTS_LENGTH: 200,
    MAX_RESPONSE_MESSAGE: 1000,
});

// Durée de vie du cache. Assez courte pour qu'un réglage modifié hors
// dashboard (édition directe de la base) finisse par être pris en compte,
// assez longue pour que la lecture ne coûte rien pendant une vague.
const CACHE_TTL_MS = 15_000;

/** guildId → { at: timestamp ms, config: object|null } */
const cache = new Map();

/**
 * Une valeur de base entière et dans ses bornes, ou null.
 * Renvoyer null (et pas une valeur repliée) est délibéré : l'appelant doit
 * pouvoir distinguer « réglage absurde » de « réglage prudent ».
 */
function boundedInt(raw, min, max) {
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;
    if (value < min || value > max) return null;
    return value;
}

/**
 * Traduit une ligne de `antiraid_config` en configuration exploitable.
 *
 * @returns {{
 *   enabled: boolean, joinCount: number, windowMs: number,
 *   minAccountAgeMs: number, punishments: Array, alertOnly: boolean,
 *   panicSeconds: number, logChannelId: string|null, responseMessage: string|null,
 *   problems: string[]
 * }|null} null si le serveur n'a rien configuré.
 */
function normalize(row) {
    if (!row) return null;

    const problems = [];

    const joinCount = boundedInt(row.join_count, LIMITS.MIN_JOIN_COUNT, LIMITS.MAX_JOIN_COUNT);
    if (joinCount === null) {
        problems.push(`Le seuil d'arrivées (${row.join_count}) est hors des bornes acceptées `
            + `(${LIMITS.MIN_JOIN_COUNT} à ${LIMITS.MAX_JOIN_COUNT}).`);
    }

    const windowSeconds = boundedInt(row.join_window_seconds, LIMITS.MIN_WINDOW_SECONDS, LIMITS.MAX_WINDOW_SECONDS);
    if (windowSeconds === null) {
        problems.push(`La fenêtre de détection (${row.join_window_seconds} s) est hors des bornes acceptées `
            + `(${LIMITS.MIN_WINDOW_SECONDS} à ${LIMITS.MAX_WINDOW_SECONDS} secondes).`);
    }

    // L'âge de compte est le seul réglage qu'on replie au lieu de refuser :
    // une valeur illisible y vaut « pas de contrôle d'âge », c'est-à-dire le
    // comportement le plus permissif. Refuser toute la configuration parce
    // qu'un contrôle facultatif est mal réglé désarmerait la détection de
    // vague, qui, elle, est correcte.
    const accountAgeHours = boundedInt(row.min_account_age_hours, LIMITS.MIN_ACCOUNT_AGE_HOURS, LIMITS.MAX_ACCOUNT_AGE_HOURS) ?? 0;

    const panicSeconds = boundedInt(row.panic_duration_seconds, LIMITS.MIN_PANIC_SECONDS, LIMITS.MAX_PANIC_SECONDS) ?? 0;

    const raw = typeof row.punishments === 'string' ? row.punishments.trim() : '';
    const check = validatePunishments(raw);
    let punishments = [];
    if (!check.valid) {
        problems.push(`Les sanctions enregistrées sont illisibles : ${check.errors.join(' ')}`);
    } else {
        punishments = parsePunishments(raw).punishments;
    }

    return {
        enabled: !!row.enabled,
        joinCount,
        windowMs: windowSeconds === null ? null : windowSeconds * 1000,
        windowSeconds,
        minAccountAgeMs: accountAgeHours * 3600 * 1000,
        accountAgeHours,
        punishments,
        // « Alerte seule » : configuration valide et volontaire. Une chaîne
        // illisible n'en fait PAS partie — elle est signalée dans `problems`,
        // et le module refusera d'agir.
        alertOnly: check.valid && punishments.length === 0,
        panicSeconds,
        logChannelId: row.log_channel || null,
        responseMessage: row.response_message || null,
        problems,
    };
}

/** Lecture directe, sans cache. Ne lève jamais. */
function readConfig(guildId) {
    try {
        const row = getDb().prepare('SELECT * FROM antiraid_config WHERE guild_id = ?').get(guildId);
        return normalize(row);
    } catch (err) {
        console.error('[Quasar Anti-raid] Lecture de la configuration en échec :', err.message);
        return null;
    }
}

/**
 * Configuration d'un serveur, mise en cache pour la durée de CACHE_TTL_MS.
 * @returns {object|null}
 */
function getConfig(guildId, now = Date.now()) {
    const hit = cache.get(guildId);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.config;

    const config = readConfig(guildId);
    cache.set(guildId, { at: now, config });
    return config;
}

/**
 * Oublie la configuration mise en cache d'un serveur — appelé par l'API après
 * un enregistrement. Sans ça, une personne qui règle son anti-raid et teste
 * dans la foulée verrait l'ancien réglage s'appliquer, et conclurait que le
 * formulaire n'enregistre rien.
 *
 * Sans argument : vide tout le cache (utile aux tests).
 */
function invalidateConfig(guildId) {
    if (guildId === undefined) cache.clear();
    else cache.delete(guildId);
}

module.exports = {
    LIMITS,
    normalize,
    getConfig,
    invalidateConfig,
};
