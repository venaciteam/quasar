// ═══════════════════════════════════════════════════════════════
//  Contrôle d'accès d'une commande personnalisée — partie neutre
//
//  Une commande personnalisée est déclenchable à volonté par n'importe qui, et
//  elle rejoue les mentions de l'embed qu'elle affiche — `@everyone` compris.
//  C'est CE contrôle d'accès, et lui seul, qui empêche que `/faq` devienne un
//  bouton « pinger tout le serveur » à disposition de tous.
//
//  ─── Pourquoi il est ici et pas dans un adaptateur ──────────────────────────
//
//  La règle ne connaît aucune plateforme : trois modes en base, un membre, ses
//  rôles, et la liste des rôles du serveur. Elle existait pourtant en DEUX
//  exemplaires — un dans le bootstrap Discord, un dans le parseur Fluxer —
//  parce que le premier lisait une interaction discord.js et le second un
//  payload de passerelle.
//
//  Deux copies d'un contrôle d'accès finissent par diverger, et la divergence
//  ne se voit pas : elle s'observe le jour où une commande restreinte répond à
//  quelqu'un qui n'aurait pas dû pouvoir la lancer. C'est le doublon le plus
//  dangereux de la couche, et c'est pour ça qu'il tombe le premier.
//
//  ─── Les trois modes ────────────────────────────────────────────────────────
//
//    'everyone' → tout le monde (défaut, et comportement historique)
//    'admins'   → permission ADMINISTRATOR sur le serveur
//    'role'     → les porteurs d'un rôle précis (`access_role_id`)
//
//  Dans TOUS les modes, un administrateur passe. Ce n'est pas un trou de
//  sécurité, c'est ce qui rend le réglage réparable :
//    1. on ne s'enferme pas dehors de sa propre commande — configurer un mode
//       « rôle » sans s'être attribué ce rôle est l'erreur la plus courante ;
//    2. une configuration cassée — rôle supprimé du serveur, mode inconnu en
//       base — resterait sinon bloquée pour tout le monde, y compris pour les
//       seules personnes capables de la corriger.
//  Un administrateur peut de toute façon s'attribuer n'importe quel rôle : la
//  restriction ne lui interdisait rien, elle ne faisait que le gêner.
// ═══════════════════════════════════════════════════════════════

const { effectiveAccessMode } = require('../../api/services/database');

/**
 * La personne peut-elle lancer cette commande personnalisée ?
 *
 * @param {object} ligne  ligne `custom_commands` : { name, access_mode, access_role_id }
 * @param {object|null} membre  membre NORMALISÉ par l'adaptateur — il porte
 *   `roles` (identifiants) et `aPermission(nom)`. `null` hors serveur.
 * @param {object} [options]
 * @param {Map|Set|object} [options.roles]  rôles du serveur, pour détecter un
 *   `access_role_id` qui n'existe plus. Omis, le contrôle d'existence est
 *   sauté — on ne refuse pas sur une information qu'on n'a pas.
 * @returns {null|{titre: string, cause: string, action: string}} `null` = accès
 *   accordé, sinon le refus à afficher.
 */
function verifierAccesCommandePersonnalisee(ligne, membre, { roles = null } = {}) {
    // Repli sur le plus restrictif si la valeur en base n'est pas reconnue
    // (cf. `effectiveAccessMode`). On le journalise : c'est le signe d'une base
    // incohérente, et la commande devient inaccessible aux non-administrateurs.
    const mode = effectiveAccessMode(ligne.access_mode);
    if (ligne.access_mode && mode !== ligne.access_mode) {
        console.warn(
            `[Quasar] Commande custom ${ligne.name} : mode d'accès inconnu "${ligne.access_mode}" `
            + `— repli sur "${mode}".`
        );
    }

    if (mode === 'everyone') return null;

    // Hors serveur (message privé) il n'y a ni membre ni rôle : rien n'est
    // vérifiable, donc rien n'est accordé. On ne s'appuie pas sur l'hypothèse
    // qu'une commande personnalisée n'arrive jamais en privé pour décider d'un
    // droit.
    if (!membre) {
        return {
            titre: 'Commande réservée au serveur',
            cause: 'L\'accès à cette commande dépend de vos rôles ou de vos permissions, et je n\'arrive pas à les consulter ici.',
            action: 'Relancez-la depuis un salon du serveur concerné. Si vous y êtes déjà, réessayez dans un instant.',
        };
    }

    // Contournement administrateur — appliqué à TOUS les modes et AVANT leur
    // évaluation. Voir l'en-tête du fichier pour les deux raisons.
    if (membre.aPermission?.('ADMINISTRATOR')) return null;

    if (mode === 'admins') {
        return {
            titre: 'Commande réservée aux administrateurs',
            cause: 'Cette commande personnalisée est configurée pour les membres ayant la permission « Administrateur » sur ce serveur.',
            action: 'Demandez à un administrateur de la lancer, ou d\'ouvrir son accès depuis le dashboard ou `/cmd edit`.',
        };
    }

    // mode === 'role'
    const roleId = ligne.access_role_id;

    // Rôle configuré puis supprimé du serveur : plus personne ne peut le
    // porter. On refuse — retomber sur « tout le monde » ouvrirait en grand une
    // commande volontairement restreinte — et on le dit clairement, pour que la
    // personne puisse le signaler plutôt que de croire à un bug. Les
    // administrateurs, eux, sont déjà passés plus haut.
    if (!roleId || (roles && !roleConnu(roles, roleId))) {
        return {
            titre: 'Commande momentanément indisponible',
            cause: 'Cette commande est réservée à un rôle qui n\'existe plus sur le serveur : en dehors des administrateurs, personne ne peut donc l\'utiliser pour l\'instant.',
            action: 'Signalez-le à un administrateur : il peut choisir un autre rôle depuis le dashboard ou `/cmd edit`.',
        };
    }

    if ((membre.roles || []).map(String).includes(String(roleId))) return null;

    return {
        titre: 'Commande réservée à un rôle',
        cause: `Cette commande personnalisée est réservée aux membres ayant le rôle <@&${roleId}>, ainsi qu'aux administrateurs du serveur.`,
        action: 'Si vous pensez que ce rôle devrait vous être attribué, demandez-le à un administrateur.',
    };
}

/**
 * Le serveur connaît-il ce rôle ?
 *
 * Accepte les trois formes que les adaptateurs ont sous la main : une `Map`
 * (état local Fluxer), un `Set`, ou un objet indexé. Un adaptateur ne devrait
 * pas avoir à convertir sa collection pour poser une question aussi simple.
 */
function roleConnu(roles, roleId) {
    const cle = String(roleId);
    if (typeof roles.has === 'function') return roles.has(cle);
    return Object.prototype.hasOwnProperty.call(roles, cle);
}

module.exports = { verifierAccesCommandePersonnalisee, roleConnu };
