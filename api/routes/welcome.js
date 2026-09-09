const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');
const { getDb } = require('../services/database');
const { SNOWFLAKE } = require('../services/mentions');
const router = express.Router({ mergeParams: true });

// ═══════════════════════════════════════════════════════════════
//  Validation de la configuration Welcome / Leave
//
//  Cette route n'a longtemps rien vérifié du tout : ni type, ni longueur, ni
//  forme de `welcome_embed`. Tout ce qui arrivait dans le corps repartait en
//  base, puis dans le DOM du dashboard et dans un embed Discord. Deux ennuis
//  distincts, corrigés ici :
//    1. sécurité — la valeur relue par le dashboard est du texte, jamais un
//       objet arbitraire, et l'échappement côté page ne suffit pas seul ;
//    2. exploitation — un message de 12 000 caractères ou une couleur qui n'en
//       est pas une n'échouait qu'au moment de l'arrivée d'un membre, dans un
//       `catch` du bot, sans que personne ne le sache.
//
//  Un champ invalide est REFUSÉ, jamais réparé en silence : une configuration
//  discrètement tronquée serait pire qu'un refus expliqué.
// ═══════════════════════════════════════════════════════════════

// Plafonds Discord. Le message texte est posté en contenu de message (2000),
// le reste vit dans un embed.
const LIMITES = {
    message: 2000,
    title: 256,
    description: 4096,
    footer: 2048,
    url: 2048,
};

// `#c86e8e`, avec ou sans dièse : buildEmbed() retire le dièse puis lit la
// valeur en hexadécimal.
const COULEUR_HEX = /^#?[0-9a-fA-F]{6}$/;
const URL_HTTP = /^https?:\/\//i;

// Champs qu'un embed de bienvenue ou de départ peut porter — exactement ceux
// que bot/utils/welcomeMessage.js sait rendre. Une clé inconnue est refusée
// plutôt qu'ignorée : elle signale un appel qui croit configurer quelque chose.
const CHAMPS_EMBED = ['title', 'description', 'color', 'footer', 'thumbnail', 'image'];

const LIBELLES = {
    welcome_channel: 'Le salon de bienvenue',
    leave_channel: 'Le salon de départ',
    welcome_message: 'Le message de bienvenue',
    leave_message: 'Le message de départ',
    welcome_embed: "L'embed de bienvenue",
    leave_embed: "L'embed de départ",
};

/** Un salon : identifiant Discord, ou rien. */
function lireSalon(valeur, champ) {
    if (valeur === undefined || valeur === null || valeur === '') return { value: null };
    if (typeof valeur !== 'string' || !SNOWFLAKE.test(valeur.trim())) {
        return { error: `${LIBELLES[champ]} doit être un identifiant de salon Discord (17 à 20 chiffres).` };
    }
    return { value: valeur.trim() };
}

/** Un texte libre, plafonné. */
function lireTexte(valeur, { libelle, max }) {
    if (valeur === undefined || valeur === null || valeur === '') return { value: null };
    if (typeof valeur !== 'string') return { error: `${libelle} doit être du texte.` };
    if (valeur.length > max) {
        return { error: `${libelle} dépasse ${max} caractères : Discord refuserait de l'envoyer.` };
    }
    return { value: valeur };
}

/** L'embed complet : objet simple, clés connues, valeurs plafonnées. */
function lireEmbed(valeur, champ) {
    if (valeur === undefined || valeur === null || valeur === '') return { value: null };
    if (typeof valeur !== 'object' || Array.isArray(valeur)) {
        return { error: `${LIBELLES[champ]} doit être un objet.` };
    }

    const inconnues = Object.keys(valeur).filter(k => !CHAMPS_EMBED.includes(k));
    if (inconnues.length) {
        return { error: `${LIBELLES[champ]} ne connaît pas le champ « ${inconnues[0]} ». Champs acceptés : ${CHAMPS_EMBED.join(', ')}.` };
    }

    const propre = {};

    for (const champTexte of ['title', 'description', 'footer']) {
        const lu = lireTexte(valeur[champTexte], { libelle: `${LIBELLES[champ]} (${champTexte})`, max: LIMITES[champTexte] });
        if (lu.error) return lu;
        if (lu.value !== null) propre[champTexte] = lu.value;
    }

    if (valeur.color !== undefined && valeur.color !== null && valeur.color !== '') {
        if (typeof valeur.color !== 'string' || !COULEUR_HEX.test(valeur.color)) {
            return { error: `${LIBELLES[champ]} attend une couleur hexadécimale, par exemple #c86e8e.` };
        }
        propre.color = valeur.color;
    }

    // `avatar` est le mot-clé qui demande l'avatar du membre ; toute autre
    // valeur doit être une URL d'image, et seuls http(s) sont acceptés — un
    // `javascript:` n'a rien à faire dans une vignette.
    if (valeur.thumbnail !== undefined && valeur.thumbnail !== null && valeur.thumbnail !== '') {
        if (valeur.thumbnail !== 'avatar') {
            const lu = lireTexte(valeur.thumbnail, { libelle: `${LIBELLES[champ]} (thumbnail)`, max: LIMITES.url });
            if (lu.error) return lu;
            if (!URL_HTTP.test(lu.value)) {
                return { error: `${LIBELLES[champ]} attend « avatar » ou une adresse http(s) pour la vignette.` };
            }
        }
        propre.thumbnail = valeur.thumbnail;
    }

    if (valeur.image !== undefined && valeur.image !== null && valeur.image !== '') {
        const lu = lireTexte(valeur.image, { libelle: `${LIBELLES[champ]} (image)`, max: LIMITES.url });
        if (lu.error) return lu;
        if (!URL_HTTP.test(lu.value)) {
            return { error: `${LIBELLES[champ]} attend une adresse http(s) pour l'image.` };
        }
        propre.image = lu.value;
    }

    // Un embed sans le moindre champ n'afficherait rien : autant le traiter
    // comme une absence d'embed, ce que fait déjà `embedoff` côté bot.
    return { value: Object.keys(propre).length ? propre : null };
}

/**
 * Corps de requête (non fiable) → configuration prête à écrire, ou { error }.
 * Exportée pour être testée sans monter de serveur ni forger de session.
 */
function validateWelcomeConfig(body) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { error: 'Le corps de la requête doit être un objet JSON.' };
    }

    const config = {};

    for (const champ of ['welcome_channel', 'leave_channel']) {
        const lu = lireSalon(body[champ], champ);
        if (lu.error) return lu;
        config[champ] = lu.value;
    }

    for (const champ of ['welcome_message', 'leave_message']) {
        const lu = lireTexte(body[champ], { libelle: LIBELLES[champ], max: LIMITES.message });
        if (lu.error) return lu;
        config[champ] = lu.value;
    }

    for (const champ of ['welcome_embed', 'leave_embed']) {
        const lu = lireEmbed(body[champ], champ);
        if (lu.error) return lu;
        config[champ] = lu.value;
    }

    // Les deux interrupteurs restent tolérants : ils n'ont que deux états, et
    // n'importe quelle valeur se range dans l'un ou l'autre sans ambiguïté.
    config.welcome_enabled = body.welcome_enabled ? 1 : 0;
    config.leave_enabled = body.leave_enabled ? 1 : 0;

    return { value: config };
}

router.get('/config', requireAuth, requireGuildAdmin, (req, res) => {
    const db = getDb();
    const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(req.params.guildId);
    if (!config) return res.json({});
    let welcomeEmbed = null;
    let leaveEmbed = null;
    try { welcomeEmbed = config.welcome_embed ? JSON.parse(config.welcome_embed) : null; } catch { welcomeEmbed = null; }
    try { leaveEmbed = config.leave_embed ? JSON.parse(config.leave_embed) : null; } catch { leaveEmbed = null; }
    res.json({
        welcome_channel: config.welcome_channel,
        welcome_message: config.welcome_message,
        welcome_embed: welcomeEmbed,
        welcome_enabled: !!config.welcome_enabled,
        leave_channel: config.leave_channel,
        leave_message: config.leave_message,
        leave_embed: leaveEmbed,
        leave_enabled: !!config.leave_enabled
    });
});

router.put('/config', requireAuth, requireGuildAdmin, (req, res) => {
    const verdict = validateWelcomeConfig(req.body);
    if (verdict.error) return res.status(400).json({ error: verdict.error });
    const d = verdict.value;

    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(req.params.guildId);
    db.prepare(`UPDATE welcome_config SET
        welcome_channel = ?, welcome_message = ?, welcome_embed = ?, welcome_enabled = ?,
        leave_channel = ?, leave_message = ?, leave_embed = ?, leave_enabled = ?
        WHERE guild_id = ?
    `).run(
        d.welcome_channel, d.welcome_message,
        d.welcome_embed ? JSON.stringify(d.welcome_embed) : null, d.welcome_enabled,
        d.leave_channel, d.leave_message,
        d.leave_embed ? JSON.stringify(d.leave_embed) : null, d.leave_enabled,
        req.params.guildId
    );
    res.json({ success: true });
});

module.exports = router;
// Exposé à côté du routeur (même procédé que api/routes/erasure.js) : la
// validation se teste directement, sans session ni serveur HTTP.
module.exports.validateWelcomeConfig = validateWelcomeConfig;
