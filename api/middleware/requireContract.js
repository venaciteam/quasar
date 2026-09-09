// ═══════════════════════════════════════════════════════════════════
//  Quasar — Imposition du contrat de sous-traitance côté serveur
//  (Lot 2 conformité RGPD, art. 28.3)
//
//  Raison d'être : jusqu'ici, le contrat n'était imposé que par le navigateur.
//  `hasAcceptedCurrent()` n'avait qu'un seul appelant, GET /api/contract/status,
//  que seul l'écran d'acceptation (dashboard/js/contractGate.js) consulte. Aucun
//  middleware n'interposait l'acceptation devant /api/guilds/:guildId/*, donc une
//  personne qui refusait le contrat — ou n'importe quel script muni d'un JWT —
//  configurait et lisait tout par l'API directe. L'article 2.3 du contrat et la
//  politique de confidentialité affirmaient un blocage qui n'existait pas.
//
//  Deux exemptions, toutes les deux volontaires :
//   • Instance non publique : `isContractRequired()` répond false hors
//     QUASAR_MODE=public. Le contrat de Venacity nomme Venacity comme
//     sous-traitant : l'imposer sur une instance auto-hébergée, dont l'opérateur
//     est quelqu'un d'autre, n'aurait aucun sens juridique.
//   • Routes /erasure : une obligation légale ne se suspend pas parce qu'un
//     contrat n'est pas signé. Même motif, même formulation que le garde-fou de
//     suspension d'api/index.js, qui exempte /erasure de la même façon.
// ═══════════════════════════════════════════════════════════════════

const { verifyToken } = require('./auth');
const { isContractRequired, hasAcceptedCurrent, CONTRACT_VERSION } = require('../services/contract');

// Code d'erreur stable, à destination du front : il lui permet de distinguer un
// refus « contrat non accepté » d'un refus de droits, et donc de rouvrir l'écran
// d'acceptation (window.checkContractGate) au lieu d'afficher un message
// générique qui ne dirait pas quoi faire.
const CONTRACT_REQUIRED_CODE = 'CONTRACT_REQUIRED';

function requireContract(req, res, next) {
    if (!isContractRequired()) return next();

    // Exemption des demandes d'exercice des droits : voir l'en-tête de fichier.
    // Même test que le garde-fou de suspension, pour que les deux exemptions
    // restent lisibles côte à côte et ne divergent pas.
    if (req.path.includes('/erasure')) return next();

    // Ce middleware est monté AVANT les routeurs, donc avant leur `requireAuth` :
    // `req.user` n'est pas encore posé et le jeton doit être lu ici. Sans jeton
    // valide, on laisse passer : ce n'est pas au contrat de répondre à la place de
    // l'authentification, `requireAuth` répondra 401 juste après. Un 403 « contrat
    // non accepté » sur une requête anonyme enverrait le front vers l'écran
    // d'acceptation alors que la seule chose à faire est de se reconnecter.
    const utilisateur = req.user || verifyToken(
        req.cookies?.token || req.headers.authorization?.replace('Bearer ', '') || ''
    );
    if (!utilisateur?.id) return next();

    let accepte = false;
    try {
        accepte = hasAcceptedCurrent(utilisateur.id);
    } catch (err) {
        // Base injoignable : on refuse plutôt que de laisser passer. Même posture
        // que l'écran d'acceptation, qui bloque quand /status échoue — un incident
        // technique ne doit pas valoir acceptation.
        console.error('[Quasar] Vérification du contrat impossible :', err.message);
    }
    if (accepte) return next();

    return res.status(403).json({
        error: 'Vous devez accepter le contrat de sous-traitance avant de configurer vos serveurs.',
        code: CONTRACT_REQUIRED_CODE,
        contractVersion: CONTRACT_VERSION,
    });
}

module.exports = { requireContract, CONTRACT_REQUIRED_CODE };
