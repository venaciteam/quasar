// ═══════════════════════════════════════════════════════════════
//  Gestionnaire d'erreurs unique de l'API
//
//  Express 5 transmet ici TOUT ce qui échoue dans un handler : exception
//  synchrone comme promesse rejetée. C'est ce qui rend inutile le wrapper
//  `guarded()` que quatre routeurs recopiaient chacun de leur côté — la
//  protection ne dépend plus de la mémoire de qui ajoute une route, elle est
//  portée par le framework.
//
//  Sans ce gestionnaire, Express répondrait avec le sien : une page HTML
//  contenant la pile d'appel. Personne ne veut ça sur un dashboard exposé.
// ═══════════════════════════════════════════════════════════════

const { newIncidentCode, alertIncident } = require('../services/incidents');

// Réponse volontairement identique pour toutes les erreurs internes : le
// détail vit dans les journaux, pas dans le corps de la réponse. Le code
// d'incident est le seul lien entre les deux, et il suffit.
const MESSAGE = 'Une erreur inattendue est survenue côté Quasar. Réessayez dans un instant.';

/**
 * Chemins dont les clientes et clients attendent du JSON. Le reste (vitrine,
 * pages du dashboard) reçoit du texte : un objet JSON affiché brut dans un
 * navigateur ne renseigne personne.
 */
function wantsJson(req) {
    return req.path.startsWith('/api') || req.path.startsWith('/auth');
}

/**
 * Gestionnaire d'erreurs Express. Sa signature à quatre arguments N'EST PAS
 * cosmétique : c'est elle, et elle seule, qui le distingue d'un middleware
 * ordinaire aux yeux d'Express. Retirer `next` en le croyant superflu ferait de
 * ce gestionnaire un middleware ordinaire, que plus aucune erreur n'atteindrait.
 */
/**
 * Une requête simplement mal formée n'est pas un incident.
 *
 * `express.json()` lève des erreurs qui portent DÉJÀ leur statut : 400 pour du
 * JSON invalide, 413 pour un corps au-delà de la limite. Les traiter comme des
 * défaillances du serveur avait deux conséquences. La personne recevait un 500
 * avec un code d'incident, c'est-à-dire « le défaut vient de Quasar », pour une
 * requête qui était la sienne. Et surtout, la route de signalement étant
 * publique, n'importe qui pouvait déclencher en boucle une alerte dans le salon
 * Discord des incidents en envoyant du JSON malformé : le canal se noie, et le
 * jour où une vraie alerte tombe, plus personne ne la regarde.
 *
 * On ne se fie pas au seul `err.status` : n'importe quelle bibliothèque peut en
 * poser un. Le marqueur `err.type` de body-parser identifie précisément la
 * famille visée.
 */
const TYPES_CORPS_INVALIDE = new Set([
    'entity.parse.failed',      // JSON syntaxiquement invalide
    'entity.too.large',         // au-delà de la limite d'express.json()
    'entity.verify.failed',
    'request.aborted',
    'request.size.invalid',
    'parameters.too.many',
    'charset.unsupported',
    'encoding.unsupported',
]);

function corpsInvalide(err) {
    const statut = err?.status || err?.statusCode;
    return TYPES_CORPS_INVALIDE.has(err?.type)
        && Number.isInteger(statut) && statut >= 400 && statut < 500;
}

function errorHandler(err, req, res, next) {
    // Traité avant toute chose : ni code d'incident consommé, ni journal, ni
    // alerte Discord. C'est le sujet même de la correction.
    if (corpsInvalide(err) && !res.headersSent) {
        const statut = err.status || err.statusCode;
        const message = statut === 413
            ? 'Le corps de la requête dépasse la taille autorisée.'
            : 'Le corps de la requête est invalide.';
        if (wantsJson(req)) return res.status(statut).json({ error: message });
        return res.status(statut).type('text/plain; charset=utf-8').send(message);
    }

    const code = newIncidentCode();
    const error = err instanceof Error ? err : new Error(String(err));

    // `req.path` et non `req.originalUrl` : la chaîne de requête transporte des
    // secrets sur certaines routes (le jeton d'authentification passe en
    // paramètre après le retour d'OAuth2). Rien de tout ça ne doit atterrir
    // dans un journal ni dans un salon Discord.
    const route = `${req.method} ${req.path}`;
    const guildId = req.params?.guildId;

    console.error(
        `[Quasar] ❌ ${code} | ${route}${guildId ? ` | guild=${guildId}` : ''} | ` +
        `${error.name}${typeof error.code !== 'undefined' ? `[${error.code}]` : ''}: ${error.message}`,
    );
    console.error(error.stack || error);

    alertIncident(error, {
        code,
        source: route,
        details: { Route: route, ...(guildId ? { Serveur: guildId } : {}) },
    });

    // Réponse déjà commencée (flux SSE, fichier en cours d'envoi) : le statut et
    // les en-têtes sont partis, rien ne peut plus être corrigé. Express ferme
    // proprement la connexion, ce que ce gestionnaire ne sait pas faire.
    if (res.headersSent) return next(error);

    if (wantsJson(req)) {
        return res.status(500).json({ error: MESSAGE, incident: code });
    }
    res.status(500).type('text/plain; charset=utf-8').send(`${MESSAGE}\n\nCode d'incident : ${code}`);
}

module.exports = { errorHandler, corpsInvalide };
