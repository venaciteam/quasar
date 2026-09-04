// ═══════════════════════════════════════════════════════════════
//  Salon piège (honeypot)
//
//  Un salon que personne de légitime n'a de raison d'utiliser. Y écrire est le
//  signal, et le SEUL : ce module ne lit jamais ce qui est écrit. Il ne compare
//  rien à une liste de mots, ne mesure pas la longueur du message, n'ouvre pas
//  les pièces jointes. Le contenu ne sert pas à décider, il n'a donc pas à être
//  regardé — c'est ce qui distingue un piège d'un scanner de messages, et c'est
//  ce qui permet de faire tourner ce module sans jamais traiter de la donnée
//  personnelle au-delà de l'identifiant de la personne.
//
//  ─── Pourquoi c'est le seul écouteur de messages du chantier ───
//  Les trois autres modules de modération automatique partent d'événements
//  rares : une règle AutoMod qui se déclenche, un avertissement donné, une
//  arrivée. Celui-ci part de `messageCreate`, c'est-à-dire de CHAQUE message de
//  CHAQUE serveur. Un salon piège ne peut pas être surveillé autrement — mais
//  cela impose deux exigences que le reste du fichier sert à tenir :
//
//   1. LE CHEMIN « CE N'EST PAS UN SALON PIÈGE » NE COÛTE RIEN. Il ne fait
//      qu'une lecture de Map en mémoire. Aucune requête SQL, aucun appel réseau,
//      aucun accès au contenu. Des instances de Quasar tournent sur Raspberry
//      Pi : une seule requête par message y serait rédhibitoire.
//   2. RIEN NE LÈVE. Une exception ici remonterait dans le traitement des
//      messages de tous les serveurs — et l'API partageant le processus du bot,
//      un rejet non capturé arrêterait Node.
//
//  ─── Les garde-fous ne sont pas des réglages ───
//  L'équipe de modération, le propriétaire du serveur et le bot lui-même sont
//  exemptés en dur, sans case à cocher. Le piège le plus évident de cette
//  fonctionnalité est la personne qui va inspecter son salon piège, y écrit
//  « test », et se fait sanctionner par son propre outil ; rendre cette
//  exemption configurable, c'est rendre cet accident possible. Elle ne l'est pas.
//
//  ─── Ce module vit dans un fichier d'événement, et pas dans bot/modules/ ───
//  Sa configuration (cache, normalisation, bornes) est donc ici, à côté de son
//  seul consommateur, et exportée pour l'API — qui invalide le cache après un
//  enregistrement et rejoue `normalize` pour afficher le même diagnostic que
//  celui qui commande le comportement du bot. Une seule source de vérité, comme
//  bot/modules/antiraid/config.js le fait pour l'anti-raid.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, Events, MessageType, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const {
    applyPunishments,
    parsePunishments,
    validatePunishments,
    sendAutomodLog,
    SOURCE_LABELS,
} = require('../utils/punishments');
const { isInScope } = require('../utils/scopeFilter');

const SOURCE = 'honeypot';

// Bornes de saisie, appliquées par l'API et affichées par le dashboard. Les
// recopier ailleurs ferait diverger ce que l'interface promet de ce que la base
// accepte réellement.
const LIMITS = Object.freeze({
    MAX_PUNISHMENTS_LENGTH: 200,
    MAX_RESPONSE_MESSAGE: 1000,
    MAX_SCOPE_ENTRIES: 25,
});

// Seuls types de messages retenus : un message écrit par une personne, ou une
// réponse à un autre message.
//
// C'est un garde-fou, pas une optimisation. Discord poste lui-même dans les
// salons : « X a rejoint le serveur », « X a épinglé un message », « fil créé ».
// Ces messages portent l'identifiant de la personne concernée comme auteur.
// Si le salon piège se trouve être le salon système du serveur, chaque arrivée
// y produirait un message d'arrivée — et sanctionnerait, sans ce filtre, une
// personne qui n'a jamais rien écrit.
const HUMAN_MESSAGE_TYPES = new Set([MessageType.Default, MessageType.Reply]);

// ─── Instantané des salons pièges ───────────────────────────────────────────
//
// Une seule Map pour TOUT le processus : salon piège → sa configuration. Le
// chemin rapide se résume donc à `traps().get(message.channelId)`.
//
// Un cache par serveur (le modèle de l'anti-raid) ne conviendrait pas ici : il
// faudrait une entrée pour chaque serveur d'où arrive un message, y compris les
// milliers qui n'ont pas de salon piège, et une lecture de base par serveur pour
// apprendre qu'il n'y a rien à surveiller. L'instantané global coûte UNE requête
// pour tout le monde, et les serveurs sans salon piège n'y figurent même pas.
//
// L'invalidation par l'API est le vrai mécanisme de fraîcheur (elle tourne dans
// le même processus, cf. api/routes/honeypot.js) ; la durée de vie n'est qu'un
// filet pour une base modifiée à la main.
const SNAPSHOT_TTL_MS = 60_000;

/** Map<channelId, ligne honeypot_config> — null tant que rien n'a été lu. */
let snapshot = null;
let snapshotAt = 0;

function loadSnapshot() {
    const map = new Map();
    try {
        const rows = getDb().prepare(`
            SELECT * FROM honeypot_config
            WHERE enabled = 1 AND channel_id IS NOT NULL AND channel_id <> ''
        `).all();
        for (const row of rows) map.set(String(row.channel_id), row);
    } catch (err) {
        // Base indisponible : on garde un instantané vide plutôt que de retenter
        // à chaque message. Le module est alors dormant, ce qui est le bon défaut.
        console.error('[Quasar Honeypot] Lecture des salons pièges en échec :', err.message);
    }
    return map;
}

function traps(now = Date.now()) {
    if (snapshot && now - snapshotAt < SNAPSHOT_TTL_MS) return snapshot;
    snapshot = loadSnapshot();
    snapshotAt = now;
    return snapshot;
}

/**
 * Oublie l'instantané — appelé par l'API après un enregistrement. Sans ça, une
 * personne qui désigne son salon piège et le teste dans la foulée verrait
 * l'ancien réglage s'appliquer, et conclurait que le formulaire n'enregistre rien.
 *
 * Sans argument de serveur : l'instantané est global, il n'y a rien à cibler.
 */
function invalidateConfig() {
    snapshot = null;
    snapshotAt = 0;
}

// ─── Normalisation ──────────────────────────────────────────────────────────

// Portée réellement applicable ici. Contrairement à l'anti-raid, ce module a un
// membre sous les yeux, avec ses rôles : « seulement ces rôles » et « jamais ces
// rôles » veulent dire quelque chose et sont exposés dans le dashboard.
const ROLE_SCOPE_LABELS = Object.freeze({
    affected_roles: 'Rôles concernés',
    ignored_roles: 'Rôles exemptés',
});

// Portée sans objet : le salon surveillé est déjà désigné par `channel_id`.
// Ces deux colonnes existent dans la table (elles sont communes aux quatre
// modules) mais ne sont ni affichées ni écrites — l'API les remet à '[]' à
// chaque enregistrement. Un réglage affiché qui ne ferait rien serait pire que
// son absence (cf. l'en-tête de bot/utils/modlog.js).
const UNUSED_SCOPE_LABELS = Object.freeze({
    affected_channels: 'Salons concernés',
    ignored_channels: 'Salons exemptés',
});

/** @returns {{ readable: boolean, ids: string[] }} */
function readScopeColumn(raw) {
    if (raw === null || raw === undefined || raw === '') return { readable: true, ids: [] };
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return { readable: false, ids: [] };
        return { readable: true, ids: parsed.map(String) };
    } catch {
        return { readable: false, ids: [] };
    }
}

/**
 * Traduit une ligne de `honeypot_config` en configuration exploitable, et dresse
 * la liste de ce qui empêche le module d'agir.
 *
 * Même posture que l'anti-raid : une valeur qu'on ne sait pas lire n'est jamais
 * ramenée à une valeur « raisonnable ». Deviner l'intention d'une configuration
 * cassée, c'est sanctionner sur une supposition.
 *
 * @returns {{
 *   enabled: boolean, channelId: string|null, punishments: Array,
 *   alertOnly: boolean, affectedRoles: string[], ignoredRoles: string[],
 *   logChannelId: string|null, responseMessage: string|null, problems: string[]
 * }|null} null si le serveur n'a rien configuré.
 */
function normalize(row) {
    if (!row) return null;

    const problems = [];

    const raw = typeof row.punishments === 'string' ? row.punishments.trim() : '';
    const check = validatePunishments(raw);
    let punishments = [];
    if (!check.valid) {
        problems.push(`Les sanctions enregistrées sont illisibles : ${check.errors.join(' ')}`);
    } else {
        punishments = parsePunishments(raw).punishments;
    }

    const scope = {};
    for (const [column, label] of Object.entries(ROLE_SCOPE_LABELS)) {
        const read = readScopeColumn(row[column]);
        scope[column] = read.ids;
        if (!read.readable) {
            problems.push(`La portée « ${label} » n'est plus lisible en base : par sécurité, `
                + 'je n\'applique rien tant qu\'elle n\'est pas réenregistrée.');
        }
    }

    // Colonnes hors sujet renseignées : c'est forcément une édition manuelle ou
    // un retour arrière de version, et ce n'est pas anodin. scopeFilter évalue
    // les QUATRE colonnes ; une liste de salons non vide ne peut correspondre à
    // rien puisque ce module ne lui transmet aucun salon, et le piège cesse donc
    // d'agir. Le dire vaut mieux que de laisser chercher.
    for (const [column, label] of Object.entries(UNUSED_SCOPE_LABELS)) {
        const read = readScopeColumn(row[column]);
        if (!read.readable || read.ids.length) {
            problems.push(`La portée « ${label} » contient une valeur alors que ce module ne l'utilise pas `
                + '(le salon surveillé est déjà celui du piège) : tant qu\'elle est renseignée, je n\'applique rien. '
                + 'Réenregistrez les réglages pour la remettre à zéro.');
        }
    }

    if (row.enabled && !row.channel_id) {
        problems.push('Le module est activé mais aucun salon piège n\'est désigné : rien n\'est surveillé.');
    }

    return {
        enabled: !!row.enabled,
        channelId: row.channel_id || null,
        punishments,
        // « Alerte seule » : configuration valide et volontaire — je signale le
        // message piégé sans sanctionner. Une chaîne illisible n'en fait PAS
        // partie, elle est signalée dans `problems`.
        alertOnly: check.valid && punishments.length === 0,
        affectedRoles: scope.affected_roles,
        ignoredRoles: scope.ignored_roles,
        logChannelId: row.log_channel || null,
        responseMessage: row.response_message || null,
        problems,
    };
}

// ─── Anti-répétition ────────────────────────────────────────────────────────
//
// Un compte automatisé ne poste pas un message, il en poste vingt. Sans ce
// garde-fou, ce serait vingt sanctions dans l'historique, vingt embeds dans les
// journaux et — le pire — vingt cas identiques dans le salon d'arbitrage.
//
// La marque est posée AVANT d'agir : les messages suivants arrivent pendant que
// la première sanction est encore en cours d'application, et un marquage a
// posteriori les laisserait tous passer.
const HANDLED_TTL_MS = 60_000;

/** `guildId:userId` → horodatage du dernier déclenchement traité. */
const recentlyHandled = new Map();

function claimTrigger(key, now) {
    // Purge opportuniste : on ne passe ici que sur un message réellement piégé,
    // donc rarement. Pas de minuterie à entretenir, et la Map ne survit pas à un
    // redémarrage — ce qui est sans conséquence, elle ne sert qu'à dédoublonner.
    for (const [entry, at] of recentlyHandled) {
        if (now - at >= HANDLED_TTL_MS) recentlyHandled.delete(entry);
    }
    if (recentlyHandled.has(key)) return false;
    recentlyHandled.set(key, now);
    return true;
}

// ─── Journalisation ─────────────────────────────────────────────────────────

// Une configuration cassée est signalée une fois par serveur et par démarrage :
// un compte automatisé qui martèle le salon piège rendrait sinon la console
// illisible.
const reportedProblems = new Set();

function reportProblems(guildId, problems) {
    if (reportedProblems.has(guildId)) return;
    reportedProblems.add(guildId);
    console.error(`[Quasar Honeypot] Configuration inexploitable sur ${guildId} : ${problems.join(' ')}`);
}

/**
 * Compte rendu action par action. Contrairement à l'anti-raid, qui agrège une
 * vague entière, un déclenchement de piège ne concerne qu'une personne : le
 * détail tient en trois lignes et vaut mieux qu'un résumé.
 */
function describeResults(results) {
    if (!results.length) return null;
    return results
        .map(result => {
            if (result.ok) return `✅ \`${result.action}\`${result.note ? ` — ${result.note}` : ''}`;
            // Messages privés fermés : un choix de la personne visée, pas une
            // panne. Le signaler comme un échec ferait chercher un problème
            // qui n'existe pas.
            return `${result.benign ? 'ℹ️' : '❌'} \`${result.action}\` — ${result.error || 'échec'}`;
        })
        .join('\n')
        .slice(0, 1024);
}

/**
 * Alerte de déclenchement. Elle part MÊME en alerte seule : un piège qui se
 * déclenche sans rien dire ne se distingue pas d'un piège en panne.
 */
async function sendTrapAlert(guild, config, { userId, channelId, alertOnly, outcome }) {
    const embed = new EmbedBuilder()
        .setTitle('🍯 Message dans le salon piège')
        .setColor(0xe67e22)
        .addFields(
            { name: 'Membre', value: `<@${userId}> (${userId})`, inline: true },
            { name: 'Déclencheur', value: SOURCE_LABELS[SOURCE], inline: true },
            { name: 'Salon', value: `<#${channelId}>`, inline: true },
            {
                name: 'Sanction',
                value: alertOnly
                    ? 'Aucune : ce serveur est réglé en alerte seule.'
                    : (outcome || 'Aucune sanction appliquée.'),
            }
        )
        .setTimestamp();

    await sendAutomodLog(guild, embed, 'mod_warn', config.logChannelId);
}

// ─── Écouteur ───────────────────────────────────────────────────────────────

/**
 * Garde-fous lisibles sur le seul message, sans avoir à charger le membre.
 * Évalués en premier : ils évitent d'aller chercher sur le réseau un « membre »
 * qui n'existe pas (un webhook n'en a pas).
 *
 * @returns {string|null} raison (pour la trace), ou null si le message continue.
 */
function exemptAuthor(message) {
    const guild = message.guild;

    if (message.author.id === message.client?.user?.id) return 'message du bot lui-même';
    if (guild.ownerId && message.author.id === guild.ownerId) return 'message du propriétaire du serveur';

    // Bots et webhooks : exemptés, et c'est un choix, pas un oubli.
    //
    // Un bot ne se trouve sur le serveur que parce qu'une personne ayant « Gérer
    // le serveur » l'y a ajouté, et un webhook parce qu'une personne l'a créé.
    // Beaucoup publient partout — relais d'annonces, journaux, ponts inter-
    // plateformes — et bannir le bot de journalisation d'un serveur parce qu'il
    // a recopié une ligne dans le salon piège est une panne que le serveur
    // s'inflige à lui-même. Un webhook n'a d'ailleurs pas de membre à
    // sanctionner : ni exclusion, ni expulsion, ni bannissement n'auraient de
    // prise sur lui.
    //
    // Cette exemption n'affaiblit pas le piège : un compte de raid automatisé
    // n'est pas un « bot » au sens de Discord. C'est un compte utilisateur
    // ordinaire piloté par un script, sans le drapeau `bot` — il tombe donc bien
    // dans le piège.
    if (message.webhookId) return 'message d\'un webhook';
    if (message.author.bot) return 'message d\'un bot';

    return null;
}

/**
 * Le garde-fou décisif, celui sans lequel la première personne qui va inspecter
 * son salon piège et y écrit « test » se fait sanctionner par son propre outil.
 *
 * `has()` accorde déjà tout à un administrateur, mais les deux permissions sont
 * nommées explicitement : cette exemption est la raison d'être de la fonction,
 * elle doit se lire, pas se déduire.
 *
 * @returns {string|null} raison (pour la trace), ou null si le membre est
 *          sanctionnable.
 */
function exemptModerator(member) {
    const permissions = member.permissions;
    if (permissions?.has(PermissionFlagsBits.Administrator)) return 'administrateur du serveur';
    if (permissions?.has(PermissionFlagsBits.ModerateMembers)) return 'membre de l\'équipe de modération';
    return null;
}

async function execute(message) {
    try {
        // ─── Chemin rapide ───
        // Tout ce qui suit s'exécute pour chaque message de chaque serveur : une
        // lecture de propriété et une lecture de Map, rien d'autre. Aucune
        // requête en base, aucun appel réseau, aucun accès au contenu, et pas
        // une seule attente : la sortie est synchrone jusqu'au `return`.
        const channelId = message?.channelId;
        if (!channelId) return;

        const configured = traps();
        if (configured.size === 0) return;

        let row = configured.get(channelId);
        if (!row) {
            // Un fil ouvert dans le salon piège est le salon piège : le piège
            // serait sinon contournable en répondant dans un fil. Le parent
            // n'est consulté que pour un fil — le parent d'un salon ordinaire
            // est sa catégorie, qui n'a rien à voir avec un salon piège.
            const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
            if (!parentId) return;
            row = configured.get(String(parentId));
            if (!row) return;
        }

        // ─── À partir d'ici, le message vient bien d'un salon piège ───

        // Instantané périmé sur un salon changé de serveur, ou message privé
        // (aucun `guildId`) : dans les deux cas, ce n'est pas le piège de ce
        // serveur-là.
        if (!message.guild || message.guildId !== row.guild_id) return;
        if (!message.author) return;
        if (!HUMAN_MESSAGE_TYPES.has(message.type)) return;
        if (exemptAuthor(message)) return;

        // La configuration est relue AVANT d'aller chercher le membre : une
        // configuration inexploitable ne doit pas déclencher un appel réseau par
        // message reçu dans le piège.
        const config = normalize(row);
        if (!config || !config.enabled) return;
        if (config.problems.length) {
            reportProblems(message.guildId, config.problems);
            return;
        }

        const member = message.member
            || await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!member) {
            // Personne déjà partie, ou membre illisible : impossible de vérifier
            // qu'elle n'appartient pas à l'équipe de modération. On s'abstient —
            // le prix d'un compte de raid qui s'échappe est sans commune mesure
            // avec celui d'un modérateur sanctionné par son propre piège.
            console.warn(`[Quasar Honeypot] Membre ${message.author.id} illisible sur ${message.guildId} : aucune sanction.`);
            return;
        }
        if (exemptModerator(member)) return;

        // Portée configurable, appliquée PAR-DESSUS les garde-fous : elle peut
        // exempter davantage, jamais moins. Seul le membre est transmis — les
        // deux dimensions de salon n'ont pas d'objet ici (cf. UNUSED_SCOPE_LABELS).
        if (!isInScope(row, { member })) return;

        const now = Date.now();
        if (!claimTrigger(`${message.guildId}:${message.author.id}`, now)) return;

        await trigger(message, member, config, channelId);
    } catch (err) {
        // Filet ultime : une erreur du salon piège ne doit pas remonter dans le
        // traitement des messages de tous les serveurs.
        console.error('[Quasar Honeypot] Traitement du message piégé en échec :', err);
    }
}

/**
 * Déclenchement effectif : sanctions puis alerte. Le contenu du message n'est
 * toujours pas lu — seule son adresse voyage, pour que l'équipe puisse aller
 * voir elle-même si elle le souhaite.
 */
async function trigger(message, member, config, channelId) {
    const guild = message.guild;
    const channelName = message.channel?.name ? `#${message.channel.name}` : `<#${channelId}>`;
    const reason = `Salon piège : message posté dans ${channelName}`;

    let results = [];
    if (!config.alertOnly) {
        results = await applyPunishments(config.punishments, {
            guild,
            member,
            userId: member.id,
            // Indispensable à l'action « supprimer le message » : sans lui, le
            // socle n'a rien à supprimer et le rapporte comme un échec.
            message,
            reason,
            source: SOURCE,
            moderatorId: guild.client?.user?.id,
            logChannelId: config.logChannelId,
            responseMessage: config.responseMessage,
            // Lien vers le message, jamais son contenu : de quoi trancher un
            // arbitrage sans que le piège devienne un lecteur de messages. Le
            // lien reste valide, `defer` court-circuitant la suppression.
            evidence: message.url ? `[Message dans le salon piège](${message.url})` : null,
        });
    }

    await sendTrapAlert(guild, config, {
        userId: member.id,
        channelId,
        alertOnly: config.alertOnly,
        outcome: describeResults(results),
    });
}

module.exports = {
    name: Events.MessageCreate,
    once: false,
    execute,
};

// Exportés pour l'API (api/routes/honeypot.js) et les tests. La valeur exportée
// reste la description d'événement attendue par le chargeur de bot/index.js ;
// on ne fait que lui attacher des fonctions, sans effet de bord.
module.exports.LIMITS = LIMITS;
module.exports.normalize = normalize;
module.exports.invalidateConfig = invalidateConfig;
