// ═══════════════════════════════════════════════════════════════
//  Messages d'erreur
//
//  « ❌ Une erreur est survenue » ne dit rien à personne : ni à qui la reçoit,
//  ni à qui doit la corriger. Un incident réel a coûté une demi-heure de
//  diagnostic parce qu'il était impossible de savoir si la commande avait même
//  atteint le bot.
//
//  Trois principes ici :
//
//   1. Un message dit CE QUI a échoué, POURQUOI, et QUOI FAIRE. Sans ces trois
//      éléments, l'utilisateur est bloqué et l'administrateur ne peut pas aider.
//   2. Chaque incident porte un code court, affiché à l'utilisateur et écrit
//      dans les journaux. « J'ai eu QSR-7F3A » suffit à retrouver la trace
//      complète, sans avoir à faire raconter la scène.
//   3. Les erreurs Discord et SQLite sont traduites en langage humain. Personne
//      ne devrait avoir à chercher ce que signifie « DiscordAPIError[50013] ».
//
//  ─── Bi-format, et il le reste ─────────────────────────────────────────────
//
//  Ce fichier est importé par 23 autres et appelé des DEUX côtés : avec un `ctx`
//  neutre par le code métier, avec une `interaction` discord.js par les deux
//  endroits qui n'en ont pas — l'ADAPTATEUR lui-même (`ctx.erreurUtilisateur`
//  rappelle `userError` avec son interaction, pour ne pas reboucler) et le
//  DISPATCH de `bot/index.js`, qui signale un incident avant d'avoir construit
//  un contexte. Ce n'est donc pas une transition à retirer : c'est la frontière
//  de la couche, et elle a deux côtés par nature.
//
//  La `Guild` discord.js, elle, ne passe plus : son dernier appelant était le
//  mode panique, que `api/routes/antiraid.js` alimente désormais par une portée
//  neutre (lot 7).
//
//  Ce qui a disparu à la consolidation, en revanche, c'est l'import de
//  `discord.js` en tête : le rendu passe par `versEmbedDiscord`, donc par
//  l'adaptateur, en require différé.
//
//  C'est ici que vivent les DEUX détecteurs de format du dépôt, et nulle part
//  ailleurs : `estContexteNeutre` (« est-ce un ctx ? ») et
//  `resoudrePorteeNeutre` (« ai-je de quoi écrire sans discord.js ? »).
//  `bot/utils/logger.js` et `bot/utils/punishments.js` les importent d'ici.
//  Les dupliquer ferait diverger la détection d'un fichier à l'autre, ce qui est
//  exactement le genre de bug qu'on ne voit pas passer.
// ═══════════════════════════════════════════════════════════════

const { embed, estEmbed, ressembleAEmbedDiscord } = require('../platform/embed');
// Une seule implémentation du code d'incident dans le projet : le dashboard en
// génère aussi (gestionnaire d'erreurs de l'API, filet global du processus), et
// deux alphabets qui divergent produiraient des codes impossibles à rapprocher.
const { newIncidentCode } = require('../../api/services/incidents');

const COLOR_ERROR = 0xED4245;

// ─── Détection du format reçu ─────────────────────────────────────────────
//
// Le critère est POSITIF sur le neutre, et tout le reste retombe sur la voie
// historique. L'inverse — reconnaître discord.js puis supposer le neutre —
// enverrait un objet inattendu vers la voie neutre, donc vers un rendu qui
// refuse les embeds Discord : un format non reconnu casserait au lieu de
// continuer à fonctionner comme avant.

/**
 * L'objet est-il un contexte d'exécution neutre (DA §5.4) ?
 *
 * Les trois champs sont exigés ENSEMBLE, et ce sont les trois qui définissent le
 * contrat : `plateforme` (le nom), `capacites` (ce qu'elle sait faire),
 * `repondre` (par où sort une réponse). Aucun objet discord.js ne porte ces
 * noms — ils sont en français, et ni `plateforme` ni `capacites` n'existent dans
 * la bibliothèque. Exiger les trois évite qu'un objet métier doté d'un
 * `repondre()` quelconque soit pris pour un contexte.
 */
function estContexteNeutre(valeur) {
    return Boolean(valeur)
        && typeof valeur === 'object'
        && typeof valeur.plateforme === 'string'
        && typeof valeur.capacites === 'object' && valeur.capacites !== null
        && typeof valeur.repondre === 'function';
}

/**
 * Portée d'écriture neutre : « où écrire, avec quel client REST ».
 *
 * Là où `estContexteNeutre` répond à une commande qui a un interlocuteur,
 * ceci répond aux journaux et aux sanctions, qui n'en ont pas : ils n'ont besoin
 * que d'un serveur et d'un `api`. Sont acceptés un `ctx` complet, l'adaptateur
 * lui-même, ou un objet littéral `{ guildeId, api }`.
 *
 * Le marqueur est `api.envoyerMessage` : c'est la seule méthode que TOUTE
 * écriture neutre finit par emprunter, et aucun objet discord.js ne l'expose
 * (une `Guild` a `channels`, un `Client` a `rest`, jamais `api`).
 *
 * @returns {null|{guildeId: string|null, api: object, moiId: string|null,
 *                 proprietaireId: string|null, nomGuilde: string|null, source: object}}
 */
function resoudrePorteeNeutre(valeur) {
    if (!valeur || typeof valeur !== 'object') return null;
    const api = valeur.api;
    if (!api || typeof api !== 'object' || typeof api.envoyerMessage !== 'function') return null;
    return {
        guildeId: valeur.guildeId ?? valeur.guilde?.id ?? null,
        api,
        // Identité du bot. Sur l'adaptateur elle vaut `null` tant que la
        // connexion n'est pas faite : c'est le signal de « pas encore prêt »,
        // utilisé tel quel par le balayage des bannissements temporaires.
        moiId: valeur.moi?.id ?? valeur.moiId ?? null,
        // Hors contrat : `api.obtenirGuilde` ne rend pas le propriétaire du
        // serveur. Renseigné seulement si l'appelant le connaît (cf. rapport).
        proprietaireId: valeur.proprietaireId ?? null,
        nomGuilde: valeur.guilde?.nom ?? valeur.nomGuilde ?? null,
        source: valeur,
    };
}

/**
 * Embed neutre -> EmbedBuilder, pour la voie native uniquement.
 *
 * Laisse passer tel quel ce qui n'est pas un embed neutre : un `EmbedBuilder`
 * déjà construit doit continuer à voyager sans être touché.
 *
 * ⚠️ Elle ne disparaîtra pas avec le lot 7 : ses appelants restants ne sont plus
 * dans `api/` mais dans la couche elle-même. `buildErrorEmbed` la traverse, et
 * ses deux appelants — `ctx.erreurUtilisateur` de l'adaptateur Discord et le
 * dispatch natif de `bot/index.js` — sont permanents par construction (voir le
 * commentaire de `buildErrorEmbed`).
 *
 * Le require de l'adaptateur est différé : ce fichier est chargé par 23 autres,
 * y compris dans un processus Fluxer qui ne doit jamais évaluer discord.js.
 */
function versEmbedDiscord(valeur) {
    if (!estEmbed(valeur)) return valeur;
    const { rendreEmbed } = require('../platform/discord/render');
    return rendreEmbed(valeur);
}

/** Refuse un embed Discord sur la voie neutre, en disant quoi faire. */
function exigerContenuNeutre(contenu, appelant) {
    if (ressembleAEmbedDiscord(contenu) && !estEmbed(contenu)) {
        throw new TypeError(
            `${appelant} : embed au format Discord passé à la voie neutre. Construisez-le avec `
            + '`embed({ titre, description, couleur, champs, … })` de bot/platform/embed.js.'
        );
    }
    return contenu;
}

// ─── Traduction des erreurs Discord ───────────────────────────────────────
// Codes officiels de l'API Discord. Seuls ceux que Quasar peut réellement
// rencontrer sont listés : une table exhaustive serait du bruit.
const DISCORD_ERRORS = {
    10003: {
        title: 'Salon introuvable',
        cause: 'Le salon concerné n\'existe plus, ou je n\'y ai plus accès.',
        action: 'Vérifiez qu\'il n\'a pas été supprimé, puis recommencez avec un autre salon.',
    },
    10008: {
        title: 'Message introuvable',
        cause: 'Le message a été supprimé, ou il est dans un salon que je ne vois pas.',
        action: 'Vérifiez qu\'il existe encore et que j\'ai accès à son salon.',
    },
    10011: {
        title: 'Rôle introuvable',
        cause: 'Le rôle a été supprimé depuis sa configuration.',
        action: 'Reconfigurez la fonctionnalité avec un rôle existant.',
    },
    10013: {
        title: 'Utilisateur introuvable',
        cause: 'Cet utilisateur n\'existe pas, ou a supprimé son compte Discord.',
        action: 'Vérifiez l\'identifiant saisi.',
    },
    10026: {
        title: 'Bannissement introuvable',
        cause: 'Cette personne n\'est pas bannie de ce serveur.',
        action: 'Vérifiez la liste des bannissements dans les paramètres du serveur.',
    },
    30003: {
        title: 'Trop de messages épinglés',
        cause: 'Discord limite à 50 messages épinglés par salon.',
        action: 'Détachez un message épinglé, puis recommencez.',
    },
    40005: {
        title: 'Fichier trop volumineux',
        cause: 'Le fichier dépasse la taille maximale acceptée par ce serveur.',
        action: 'Ce serveur accepte des fichiers plus gros s\'il est boosté. Sinon, le contenu doit être réduit.',
    },
    50001: {
        title: 'Accès refusé',
        cause: 'Je n\'ai pas accès à ce salon ou à cette ressource.',
        action: 'Vérifiez mes permissions sur le salon concerné, notamment « Voir le salon ».',
    },
    50007: {
        title: 'Message privé impossible',
        cause: 'Cette personne n\'accepte pas les messages privés venant de ce serveur, ou m\'a bloqué.',
        action: 'Elle doit autoriser les messages privés : Paramètres du serveur → Confidentialité.',
    },
    50013: {
        title: 'Permission manquante',
        cause: 'Il me manque une permission pour faire ça.',
        action: 'Vérifiez mes permissions sur le serveur et sur le salon concerné. Mon rôle doit aussi être placé au-dessus des rôles que je dois gérer.',
    },
    50034: {
        title: 'Messages trop anciens',
        cause: 'Discord interdit la suppression groupée des messages de plus de 14 jours.',
        action: 'Supprimez-les manuellement, ou limitez la purge aux messages récents.',
    },
    50035: {
        title: 'Valeur refusée par Discord',
        cause: 'Une des valeurs envoyées n\'a pas été acceptée : souvent un salon d\'un type inattendu, ou un texte trop long.',
        action: 'Vérifiez les options choisies. Si le problème persiste, transmettez le code ci-dessous.',
    },
    160002: {
        title: 'Fil déjà archivé',
        cause: 'Ce fil de discussion est archivé et ne peut plus être modifié.',
        action: 'Désarchivez-le, puis recommencez.',
    },
};

// ─── Traduction des erreurs de base de données ────────────────────────────
const SQLITE_ERRORS = {
    SQLITE_CONSTRAINT_FOREIGNKEY: {
        title: 'Donnée liée manquante',
        cause: 'Une donnée nécessaire n\'existe pas encore en base — souvent le serveur lui-même, s\'il vient d\'être ajouté.',
        action: 'Réessayez dans quelques secondes. Si ça persiste, redémarrez le bot.',
    },
    SQLITE_CONSTRAINT_UNIQUE: {
        title: 'Entrée déjà existante',
        cause: 'Cette entrée existe déjà et ne peut pas être créée en double.',
        action: 'Modifiez l\'existante plutôt que d\'en créer une nouvelle.',
    },
    SQLITE_BUSY: {
        title: 'Base de données occupée',
        cause: 'Une autre opération écrit en base au même moment.',
        action: 'Réessayez dans quelques secondes.',
    },
    SQLITE_READONLY: {
        title: 'Base de données en lecture seule',
        cause: 'Le bot ne peut pas écrire dans sa base — généralement un problème de droits sur le volume de données.',
        action: 'Côté hébergeur : vérifier les permissions du dossier /app/data.',
    },
    SQLITE_CORRUPT: {
        title: 'Base de données corrompue',
        cause: 'Le fichier de base de données est endommagé.',
        action: 'Côté hébergeur : restaurer une sauvegarde de /app/data/quasar.db.',
    },
};

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

const FALLBACK = {
    title: 'Erreur inattendue',
    cause: 'Quelque chose s\'est mal passé et je n\'ai pas su l\'identifier précisément.',
    action: 'Transmettez le code ci-dessous à l\'administrateur du serveur : il permet de retrouver le détail dans les journaux.',
};

/**
 * Traduit une exception en explication lisible.
 * @returns {{ title: string, cause: string, action: string }}
 */
function explain(error) {
    if (!error) return FALLBACK;

    // Erreur de l'API Discord : discord.js expose le code numérique officiel.
    if (typeof error.code === 'number' && DISCORD_ERRORS[error.code]) {
        return DISCORD_ERRORS[error.code];
    }

    if (typeof error.code === 'string') {
        if (SQLITE_ERRORS[error.code]) return SQLITE_ERRORS[error.code];
        // better-sqlite3 renvoie parfois le code générique sans le suffixe.
        if (error.code === 'SQLITE_CONSTRAINT') return SQLITE_ERRORS.SQLITE_CONSTRAINT_FOREIGNKEY;
        if (NETWORK_CODES.has(error.code)) {
            return {
                title: 'Service injoignable',
                cause: 'La connexion à un service externe a échoué.',
                action: 'Réessayez dans quelques minutes. Si ça persiste, le problème vient du réseau de l\'hébergeur.',
            };
        }
    }

    // Délai dépassé côté Discord : l'interaction a expiré avant la réponse.
    if (error.name === 'AbortError' || /timeout/i.test(error.message || '')) {
        return {
            title: 'Délai dépassé',
            cause: 'L\'opération a pris trop de temps et Discord a coupé la connexion.',
            action: 'Réessayez. Si ça se reproduit, c\'est que le serveur est surchargé.',
        };
    }

    return FALLBACK;
}

/**
 * Contenu de l'embed d'erreur, au format NEUTRE — la source unique.
 *
 * Le code d'incident n'est présent que pour les vraies exceptions : sur une
 * erreur d'usage (« tu ne peux pas te warn toi-même »), il n'y a rien à
 * diagnostiquer et l'afficher ferait croire à un bug.
 */
function construireEmbedErreur({ title, cause, action, code }) {
    const parts = [];
    if (cause) parts.push(cause);
    if (action) parts.push(`\n**Que faire :** ${action}`);

    return embed({
        titre: `❌ ${title}`,
        couleur: COLOR_ERROR,
        description: parts.join('\n'),
        pied: code ? { texte: `Code : ${code} — à transmettre en cas de signalement` } : undefined,
    });
}

/**
 * Même embed, au format Discord. Construit à partir du neutre : il n'y a qu'un
 * seul endroit où le TEXTE d'une erreur est décidé.
 *
 * ⚠️ VOIE NATIVE, et elle ne disparaîtra pas — ce n'est pas une transition.
 * Deux appelants la retiennent, tous deux par construction :
 *   • `bot/platform/discord/context.js` : `ctx.erreurUtilisateur` rappelle
 *     `userError` avec son INTERACTION, précisément pour ne pas reboucler sur
 *     lui-même. C'est l'adaptateur qui rend, c'est son droit.
 *   • `bot/index.js` : le dispatch natif (`interactionCreate`) signale ses
 *     incidents avant d'avoir construit le moindre contexte.
 *
 * Le rendu passe par `versEmbedDiscord`, donc par `rendreEmbed` de l'adaptateur :
 * ce fichier n'importe plus `discord.js`. Seule nuance, sans effet visible : un
 * embed d'erreur SANS cause ni action porte désormais une description absente
 * là où le builder écrit à la main envoyait `description: ""`.
 */
function buildErrorEmbed(spec) {
    return versEmbedDiscord(construireEmbedErreur(spec));
}

/**
 * Poste un embed sur la cible, quel que soit son format et quel que soit son
 * état (déjà répondue, différée…). Sans cette précaution, une erreur survenant
 * après un deferReply produit une seconde erreur qui masque la première.
 *
 * @param {object} cible  `ctx` neutre, ou interaction discord.js
 * @param {object} contenu  embed neutre, ou EmbedBuilder sur la voie native
 */
async function replyWithEmbed(cible, contenu, { ephemeral = true } = {}) {
    if (estContexteNeutre(cible)) {
        // Vérifié AVANT le try : un embed Discord passé ici serait refusé par le
        // rendu neutre, et l'avaler avec le reste ferait disparaître la réponse
        // sans un mot.
        exigerContenuNeutre(contenu, 'replyWithEmbed');
        try {
            return await cible.repondre(contenu, { ephemere: ephemeral });
        } catch {
            // Même silence que la voie historique : l'incident est déjà tracé.
        }
        return undefined;
    }

    // Voie native : une interaction discord.js. Retenue par l'adaptateur
    // lui-même (`ctx.erreurUtilisateur`) et par le dispatch de `bot/index.js`.
    const embedDiscord = versEmbedDiscord(contenu);
    const payload = { embeds: [embedDiscord], ephemeral };
    try {
        if (cible.deferred) return await cible.editReply({ embeds: [embedDiscord] });
        if (cible.replied) return await cible.followUp(payload);
        return await cible.reply(payload);
    } catch {
        // L'interaction a expiré ou a déjà reçu sa réponse finale : il n'y a plus
        // rien à faire côté Discord, l'incident reste tracé dans les journaux.
    }
}

/**
 * Erreur d'USAGE : l'utilisateur a demandé quelque chose d'impossible, ce n'est
 * pas un bug. Message explicite, pas de code d'incident, rien dans les journaux.
 *
 * Sur la voie neutre, DÉLÉGATION à `ctx.erreurUtilisateur` : le contexte porte
 * déjà cette primitive (DA §5.4), et en réécrire une seconde ici ferait diverger
 * les deux le jour où l'adaptateur Fluxer décidera autrement de l'éphémère.
 *
 * ⚠️ Corollaire pour les adaptateurs : `ctx.erreurUtilisateur` ne doit JAMAIS
 * rappeler `userError(ctx, …)`, sous peine de boucle. L'adaptateur Discord
 * rappelle `userError` avec son INTERACTION, qui repart par la voie native.
 *
 * @param {object} cible  `ctx` neutre, ou interaction discord.js
 * @param {{title?: string, titre?: string, cause?: string, action?: string,
 *          ephemeral?: boolean, ephemere?: boolean}} spec
 *   Les deux orthographes sont acceptées : le code historique écrit `title` et
 *   `ephemeral`, le code migré écrit `titre` et `ephemere` comme partout
 *   ailleurs dans la couche neutre. Ne reconnaître qu'une seule des deux
 *   produirait un « ❌ undefined » parfaitement silencieux.
 */
function userError(cible, spec = {}) {
    const title = spec.title ?? spec.titre;
    const { cause, action } = spec;
    const ephemeral = spec.ephemeral ?? spec.ephemere ?? true;

    if (estContexteNeutre(cible)) {
        if (typeof cible.erreurUtilisateur === 'function') {
            return cible.erreurUtilisateur({ titre: title, cause, action, ephemere: ephemeral });
        }
        // Contexte réduit (autocomplétion) : il répond, mais ne porte pas la
        // primitive. On rend l'embed nous-mêmes plutôt que d'échouer.
        return replyWithEmbed(cible, construireEmbedErreur({ title, cause, action }), { ephemeral });
    }

    // Voie native : interaction discord.js (adaptateur, bootstrap).
    return replyWithEmbed(cible, buildErrorEmbed({ title, cause, action }), { ephemeral });
}

/**
 * INCIDENT : une exception s'est produite. On journalise avec un code, et on
 * explique à l'utilisateur ce qu'on peut.
 *
 * La ligne de journal est identique quel que soit le format : ce sont les mêmes
 * trois informations, lues à des endroits différents. `commandName` et `customId`
 * côté discord.js, `commande` et `panneau.nom` côté neutre — les noms que
 * `creerContexteCommande` et `creerContextePanneau` posent sur le contexte.
 *
 * @param {object} cible — `ctx` neutre, interaction discord.js, ou null
 * @param {object} context — { command, guildId, userId } pour retrouver la trace
 * @returns {string} le code d'incident
 */
function reportIncident(cible, error, context = {}) {
    const code = newIncidentCode();
    const neutre = estContexteNeutre(cible);

    const where = context.command
        || (neutre ? (cible.commande || cible.panneau?.nom) : (cible?.commandName || cible?.customId))
        || 'inconnu';
    const guildId = context.guildId || (neutre ? cible.guildeId : cible?.guild?.id) || 'aucun';
    const userId = context.userId || (neutre ? cible.auteur?.id : cible?.user?.id) || 'inconnu';

    // Une seule ligne pour l'essentiel : c'est elle qu'on cherchera avec le code.
    // La stack suit, sur les lignes suivantes.
    console.error(
        `[Quasar] ❌ ${code} | ${where} | guild=${guildId} | user=${userId} | ` +
        `${error?.name || 'Error'}${typeof error?.code !== 'undefined' ? `[${error.code}]` : ''}: ${error?.message || error}`
    );
    if (error?.stack) console.error(error.stack);

    const explained = explain(error);
    if (cible) {
        const contenu = neutre
            ? construireEmbedErreur({ ...explained, code })
            // Voie native : interaction discord.js (adaptateur, bootstrap).
            : buildErrorEmbed({ ...explained, code });
        replyWithEmbed(cible, contenu).catch(() => {});
    }
    return code;
}

module.exports = {
    newIncidentCode,
    explain,
    buildErrorEmbed,
    construireEmbedErreur,
    userError,
    reportIncident,
    replyWithEmbed,
    // Détection de format, partagée par logger.js et punishments.js.
    estContexteNeutre,
    resoudrePorteeNeutre,
    versEmbedDiscord,
    DISCORD_ERRORS,
    SQLITE_ERRORS,
};
