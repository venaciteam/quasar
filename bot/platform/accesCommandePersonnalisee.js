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

// Les deux plateformes plafonnent `allowed_mentions.users` et `.roles` à 100
// entrées : au-delà, l'API rejette le MESSAGE ENTIER. On tronque à la
// construction plutôt que de laisser un envoi échouer au moment du ping.
const MAX_MENTIONS = 100;

// Mentions telles qu'un client les écrit. `<@!id>` est la forme héritée d'une
// mention de membre avec pseudonyme : certains clients la produisent encore, et
// l'ignorer ferait cesser de notifier une mention parfaitement légitime.
const MENTION_UTILISATEUR = /<@!?(\d{5,})>/g;
const MENTION_ROLE = /<@&(\d{5,})>/g;

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

// ═══════════════════════════════════════════════════════════════
//  Verrou de mentions d'une commande personnalisée
//
//  Le contrôle d'accès ci-dessus décide QUI peut déclencher la commande. Il ne
//  décide pas ce que la commande a le droit de NOTIFIER, et ces deux questions
//  ont longtemps été confondues : le chemin texte partait sans aucun verrou, au
//  motif que « ce qui est écrit dans la réponse doit pinger normalement » et que
//  le contrôle d'accès suffisait.
//
//  Il ne suffit pas. Sur une instance publique, il suffit d'un détenteur de
//  MANAGE_GUILD — le droit de créer une commande personnalisée — pour fabriquer
//  un `!faq` en mode `everyone` dont le texte contient `@everyone`. N'importe
//  quel membre le déclenche ensuite, autant de fois qu'il veut. Le contrôle
//  d'accès a fait son travail : la commande EST ouverte à tous, volontairement.
//  C'est le verrou de mentions qui manquait.
//
//  ─── La règle ───────────────────────────────────────────────────────────────
//
//  Les mentions qu'une commande personnalisée peut déclencher sont celles que
//  LA PERSONNE QUI LA DÉCLENCHE pourrait faire elle-même.
//
//  Trois candidats étaient possibles, et les deux autres sont faux :
//
//   • La permission du CRÉATEUR. Elle n'est pas lisible au moment du
//     déclenchement — il n'est plus là, il a peut-être quitté le serveur ou
//     perdu son rôle — et une commande créée par un administrateur deviendrait
//     un canon à `@everyone` transmissible.
//   • Un blocage TOTAL. Il casserait les commandes légitimes : un `!raid` qui
//     ping le rôle « Événement » est exactement l'usage pour lequel les
//     commandes personnalisées existent.
//   • La permission du DÉCLENCHEUR. Elle est lisible, elle est à jour, et elle
//     ne donne à personne un pouvoir qu'il n'avait pas déjà. C'est celle-là.
// ═══════════════════════════════════════════════════════════════

/**
 * Le déclencheur peut-il notifier tout le monde ?
 *
 * `MENTION_EVERYONE` couvre `@everyone`, `@here` ET les rôles non mentionnables
 * sur les deux plateformes — « Whether a member without MENTION_EVERYONE can
 * mention the role » (http-api/permissions.mdx, champ `mentionable`).
 *
 * Un membre illisible répond « non ». Transformer un « je ne sais pas » en
 * droit de notifier tout le serveur serait le pire des replis, et c'est
 * exactement le cas d'un déclenchement hors serveur.
 */
function peutMentionnerTous(membre) {
    return Boolean(membre?.aPermission?.('MENTION_EVERYONE'));
}

/** Identifiants d'un motif, dédoublonnés et plafonnés. */
function extraireIdentifiants(contenu, motif) {
    const trouves = new Set();
    for (const correspondance of String(contenu).matchAll(motif)) trouves.add(correspondance[1]);
    return [...trouves].slice(0, MAX_MENTIONS);
}

/**
 * Verrou de mentions pour le texte libre d'une commande personnalisée.
 *
 * @param {object|null} membre  membre NORMALISÉ qui déclenche la commande
 * @param {object} [contexte]
 * @param {string}  [contexte.contenu]  le texte qui va être envoyé
 * @param {Map|Set|object|Array} [contexte.roles]  rôles du serveur, pour
 *   distinguer un rôle mentionnable d'un rôle qui ne l'est pas
 * @returns {{parse: string[], users?: string[], roles?: string[]}} verrou au
 *   vocabulaire neutre de `rendreContenu` (clé `mentionsAutorisees`)
 *
 * Deux formes sont rendues, et le choix n'est pas cosmétique — les deux
 * plateformes REFUSENT un `parse` non vide combiné à une liste `users` ou
 * `roles` non vide (Fluxer le nomme `PARSE_AND_USERS_OR_ROLES_CANNOT_BE_USED_TOGETHER`,
 * Discord les déclare mutuellement exclusifs). On ne peut donc pas mélanger
 * « tous les rôles sauf ceux-là » : il faut choisir un mode.
 *
 *   • Le déclencheur a MENTION_EVERYONE — il peut déjà tout notifier à la main.
 *     On ouvre par catégories : `{ parse: ['users', 'roles', 'everyone'] }`.
 *     Rien n'est restreint parce que rien ne le serait s'il tapait le message
 *     lui-même.
 *
 *   • Il ne l'a pas. On ferme les catégories et on n'ouvre QUE les
 *     identifiants qu'il pourrait mentionner : `{ parse: [], users: [...],
 *     roles: [...mentionnables] }`. `@everyone` et `@here` restent écrits dans
 *     le message, en clair, sans notifier personne — ce qui est exactement ce
 *     que produirait sa propre saisie.
 *
 * ⚠️ Sans `contenu`, on ne peut pas énumérer : on retombe sur
 * `{ parse: ['users', 'roles'] }`. La protection sur `@everyone` est intacte,
 * mais un rôle NON mentionnable notifierait alors. Les deux dispatchs passent
 * le contenu ; ce repli n'existe que pour un appelant qui ne l'aurait pas.
 */
function mentionsAutoriseesPour(membre, { contenu = null, roles = null } = {}) {
    if (peutMentionnerTous(membre)) return { parse: ['users', 'roles', 'everyone'] };
    if (contenu === null || contenu === undefined) return { parse: ['users', 'roles'] };

    const utilisateurs = extraireIdentifiants(contenu, MENTION_UTILISATEUR);
    const rolesCites = extraireIdentifiants(contenu, MENTION_ROLE);

    // Sans la liste des rôles du serveur, on ne sait pas lesquels sont
    // mentionnables. On les laisse passer : c'était le comportement d'avant, et
    // le refuser ferait taire un ping de rôle légitime sur un simple manque
    // d'information. Le verrou sur `@everyone`, lui, ne dépend d'aucun cache.
    const autorises = roles === null
        ? rolesCites
        : rolesCites.filter(id => estRoleMentionnable(roles, id));

    return { parse: [], users: utilisateurs, roles: autorises };
}

/**
 * Restreint un verrou DÉJÀ CONSTRUIT à ce que le déclencheur pourrait faire.
 *
 * Sert au chemin embed, où les mentions sont celles cochées SUR L'EMBED et
 * rejouées dans un `content` — `buildMentionPayload`. Les mentions d'un embed
 * ne notifient pas ; cette ligne de rejeu, elle, si. Un embed configuré avec
 * `@everyone` par un administrateur deviendrait sinon le même canon, déclenché
 * par n'importe qui.
 *
 * On RETIRE, on n'ajoute jamais : une configuration qui ne demande pas
 * `@everyone` ne doit pas se le voir accorder parce que le déclencheur en a le
 * droit.
 */
function restreindreMentionsAuDeclencheur(mentions, membre, { roles = null } = {}) {
    const verrou = {
        parse: [...(mentions?.parse || [])],
        users: [...(mentions?.users || [])],
        roles: [...(mentions?.roles || [])],
    };
    if (peutMentionnerTous(membre)) return verrou;

    verrou.parse = verrou.parse.filter(categorie => categorie !== 'everyone');
    if (roles !== null) verrou.roles = verrou.roles.filter(id => estRoleMentionnable(roles, id));
    return verrou;
}

/**
 * Le rôle est-il mentionnable par un membre ordinaire ?
 *
 * Accepte les formes que les deux adaptateurs ont sous la main : une `Map` ou
 * une `Collection` (cache discord.js, état local Fluxer), un tableau de rôles,
 * ou un objet indexé.
 *
 * ⚠️ Un rôle INCONNU est traité comme mentionnable. C'est délibéré : un cache
 * froid ou un rôle créé à l'instant ne doit pas faire taire un ping légitime.
 * Le cas dangereux — `@everyone` — ne passe jamais par ici.
 */
function estRoleMentionnable(roles, roleId) {
    const cle = String(roleId);
    let role;
    if (Array.isArray(roles)) role = roles.find(r => String(r?.id) === cle);
    else if (typeof roles?.get === 'function') role = roles.get(cle);
    else role = roles?.[cle];
    if (!role) return true;
    return Boolean(role.mentionable ?? role.mentionnable);
}

module.exports = {
    verifierAccesCommandePersonnalisee,
    roleConnu,
    peutMentionnerTous,
    mentionsAutoriseesPour,
    restreindreMentionsAuDeclencheur,
    estRoleMentionnable,
    MAX_MENTIONS,
};
