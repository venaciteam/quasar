// ═══════════════════════════════════════════════════════════════
//  Anti-raid — mode panique
//
//  Pendant quelques minutes, le serveur se ferme à l'arrivée, puis se rouvre
//  TOUT SEUL. Deux exigences dominent tout ce fichier : la posture doit être
//  parfaitement réversible, et sa levée doit survivre à un redémarrage du bot.
//
//  ─── Le mécanisme retenu : mettre les invitations en pause ───
//  Discord expose une action d'incident dédiée — `PUT /guilds/{id}/incident-actions`,
//  exposée par discord.js 14.26 sous `guild.setIncidentActions({ invitesDisabledUntil })`.
//  Elle a trois propriétés qu'aucune autre piste n'a réunies :
//   • Elle porte SA PROPRE ÉCHÉANCE, tenue par Discord (24 h au maximum). Même
//     si ce processus disparaissait définitivement, le serveur se rouvrirait.
//     C'est le meilleur filet possible pour un module dont le pire échec serait
//     un verrou oublié.
//   • Elle est strictement additive : rien n'est réécrit, aucune permission de
//     salon n'est touchée, les membres déjà présents ne voient aucune différence.
//   • Elle vise exactement le vecteur d'un raid — le lien d'invitation.
//
//  Repli : `guild.disableInvites(true)`, qui pose la fonction de serveur
//  INVITES_DISABLED. Même effet visible, mais SANS échéance : c'est le balayage
//  ci-dessous qui doit la retirer, d'où la persistance. Le repli n'est emprunté
//  que si l'action d'incident est refusée par l'API.
//
//  ─── Ce qui a été écarté, et pourquoi ───
//  • Élever le niveau de vérification (`guild.setVerificationLevel`) : ça
//    n'empêche personne d'entrer, ça empêche les nouveaux arrivants LÉGITIMES
//    de parler — la gêne est pour les mauvaises personnes. Et la restauration
//    est une écriture d'état que Discord peut refuser (un serveur Communauté
//    impose un niveau minimum) : une levée ratée laisserait un réglage de
//    serveur modifié à l'insu de son administration.
//  • Modifier en masse les permissions de salons : destructif, difficile à
//    annuler fidèlement, et une levée partielle laisse un serveur cassé.
//    Explicitement hors de question.
//
//  ─── L'état d'origine est mémorisé ───
//  Si les invitations étaient DÉJÀ en pause avant mon intervention, la levée ne
//  les rouvre pas : ce n'était pas ma décision, ce n'est pas à moi de la défaire.
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, PermissionFlagsBits, GuildFeature } = require('discord.js');
const { getDb } = require('../../../api/services/database');
const { sendAutomodLog, formatDuration } = require('../../utils/punishments');

const METHOD_INCIDENT_ACTIONS = 'incident_actions';
const METHOD_INVITES_DISABLED = 'invites_disabled';

// Cadence du balayage. Plus serrée que celle des bannissements temporaires
// (60 s) : un mode panique peut durer 30 secondes, une minute de retard à la
// levée y serait une minute de trop.
const SWEEP_TICK_MS = 15_000;
// Le balayage démarre vite après le `ready` : un mode panique dont l'échéance
// est passée pendant l'arrêt du bot doit être levé sans attendre.
const SWEEP_BOOT_DELAY_MS = 10_000;

let sweepHandle = null;
let sweepBootHandle = null;

// ─── Persistance ────────────────────────────────────────────────────────────

/** Ligne de mode panique d'un serveur, ou null. Ne lève jamais. */
function getPanicRow(guildId) {
    try {
        return getDb().prepare('SELECT * FROM antiraid_panic WHERE guild_id = ?').get(guildId) || null;
    } catch (err) {
        console.error('[Quasar Anti-raid] Lecture du mode panique en échec :', err.message);
        return null;
    }
}

/**
 * État du mode panique, tel que l'affiche le dashboard.
 * @returns {{ active: boolean, method: string|null, expiresAt: number|null,
 *             reason: string|null, triggeredBy: string|null, startedAt: number|null }}
 */
function getPanicState(guildId, now = Date.now()) {
    const row = getPanicRow(guildId);
    if (!row) return { active: false, method: null, expiresAt: null, reason: null, triggeredBy: null, startedAt: null };
    return {
        // Une échéance dépassée mais encore en base signifie « levée pas encore
        // balayée » : l'annoncer comme active serait mentir de quelques secondes.
        active: row.expires_at * 1000 > now,
        method: row.method,
        expiresAt: row.expires_at,
        reason: row.reason || null,
        triggeredBy: row.triggered_by || null,
        startedAt: row.created_at || null,
    };
}

function savePanicRow({ guildId, method, expiresAt, previousInvitesDisabled, reason, triggeredBy }) {
    getDb().prepare(`
        INSERT INTO antiraid_panic
            (guild_id, method, expires_at, previous_invites_disabled, reason, triggered_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            method = excluded.method,
            expires_at = excluded.expires_at,
            reason = excluded.reason,
            triggered_by = excluded.triggered_by
        -- previous_invites_disabled n'est VOLONTAIREMENT pas mis à jour :
        -- prolonger un mode panique ne doit pas enregistrer « les invitations
        -- étaient déjà en pause » — elles le sont parce que je viens de le faire.
    `).run(guildId, method, expiresAt, previousInvitesDisabled ? 1 : 0, reason || null, triggeredBy || null);
}

function forgetPanicRow(guildId) {
    try {
        getDb().prepare('DELETE FROM antiraid_panic WHERE guild_id = ?').run(guildId);
    } catch (err) {
        console.error('[Quasar Anti-raid] Suppression de l\'état de panique en échec :', err.message);
    }
}

// ─── Lecture de l'état Discord ──────────────────────────────────────────────

/**
 * Les invitations du serveur sont-elles déjà fermées, indépendamment de moi ?
 * Deux mécanismes coexistent chez Discord et doivent tous deux être consultés :
 * la fonction de serveur (permanente) et l'action d'incident (temporaire).
 */
function invitesAlreadyPaused(guild, now = Date.now()) {
    if (Array.isArray(guild?.features) && guild.features.includes(GuildFeature.InvitesDisabled)) return true;
    const until = guild?.incidentsData?.invitesDisabledUntil;
    return !!until && new Date(until).getTime() > now;
}

function canManageGuild(guild) {
    return !!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

// ─── Pose ───────────────────────────────────────────────────────────────────

/**
 * Bascule le serveur en mode panique jusqu'à `durationSeconds`.
 * Ne lève jamais.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object}  options
 * @param {number}  options.durationSeconds — 0 : le mode panique est désactivé
 * @param {string}  options.reason
 * @param {string}  [options.triggeredBy]   — 'detection' ou un identifiant Discord
 * @param {string}  [options.logChannelId]
 * @returns {Promise<{ ok: boolean, skipped?: string, method?: string,
 *                     expiresAt?: number, extended?: boolean, error?: string }>}
 */
async function enterPanic(guild, { durationSeconds, reason, triggeredBy = 'detection', logChannelId = null } = {}) {
    if (!guild) return { ok: false, error: 'Serveur indisponible.' };

    const seconds = Number(durationSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, skipped: 'disabled' };
    }
    if (!canManageGuild(guild)) {
        return { ok: false, error: 'Permission « Gérer le serveur » manquante : je ne peux pas mettre les invitations en pause.' };
    }

    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + Math.floor(seconds);
    const existing = getPanicRow(guild.id);
    const extended = !!existing && existing.expires_at * 1000 > now;

    // L'état d'origine n'est relevé qu'à la PREMIÈRE pose. Le relire pendant une
    // prolongation retiendrait l'état que je viens moi-même d'installer, et la
    // levée ne rouvrirait alors jamais les invitations.
    const previousInvitesDisabled = existing
        ? !!existing.previous_invites_disabled
        : invitesAlreadyPaused(guild, now);

    let method = null;
    let apiError = null;

    try {
        await guild.setIncidentActions({ invitesDisabledUntil: new Date(expiresAt * 1000) });
        method = METHOD_INCIDENT_ACTIONS;
    } catch (err) {
        apiError = err;
    }

    if (!method) {
        // Repli. Il n'a pas d'échéance côté Discord : c'est le balayage qui la
        // tiendra, et c'est précisément pour ce cas que l'état est persisté.
        try {
            await guild.disableInvites(true);
            method = METHOD_INVITES_DISABLED;
            console.warn('[Quasar Anti-raid] Action d\'incident refusée, repli sur INVITES_DISABLED :',
                apiError?.message || apiError);
        } catch (err) {
            return {
                ok: false,
                error: `Les invitations n'ont pas pu être mises en pause : ${err?.message || 'erreur inconnue'}.`,
            };
        }
    }

    try {
        savePanicRow({
            guildId: guild.id, method, expiresAt,
            previousInvitesDisabled, reason, triggeredBy,
        });
    } catch (err) {
        // La posture est posée sur Discord mais l'échéance n'a pas pu être
        // écrite : avec la méthode native, Discord lèvera quand même. Avec le
        // repli, personne ne lèvera — on annule immédiatement plutôt que de
        // laisser un verrou sans horloge.
        console.error('[Quasar Anti-raid] Échéance de mode panique non enregistrée :', err.message);
        if (method === METHOD_INVITES_DISABLED && !previousInvitesDisabled) {
            await guild.disableInvites(false).catch(() => {});
            return { ok: false, error: 'L\'échéance du mode panique n\'a pas pu être enregistrée : rien n\'a été appliqué.' };
        }
    }

    await sendPanicLog(guild, {
        entering: true, method, expiresAt, reason, triggeredBy, extended,
        durationSeconds: seconds, logChannelId,
    });

    return { ok: true, method, expiresAt, extended };
}

// ─── Levée ──────────────────────────────────────────────────────────────────

/**
 * Rend au serveur son état d'avant le mode panique.
 * Ne lève jamais.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} [options]
 * @param {object} [options.row]        — ligne déjà lue (évite un SELECT au balayage)
 * @param {string} [options.liftedBy]   — identifiant Discord, pour une levée manuelle
 * @param {string} [options.logChannelId]
 * @returns {Promise<{ ok: boolean, skipped?: string, retry?: boolean, error?: string }>}
 */
async function liftPanic(guild, { row = null, liftedBy = null, logChannelId = null } = {}) {
    if (!guild) return { ok: false, error: 'Serveur indisponible.' };

    const state = row || getPanicRow(guild.id);
    if (!state) return { ok: false, skipped: 'not_active' };

    // Les invitations étaient déjà en pause avant mon intervention : je retire
    // mon échéance, pas la décision de quelqu'un d'autre.
    if (state.previous_invites_disabled) {
        forgetPanicRow(guild.id);
        await sendPanicLog(guild, { entering: false, method: state.method, liftedBy, restoredNothing: true, logChannelId });
        return { ok: true };
    }

    try {
        if (state.method === METHOD_INVITES_DISABLED) {
            await guild.disableInvites(false);
        } else {
            await guild.setIncidentActions({ invitesDisabledUntil: null });
        }
    } catch (err) {
        // Le repli n'a pas d'échéance côté Discord : tant qu'il n'est pas levé,
        // le serveur reste fermé. On garde la ligne et on retentera — c'est la
        // même règle que la levée des bannissements temporaires.
        if (state.method === METHOD_INVITES_DISABLED) {
            console.error('[Quasar Anti-raid] Levée du mode panique en échec, nouvelle tentative au prochain passage :', err?.message);
            return { ok: false, retry: true, error: err?.message || 'Erreur inconnue.' };
        }
        // Méthode native : l'échéance est tenue par Discord, le serveur est déjà
        // rouvert ou le sera à la seconde près. Insister n'apporterait rien.
        console.error('[Quasar Anti-raid] Retrait de l\'action d\'incident en échec (sans conséquence, Discord tient l\'échéance) :', err?.message);
    }

    forgetPanicRow(guild.id);
    await sendPanicLog(guild, { entering: false, method: state.method, liftedBy, logChannelId });
    return { ok: true };
}

// ─── Journalisation ─────────────────────────────────────────────────────────

const METHOD_LABELS = {
    [METHOD_INCIDENT_ACTIONS]: 'invitations mises en pause (action d\'incident Discord)',
    [METHOD_INVITES_DISABLED]: 'invitations désactivées (fonction de serveur)',
};

async function sendPanicLog(guild, opts) {
    const {
        entering, method, expiresAt, reason, triggeredBy, extended,
        durationSeconds, liftedBy, restoredNothing, logChannelId,
    } = opts;

    const embed = new EmbedBuilder()
        .setColor(entering ? 0xe74c3c : 0x2ecc71)
        .setTitle(entering
            ? (extended ? '🚨 Mode panique prolongé' : '🚨 Mode panique activé')
            : '✅ Mode panique levé')
        .setTimestamp();

    if (entering) {
        embed.addFields(
            { name: 'Mesure', value: METHOD_LABELS[method] || method, inline: false },
            { name: 'Durée', value: formatDuration(durationSeconds * 1000), inline: true },
            { name: 'Levée automatique', value: `<t:${expiresAt}:R>`, inline: true },
            {
                name: 'Déclenchement',
                value: triggeredBy && triggeredBy !== 'detection' ? `<@${triggeredBy}>` : 'Détection automatique',
                inline: true,
            },
            { name: 'Motif', value: (reason || 'Vague d\'arrivées détectée').slice(0, 1024) }
        );
    } else {
        embed.addFields(
            {
                name: 'Levée',
                value: liftedBy ? `Manuelle, par <@${liftedBy}>` : 'Automatique, à l\'échéance',
                inline: true,
            },
            {
                name: 'Invitations',
                value: restoredNothing
                    ? 'Laissées en pause : elles l\'étaient déjà avant le mode panique.'
                    : 'Rouvertes.',
            }
        );
    }

    await sendAutomodLog(guild, embed, 'mod_ban', logChannelId);
}

// ─── Balayage ───────────────────────────────────────────────────────────────

/**
 * Lève les modes panique arrivés à terme.
 * Exporté pour permettre une levée immédiate sans attendre le tour de boucle
 * (tests, opération manuelle).
 */
async function sweepExpiredPanics(client, now = Date.now()) {
    let due;
    try {
        due = getDb()
            .prepare('SELECT * FROM antiraid_panic WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT 50')
            .all(Math.floor(now / 1000));
    } catch (err) {
        console.error('[Quasar Anti-raid] Lecture des modes panique en échec :', err.message);
        return 0;
    }
    if (!due.length) return 0;

    let lifted = 0;
    for (const row of due) {
        const guild = client?.guilds?.cache?.get(row.guild_id);
        if (!guild) {
            // Bot retiré du serveur : il n'y a plus rien à lever, et garder
            // l'échéance ferait retenter indéfiniment.
            forgetPanicRow(row.guild_id);
            continue;
        }
        const result = await liftPanic(guild, { row }).catch(err => {
            console.error('[Quasar Anti-raid] Levée du mode panique en échec :', err?.message);
            return { ok: false, retry: true };
        });
        if (result.ok) lifted += 1;
    }
    return lifted;
}

/**
 * Démarre le balayage des modes panique arrivés à terme, et le ménage de la
 * fenêtre glissante. Idempotent : un second appel ne crée pas de seconde boucle.
 */
function startPanicSweeper(client) {
    if (sweepHandle) return;
    const { sweepIdle } = require('./window');

    const run = () => {
        sweepExpiredPanics(client).catch(() => {});
        // Le même tour de boucle sert au ménage mémoire : une entrée de plus
        // dans un setInterval déjà en place ne coûte rien, un second timer si.
        try { sweepIdle(); } catch { /* le ménage n'est jamais critique */ }
    };

    sweepBootHandle = setTimeout(run, SWEEP_BOOT_DELAY_MS);
    sweepHandle = setInterval(run, SWEEP_TICK_MS);
    if (sweepBootHandle.unref) sweepBootHandle.unref();
    if (sweepHandle.unref) sweepHandle.unref();
    console.log('[Quasar Anti-raid] Balayage des modes panique démarré (tick 15 s).');
}

module.exports = {
    enterPanic,
    liftPanic,
    getPanicState,
    sweepExpiredPanics,
    startPanicSweeper,
};
