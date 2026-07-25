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
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder } = require('discord.js');

const COLOR_ERROR = 0xED4245;

// Alphabet sans caractères ambigus : un code se lit à voix haute ou se recopie
// depuis une capture d'écran, O/0 et I/1 y sont des pièges.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newIncidentCode() {
    let out = '';
    for (let i = 0; i < 4; i++) {
        out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return `QSR-${out}`;
}

// ─── Traduction des erreurs Discord ───────────────────────────────────────
// Codes officiels de l'API Discord. Seuls ceux que Quasar peut réellement
// rencontrer sont listés : une table exhaustive serait du bruit.
const DISCORD_ERRORS = {
    10003: {
        title: 'Salon introuvable',
        cause: 'Le salon concerné n\'existe plus, ou je n\'y ai plus accès.',
        action: 'Vérifie qu\'il n\'a pas été supprimé, puis recommence avec un autre salon.',
    },
    10008: {
        title: 'Message introuvable',
        cause: 'Le message a été supprimé, ou il est dans un salon que je ne vois pas.',
        action: 'Vérifie qu\'il existe encore et que j\'ai accès à son salon.',
    },
    10011: {
        title: 'Rôle introuvable',
        cause: 'Le rôle a été supprimé depuis sa configuration.',
        action: 'Reconfigure la fonctionnalité avec un rôle existant.',
    },
    10013: {
        title: 'Utilisateur introuvable',
        cause: 'Cet utilisateur n\'existe pas, ou a supprimé son compte Discord.',
        action: 'Vérifie l\'identifiant saisi.',
    },
    10026: {
        title: 'Bannissement introuvable',
        cause: 'Cette personne n\'est pas bannie de ce serveur.',
        action: 'Vérifie la liste des bannissements dans les paramètres du serveur.',
    },
    30003: {
        title: 'Trop de messages épinglés',
        cause: 'Discord limite à 50 messages épinglés par salon.',
        action: 'Détache un message épinglé, puis recommence.',
    },
    40005: {
        title: 'Fichier trop volumineux',
        cause: 'Le fichier dépasse la taille maximale acceptée par ce serveur.',
        action: 'Ce serveur accepte des fichiers plus gros s\'il est boosté. Sinon, le contenu doit être réduit.',
    },
    50001: {
        title: 'Accès refusé',
        cause: 'Je n\'ai pas accès à ce salon ou à cette ressource.',
        action: 'Vérifie mes permissions sur le salon concerné, notamment « Voir le salon ».',
    },
    50007: {
        title: 'Message privé impossible',
        cause: 'Cette personne n\'accepte pas les messages privés venant de ce serveur, ou m\'a bloqué.',
        action: 'Elle doit autoriser les messages privés : Paramètres du serveur → Confidentialité.',
    },
    50013: {
        title: 'Permission manquante',
        cause: 'Il me manque une permission pour faire ça.',
        action: 'Vérifie mes permissions sur le serveur et sur le salon concerné. Mon rôle doit aussi être placé au-dessus des rôles que je dois gérer.',
    },
    50034: {
        title: 'Messages trop anciens',
        cause: 'Discord interdit la suppression groupée des messages de plus de 14 jours.',
        action: 'Supprime-les manuellement, ou limite la purge aux messages récents.',
    },
    50035: {
        title: 'Valeur refusée par Discord',
        cause: 'Une des valeurs envoyées n\'a pas été acceptée : souvent un salon d\'un type inattendu, ou un texte trop long.',
        action: 'Vérifie les options choisies. Si le problème persiste, transmets le code ci-dessous.',
    },
    160002: {
        title: 'Fil déjà archivé',
        cause: 'Ce fil de discussion est archivé et ne peut plus être modifié.',
        action: 'Désarchive-le, puis recommence.',
    },
};

// ─── Traduction des erreurs de base de données ────────────────────────────
const SQLITE_ERRORS = {
    SQLITE_CONSTRAINT_FOREIGNKEY: {
        title: 'Donnée liée manquante',
        cause: 'Une donnée nécessaire n\'existe pas encore en base — souvent le serveur lui-même, s\'il vient d\'être ajouté.',
        action: 'Réessaie dans quelques secondes. Si ça persiste, redémarre le bot.',
    },
    SQLITE_CONSTRAINT_UNIQUE: {
        title: 'Entrée déjà existante',
        cause: 'Cette entrée existe déjà et ne peut pas être créée en double.',
        action: 'Modifie l\'existante plutôt que d\'en créer une nouvelle.',
    },
    SQLITE_BUSY: {
        title: 'Base de données occupée',
        cause: 'Une autre opération écrit en base au même moment.',
        action: 'Réessaie dans quelques secondes.',
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
    action: 'Transmets le code ci-dessous à l\'administrateur du serveur : il permet de retrouver le détail dans les journaux.',
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
                action: 'Réessaie dans quelques minutes. Si ça persiste, le problème vient du réseau de l\'hébergeur.',
            };
        }
    }

    // Délai dépassé côté Discord : l'interaction a expiré avant la réponse.
    if (error.name === 'AbortError' || /timeout/i.test(error.message || '')) {
        return {
            title: 'Délai dépassé',
            cause: 'L\'opération a pris trop de temps et Discord a coupé la connexion.',
            action: 'Réessaie. Si ça se reproduit, c\'est que le serveur est surchargé.',
        };
    }

    return FALLBACK;
}

/**
 * Construit l'embed affiché à l'utilisateur.
 * Le code d'incident n'est présent que pour les vraies exceptions : sur une
 * erreur d'usage (« tu ne peux pas te warn toi-même »), il n'y a rien à
 * diagnostiquer et l'afficher ferait croire à un bug.
 */
function buildErrorEmbed({ title, cause, action, code }) {
    const embed = new EmbedBuilder()
        .setTitle(`❌ ${title}`)
        .setColor(COLOR_ERROR);

    const parts = [];
    if (cause) parts.push(cause);
    if (action) parts.push(`\n**Que faire :** ${action}`);
    embed.setDescription(parts.join('\n'));

    if (code) {
        embed.setFooter({ text: `Code : ${code} — à transmettre en cas de signalement` });
    }
    return embed;
}

/**
 * Répond à une interaction, quel que soit son état (déjà répondue, différée…).
 * Sans cette précaution, une erreur survenant après un deferReply produit une
 * seconde erreur qui masque la première.
 */
async function replyWithEmbed(interaction, embed, { ephemeral = true } = {}) {
    const payload = { embeds: [embed], ephemeral };
    try {
        if (interaction.deferred) return await interaction.editReply({ embeds: [embed] });
        if (interaction.replied) return await interaction.followUp(payload);
        return await interaction.reply(payload);
    } catch {
        // L'interaction a expiré ou a déjà reçu sa réponse finale : il n'y a plus
        // rien à faire côté Discord, l'incident reste tracé dans les journaux.
    }
}

/**
 * Erreur d'USAGE : l'utilisateur a demandé quelque chose d'impossible, ce n'est
 * pas un bug. Message explicite, pas de code d'incident, rien dans les journaux.
 */
function userError(interaction, { title, cause, action, ephemeral = true }) {
    return replyWithEmbed(interaction, buildErrorEmbed({ title, cause, action }), { ephemeral });
}

/**
 * INCIDENT : une exception s'est produite. On journalise avec un code, et on
 * explique à l'utilisateur ce qu'on peut.
 *
 * @param {object} context — { command, guildId, userId } pour retrouver la trace
 * @returns {string} le code d'incident
 */
function reportIncident(interaction, error, context = {}) {
    const code = newIncidentCode();
    const where = context.command || interaction?.commandName || interaction?.customId || 'inconnu';
    const guildId = context.guildId || interaction?.guild?.id || 'aucun';
    const userId = context.userId || interaction?.user?.id || 'inconnu';

    // Une seule ligne pour l'essentiel : c'est elle qu'on cherchera avec le code.
    // La stack suit, sur les lignes suivantes.
    console.error(
        `[Quasar] ❌ ${code} | ${where} | guild=${guildId} | user=${userId} | ` +
        `${error?.name || 'Error'}${typeof error?.code !== 'undefined' ? `[${error.code}]` : ''}: ${error?.message || error}`
    );
    if (error?.stack) console.error(error.stack);

    const explained = explain(error);
    if (interaction) {
        replyWithEmbed(interaction, buildErrorEmbed({ ...explained, code })).catch(() => {});
    }
    return code;
}

module.exports = {
    newIncidentCode,
    explain,
    buildErrorEmbed,
    userError,
    reportIncident,
    replyWithEmbed,
    DISCORD_ERRORS,
    SQLITE_ERRORS,
};
