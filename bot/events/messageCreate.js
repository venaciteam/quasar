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
//
//  ─── Le chemin rapide, et ce que le contrat neutre lui doit ────────────────
//
//  Trois garde-fous de ce fichier lisaient des champs propres à discord.js. Le
//  payload neutre de `messageCree` les porte désormais, et c'est ce qui rend la
//  migration possible SANS renoncer à l'exigence n° 1 ci-dessus :
//
//   • `estSysteme` remplace le filtre sur `MessageType` ;
//   • `estWebhook` remplace `message.webhookId` ;
//   • `estFil` + `canalParentId` remplacent `channel.isThread()` — portés PAR LE
//     MESSAGE, donc sans le moindre aller-retour sur le chemin rapide ;
//   • `lien` remplace `message.url`, sans écrire d'URL Discord ici.
//
//  Les seuls appels réseau ajoutés — propriétaire du serveur, membre, nom du
//  salon — sont tous APRÈS la reconnaissance du salon piège, c'est-à-dire sur
//  un chemin emprunté par une poignée de messages, jamais par tous.
// ═══════════════════════════════════════════════════════════════

const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
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
async function sendTrapAlert(portee, config, { userId, channelId, alertOnly, outcome }) {
    await sendAutomodLog(portee, embed({
        titre: '🍯 Message dans le salon piège',
        couleur: 0xe67e22,
        champs: [
            { nom: 'Membre', valeur: `<@${userId}> (${userId})`, enLigne: true },
            { nom: 'Déclencheur', valeur: SOURCE_LABELS[SOURCE], enLigne: true },
            { nom: 'Salon', valeur: `<#${channelId}>`, enLigne: true },
            {
                nom: 'Sanction',
                valeur: alertOnly
                    ? 'Aucune : ce serveur est réglé en alerte seule.'
                    : (outcome || 'Aucune sanction appliquée.'),
            },
        ],
        horodatage: true,
    }), 'mod_warn', config.logChannelId);
}

// ─── Écouteur ───────────────────────────────────────────────────────────────

/**
 * Garde-fous lisibles sur le seul message, sans avoir à charger le membre.
 * Évalués en premier : ils évitent d'aller chercher sur le réseau un « membre »
 * qui n'existe pas (un webhook n'en a pas).
 *
 * @param {object} message  message normalisé
 * @param {object} contexte { moiId, proprietaireId }
 * @returns {string|null} raison (pour la trace), ou null si le message continue.
 */
function exemptAuthor(message, { moiId, proprietaireId }) {
    if (message.auteur.id === moiId) return 'message du bot lui-même';
    if (proprietaireId && message.auteur.id === proprietaireId) return 'message du propriétaire du serveur';

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
    if (message.estWebhook) return 'message d\'un webhook';
    if (message.auteur.estBot) return 'message d\'un bot';

    return null;
}

/**
 * Le garde-fou décisif, celui sans lequel la première personne qui va inspecter
 * son salon piège et y écrit « test » se fait sanctionner par son propre outil.
 *
 * `aPermission` accorde déjà tout à un administrateur, mais les deux permissions
 * sont nommées explicitement : cette exemption est la raison d'être de la
 * fonction, elle doit se lire, pas se déduire.
 *
 * @returns {string|null} raison (pour la trace), ou null si le membre est
 *          sanctionnable.
 */
function exemptModerator(membre) {
    if (membre.aPermission('ADMINISTRATOR')) return 'administrateur du serveur';
    if (membre.aPermission('MODERATE_MEMBERS')) return 'membre de l\'équipe de modération';
    return null;
}

async function executer(ctx, message) {
    try {
        // ─── Chemin rapide ───
        // Tout ce qui suit s'exécute pour chaque message de chaque serveur : une
        // lecture de propriété et une lecture de Map, rien d'autre. Aucune
        // requête en base, aucun appel réseau, aucun accès au contenu, et pas
        // une seule attente : la sortie est synchrone jusqu'au `return`.
        const canalId = message?.canalId;
        if (!canalId) return;

        const configured = traps();
        if (configured.size === 0) return;

        let row = configured.get(canalId);
        if (!row) {
            // Un fil ouvert dans le salon piège est le salon piège : le piège
            // serait sinon contournable en répondant dans un fil. Le parent
            // n'est consulté que pour un fil — le parent d'un salon ordinaire
            // est sa catégorie, qui n'a rien à voir avec un salon piège. Les
            // deux champs sont portés par le message : toujours pas d'attente.
            const parentId = message.estFil ? message.canalParentId : null;
            if (!parentId) return;
            row = configured.get(String(parentId));
            if (!row) return;
        }

        // ─── À partir d'ici, le message vient bien d'un salon piège ───

        // Instantané périmé sur un salon changé de serveur, ou message privé
        // (aucun `guildeId`) : dans les deux cas, ce n'est pas le piège de ce
        // serveur-là.
        if (!message.guildeId || message.guildeId !== row.guild_id) return;
        if (!message.auteur) return;
        if (message.estSysteme) return;

        // Portée d'écriture : le piège n'a personne à qui répondre, il agit et
        // journalise par le client REST.
        const portee = { guildeId: message.guildeId, api: ctx.api, moi: ctx.moi };

        // Le propriétaire du serveur est la seule exemption qui demande une
        // lecture. Elle passe par le cache de l'adaptateur, et n'est atteinte
        // que par un message DÉJÀ reconnu comme venant d'un salon piège.
        const guilde = await ctx.api.obtenirGuilde(message.guildeId).catch(() => null);
        if (exemptAuthor(message, { moiId: ctx.moi?.id, proprietaireId: guilde?.proprietaireId })) return;

        // La configuration est relue AVANT d'aller chercher le membre : une
        // configuration inexploitable ne doit pas déclencher un appel réseau par
        // message reçu dans le piège.
        const config = normalize(row);
        if (!config || !config.enabled) return;
        if (config.problems.length) {
            reportProblems(message.guildeId, config.problems);
            return;
        }

        const membre = await ctx.api.obtenirMembre(message.guildeId, message.auteur.id).catch(() => null);
        if (!membre) {
            // Personne déjà partie, ou membre illisible : impossible de vérifier
            // qu'elle n'appartient pas à l'équipe de modération. On s'abstient —
            // le prix d'un compte de raid qui s'échappe est sans commune mesure
            // avec celui d'un modérateur sanctionné par son propre piège.
            console.warn(`[Quasar Honeypot] Membre ${message.auteur.id} illisible sur ${message.guildeId} : aucune sanction.`);
            return;
        }
        if (exemptModerator(membre)) return;

        // Portée configurable, appliquée PAR-DESSUS les garde-fous : elle peut
        // exempter davantage, jamais moins. Seul le membre est transmis — les
        // deux dimensions de salon n'ont pas d'objet ici (cf. UNUSED_SCOPE_LABELS).
        if (!isInScope(row, { member: membre })) return;

        const now = Date.now();
        if (!claimTrigger(`${message.guildeId}:${message.auteur.id}`, now)) return;

        await trigger(ctx, portee, message, membre, config, canalId);
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
async function trigger(ctx, portee, message, membre, config, canalId) {
    // Nom du salon, pour que le motif de la sanction reste lisible dans
    // l'historique. Une lecture, sur un chemin déjà rare, et un repli sur la
    // mention si le salon est illisible — exactement comme avant.
    const canal = await ctx.api.obtenirCanal(canalId).catch(() => null);
    const channelName = canal?.nom ? `#${canal.nom}` : `<#${canalId}>`;
    const reason = `Salon piège : message posté dans ${channelName}`;

    let results = [];
    if (!config.alertOnly) {
        results = await applyPunishments(config.punishments, {
            portee,
            member: membre,
            userId: membre.id,
            // Indispensable à l'action « supprimer le message » : sans lui, le
            // socle n'a rien à supprimer et le rapporte comme un échec.
            message,
            reason,
            source: SOURCE,
            moderatorId: ctx.moi?.id,
            logChannelId: config.logChannelId,
            responseMessage: config.responseMessage,
            // Lien vers le message, jamais son contenu : de quoi trancher un
            // arbitrage sans que le piège devienne un lecteur de messages. Le
            // lien reste valide, `defer` court-circuitant la suppression.
            evidence: message.lien ? `[Message dans le salon piège](${message.lien})` : null,
        });
    }

    await sendTrapAlert(portee, config, {
        userId: membre.id,
        channelId: canalId,
        alertOnly: config.alertOnly,
        outcome: describeResults(results),
    });
}

module.exports = definirEvenement({
    nom: 'messageCree',
    executer,
});

// Exportés pour l'API (api/routes/honeypot.js) et les tests. La valeur exportée
// reste le descripteur d'événement attendu par le chargeur de la plateforme ;
// on ne fait que lui attacher des fonctions, sans effet de bord.
module.exports.LIMITS = LIMITS;
module.exports.normalize = normalize;
module.exports.invalidateConfig = invalidateConfig;
