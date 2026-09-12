// ═══════════════════════════════════════════════════════════════
//  Gabarits d'accueil et de départ
//
//  Une seule grammaire de variables — {user} {username} {server} {membercount} —
//  partagée par /welcome, /leave, l'arrivée et le départ d'un membre. Elle est
//  aussi celle que le dashboard documente (api/routes/welcome.js) : la changer
//  ici sans l'y changer ferait mentir l'interface.
//
//  Les deux fonctions ne connaissent plus la plateforme. Elles reçoivent le
//  MEMBRE et la GUILDE normalisés, et rendent un embed NEUTRE : c'est le rendu
//  de l'adaptateur qui décide de la forme envoyée.
// ═══════════════════════════════════════════════════════════════

const { embed } = require('../platform/embed');

// Taille de l'avatar en vignette d'embed d'accueil. C'était déjà la valeur
// posée à la main ; elle reste ici, à l'endroit qui la demande.
const TAILLE_AVATAR = 128;

/**
 * Remplace les variables d'un gabarit d'accueil ou de départ.
 *
 * `{username}` rend le pseudonyme BRUT et `{user}` la mention : ce sont deux
 * variables distinctes du gabarit, et `membre.nom` (le nom affiché) ne remplace
 * ni l'une ni l'autre.
 *
 * @param {string} text
 * @param {object} membre  membre normalisé (bot/platform/discord/context.js)
 * @param {object} guilde  guilde normalisée
 */
function resolveVariables(text, membre, guilde) {
    if (!text) return text;
    return text
        .replace(/\{user\}/g, membre.mention)
        .replace(/\{username\}/g, membre.nomUtilisateur)
        .replace(/\{server\}/g, guilde.nom)
        .replace(/\{membercount\}/g, guilde.membreCount);
}

/**
 * Construit l'embed d'accueil ou de départ à partir de la configuration stockée
 * en base (colonne `welcome_embed` / `leave_embed`, du JSON).
 *
 * ⚠️ `JSON.parse` n'est PAS protégé, volontairement : une configuration
 * illisible doit remonter à l'appelant, qui décide. L'avaler ici enverrait un
 * message d'accueil sans embed sans que personne ne sache pourquoi.
 *
 * @returns {object|null} embed neutre, ou null si aucun embed n'est configuré
 */
function buildEmbed(embedConfig, membre, guilde) {
    if (!embedConfig) return null;
    const cfg = typeof embedConfig === 'string' ? JSON.parse(embedConfig) : embedConfig;

    // `thumbnail: 'avatar'` est le mot-clé posé par `/welcome embed` : la
    // vignette suit alors la personne qui arrive, au lieu d'une URL fixe.
    const vignette = cfg.thumbnail === 'avatar'
        ? membre.avatar(TAILLE_AVATAR)
        : (cfg.thumbnail || undefined);

    return embed({
        titre: cfg.title ? resolveVariables(cfg.title, membre, guilde) : undefined,
        description: cfg.description ? resolveVariables(cfg.description, membre, guilde) : undefined,
        couleur: cfg.color || undefined,
        pied: cfg.footer ? { texte: resolveVariables(cfg.footer, membre, guilde) } : undefined,
        vignette,
        image: cfg.image || undefined,
    });
}

module.exports = { resolveVariables, buildEmbed, TAILLE_AVATAR };
