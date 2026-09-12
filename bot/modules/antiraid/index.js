// ═══════════════════════════════════════════════════════════════
//  Anti-raid sur les arrivées
//
//  Le seul module de modération automatique de Quasar qui soit vraiment
//  maison. L'AutoMod natif de Discord couvre le spam, les liens, les mots-clés
//  et les mentions en masse ; il ne sait rien de la VAGUE D'ARRIVÉES. C'est ce
//  manque, et rien d'autre, que ce module comble.
//
//  ─── Ce que ce module ne prétend pas être ───
//  Il fait de la détection de seuil, honnête et réglable. Pas de la détection
//  « intelligente ». Distinguer un raid d'un pic de popularité demande un
//  corpus inter-serveurs : Quasar est auto-hébergeable, chaque instance est
//  isolée, ce corpus n'existera jamais. Promettre mieux serait mentir, et un
//  faux positif ici coûte des expulsions de personnes légitimes — d'où des
//  défauts inoffensifs (module désactivé, aucune sanction) et une interface qui
//  dit franchement comment régler le seuil.
//
//  ─── Deux signaux, deux logiques ───
//   • LA VAGUE : N arrivées en X secondes (window.js). Quand elle est détectée,
//     c'est TOUTE la fenêtre qui est sanctionnée, pas seulement la dernière
//     personne arrivée — sinon N-1 comptes du raid passent.
//   • L'ÂGE DU COMPTE : le signal le plus fiable dont on dispose sans corpus
//     externe. Individuel, il ne dépend d'aucune vague.
//  La vague l'emporte quand les deux se présentent : son lot de sanctions
//  contient déjà l'arrivant, le punir une seconde fois pour son âge de compte
//  produirait deux sanctions pour une seule arrivée.
//
//  ─── Invariants ───
//   1. NE JAMAIS LEVER. Cette évaluation s'insère dans `guildMemberAdd`, juste
//      avant le message de bienvenue et les autorôles. Une erreur d'anti-raid
//      ne doit jamais empêcher un serveur de souhaiter la bienvenue.
//   2. NE RIEN COÛTER QUAND C'EST CALME. Le cas courant — module désactivé —
//      doit sortir sur une lecture de cache mémoire, sans requête.
//   3. NE JAMAIS AGIR SUR UNE CONFIGURATION QU'ON NE COMPREND PAS. Seuil hors
//      bornes, sanctions illisibles : j'alerte et je m'abstiens.
//
//  ─── Migration multiplateforme : PARTIELLE, et ce qui la bloque ────────────
//
//  Les embeds sont neutres et `discord.js` n'est plus importé ici. Le module
//  reste pourtant nourri d'objets discord.js (`member`, `member.guild`), et
//  `handleMemberJoin` GARDE sa signature historique, pour trois manques du
//  contrat neutre qui ne se contournent pas :
//
//   1. DATE DE CRÉATION DU COMPTE. `handleAccountAge` lit
//      `member.user.createdTimestamp`. Le membre normalisé porte `rejointLe`
//      (arrivée sur le serveur) mais pas la création du compte, et la déduire du
//      snowflake exigerait l'époque de la plateforme — donc de connaître la
//      plateforme. Sans ce champ, la moitié « âge du compte » de l'anti-raid
//      disparaît en silence.
//   2. NOMBRE DE MEMBRES. `sendWaveAlert` affiche `guild.memberCount`. La guilde
//      normalisée ne le porte pas : l'alerte de vague perdrait ce repère.
//   3. MODE PANIQUE. `panic.enterPanic` a besoin d'écritures de serveur que le
//      client REST normalisé n'expose pas du tout (voir l'en-tête de panic.js).
//
//  ⚠️ CONSÉQUENCE POUR LE LOT « ACCUEIL » : `bot/events/guildMemberAdd.js`
//  appelle `handleMemberJoin(member)` avec un membre discord.js. Migrer cet
//  événement en `membreRejoint` lui ferait passer un membre NORMALISÉ, qui n'a
//  pas de `.guild` : `handleMemberJoin` sortirait alors sur `{ removed: false }`
//  à chaque arrivée, sans erreur ni journal — l'anti-raid s'éteindrait en
//  silence. Les deux migrations doivent être faites ENSEMBLE, une fois les trois
//  manques ci-dessus comblés.
// ═══════════════════════════════════════════════════════════════

const { embed } = require('../../platform/embed');
const { applyPunishments, sendAutomodLog, SOURCE_LABELS } = require('../../utils/punishments');
const { getConfig, invalidateConfig, LIMITS } = require('./config');
const { registerJoin, MAX_PUNISHED_PER_WAVE } = require('./window');
const panic = require('./panic');

const SOURCE = 'antiraid';

// Actions qui retirent la personne du serveur. Quand l'une d'elles a réussi,
// `guildMemberAdd` s'arrête là : souhaiter la bienvenue à quelqu'un qu'on vient
// d'expulser, et lui poser un autorôle au passage, n'aurait aucun sens.
const REMOVES_MEMBER = new Set(['kick', 'ban', 'tempban']);

// Une configuration cassée est signalée une fois par serveur et par démarrage,
// pas à chaque arrivée : pendant un raid, la console serait illisible et le
// message noyé.
const reportedProblems = new Set();

function reportProblems(guildId, problems) {
    if (reportedProblems.has(guildId)) return;
    reportedProblems.add(guildId);
    console.error(`[Quasar Anti-raid] Configuration inexploitable sur ${guildId} : ${problems.join(' ')}`);
}

// ─── Journalisation ─────────────────────────────────────────────────────────

function describeResults(results) {
    if (!results.length) return null;
    const deferred = results.find(r => r.action === 'defer' && r.ok);
    if (deferred) return deferred.note || 'Cas transmis au salon d\'arbitrage, aucune sanction appliquée.';

    const applied = results.filter(r => r.ok && !r.deferred).map(r => r.action);
    // Un échec bénin (messages privés fermés) est un choix de la personne
    // visée, pas un incident : le compter comme une panne ferait chercher un
    // problème qui n'existe pas.
    const failed = results.filter(r => !r.ok && !r.benign);

    const parts = [];
    if (applied.length) parts.push(`Appliqué : ${applied.join(', ')}.`);
    if (!applied.length) parts.push('Aucune sanction n\'a pu être appliquée.');
    for (const failure of failed) parts.push(`❌ ${failure.action} : ${failure.error}`);
    return parts.join(' ');
}

/**
 * Alerte de vague. Elle part MÊME en mode alerte seule : un module qui détecte
 * sans rien dire ne se distingue pas d'un module en panne.
 */
async function sendWaveAlert(guild, config, { size, punishedCount, outcome, panicResult }) {
    const champs = [
        { nom: 'Arrivées', valeur: `${size} en moins de ${config.windowSeconds} s`, enLigne: true },
        { nom: 'Déclencheur', valeur: SOURCE_LABELS[SOURCE], enLigne: true },
        // ⚠️ Manque du contrat : la guilde normalisée ne porte pas le nombre de
        // membres. C'est l'une des trois raisons pour lesquelles ce module reçoit
        // encore une guilde discord.js (cf. en-tête).
        { nom: 'Membres du serveur', valeur: `${guild.memberCount ?? '?'}`, enLigne: true },
    ];

    if (config.alertOnly) {
        champs.push({
            nom: 'Sanction',
            valeur: 'Aucune : ce serveur est réglé en alerte seule.',
        });
    } else {
        champs.push({
            nom: `Comptes traités (${punishedCount})`,
            valeur: outcome || 'Aucune sanction appliquée.',
        });
        if (size >= MAX_PUNISHED_PER_WAVE) {
            champs.push({
                nom: 'Plafond atteint',
                valeur: `Je sanctionne au plus ${MAX_PUNISHED_PER_WAVE} comptes par vague. `
                    + 'Au-delà, c\'est la mise en pause des invitations qui coupe la vague à la source.',
            });
        }
    }

    if (panicResult?.ok) {
        champs.push({ nom: 'Mode panique', valeur: `Activé, levée automatique <t:${panicResult.expiresAt}:R>.` });
    } else if (panicResult?.error) {
        champs.push({ nom: 'Mode panique', valeur: `❌ ${panicResult.error}` });
    } else if (panicResult?.skipped === 'disabled') {
        champs.push({ nom: 'Mode panique', valeur: 'Désactivé sur ce serveur (durée réglée à 0).' });
    }

    await sendAutomodLog(guild, embed({
        titre: '🚨 Vague d\'arrivées détectée',
        couleur: 0xe74c3c,
        champs,
        horodatage: true,
    }), 'mod_ban', config.logChannelId);
}

/** Alerte d'un compte trop récent, quand aucune sanction n'est configurée. */
async function sendAccountAgeAlert(guild, config, member, ageHours) {
    await sendAutomodLog(guild, embed({
        titre: '⚠️ Compte trop récent',
        couleur: 0xf1c40f,
        champs: [
            { nom: 'Membre', valeur: `<@${member.id}> (${member.id})`, enLigne: true },
            { nom: 'Déclencheur', valeur: SOURCE_LABELS[SOURCE], enLigne: true },
            { nom: 'Âge du compte', valeur: `${ageHours} h (minimum exigé : ${config.accountAgeHours} h)`, enLigne: true },
            { nom: 'Sanction', valeur: 'Aucune : ce serveur est réglé en alerte seule.' },
        ],
        horodatage: true,
    }), 'mod_warn', config.logChannelId);
}

// ─── Application ────────────────────────────────────────────────────────────

/**
 * Sanctionne une liste de membres, en série. Renvoie les résultats agrégés et
 * dit si le membre COURANT a été retiré du serveur.
 *
 * En série et pas en parallèle : discord.js sérialise déjà ses appels par
 * route, et lancer cent promesses d'un coup ne ferait qu'enfler la file
 * d'attente et la mémoire au moment exact où il faut être léger.
 */
async function punishBatch(batch, { guild, config, reason, currentMemberId }) {
    const results = [];
    let removedCurrent = false;

    for (const target of batch) {
        const outcome = await applyPunishments(config.punishments, {
            guild,
            member: target,
            // `userId` est toujours transmis : un compte de raid a souvent déjà
            // quitté le serveur quand la sanction tombe, et le socle sait encore
            // le bannir par son identifiant.
            userId: target?.id,
            reason,
            source: SOURCE,
            moderatorId: guild.client?.user?.id,
            logChannelId: config.logChannelId,
            responseMessage: config.responseMessage,
        });
        results.push(...outcome);

        if (target?.id === currentMemberId
            && outcome.some(r => r.ok && !r.deferred && REMOVES_MEMBER.has(r.action))) {
            removedCurrent = true;
        }
    }

    return { results, removedCurrent };
}

// ─── Point d'entrée ─────────────────────────────────────────────────────────

/**
 * Évalue une arrivée. Ne lève JAMAIS.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<{ removed: boolean }>} `removed` : le membre n'est plus sur
 *          le serveur du fait de l'anti-raid — l'événement `guildMemberAdd`
 *          s'arrête alors avant le message de bienvenue et les autorôles.
 */
async function handleMemberJoin(member) {
    try {
        const guild = member?.guild;
        if (!guild || !member.id) return { removed: false };

        // Un bot ne peut être ajouté que par quelqu'un ayant « Gérer le
        // serveur » : ce n'est pas une arrivée subie, et l'expulser à cause
        // d'une vague ou d'un âge de compte serait absurde. Il ne compte donc
        // pas non plus dans la fenêtre.
        if (member.user?.bot) return { removed: false };

        const config = getConfig(guild.id);
        if (!config || !config.enabled) return { removed: false };

        if (config.problems.length) {
            reportProblems(guild.id, config.problems);
            return { removed: false };
        }

        const now = Date.now();
        const wave = registerJoin(guild.id, member, { joinCount: config.joinCount, windowMs: config.windowMs }, now);

        if (wave.status === 'triggered') {
            return await handleWave(guild, config, member, wave);
        }
        if (wave.status === 'ongoing') {
            // La vague est déjà annoncée : on sanctionne l'arrivant sans
            // republier une alerte par personne.
            if (config.alertOnly) return { removed: false };
            const { removedCurrent } = await punishBatch(wave.batch, {
                guild, config, currentMemberId: member.id,
                reason: buildWaveReason(config),
            });
            return { removed: removedCurrent };
        }
        if (wave.status === 'saturated') {
            return { removed: false };
        }

        return await handleAccountAge(guild, config, member, now);
    } catch (err) {
        // Filet ultime. Une erreur d'anti-raid ne doit ni remonter en rejet non
        // capturé — l'API et le bot partagent le même processus — ni empêcher le
        // message de bienvenue de partir.
        console.error('[Quasar Anti-raid] Évaluation de l\'arrivée en échec :', err);
        return { removed: false };
    }
}

function buildWaveReason(config) {
    return `Anti-raid : ${config.joinCount} arrivées ou plus en moins de ${config.windowSeconds} secondes`;
}

async function handleWave(guild, config, member, wave) {
    const reason = buildWaveReason(config);

    let results = [];
    let removedCurrent = false;
    if (!config.alertOnly) {
        ({ results, removedCurrent } = await punishBatch(wave.batch, {
            guild, config, reason, currentMemberId: member.id,
        }));
    }

    // Le mode panique est posé APRÈS les sanctions du premier lot : les comptes
    // déjà entrés sont traités, et la mise en pause des invitations empêche les
    // suivants d'arriver. L'inverse laisserait le lot initial impuni le temps
    // d'un appel d'API.
    //
    // Il est volontairement INDÉPENDANT du mode alerte seule : c'est un geste
    // réversible sur le serveur, pas une sanction contre une personne, et c'est
    // souvent la seule mesure qu'un serveur veut au départ. Sa durée réglée à 0
    // le désactive.
    const panicResult = await panic.enterPanic(guild, {
        durationSeconds: config.panicSeconds,
        reason,
        triggeredBy: 'detection',
        logChannelId: config.logChannelId,
    }).catch(err => ({ ok: false, error: err?.message || 'Erreur inconnue.' }));

    await sendWaveAlert(guild, config, {
        size: wave.size,
        punishedCount: wave.batch.length,
        outcome: describeResults(results),
        panicResult,
    });

    return { removed: removedCurrent };
}

async function handleAccountAge(guild, config, member, now) {
    if (!config.minAccountAgeMs) return { removed: false };

    const createdAt = member.user?.createdTimestamp;
    // Horodatage absent (cache partiel, structure incomplète) : on ne devine
    // pas un âge, et surtout on ne sanctionne pas sur une supposition.
    if (!Number.isFinite(createdAt)) return { removed: false };

    const age = now - createdAt;
    if (age >= config.minAccountAgeMs) return { removed: false };

    const ageHours = Math.max(0, Math.floor(age / 3600000));
    const reason = `Anti-raid : compte créé il y a ${ageHours} h, minimum exigé ${config.accountAgeHours} h`;

    if (config.alertOnly) {
        await sendAccountAgeAlert(guild, config, member, ageHours);
        return { removed: false };
    }

    const { removedCurrent } = await punishBatch([member], {
        guild, config, reason, currentMemberId: member.id,
    });
    return { removed: removedCurrent };
}

module.exports = {
    handleMemberJoin,
    // Réexports : les autres couches (API, `ready` du bot) n'ont à connaître
    // qu'un seul module, pas l'organisation interne du dossier.
    getConfig,
    invalidateConfig,
    enterPanic: panic.enterPanic,
    liftPanic: panic.liftPanic,
    getPanicState: panic.getPanicState,
    sweepExpiredPanics: panic.sweepExpiredPanics,
    startPanicSweeper: panic.startPanicSweeper,
    LIMITS,
    MAX_PUNISHED_PER_WAVE,
    SOURCE,
};
