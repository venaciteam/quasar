// ═══════════════════════════════════════════════════════════════
//  Événements normalisés — Discord
//
//  Table de correspondance de la DA §7.2, normalisation des payloads, et
//  chargement de bot/events/.
//
//  Un handler neutre reçoit toujours `(ctx, ...donnees)`, où `ctx` porte
//  l'accès à la plateforme et où `donnees` a la MÊME forme sur Discord et sur
//  Fluxer. Les payloads sont documentés ci-dessous, à l'endroit qui les porte :
//  c'est le contrat que consomment les seize handlers de bot/events/. Toute
//  donnée absente de ces structures est inaccessible au code métier — si un
//  handler en a besoin, elle s'ajoute ici pour les DEUX plateformes.
//
//  ⚠️ `sanctionAutomatique` n'existe que sur Discord (Fluxer n'a pas d'automod).
//  Un handler qui s'y abonne déclare `capaciteRequise: 'automod'` : il n'est
//  alors branché que là où la capacité existe, sans jamais tester le nom de la
//  plateforme.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    normaliserCanal,
    normaliserGuilde,
    poserPanneau,
} = require('./context');
const { EVENEMENTS_NEUTRES, estDescripteurEvenement } = require('../events');
const { dateDuSnowflake } = require('./snowflake');

// Types de message écrits par un humain. Tout le reste est un message SYSTÈME —
// arrivée, épinglage, boost — que personne n'a tapé. Sans cette distinction, un
// salon piège qui se trouve être le salon système sanctionne chaque arrivée.
// 0 = Default, 19 = Reply : les deux seules valeurs de `MessageType` que Quasar
// considère comme humaines.
const TYPES_MESSAGE_HUMAINS = new Set([0, 19]);

// Base des liens de message. Propre à Discord : c'est justement pour ne pas la
// voir apparaître dans du code métier qu'elle est ici.
const BASE_LIEN_MESSAGE = 'https://discord.com/channels';

/**
 * message : { id, canalId, guildeId, auteur, contenu, embeds, reactions,
 *             piecesJointes, lien, creeLe, estBot, estSysteme, estWebhook,
 *             estFil, canalParentId, partiel }
 *
 * `partiel` signale un message hors cache : seuls `id`, `canalId` et `guildeId`
 * sont alors fiables. C'est le cas courant d'une suppression ou d'une réaction
 * sur un message antérieur au démarrage.
 *
 * Tolère la forme discord.js (`channelId`) comme la réponse REST brute
 * (`channel_id`) : `api.envoyerMessage` normalise ce qu'il reçoit de l'API.
 */
function normaliserMessage(message) {
    if (!message) return null;
    return {
        id: message.id,
        canalId: message.channelId ?? message.channel_id ?? message.channel?.id ?? null,
        guildeId: message.guildId ?? message.guild_id ?? message.guild?.id ?? null,
        auteur: normaliserUtilisateur(message.author),
        contenu: message.content ?? null,
        embeds: message.embeds ?? [],
        reactions: normaliserReactions(message),
        piecesJointes: normaliserPiecesJointes(message),
        lien: lienMessage(message),
        // Date d'émission. Le transcript d'un ticket écrit « [ISO] auteur :
        // contenu » et c'est souvent la seule copie d'une conversation, avec la
        // portée juridique que ça implique : une ligne sans date est une pièce
        // dégradée. Déduite du snowflake en dernier recours — la convention
        // appartient à la plateforme.
        creeLe: message.createdTimestamp
            ?? (message.timestamp ? Date.parse(message.timestamp) : dateDuSnowflake(message.id)),
        estBot: Boolean(message.author?.bot),
        // Message SYSTÈME : arrivée, épinglage, boost. Personne ne l'a écrit,
        // et le sanctionner comme un message humain est le piège du salon piège
        // posé sur le salon système.
        estSysteme: !TYPES_MESSAGE_HUMAINS.has(message.type ?? 0),
        estWebhook: Boolean(message.webhookId ?? message.webhook_id),
        // Fil et salon parent portés PAR LE MESSAGE, et non derrière un appel à
        // `api.obtenirCanal` : le chemin rapide du salon piège s'exécute pour
        // chaque message de chaque serveur et ne peut pas payer un aller-retour.
        // La nuance compte : le parent d'un salon ordinaire est sa CATÉGORIE,
        // celui d'un fil est le salon qui le porte — sans savoir les
        // distinguer, la règle du piège change de sens et redevient
        // contournable en répondant dans un fil.
        estFil: estFil(message),
        canalParentId: message.channel?.parentId ?? message.channel?.parent_id ?? null,
        partiel: Boolean(message.partial),
    };
}

/**
 * piecesJointes : [{ id, nom, url, taille }]
 *
 * Le journal de suppression n'a souvent que cette liste de noms comme trace :
 * le fichier, lui, disparaît avec le message.
 */
function normaliserPiecesJointes(message) {
    const brut = message.attachments;
    if (!brut) return [];
    const liste = Array.isArray(brut) ? brut : [...(brut.cache?.values?.() || brut.values?.() || [])];
    return liste.map(piece => ({
        id: piece.id ?? null,
        nom: piece.name ?? piece.filename ?? null,
        url: piece.url ?? null,
        taille: piece.size ?? null,
    }));
}

/**
 * Lien permanent vers le message.
 *
 * `message.url` n'existe que sur l'objet discord.js ; une réponse REST brute ne
 * le porte pas. On le construit alors, ici et pas dans le code métier — une URL
 * `discord.com` écrite dans un handler neutre serait exactement ce que ce
 * chantier retire.
 */
function lienMessage(message) {
    if (typeof message.url === 'string' && message.url) return message.url;
    const canalId = message.channelId ?? message.channel_id ?? message.channel?.id;
    if (!canalId || !message.id) return null;
    const guildeId = message.guildId ?? message.guild_id ?? message.guild?.id ?? '@me';
    return `${BASE_LIEN_MESSAGE}/${guildeId}/${canalId}/${message.id}`;
}

/** Le message est-il dans un fil ? */
function estFil(message) {
    const canal = message.channel;
    if (!canal) return false;
    if (typeof canal.isThread === 'function') return canal.isThread();
    // Réponse REST : types 10, 11 et 12 sont les trois familles de fils.
    return [10, 11, 12].includes(canal.type);
}

/**
 * reactions : [{ emoji: { id, nom, anime, cle }, nombre, parMoi }]
 *
 * `parMoi` dit si le bot a DÉJÀ posé cette réaction, et c'est la raison d'être
 * de ce champ : sans lui, un panneau de rôles-réactions doit reposer chaque
 * emoji à chaque modification, faute de pouvoir constater qu'il est déjà là.
 * Un PUT par entrée au lieu de zéro, sur une route limitée en débit — l'état
 * final est le même, le coût ne l'est pas.
 *
 * Accepte le gestionnaire discord.js (`reactions.cache`) comme le tableau brut
 * d'une réponse REST. `cle` est produite par `cleEmoji`, la même fonction que
 * pour `reactionAjoutee` : les deux voies doivent indexer à l'identique, sinon
 * une comparaison avec la base échoue sur les emojis personnalisés.
 */
function normaliserReactions(message) {
    const brut = message.reactions;
    if (!brut) return [];

    const liste = Array.isArray(brut) ? brut : [...(brut.cache?.values?.() || [])];
    return liste.map(reaction => ({
        emoji: {
            id: reaction.emoji?.id ?? null,
            nom: reaction.emoji?.name ?? null,
            anime: Boolean(reaction.emoji?.animated),
            cle: cleEmoji(reaction.emoji),
        },
        nombre: reaction.count ?? 0,
        parMoi: Boolean(reaction.me),
    }));
}

/**
 * Clé d'un emoji, telle qu'elle est STOCKÉE EN BASE.
 *
 * ⚠️ Ce n'est pas l'identifiant. `bot/commands/reactionrole.js` enregistre la
 * chaîne saisie par l'administrateur — `🎮` pour un unicode, `<:nom:id>` ou
 * `<a:nom:id>` pour un emoji personnalisé — et c'est cette forme exacte que
 * `reaction_roles.emoji` contient. Rendre `emoji.id` produirait `55` là où la
 * base porte `<:quasar:55>` : les emojis unicode continueraient de fonctionner
 * par coïncidence, les personnalisés cesseraient d'attribuer leur rôle, sans
 * erreur ni journal. D'où `anime` dans le payload : sans lui, la forme d'un
 * emoji animé est irreconstructible.
 */
function cleEmoji(emoji) {
    if (!emoji) return null;
    if (emoji.id) return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
    return emoji.name ?? null;
}

/** reaction : { messageId, canalId, guildeId, emoji: { id, nom, anime, cle } } */
function normaliserReaction(reaction) {
    if (!reaction) return null;
    const emoji = reaction.emoji || {};
    return {
        messageId: reaction.message?.id ?? null,
        canalId: reaction.message?.channelId ?? null,
        guildeId: reaction.message?.guildId ?? null,
        emoji: {
            id: emoji.id ?? null,
            nom: emoji.name ?? null,
            anime: Boolean(emoji.animated),
            cle: cleEmoji(emoji),
        },
    };
}

/**
 * etatVocal : { guildeId, membreId, membre, canalId, muetServeur, muetSoi,
 *               sourdServeur, sourdSoi, muet, sourd }
 *
 * Les quatre drapeaux sont exposés séparément, et `muet`/`sourd` n'en sont que
 * le résumé. Fusionner « rendu muet par un modérateur » et « s'est mis en muet »
 * est une perte irréversible : un journal de modération qui les confond annonce
 * une sanction là où quelqu'un a simplement coupé son micro. Les deux drapeaux
 * existent à l'identique dans le VOICE_STATE_UPDATE de Fluxer.
 */
function normaliserEtatVocal(etat) {
    if (!etat) return null;
    return {
        guildeId: etat.guild?.id ?? etat.guildId ?? null,
        membreId: etat.id ?? etat.member?.id ?? null,
        membre: normaliserMembre(etat.member),
        canalId: etat.channelId ?? null,
        muetServeur: Boolean(etat.serverMute),
        muetSoi: Boolean(etat.selfMute),
        sourdServeur: Boolean(etat.serverDeaf),
        sourdSoi: Boolean(etat.selfDeaf),
        get muet() { return this.muetServeur || this.muetSoi; },
        get sourd() { return this.sourdServeur || this.sourdSoi; },
    };
}

/** sanction : { guildeId, membreId, regleId, action, contenu, canalId } */
function normaliserSanction(execution) {
    if (!execution) return null;
    return {
        guildeId: execution.guild?.id ?? execution.guildId ?? null,
        membreId: execution.userId ?? null,
        regleId: execution.ruleId ?? null,
        action: execution.action?.type ?? null,
        contenu: execution.content ?? null,
        canalId: execution.channelId ?? null,
        // ⚠️ Valeur NATIVE assumée : c'est la clé de
        // `automodSync.TRIGGER_BY_DISCORD_TYPE`, et l'AutoMod n'a pas de second
        // implémenteur — Fluxer n'en a pas du tout. La neutraliser inventerait
        // un vocabulaire pour une seule plateforme.
        declencheurNatif: execution.ruleTriggerType ?? null,
        motCle: execution.matchedKeyword ?? null,
        dureeSecondes: execution.action?.metadata?.durationSeconds ?? null,
    };
}

// Nom neutre -> [nom discord.js, normalisation du payload].
// L'ordre des arguments d'un événement discord.js est repris tel quel : c'est
// lui qui décide de la signature neutre.
const EVENEMENTS = Object.freeze({
    pret: ['clientReady', () => []],
    messageCree: ['messageCreate', (message) => [normaliserMessage(message)]],
    messageModifie: ['messageUpdate', (avant, apres) => [normaliserMessage(avant), normaliserMessage(apres)]],
    messageSupprime: ['messageDelete', (message) => [normaliserMessage(message)]],
    reactionAjoutee: ['messageReactionAdd', (reaction, user) => [normaliserReaction(reaction), normaliserUtilisateur(user)]],
    reactionRetiree: ['messageReactionRemove', (reaction, user) => [normaliserReaction(reaction), normaliserUtilisateur(user)]],
    membreRejoint: ['guildMemberAdd', (membre) => [normaliserMembre(membre), normaliserGuilde(membre?.guild)]],
    membreParti: ['guildMemberRemove', (membre) => [normaliserMembre(membre), normaliserGuilde(membre?.guild)]],
    // Le SERVEUR est le troisième argument : sans lui, un handler qui compare
    // deux états de membre ne sait pas dans quel journal écrire. Ajouté en
    // queue pour rester additif — aucun consommateur ne lisait ce payload.
    membreModifie: ['guildMemberUpdate', (avant, apres) => [
        normaliserMembre(avant), normaliserMembre(apres), normaliserGuilde(apres?.guild ?? avant?.guild),
    ]],
    guildeRejointe: ['guildCreate', (guilde) => [normaliserGuilde(guilde)]],
    guildeQuittee: ['guildDelete', (guilde) => [normaliserGuilde(guilde)]],
    canalCree: ['channelCreate', (canal) => [normaliserCanal(canal)]],
    canalSupprime: ['channelDelete', (canal) => [normaliserCanal(canal)]],
    roleCree: ['roleCreate', (role) => [normaliserRole(role)]],
    roleSupprime: ['roleDelete', (role) => [normaliserRole(role)]],
    etatVocalModifie: ['voiceStateUpdate', (avant, apres) => [normaliserEtatVocal(avant), normaliserEtatVocal(apres)]],
    sanctionAutomatique: ['autoModerationActionExecution', (execution) => [normaliserSanction(execution)]],
});

const NOMS_EVENEMENTS = Object.freeze(Object.keys(EVENEMENTS));

// La table doit couvrir tout le vocabulaire neutre. Un nom déclaré au contrat
// mais absent ici ferait échouer un abonnement au démarrage, très loin du
// fichier fautif.
const manquants = EVENEMENTS_NEUTRES.filter(nom => !EVENEMENTS[nom]);
if (manquants.length > 0) {
    throw new Error(
        `Table des événements Discord incomplète : ${manquants.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/discord/events.js.'
    );
}

/**
 * Filet d'erreur par défaut d'un handler d'événement.
 *
 * Il ne remplace pas celui de `bot/index.js` (qui produit un code d'incident et
 * une alerte) : il existe pour qu'un abonnement pris hors du chargeur ne laisse
 * JAMAIS une promesse flottante. Une promesse rendue à l'EventEmitter part sinon
 * dans le filet global du processus, où elle devient un « rejet non capté »
 * anonyme — sans le nom de l'événement, donc sans le seul indice utile.
 */
function surErreurParDefaut(err, contexte) {
    console.error(
        `[Quasar] ⚠️  Événement ${contexte.evenement} | ${err?.name || 'Error'}: ${err?.message || err}`
    );
    if (err?.stack) console.error(err.stack);
}

/**
 * Abonne un handler neutre à un événement de la passerelle Discord.
 *
 * @param {import('discord.js').Client} client
 * @param {object} adaptateur
 * @param {string} nomNeutre
 * @param {(ctx: object, ...donnees: any[]) => any} handler
 * @param {object} [options]
 * @param {boolean}  [options.une]       abonnement unique (`once`)
 * @param {Function} [options.surErreur] (err, { evenement }) => void
 * @returns {() => void} fonction de désabonnement
 */
function surEvenement(client, adaptateur, nomNeutre, handler, { une = false, surErreur } = {}) {
    const entree = EVENEMENTS[nomNeutre];
    if (!entree) {
        throw new Error(
            `Événement neutre inconnu : "${nomNeutre}". Noms acceptés : ${NOMS_EVENEMENTS.join(', ')}.`
        );
    }
    const [nomNatif, normaliser] = entree;
    const signaler = surErreur || surErreurParDefaut;

    // `Promise.resolve().then()` plutôt qu'un try/catch : il attrape aussi bien
    // le throw synchrone que le rejet asynchrone, en une seule forme. Et la
    // promesse n'est SURTOUT pas rendue à l'EventEmitter, qui la laisserait
    // flotter.
    const pont = (...args) => {
        Promise.resolve()
            .then(() => handler(creerContexteEvenement(adaptateur), ...normaliser(...args)))
            .catch((err) => signaler(err, { evenement: nomNeutre }));
    };

    if (une) client.once(nomNatif, pont);
    else client.on(nomNatif, pont);

    return () => client.off(nomNatif, pont);
}

/**
 * Contexte servi aux handlers d'événements. Volontairement plus pauvre que
 * celui des commandes : un événement n'a personne à qui répondre, il agit par
 * `api`.
 */
function creerContexteEvenement(adaptateur) {
    return {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,
        moi: adaptateur.moi,
        api: adaptateur.api,
        get db() { return require('../../../api/services/database').getDb(); },

        /**
         * Pose un panneau persistant. Même méthode, même signature et même
         * routage que sur un contexte de commande : c'est `canalId` qui décide
         * du salon, pas l'origine de l'appel.
         *
         * @see poserPanneau dans bot/platform/discord/context.js
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, options);
        },
    };
}

/**
 * Charge bot/events/ et branche chaque handler — descripteurs neutres seulement.
 *
 * C'est le pendant de `chargerCommandes`, et il est aussi indispensable : sans
 * lui, un handler migré en `{ nom: 'roleCree', executer }` serait abonné à
 * `client.on('roleCree')`, un événement que discord.js n'émet jamais. Le
 * handler ne serait pas appelé, aucune erreur ne serait levée, et la
 * fonctionnalité disparaîtrait en silence.
 *
 * @param {object} options
 * @param {string}   options.dossier
 * @param {object}   options.adaptateur
 * @param {Function} [options.surErreur] filet commun, appliqué aux deux formats
 * @returns {Array<{nom: string, fichier: string, neutre: boolean, branche: boolean}>}
 */
function chargerEvenements({ dossier, adaptateur, surErreur } = {}) {
    if (!fs.existsSync(dossier)) return [];
    const client = adaptateur.client;
    const signaler = surErreur || surErreurParDefaut;
    const charges = [];

    for (const fichier of fs.readdirSync(dossier).filter(f => f.endsWith('.js'))) {
        const mod = require(path.join(dossier, fichier));

        if (estDescripteurEvenement(mod)) {
            // Un handler qui exige une capacité absente n'est pas branché du
            // tout : c'est la voie par laquelle `sanctionAutomatique` reste
            // Discord-only sans qu'aucun code métier ne nomme la plateforme.
            if (mod.capaciteRequise && !adaptateur.capacites[mod.capaciteRequise]) {
                charges.push({ nom: mod.nom, fichier, neutre: true, branche: false });
                continue;
            }
            surEvenement(client, adaptateur, mod.nom, mod.executer, { une: mod.une, surErreur: signaler });
            charges.push({ nom: mod.nom, fichier, neutre: true, branche: true });
            continue;
        }

        // Format historique : `{ name, once, execute }`, avec les objets
        // discord.js bruts en argument. Accepté le temps des lots 1 à 5, REFUSÉ
        // depuis la consolidation. On LÈVE plutôt que de passer au fichier
        // suivant : un handler simplement ignoré, c'est une fonctionnalité du
        // bot qui disparaît sans erreur, sans journal et sans symptôme qui
        // désigne sa cause — exactement ce que ce chargeur existe pour empêcher.
        if (typeof mod?.name === 'string' && typeof mod?.execute === 'function') {
            throw new Error(
                `bot/events/${fichier} : le handler « ${mod.name} » est au format historique `
                + '`{ name, execute(...objets discord.js) }`, que le chargeur n\'accepte plus. '
                + 'Décrivez-le avec `definirEvenement({ nom, executer(ctx, …) })` (bot/platform/events.js), '
                + `en reprenant le nom NEUTRE de l'événement (${EVENEMENTS_NEUTRES.join(', ')}).`
            );
        }
    }

    return charges;
}

module.exports = {
    EVENEMENTS,
    NOMS_EVENEMENTS,
    surEvenement,
    chargerEvenements,
    creerContexteEvenement,
    surErreurParDefaut,
    normaliserMessage,
    normaliserReactions,
    normaliserPiecesJointes,
    lienMessage,
    TYPES_MESSAGE_HUMAINS,
    normaliserReaction,
    normaliserEtatVocal,
    normaliserSanction,
    cleEmoji,
};
