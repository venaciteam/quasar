// ═══════════════════════════════════════════════════════════════
//  Punitions composables
//
//  Un même vocabulaire de sanctions pour les quatre modules de modération
//  automatique (AutoMod Discord, escalade par warns, anti-raid, honeypot). Une
//  configuration écrit une chaîne — « delete, tempmute 20m, dm » — et ce module
//  la parse, la valide avant écriture en base, puis l'applique.
//
//  Trois invariants tiennent tout le reste :
//
//   1. RIEN NE LÈVE D'EXCEPTION. Ces punitions partent d'événements Discord
//      (arrivée d'un membre, message posté), pas d'une commande : personne n'est
//      là pour voir un rejet de promesse. Chaque action est isolée, son échec est
//      capturé et rapporté, les suivantes continuent.
//   2. CHAQUE SANCTION EST TRACÉE. Écriture dans la table `sanctions` existante
//      (avec l'identifiant du bot en modérateur) et log de modération : une
//      sanction automatique doit apparaître dans /sanctions et dans le salon de
//      logs exactement comme une sanction manuelle. Une punition invisible est
//      une punition incontestable.
//   3. ON NE PUNIT PAS CE QU'ON NE PEUT PAS PUNIR. Hiérarchie des rôles,
//      permissions manquantes, membre déjà parti, propriétaire du serveur, le bot
//      lui-même : chaque cas est détecté et rapporté en clair, jamais tenté à
//      l'aveugle pour finir en trace d'erreur illisible.
//
//  ─── Bi-format, le temps de la migration multiplateforme ───────────────────
//
//  Onze fichiers appellent ce module, migrés ou non. Chaque fonction publique
//  accepte donc les deux mondes :
//
//    voie historique — `guild` / `member` / `message` discord.js, `client` pour
//                      le balayeur. Comportement inchangé, marqué
//                      `// TRANSITION : format historique, à retirer au lot de
//                      consolidation`.
//    voie neutre     — une PORTÉE (`ctx`, adaptateur, ou `{ guildeId, api }`)
//                      passée dans le champ `portee`, et le client REST
//                      normalisé pour toutes les écritures.
//
//  Les trois contrôles préventifs qui manquaient à la voie neutre y sont
//  désormais, et ce n'est pas un détail de confort : un refus annoncé AVANT la
//  tentative nomme la correction à faire (remonter le rôle du bot, cocher une
//  permission), là où un refus traduit après coup dit seulement « permission
//  manquante » et envoie chercher au mauvais endroit une fois sur deux.
//    • hiérarchie des rôles -> `api.verifierMembreSanctionnable(guildeId,
//      membreId, 'timeout' | 'kick' | 'ban')`, équivalent de `member.moderatable`
//      / `kickable` / `bannable` ;
//    • propriétaire du serveur -> `proprietaireId`, porté par la portée neutre ;
//    • bot retiré du serveur -> code neutre `guilde_inconnue`, qui se distingue
//      d'une panne réseau (`inconnu`).
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { embed } = require('../platform/embed');
const { CODES_NEUTRES, codeNeutre } = require('../platform/erreurs');
const { resoudrePorteeNeutre, versEmbedDiscord } = require('./errors');
const { sendModLog } = require('./modlog');
const { sendLog } = require('./logger');

// Plafond du timeout natif de Discord. Au-delà, l'API refuse : on tronque et on
// le dit dans le résultat plutôt que de laisser croire à une exclusion plus longue.
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// Garde-fou de saisie : au-delà de dix ans, la valeur est une faute de frappe,
// pas une intention. `parseDuration` la refuse au lieu de produire une échéance
// absurde en base.
const MAX_DURATION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const DURATION_UNITS = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    j: 24 * 60 * 60 * 1000, // « jours » — le /mute existant accepte déjà cette lettre
    w: 7 * 24 * 60 * 60 * 1000,
};

const SOURCES = ['automod', 'escalation', 'antiraid', 'honeypot'];

const SOURCE_LABELS = {
    automod: 'AutoMod Discord',
    escalation: 'Escalade des avertissements',
    antiraid: 'Anti-raid',
    honeypot: 'Salon piège',
};

// ─── Durées ────────────────────────────────────────────────────────────────

/**
 * Parse une durée composable : « 30s », « 20m », « 3h42m », « 7d », « 1w2d ».
 * @returns {number|null} millisecondes, ou null si la chaîne est invalide.
 */
function parseDuration(str) {
    if (typeof str !== 'string') return null;
    const cleaned = str.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleaned) return null;
    // La chaîne DOIT être intégralement composée de paires nombre+unité : sans
    // cet ancrage, « 20mn » ou « 5 bananes » passeraient en ne lisant que le début.
    if (!/^(\d+[smhdjw])+$/.test(cleaned)) return null;

    let total = 0;
    for (const [, value, unit] of cleaned.matchAll(/(\d+)([smhdjw])/g)) {
        total += Number(value) * DURATION_UNITS[unit];
        if (total > MAX_DURATION_MS) return null;
    }
    return total > 0 ? total : null;
}

/**
 * Forme compacte d'une durée, celle qu'attend la colonne `sanctions.duration`
 * (le /mute manuel y écrit déjà « 10m », « 1d »).
 */
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const parts = [];
    let rest = Math.floor(ms);
    for (const unit of ['d', 'h', 'm', 's']) {
        const size = DURATION_UNITS[unit];
        const count = Math.floor(rest / size);
        if (count > 0) {
            parts.push(`${count}${unit}`);
            rest -= count * size;
        }
    }
    return parts.join('') || '0s';
}

// ─── Vocabulaire des actions ───────────────────────────────────────────────
//
// `duration: 'required'` — l'action est refusée sans durée valide.
// `duration: 'none'`     — une durée passée en argument est une erreur de saisie
//                          qu'on signale, plutôt que de l'ignorer en silence.

const ACTIONS = {
    delete: { duration: 'none' },
    warn: { duration: 'none' },
    timeout: { duration: 'required' },
    tempmute: { duration: 'required' },
    mute: { duration: 'none' },
    kick: { duration: 'none' },
    tempban: { duration: 'required' },
    ban: { duration: 'none' },
    dm: { duration: 'none' },
    defer: { duration: 'none' },
};

const ACTION_NAMES = Object.keys(ACTIONS);

// ─── Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse une chaîne de punitions composables séparées par des virgules.
 * Ne lève jamais : les entrées fautives sont écartées et décrites dans `errors`.
 *
 * @param {string} str — ex. « delete, tempmute 20m, defer »
 * @returns {{ punishments: Array<{action: string, durationMs?: number}>, errors: string[] }}
 */
function parsePunishments(str) {
    const punishments = [];
    const errors = [];

    if (str === null || str === undefined) return { punishments, errors };
    if (typeof str !== 'string') {
        errors.push('La liste de punitions doit être du texte.');
        return { punishments, errors };
    }

    const seen = new Set();

    for (const raw of str.split(',')) {
        const entry = raw.trim();
        if (!entry) continue;

        const [word, ...rest] = entry.split(/\s+/);
        const action = word.toLowerCase();
        const argument = rest.join('');

        if (!ACTIONS[action]) {
            errors.push(`Action inconnue : « ${word} ».`);
            continue;
        }
        // Une action répétée n'a pas de sens (bannir deux fois) et trahit une
        // faute de saisie : on garde la première occurrence et on le signale.
        if (seen.has(action)) {
            errors.push(`Action « ${action} » indiquée plusieurs fois : seule la première est retenue.`);
            continue;
        }

        if (ACTIONS[action].duration === 'required') {
            if (!argument) {
                errors.push(`L'action « ${action} » a besoin d'une durée (ex. « ${action} 20m »).`);
                continue;
            }
            const durationMs = parseDuration(argument);
            if (durationMs === null) {
                errors.push(`Durée invalide pour « ${action} » : « ${argument} ».`);
                continue;
            }
            seen.add(action);
            punishments.push({ action, durationMs });
            continue;
        }

        if (argument) {
            errors.push(`L'action « ${action} » ne prend pas de durée : « ${argument} » sera ignoré.`);
        }
        seen.add(action);
        punishments.push({ action });
    }

    return { punishments, errors };
}

/**
 * Valide une chaîne sans rien appliquer — pour l'API, avant écriture en base.
 * Une chaîne vide est VALIDE : c'est le mode « alerte seule », le seul défaut
 * acceptable pour une protection qu'on n'a pas encore configurée.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePunishments(str) {
    const { punishments, errors } = parsePunishments(str);
    // Une chaîne non vide qui ne produit aucune punition n'a rien de valide :
    // l'enregistrer donnerait une règle qui ne fait rien, sans le dire.
    if (!punishments.length && typeof str === 'string' && str.trim() && !errors.length) {
        errors.push('Aucune action reconnue dans cette liste.');
    }
    return { valid: errors.length === 0, errors };
}

// ─── Journalisation ────────────────────────────────────────────────────────

/**
 * Envoie un embed de modération, en respectant le salon de log dédié éventuel
 * de la règle (`log_channel`) et en retombant sur le modlog global du serveur
 * quand il n'y en a pas — ou quand le salon configuré n'existe plus.
 *
 * Exporté : les quatre modules en ont besoin pour leurs propres alertes (mode
 * panique, cas honeypot…), et faire passer ce repli par quatre implémentations
 * différentes garantirait que trois d'entre elles l'oublient.
 *
 * @param {object} cible   `Guild` discord.js, ou portée neutre (`ctx`, `{ guildeId, api }`)
 * @param {object} contenu embed neutre, ou `EmbedBuilder` sur la voie historique
 */
async function sendAutomodLog(cible, contenu, logType, logChannelId) {
    if (!cible) return;
    const portee = resoudrePorteeNeutre(cible);

    if (portee) {
        if (logChannelId) {
            const envoye = await portee.api.envoyerMessage(String(logChannelId), contenu).catch(err => {
                console.error(`[Quasar AutoMod] Log ${logType} vers ${logChannelId} en échec :`, err.message);
                return null;
            });
            if (envoye) return;
        }
        // Le repli passe par `sendLog` et non par `sendModLog` : ce dernier est
        // encore strictement discord.js (lot 1). Les deux appliquent la même
        // règle — type de log activé, salon configuré — seul le libellé de
        // l'erreur d'envoi diffère.
        await sendLog(portee.source, logType, contenu).catch(() => {});
        return;
    }

    // TRANSITION : format historique, à retirer au lot de consolidation
    const embedDiscord = versEmbedDiscord(contenu);
    if (logChannelId) {
        const channel = cible.channels?.cache?.get(String(logChannelId));
        if (channel) {
            const sent = await channel.send({ embeds: [embedDiscord] }).catch(err => {
                console.error(`[Quasar AutoMod] Log ${logType} vers ${logChannelId} en échec :`, err.message);
                return null;
            });
            if (sent) return;
        }
        // Salon supprimé ou inaccessible : on ne perd pas le log, on retombe sur
        // le modlog global plutôt que de laisser la sanction sans trace.
    }
    await sendModLog(cible, embedDiscord, logType).catch(() => {});
}

function recordSanction({ guildId, userId, moderatorId, type, reason, duration }) {
    try {
        const db = getDb();
        return db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(guildId, userId, moderatorId, type, reason, duration || null).lastInsertRowid;
    } catch (err) {
        // Une écriture d'historique en échec ne doit pas annuler une sanction
        // déjà appliquée sur Discord : on trace et on continue.
        console.error('[Quasar AutoMod] Écriture de la sanction en échec :', err.message);
        return null;
    }
}

/**
 * Embed de log d'une sanction, au format NEUTRE — la source unique du contenu.
 *
 * Le champ « Raison » ne déclare volontairement PAS `enLigne` : c'était déjà le
 * cas avant (aucune clé `inline` sur ce champ), et `buildLogEmbedHistorique`
 * s'appuie sur cette absence pour produire un corps identique à l'octet près.
 */
function buildLogEmbed({ title, color, targetId, reason, source, extra }) {
    const champs = [
        { nom: 'Membre', valeur: targetId ? `<@${targetId}> (${targetId})` : 'Inconnu', enLigne: true },
        { nom: 'Déclencheur', valeur: SOURCE_LABELS[source] || 'Modération automatique', enLigne: true },
        { nom: 'Raison', valeur: (reason || 'Aucune raison précisée').slice(0, 1024) },
    ];
    if (extra) champs.push({ nom: extra.name, valeur: extra.value, enLigne: true });

    return embed({ titre: title, couleur: color, champs, horodatage: true });
}

/**
 * Le même embed, au format Discord.
 *
 * Monté à la main à partir du neutre, et non par `rendreEmbed` : le rendu
 * générique pose `inline: Boolean(champ.enLigne)` sur TOUS les champs, ce qui
 * ajouterait `"inline": false` au champ « Raison » — même affichage, mais un
 * corps différent de celui d'avant. Ici, un champ sans `enLigne` ressort sans
 * clé `inline`, comme le faisait l'implémentation d'origine.
 */
// TRANSITION : format historique, à retirer au lot de consolidation
function buildLogEmbedHistorique(spec) {
    const neutre = buildLogEmbed(spec);
    return new EmbedBuilder()
        .setTitle(neutre.titre)
        .setColor(neutre.couleur)
        .addFields(neutre.champs.map(champ => ('enLigne' in champ
            ? { name: champ.nom, value: champ.valeur, inline: champ.enLigne }
            : { name: champ.nom, value: champ.valeur })))
        .setTimestamp();
}

/** Embed de log dans le format attendu par la voie empruntée. */
function logEmbedPour(portee, spec) {
    return portee ? buildLogEmbed(spec) : buildLogEmbedHistorique(spec);
}

// ─── Application ───────────────────────────────────────────────────────────

// Phrase associée à chaque code neutre. Le vocabulaire neutre est délibérément
// plus grossier que les numéros de Discord — `permission` couvre 50013 comme
// 50001, `introuvable` couvre le membre parti comme le message effacé : ce sont
// des DÉCISIONS possibles pour l'appelant, pas des catégories d'erreur. Une
// phrase par décision, donc, et pas une par numéro.
const PHRASES_NEUTRES = Object.freeze({
    [CODES_NEUTRES.permission]: 'Permission manquante côté bot.',
    [CODES_NEUTRES.introuvable]: 'La cible n\'existe plus : membre parti, message ou salon supprimé.',
    [CODES_NEUTRES.deja_fait]: 'Aucun bannissement en cours pour ce membre.',
    [CODES_NEUTRES.guilde_inconnue]: 'Je ne suis plus sur ce serveur.',
});

// TRANSITION : format historique, à retirer au lot de consolidation
// Une erreur n'est marquée d'un `codeNeutre` que si elle a traversé `api.*`. La
// voie historique de ce fichier (`member.kick`, `guild.members.ban`,
// `message.delete`) lève des erreurs BRUTES : sans cette table, tous ses échecs
// ressortiraient en anglais, dans la langue de discord.js.
const PHRASES_DISCORD = Object.freeze({
    50013: 'Permission manquante côté bot.',
    50001: 'Accès refusé au salon ou au membre.',
    10007: 'Ce membre n\'est plus sur le serveur.',
    10008: 'Le message n\'existe plus.',
    10026: 'Aucun bannissement en cours pour ce membre.',
});

/**
 * Traduit une erreur d'API en phrase exploitable. Sans ça, un résultat dit
 * « DiscordAPIError[50013] » à une personne qui cherche pourquoi son anti-raid
 * ne fait rien.
 */
function describeError(err) {
    // 30035 n'a aucun équivalent dans le vocabulaire neutre : la limite de
    // bannissements d'un serveur est une contrainte propre à Discord, et son
    // numéro reste le seul moyen de la nommer. Testé en premier, parce que
    // l'adaptateur la classe en `inconnu` — ce qu'elle est, pour une décision.
    if (err?.code === 30035) return 'Limite de bannissements atteinte pour ce serveur.';

    const phrase = PHRASES_NEUTRES[codeNeutre(err)];
    if (phrase) return phrase;

    // TRANSITION : format historique, à retirer au lot de consolidation
    return PHRASES_DISCORD[err?.code] || err?.message || 'Erreur inconnue.';
}

/**
 * Le membre est-il hors d'atteinte pour une raison structurelle (et pas
 * seulement pour l'action demandée) ? Ces trois cas rendent TOUTE sanction
 * impossible ou dangereuse, et ne dépendent pas de l'action.
 *
 * ⚠️ Voie neutre : le propriétaire du serveur n'est contrôlé que si la portée
 * le déclare (`proprietaireId`). Le contrat ne l'expose pas — `api.obtenirGuilde`
 * rend `{ id, nom }`. Sans lui, la sanction est tentée et refusée par la
 * plateforme (50013), traduite en « Permission manquante côté bot. » : moins
 * explicite, jamais dangereux.
 *
 * @param {object} cible `Guild` discord.js, ou portée neutre
 * @returns {string|null} raison du refus, ou null si la cible est sanctionnable.
 */
function unreachableTarget(cible, targetId) {
    if (!targetId) return 'Cible inconnue.';

    const portee = resoudrePorteeNeutre(cible);
    if (portee) {
        if (portee.proprietaireId && targetId === portee.proprietaireId) {
            return 'Le propriétaire du serveur ne peut pas être sanctionné.';
        }
        if (portee.moiId && targetId === portee.moiId) return 'Je ne me sanctionne pas moi-même.';
        return null;
    }

    // TRANSITION : format historique, à retirer au lot de consolidation
    if (cible.ownerId && targetId === cible.ownerId) return 'Le propriétaire du serveur ne peut pas être sanctionné.';
    if (cible.client?.user?.id && targetId === cible.client.user.id) return 'Je ne me sanctionne pas moi-même.';
    return null;
}

/**
 * Applique une suite de punitions à une cible. Ne lève jamais.
 *
 * @param {Array|string} punishments — sortie de parsePunishments(), ou
 *        directement la chaîne de configuration (parsée ici dans ce cas).
 * @param {object} etat
 * @param {object} [etat.portee]  VOIE NEUTRE : `ctx`, adaptateur, ou
 *        `{ guildeId, api }`. Exclusif de `guild`, et prioritaire sur lui.
 * @param {import('discord.js').Guild}  [etat.guild]  VOIE HISTORIQUE
 * @param {object|null} [etat.member] membre discord.js, ou membre normalisé sur
 *        la voie neutre. Peut être null (membre déjà parti) : les actions qui
 *        l'exigent sont alors écartées.
 * @param {object} [etat.message]     message discord.js, ou message normalisé
 *        (`{ id, canalId }`) sur la voie neutre — requis par `delete`
 * @param {string} [etat.userId]      — identifiant de la cible quand `member`
 *        est null (permet de bannir quelqu'un qui vient de partir)
 * @param {string}  etat.reason
 * @param {string}  etat.source        — 'automod' | 'escalation' | 'antiraid' | 'honeypot'
 * @param {string}  etat.moderatorId   — identifiant du bot pour une action automatique
 * @param {string}  [etat.logChannelId] — salon de log dédié de la règle
 * @param {string}  [etat.responseMessage] — texte du MP de l'action `dm`
 * @returns {Promise<Array<{action: string, ok: boolean, error?: string, note?: string}>>}
 */
async function applyPunishments(punishments, etat = {}) {
    const list = Array.isArray(punishments)
        ? punishments
        : parsePunishments(punishments).punishments;

    if (!list.length) return [];

    // `portee` d'abord : un appelant qui fournit les deux a migré, et c'est la
    // voie neutre qui fait foi.
    const cible = etat.portee || etat.guild;
    const portee = resoudrePorteeNeutre(cible);
    const guild = portee ? null : etat.guild;

    // Une portée neutre sans `guildeId` ne désigne aucun serveur : même issue
    // qu'une guilde absente, plutôt qu'une sanction écrite en base sur `null`.
    if ((!portee && !guild) || (portee && !portee.guildeId)) {
        return list.map(p => ({ action: p.action, ok: false, error: 'Serveur indisponible.' }));
    }

    const guildeId = portee ? portee.guildeId : guild.id;

    const member = etat.member || null;
    // `auteur` : forme normalisée d'un message (bot/platform/discord/events.js).
    const targetId = member?.id || etat.userId || etat.message?.author?.id || etat.message?.auteur?.id || null;
    const reason = etat.reason || 'Modération automatique';
    const source = SOURCES.includes(etat.source) ? etat.source : 'automod';
    const moderatorId = etat.moderatorId || (portee ? portee.moiId : guild.client?.user?.id) || 'system';

    // ─── `defer` court-circuite tout le reste ───
    // Écrire « tempmute 20m, defer », c'est demander qu'une personne tranche
    // AVANT que le mute ne tombe. Appliquer le mute puis ouvrir un arbitrage sur
    // le même cas viderait l'arbitrage de son sens : les autres actions
    // deviennent la proposition soumise au salon d'arbitrage.
    if (list.some(p => p.action === 'defer') && etat.allowDefer !== false) {
        const proposed = list.filter(p => p.action !== 'defer');
        const { sendDeferCase } = require('../modules/defer');
        // `sendDeferCase` est encore strictement discord.js (lot 5). On lui
        // transmet la cible telle qu'on l'a reçue : le jour où il devient
        // bi-format, rien à changer ici. En attendant, un appel neutre portant
        // `defer` obtient « Arbitrage indisponible » — et donc AUCUNE sanction
        // appliquée, ce qui est le repli voulu par l'invariant ci-dessus.
        const outcome = await sendDeferCase(cible, {
            targetUserId: targetId,
            source,
            reason,
            proposedPunishments: stringifyPunishments(proposed),
            evidence: etat.evidence,
        });

        if (!outcome.ok) {
            // Arbitrage indisponible (salon non configuré, supprimé, sans droit
            // d'écriture) : on N'APPLIQUE PAS les punitions à la place. La
            // configuration disait « qu'une personne décide » — se substituer à
            // elle parce qu'un salon manque serait exactement l'inverse.
            return list.map(p => ({
                action: p.action,
                ok: false,
                error: `Arbitrage indisponible : ${outcome.error}`,
            }));
        }

        return [
            { action: 'defer', ok: true, note: `Cas #${outcome.caseId} ouvert dans le salon d'arbitrage.` },
            ...proposed.map(p => ({
                action: p.action,
                ok: true,
                deferred: true,
                note: `Proposé à l'arbitrage (cas #${outcome.caseId}), non appliqué pour l'instant.`,
            })),
        ];
    }

    const blocked = unreachableTarget(cible, targetId);
    const results = [];

    for (const punishment of list) {
        const { action, durationMs } = punishment;

        // `delete` ne vise pas une personne : il reste possible même quand la
        // cible est hors d'atteinte (propriétaire du serveur, membre parti).
        if (blocked && action !== 'delete' && action !== 'defer') {
            results.push({ action, ok: false, error: blocked });
            continue;
        }

        try {
            results.push(await applyOne(action, durationMs, {
                cible, portee, guild, guildeId,
                member, targetId, reason, source, moderatorId,
                message: etat.message,
                logChannelId: etat.logChannelId,
                responseMessage: etat.responseMessage,
            }));
        } catch (err) {
            // Filet ultime : aucune exception ne remonte à l'appelant, même si
            // une des branches ci-dessous en oubliait une.
            console.error(`[Quasar AutoMod] Action « ${action} » en échec :`, err);
            results.push({ action, ok: false, error: describeError(err) });
        }
    }

    return results;
}

/** Reconstruit une chaîne de configuration à partir de punitions parsées. */
function stringifyPunishments(list) {
    return (list || [])
        .map(p => (p.durationMs ? `${p.action} ${formatDuration(p.durationMs)}` : p.action))
        .join(', ');
}

/**
 * Le bot a-t-il le droit de bannir, sur la voie neutre ?
 *
 * `api.obtenirMembre` rend un membre dont `aPermission` lit les permissions
 * CALCULÉES — c'est la seule façon, sans discord.js, de poser la question que
 * `guild.members.me.permissions.has()` posait. Sans identité de bot connue
 * (adaptateur pas encore connecté), on ne bloque pas : la plateforme refusera
 * elle-même, et inventer un refus empêcherait une sanction légitime.
 *
 * @returns {Promise<string|null>} motif du refus, ou null
 */
// Motif d'un refus structurel, par sanction. Une seule phrase pour les DEUX
// causes — hiérarchie et permission — parce que c'est ce que la voie historique
// annonce depuis toujours (`member.moderatable` confond déjà les deux), et que
// les séparer changerait ce que lit une personne qui modère.
const REFUS_PAR_SANCTION = Object.freeze({
    timeout: 'Hiérarchie des rôles ou permission « Exclure temporairement » manquante.',
    kick: 'Hiérarchie des rôles ou permission « Expulser des membres » manquante.',
    ban: 'Hiérarchie des rôles ou permission « Bannir des membres » manquante.',
});

/**
 * Pré-contrôle neutre d'une sanction, équivalent de `member.moderatable` /
 * `kickable` / `bannable`.
 *
 * Rend `null` dès que la réponse est indéterminable, et c'est la règle qui
 * compte : inventer un refus empêcherait une sanction légitime, alors qu'en
 * laissant passer c'est la plateforme qui tranche — et son erreur est traduite.
 * Trois cas y mènent, et aucun n'est un refus :
 *   • `verifierMembreSanctionnable` rend `null` (membre illisible, identité du
 *     bot hors cache) ;
 *   • l'appel échoue (API injoignable) ;
 *   • la portée reçue n'expose PAS la méthode. Une portée n'est reconnue qu'à
 *     son `api.envoyerMessage` (`resoudrePorteeNeutre`) : rien ne garantit le
 *     reste du client REST, et un appel à une méthode absente lèverait de façon
 *     SYNCHRONE — donc hors de portée d'un `.catch()` — pour ressortir en
 *     « verifierMembreSanctionnable is not a function » à la place du motif réel.
 *
 * @param {'timeout'|'kick'|'ban'} sanction
 * @returns {Promise<string|null>} motif du refus, ou null
 */
async function refusSanctionNeutre(portee, guildeId, membreId, sanction) {
    if (!membreId || typeof portee.api?.verifierMembreSanctionnable !== 'function') return null;
    let refus;
    try {
        refus = await portee.api.verifierMembreSanctionnable(guildeId, membreId, sanction);
    } catch {
        return null;
    }
    return refus ? REFUS_PAR_SANCTION[sanction] : null;
}

async function refusPermissionBanNeutre(portee, guildeId) {
    if (!portee.moiId) return null;
    const moi = await portee.api.obtenirMembre(guildeId, portee.moiId).catch(() => null);
    if (!moi || typeof moi.aPermission !== 'function') return null;
    return moi.aPermission('BAN_MEMBERS') ? null : 'Permission « Bannir des membres » manquante.';
}

/** Nom du serveur, pour le texte du MP de l'action `dm`. */
async function nomDuServeur(state) {
    // TRANSITION : format historique, à retirer au lot de consolidation
    if (!state.portee) return state.guild.name;
    if (state.portee.nomGuilde) return state.portee.nomGuilde;
    const guilde = await state.portee.api.obtenirGuilde(state.guildeId).catch(() => null);
    return guilde?.nom || 'ce serveur';
}

async function applyOne(action, durationMs, state) {
    const { cible, portee, guild, guildeId, member, targetId, reason, source, moderatorId, logChannelId } = state;

    switch (action) {
        case 'delete': {
            if (!state.message) return { action, ok: false, error: 'Aucun message à supprimer.' };
            // `canalId` sur un message normalisé, `channelId` sur un message
            // discord.js : le salon est lu avant la suppression, il sert au log.
            const canalId = state.message.canalId ?? state.message.channelId;
            try {
                if (portee) await portee.api.supprimerMessage(canalId, state.message.id);
                // TRANSITION : format historique, à retirer au lot de consolidation
                else await state.message.delete();
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }
            await sendAutomodLog(cible, logEmbedPour(portee, {
                title: '🗑️ Message supprimé automatiquement',
                color: 0x95a5a6,
                targetId, reason, source,
                extra: { name: 'Salon', value: `<#${canalId}>` },
            }), 'mod_clear', logChannelId);
            return { action, ok: true };
        }

        case 'warn': {
            const id = recordSanction({ guildId: guildeId, userId: targetId, moderatorId, type: 'warn', reason });
            await sendAutomodLog(cible, logEmbedPour(portee, {
                title: '⚠️ Avertissement automatique',
                color: 0xf1c40f,
                targetId, reason, source,
                extra: id ? { name: 'ID sanction', value: `#${id}` } : null,
            }), 'mod_warn', logChannelId);
            return { action, ok: true };
        }

        // timeout / tempmute / mute reposent tous les trois sur l'exclusion
        // temporaire native de Discord — Quasar n'a pas de rôle « muet ».
        // `mute` sans durée applique donc le plafond de l'API (28 jours) : c'est
        // ce que Discord permet de plus proche d'un mute sans fin, et le
        // résultat le dit explicitement pour que personne ne croie à un mute
        // définitif.
        case 'timeout':
        case 'tempmute':
        case 'mute': {
            if (!member) return { action, ok: false, error: 'Ce membre n\'est plus sur le serveur.' };
            const refusTimeout = portee
                ? await refusSanctionNeutre(portee, guildeId, member.id, 'timeout')
                // TRANSITION : format historique, à retirer au lot de consolidation
                : (member.moderatable ? null : REFUS_PAR_SANCTION.timeout);
            if (refusTimeout) return { action, ok: false, error: refusTimeout };

            const asked = action === 'mute' ? MAX_TIMEOUT_MS : durationMs;
            const applied = Math.min(asked, MAX_TIMEOUT_MS);
            let note;
            if (action === 'mute') {
                note = 'Exclusion appliquée au maximum autorisé par Discord (28 jours).';
            } else if (applied < asked) {
                note = `Durée tronquée à 28 jours (plafond de l'API Discord) au lieu de ${formatDuration(asked)}.`;
            }

            try {
                // `appliquerTimeout` attend une ÉCHÉANCE, `member.timeout` une
                // durée : c'est la même exclusion, exprimée dans les termes de
                // chaque API.
                if (portee) await portee.api.appliquerTimeout(guildeId, member.id, Date.now() + applied, reason);
                // TRANSITION : format historique, à retirer au lot de consolidation
                else await member.timeout(applied, reason);
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }

            recordSanction({
                guildId: guildeId, userId: targetId, moderatorId,
                type: 'mute', reason, duration: formatDuration(applied),
            });
            await sendAutomodLog(cible, logEmbedPour(portee, {
                title: '🔇 Exclusion temporaire automatique',
                color: 0xe67e22,
                targetId, reason, source,
                extra: { name: 'Durée', value: formatDuration(applied) },
            }), 'mod_mute', logChannelId);
            return note ? { action, ok: true, note } : { action, ok: true };
        }

        case 'kick': {
            if (!member) return { action, ok: false, error: 'Ce membre n\'est plus sur le serveur.' };
            const refusKick = portee
                ? await refusSanctionNeutre(portee, guildeId, member.id, 'kick')
                // TRANSITION : format historique, à retirer au lot de consolidation
                : (member.kickable ? null : REFUS_PAR_SANCTION.kick);
            if (refusKick) return { action, ok: false, error: refusKick };
            try {
                if (portee) await portee.api.exclureMembre(guildeId, member.id, reason);
                // TRANSITION : format historique, à retirer au lot de consolidation
                else await member.kick(reason);
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }
            recordSanction({ guildId: guildeId, userId: targetId, moderatorId, type: 'kick', reason });
            await sendAutomodLog(cible, logEmbedPour(portee, {
                title: '🔴 Expulsion automatique',
                color: 0xe67e22,
                targetId, reason, source,
            }), 'mod_kick', logChannelId);
            return { action, ok: true };
        }

        case 'tempban':
        case 'ban': {
            // Un membre déjà parti reste bannissable par son identifiant : c'est
            // même le cas le plus fréquent en anti-raid. La hiérarchie ne se
            // contrôle donc QUE s'il est encore là ; la permission du bot, elle,
            // se contrôle dans tous les cas, juste en dessous.
            const refusHierarchie = member
                ? (portee
                    ? await refusSanctionNeutre(portee, guildeId, member.id, 'ban')
                    // TRANSITION : format historique, à retirer au lot de consolidation
                    : (member.bannable ? null : REFUS_PAR_SANCTION.ban))
                : null;
            if (refusHierarchie) return { action, ok: false, error: refusHierarchie };

            const refusBan = portee
                ? await refusPermissionBanNeutre(portee, guildeId)
                // TRANSITION : format historique, à retirer au lot de consolidation
                : (guild.members.me?.permissions?.has(PermissionFlagsBits.BanMembers)
                    ? null
                    : 'Permission « Bannir des membres » manquante.');
            if (refusBan) return { action, ok: false, error: refusBan };

            try {
                if (portee) await portee.api.bannirMembre(guildeId, targetId, reason);
                // TRANSITION : format historique, à retirer au lot de consolidation
                else await guild.members.ban(targetId, { reason });
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }

            const duration = action === 'tempban' ? formatDuration(durationMs) : null;
            recordSanction({ guildId: guildeId, userId: targetId, moderatorId, type: 'ban', reason, duration });

            if (action === 'tempban') {
                scheduleUnban(guildeId, targetId, durationMs, reason, source);
            }

            await sendAutomodLog(cible, logEmbedPour(portee, {
                title: action === 'tempban' ? '🔨 Bannissement temporaire automatique' : '🔨 Bannissement automatique',
                color: 0xe74c3c,
                targetId, reason, source,
                extra: duration ? { name: 'Durée', value: duration } : null,
            }), 'mod_ban', logChannelId);
            return { action, ok: true };
        }

        case 'dm': {
            let envoyer;
            if (portee) {
                const canalPrive = targetId
                    ? await portee.api.ouvrirMessagePrive(targetId).catch(() => null)
                    : null;
                if (!canalPrive) return { action, ok: false, error: 'Destinataire introuvable.', benign: true };
                envoyer = (contenu) => portee.api.envoyerMessage(canalPrive, contenu);
            } else {
                // TRANSITION : format historique, à retirer au lot de consolidation
                const user = member?.user || (targetId ? await guild.client.users.fetch(targetId).catch(() => null) : null);
                if (!user) return { action, ok: false, error: 'Destinataire introuvable.', benign: true };
                envoyer = (contenu) => user.send({ content: contenu });
            }

            const text = state.responseMessage
                || `Une règle de modération automatique de **${await nomDuServeur(state)}** vient de s'appliquer à votre message ou à votre compte.\nMotif : ${reason}`;
            try {
                await envoyer(String(text).slice(0, 2000));
            } catch (err) {
                // Messages privés fermés : c'est un choix de la personne, pas une
                // panne. Rapporté, mais marqué comme bénin pour que les modules
                // n'en fassent pas une alerte.
                return { action, ok: false, error: describeError(err), benign: true };
            }
            return { action, ok: true };
        }

        case 'defer':
            // Atteignable uniquement via allowDefer === false, c'est-à-dire
            // depuis l'arbitrage lui-même : on ne rouvre pas un cas à partir d'un
            // cas, sous peine de boucle.
            return { action, ok: false, error: 'Arbitrage déjà en cours pour ce cas.' };

        default:
            return { action, ok: false, error: 'Action inconnue.' };
    }
}

// ─── Bannissements temporaires ─────────────────────────────────────────────
//
// Discord ne connaît pas le ban à durée : la levée est à notre charge. L'échéance
// est persistée en base et relue par un balayage périodique — un `setTimeout` ne
// survivrait pas au premier redémarrage, et un tempban qui ne se lève jamais est
// un ban définitif qui ment sur sa durée.

const SWEEP_TICK_MS = 60_000;
const SWEEP_BOOT_DELAY_MS = 45_000; // laisse le bot finir de se connecter
let sweepHandle = null;
let sweepBootHandle = null;

// Verrou de ré-entrance du balayage. Une levée de bannissement est un appel
// réseau : cinquante échéances tombées ensemble, sous limitation de débit, et un
// tour dépasse les 60 s du tick. Le tour suivant relirait alors les MÊMES lignes
// (supprimées seulement une fois la levée faite) : seconde tentative de
// débannissement, et surtout second message « Fin de bannissement temporaire »
// dans le salon de logs. Modèle : bot/modules/breach/index.js.
let sweeping = false;

function scheduleUnban(guildId, userId, durationMs, reason, source) {
    try {
        const db = getDb();
        const expiresAt = Math.floor((Date.now() + durationMs) / 1000);
        db.prepare(`
            INSERT INTO temp_bans (guild_id, user_id, expires_at, reason, source)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET
                expires_at = excluded.expires_at,
                reason = excluded.reason,
                source = excluded.source
        `).run(guildId, userId, expiresAt, reason, source);
    } catch (err) {
        console.error('[Quasar AutoMod] Échéance de bannissement temporaire non enregistrée :', err.message);
    }
}

/** Marque comme levée la dernière sanction de type ban encore active. */
function deactivateBanSanction(guildId, userId) {
    try {
        const db = getDb();
        db.prepare(`
            UPDATE sanctions SET active = 0
            WHERE id = (
                SELECT id FROM sanctions
                WHERE guild_id = ? AND user_id = ? AND type = 'ban' AND active = 1
                ORDER BY id DESC LIMIT 1
            )
        `).run(guildId, userId);
    } catch (err) {
        console.error('[Quasar AutoMod] Sanction de ban non désactivée :', err.message);
    }
}

/**
 * Lève un bannissement temporaire par le client REST normalisé.
 *
 * @returns {Promise<'fait'|'reessayer'|'abandon'>}
 *   'fait'      — levé, ou déjà levé à la main (10026) : on continue vers le log ;
 *   'reessayer' — permission manquante, l'échéance est gardée pour le tour suivant ;
 *   'abandon'   — bot retiré du serveur (10004) : échéance oubliée, sans log.
 */
async function leverBanNeutre(portee, row) {
    try {
        await portee.api.debannirMembre(row.guild_id, row.user_id, 'Fin du bannissement temporaire');
        return 'fait';
    } catch (err) {
        // L'erreur vient de `api.debannirMembre` : elle est donc marquée d'un
        // code neutre, et on raisonne dessus plutôt que sur un numéro Discord
        // qui ne voudra rien dire sur Fluxer.
        switch (codeNeutre(err)) {
            // Plus aucun bannissement : quelqu'un a déjà levé la sanction à la
            // main. C'est un succès, pas un échec.
            case CODES_NEUTRES.deja_fait:
                return 'fait';
            // Le bot n'est plus sur ce serveur : équivalent neutre du « absent
            // du cache » de la voie historique, qui oublie l'échéance sans rien
            // journaliser.
            case CODES_NEUTRES.guilde_inconnue:
                return 'abandon';
            default:
                break;
        }
        console.error(`[Quasar AutoMod] Levée du ban de ${row.user_id} en échec :`, describeError(err));
        // Permission manquante : on garde l'échéance pour retenter au prochain
        // passage, une fois les droits rétablis.
        if (codeNeutre(err) === CODES_NEUTRES.permission) return 'reessayer';
        return 'fait';
    }
}

/**
 * @param {object} cible  adaptateur de plateforme (voie neutre), ou `Client`
 *   discord.js (voie historique).
 */
async function sweepExpiredBans(cible) {
    // Verrou de ré-entrance : un tour qui déborde ne doit pas être doublé par le
    // suivant. Le tour en cours traitera toute la file.
    if (sweeping) return;
    sweeping = true;
    try {
        const portee = resoudrePorteeNeutre(cible);

        // Connexion incomplète : il faut pouvoir la distinguer d'un bot sans
        // serveur, parce que la branche « serveur introuvable » ci-dessous
        // SUPPRIME l'échéance — ce qui transformerait un bannissement temporaire
        // en bannissement définitif. Côté neutre, le signal est l'identité du
        // bot, que l'adaptateur ne renseigne qu'une fois connecté (DA §4.1) ;
        // côté historique, c'est le cache de serveurs.
        if (portee) {
            if (!portee.moiId) return;
        } else if (!cible?.guilds?.cache || cible.guilds.cache.size === 0) {
            return;
        }

        let due;
        try {
            const db = getDb();
            due = db.prepare('SELECT * FROM temp_bans WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 50')
                .all(Math.floor(Date.now() / 1000));
        } catch (err) {
            console.error('[Quasar AutoMod] Lecture des bannissements temporaires en échec :', err.message);
            return;
        }
        if (!due.length) return;

        const db = getDb();
        const forget = db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?');

        for (const row of due) {
            // Cible de journalisation du tour : la portée du serveur concerné
            // côté neutre, la guilde discord.js côté historique.
            let cibleLog;

            if (portee) {
                // Portée reconstruite explicitement, et non copiée depuis la
                // source : un `ctx` porte un accesseur `db` qu'une recopie par
                // décomposition déclencherait — donc ouvrirait la base — pour
                // rien. Le journal n'a besoin que du serveur et du client REST.
                cibleLog = { guildeId: row.guild_id, api: portee.api, moiId: portee.moiId };
                const issue = await leverBanNeutre(portee, row);
                if (issue === 'reessayer') continue;
                if (issue === 'abandon') {
                    forget.run(row.guild_id, row.user_id);
                    continue;
                }
            } else {
                // TRANSITION : format historique, à retirer au lot de consolidation
                const guild = cible.guilds.cache.get(row.guild_id);
                if (!guild) {
                    // Bot retiré du serveur : plus rien à lever, et garder l'échéance
                    // ferait retenter indéfiniment.
                    forget.run(row.guild_id, row.user_id);
                    continue;
                }
                cibleLog = guild;

                try {
                    await guild.bans.remove(row.user_id, 'Fin du bannissement temporaire');
                } catch (err) {
                    // 10026 = plus aucun bannissement : quelqu'un a déjà levé la sanction
                    // à la main. C'est un succès, pas un échec.
                    if (err?.code !== 10026) {
                        console.error(`[Quasar AutoMod] Levée du ban de ${row.user_id} en échec :`, describeError(err));
                        // Permission manquante : on garde l'échéance pour retenter au
                        // prochain passage, une fois les droits rétablis.
                        if (err?.code === 50013) continue;
                    }
                }
            }

            // ─── ORDRE DES ÉCRITURES ────────────────────────────────────────
            // L'échéance est supprimée AVANT le message de log : un SIGTERM entre
            // les deux fait perdre une ligne de log, jamais l'inverse (un second
            // « Fin de bannissement temporaire » posté au redémarrage).
            //
            // L'ordre inverse — supprimer avant l'appel à Discord — n'est PAS
            // retenu : le processus mourrait alors entre la suppression et le
            // débannissement, et la sanction temporaire deviendrait définitive
            // sans que rien ne le rattrape. Le débannissement reste donc en
            // « au moins une fois ». Fenêtre résiduelle : mourir entre le
            // débannissement réussi et la suppression de la ligne fait reposter le
            // message de fin au redémarrage (le débannissement, lui, est
            // idempotent — code 10026). La fermer demanderait une colonne d'état
            // sur temp_bans, donc une migration : voir le rapport.
            forget.run(row.guild_id, row.user_id);
            deactivateBanSanction(row.guild_id, row.user_id);

            await sendAutomodLog(cibleLog, logEmbedPour(portee, {
                title: '🔓 Fin de bannissement temporaire',
                color: 0x2ecc71,
                targetId: row.user_id,
                reason: row.reason || 'Bannissement temporaire arrivé à son terme',
                source: row.source,
            }), 'mod_ban', null);
        }
    } finally {
        // finally obligatoire : sans lui, une exception fige le balayage jusqu'au
        // prochain redémarrage, et les bannissements temporaires ne seraient plus
        // jamais levés.
        sweeping = false;
    }
}

/**
 * Démarre le balayage des bannissements temporaires arrivés à terme.
 * Idempotent : un second appel ne crée pas de seconde boucle.
 *
 * @param {object} cible  adaptateur de plateforme (`createBot()` le rend), ou
 *   `Client` discord.js tant que `bot/index.js` n'a pas basculé. La cible est
 *   transmise telle quelle à chaque tour : c'est `sweepExpiredBans` qui décide.
 */
function startTempBanSweeper(cible) {
    if (sweepHandle) return;
    const run = () => { sweepExpiredBans(cible).catch(() => {}); };
    sweepBootHandle = setTimeout(run, SWEEP_BOOT_DELAY_MS);
    sweepHandle = setInterval(run, SWEEP_TICK_MS);
    if (sweepBootHandle.unref) sweepBootHandle.unref();
    if (sweepHandle.unref) sweepHandle.unref();
    console.log('[Quasar AutoMod] Balayage des bannissements temporaires démarré (tick 60 s).');
}

/**
 * Arrête le balayage. Symétrique de `startTempBanSweeper`, idempotent.
 *
 * Les deux timers sont `unref()`, donc ils ne retiennent pas le processus : ce
 * qu'on ferme ici, c'est la possibilité qu'un tour parte PENDANT le drainage,
 * après la fermeture de la base. Aujourd'hui l'erreur qui en résulterait serait
 * avalée et le processus sortirait juste après — autrement dit ça tient par
 * chance, pas par conception. Un arrêt ordonné n'a pas à reposer sur la chance.
 */
function stopTempBanSweeper() {
    if (sweepBootHandle) { clearTimeout(sweepBootHandle); sweepBootHandle = null; }
    if (sweepHandle) { clearInterval(sweepHandle); sweepHandle = null; }
}

module.exports = {
    parseDuration,
    formatDuration,
    parsePunishments,
    validatePunishments,
    stringifyPunishments,
    applyPunishments,
    sendAutomodLog,
    // Exportés pour le lot 1 (modération) et pour les tests : la construction
    // d'un embed de log et le contrôle « cible hors d'atteinte » sont les deux
    // morceaux que les commandes manuelles réimplémentaient jusqu'ici.
    buildLogEmbed,
    unreachableTarget,
    startTempBanSweeper,
    stopTempBanSweeper,
    // Exporté pour permettre une levée immédiate des bannissements échus, sans
    // attendre le prochain tour de boucle (tests, opération manuelle).
    sweepExpiredBans,
    ACTION_NAMES,
    SOURCES,
    SOURCE_LABELS,
    MAX_TIMEOUT_MS,
};
