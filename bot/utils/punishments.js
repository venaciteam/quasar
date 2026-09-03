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
// ═══════════════════════════════════════════════════════════════

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { sendModLog } = require('./modlog');

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
 */
async function sendAutomodLog(guild, embed, logType, logChannelId) {
    if (!guild) return;
    if (logChannelId) {
        const channel = guild.channels?.cache?.get(String(logChannelId));
        if (channel) {
            const sent = await channel.send({ embeds: [embed] }).catch(err => {
                console.error(`[Quasar AutoMod] Log ${logType} vers ${logChannelId} en échec :`, err.message);
                return null;
            });
            if (sent) return;
        }
        // Salon supprimé ou inaccessible : on ne perd pas le log, on retombe sur
        // le modlog global plutôt que de laisser la sanction sans trace.
    }
    await sendModLog(guild, embed, logType).catch(() => {});
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

function buildLogEmbed({ title, color, targetId, reason, source, extra }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .addFields(
            { name: 'Membre', value: targetId ? `<@${targetId}> (${targetId})` : 'Inconnu', inline: true },
            { name: 'Déclencheur', value: SOURCE_LABELS[source] || 'Modération automatique', inline: true },
            { name: 'Raison', value: (reason || 'Aucune raison précisée').slice(0, 1024) }
        )
        .setTimestamp();
    if (extra) embed.addFields({ name: extra.name, value: extra.value, inline: true });
    return embed;
}

// ─── Application ───────────────────────────────────────────────────────────

/**
 * Traduit une erreur d'API Discord en phrase exploitable. Sans ça, un résultat
 * dit « DiscordAPIError[50013] » à une personne qui cherche pourquoi son
 * anti-raid ne fait rien.
 */
function describeError(err) {
    const code = err?.code;
    if (code === 50013) return 'Permission manquante côté bot.';
    if (code === 50001) return 'Accès refusé au salon ou au membre.';
    if (code === 10007) return 'Ce membre n\'est plus sur le serveur.';
    if (code === 10008) return 'Le message n\'existe plus.';
    if (code === 10026) return 'Aucun bannissement en cours pour ce membre.';
    if (code === 30035) return 'Limite de bannissements atteinte pour ce serveur.';
    return err?.message || 'Erreur inconnue.';
}

/**
 * Le membre est-il hors d'atteinte pour une raison structurelle (et pas
 * seulement pour l'action demandée) ? Ces trois cas rendent TOUTE sanction
 * impossible ou dangereuse, et ne dépendent pas de l'action.
 * @returns {string|null} raison du refus, ou null si la cible est sanctionnable.
 */
function unreachableTarget(guild, targetId) {
    if (!targetId) return 'Cible inconnue.';
    if (guild.ownerId && targetId === guild.ownerId) return 'Le propriétaire du serveur ne peut pas être sanctionné.';
    if (guild.client?.user?.id && targetId === guild.client.user.id) return 'Je ne me sanctionne pas moi-même.';
    return null;
}

/**
 * Applique une suite de punitions à une cible. Ne lève jamais.
 *
 * @param {Array|string} punishments — sortie de parsePunishments(), ou
 *        directement la chaîne de configuration (parsée ici dans ce cas).
 * @param {object} ctx
 * @param {import('discord.js').Guild}  ctx.guild        — obligatoire
 * @param {import('discord.js').GuildMember|null} ctx.member — peut être null
 *        (membre déjà parti) : les actions qui l'exigent sont alors écartées.
 * @param {import('discord.js').Message} [ctx.message]   — requis par `delete`
 * @param {string} [ctx.userId]        — identifiant de la cible quand `member`
 *        est null (permet de bannir quelqu'un qui vient de partir)
 * @param {string}  ctx.reason
 * @param {string}  ctx.source         — 'automod' | 'escalation' | 'antiraid' | 'honeypot'
 * @param {string}  ctx.moderatorId    — identifiant du bot pour une action automatique
 * @param {string}  [ctx.logChannelId] — salon de log dédié de la règle
 * @param {string}  [ctx.responseMessage] — texte du MP de l'action `dm`
 * @returns {Promise<Array<{action: string, ok: boolean, error?: string, note?: string}>>}
 */
async function applyPunishments(punishments, ctx = {}) {
    const list = Array.isArray(punishments)
        ? punishments
        : parsePunishments(punishments).punishments;

    if (!list.length) return [];

    const guild = ctx.guild;
    if (!guild) {
        return list.map(p => ({ action: p.action, ok: false, error: 'Serveur indisponible.' }));
    }

    const member = ctx.member || null;
    const targetId = member?.id || ctx.userId || ctx.message?.author?.id || null;
    const reason = ctx.reason || 'Modération automatique';
    const source = SOURCES.includes(ctx.source) ? ctx.source : 'automod';
    const moderatorId = ctx.moderatorId || guild.client?.user?.id || 'system';

    // ─── `defer` court-circuite tout le reste ───
    // Écrire « tempmute 20m, defer », c'est demander qu'une personne tranche
    // AVANT que le mute ne tombe. Appliquer le mute puis ouvrir un arbitrage sur
    // le même cas viderait l'arbitrage de son sens : les autres actions
    // deviennent la proposition soumise au salon d'arbitrage.
    if (list.some(p => p.action === 'defer') && ctx.allowDefer !== false) {
        const proposed = list.filter(p => p.action !== 'defer');
        const { sendDeferCase } = require('../modules/defer');
        const outcome = await sendDeferCase(guild, {
            targetUserId: targetId,
            source,
            reason,
            proposedPunishments: stringifyPunishments(proposed),
            evidence: ctx.evidence,
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

    const blocked = unreachableTarget(guild, targetId);
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
                guild, member, targetId, reason, source, moderatorId,
                message: ctx.message,
                logChannelId: ctx.logChannelId,
                responseMessage: ctx.responseMessage,
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

async function applyOne(action, durationMs, state) {
    const { guild, member, targetId, reason, source, moderatorId, logChannelId } = state;

    switch (action) {
        case 'delete': {
            if (!state.message) return { action, ok: false, error: 'Aucun message à supprimer.' };
            try {
                await state.message.delete();
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }
            await sendAutomodLog(guild, buildLogEmbed({
                title: '🗑️ Message supprimé automatiquement',
                color: 0x95a5a6,
                targetId, reason, source,
                extra: { name: 'Salon', value: `<#${state.message.channelId}>` },
            }), 'mod_clear', logChannelId);
            return { action, ok: true };
        }

        case 'warn': {
            const id = recordSanction({ guildId: guild.id, userId: targetId, moderatorId, type: 'warn', reason });
            await sendAutomodLog(guild, buildLogEmbed({
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
            if (!member.moderatable) {
                return { action, ok: false, error: 'Hiérarchie des rôles ou permission « Exclure temporairement » manquante.' };
            }

            const asked = action === 'mute' ? MAX_TIMEOUT_MS : durationMs;
            const applied = Math.min(asked, MAX_TIMEOUT_MS);
            let note;
            if (action === 'mute') {
                note = 'Exclusion appliquée au maximum autorisé par Discord (28 jours).';
            } else if (applied < asked) {
                note = `Durée tronquée à 28 jours (plafond de l'API Discord) au lieu de ${formatDuration(asked)}.`;
            }

            try {
                await member.timeout(applied, reason);
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }

            recordSanction({
                guildId: guild.id, userId: targetId, moderatorId,
                type: 'mute', reason, duration: formatDuration(applied),
            });
            await sendAutomodLog(guild, buildLogEmbed({
                title: '🔇 Exclusion temporaire automatique',
                color: 0xe67e22,
                targetId, reason, source,
                extra: { name: 'Durée', value: formatDuration(applied) },
            }), 'mod_mute', logChannelId);
            return note ? { action, ok: true, note } : { action, ok: true };
        }

        case 'kick': {
            if (!member) return { action, ok: false, error: 'Ce membre n\'est plus sur le serveur.' };
            if (!member.kickable) {
                return { action, ok: false, error: 'Hiérarchie des rôles ou permission « Expulser des membres » manquante.' };
            }
            try {
                await member.kick(reason);
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }
            recordSanction({ guildId: guild.id, userId: targetId, moderatorId, type: 'kick', reason });
            await sendAutomodLog(guild, buildLogEmbed({
                title: '🔴 Expulsion automatique',
                color: 0xe67e22,
                targetId, reason, source,
            }), 'mod_kick', logChannelId);
            return { action, ok: true };
        }

        case 'tempban':
        case 'ban': {
            // Un membre déjà parti reste bannissable par son identifiant : c'est
            // même le cas le plus fréquent en anti-raid.
            if (member && !member.bannable) {
                return { action, ok: false, error: 'Hiérarchie des rôles ou permission « Bannir des membres » manquante.' };
            }
            if (!guild.members.me?.permissions?.has(PermissionFlagsBits.BanMembers)) {
                return { action, ok: false, error: 'Permission « Bannir des membres » manquante.' };
            }
            try {
                await guild.members.ban(targetId, { reason });
            } catch (err) {
                return { action, ok: false, error: describeError(err) };
            }

            const duration = action === 'tempban' ? formatDuration(durationMs) : null;
            recordSanction({ guildId: guild.id, userId: targetId, moderatorId, type: 'ban', reason, duration });

            if (action === 'tempban') {
                scheduleUnban(guild.id, targetId, durationMs, reason, source);
            }

            await sendAutomodLog(guild, buildLogEmbed({
                title: action === 'tempban' ? '🔨 Bannissement temporaire automatique' : '🔨 Bannissement automatique',
                color: 0xe74c3c,
                targetId, reason, source,
                extra: duration ? { name: 'Durée', value: duration } : null,
            }), 'mod_ban', logChannelId);
            return { action, ok: true };
        }

        case 'dm': {
            const user = member?.user || (targetId ? await guild.client.users.fetch(targetId).catch(() => null) : null);
            if (!user) return { action, ok: false, error: 'Destinataire introuvable.', benign: true };
            const text = state.responseMessage
                || `Une règle de modération automatique de **${guild.name}** vient de s'appliquer à votre message ou à votre compte.\nMotif : ${reason}`;
            try {
                await user.send({ content: String(text).slice(0, 2000) });
            } catch (err) {
                // Messages privés fermés : c'est un choix de la personne, pas une
                // panne. Rapporté, mais marqué comme bénin pour que les modules
                // n'en fassent pas une alerte.
                return { action, ok: false, error: describeError(err), benign: true };
            }
            return { action, ok: true };
        }

        case 'defer':
            // Atteignable uniquement via ctx.allowDefer === false, c'est-à-dire
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

async function sweepExpiredBans(client) {
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
        const guild = client.guilds.cache.get(row.guild_id);
        if (!guild) {
            // Bot retiré du serveur : plus rien à lever, et garder l'échéance
            // ferait retenter indéfiniment.
            forget.run(row.guild_id, row.user_id);
            continue;
        }

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

        forget.run(row.guild_id, row.user_id);
        deactivateBanSanction(row.guild_id, row.user_id);

        await sendAutomodLog(guild, buildLogEmbed({
            title: '🔓 Fin de bannissement temporaire',
            color: 0x2ecc71,
            targetId: row.user_id,
            reason: row.reason || 'Bannissement temporaire arrivé à son terme',
            source: row.source,
        }), 'mod_ban', null);
    }
}

/**
 * Démarre le balayage des bannissements temporaires arrivés à terme.
 * Idempotent : un second appel ne crée pas de seconde boucle.
 */
function startTempBanSweeper(client) {
    if (sweepHandle) return;
    const run = () => { sweepExpiredBans(client).catch(() => {}); };
    sweepBootHandle = setTimeout(run, SWEEP_BOOT_DELAY_MS);
    sweepHandle = setInterval(run, SWEEP_TICK_MS);
    if (sweepBootHandle.unref) sweepBootHandle.unref();
    if (sweepHandle.unref) sweepHandle.unref();
    console.log('[Quasar AutoMod] Balayage des bannissements temporaires démarré (tick 60 s).');
}

module.exports = {
    parseDuration,
    formatDuration,
    parsePunishments,
    validatePunishments,
    stringifyPunishments,
    applyPunishments,
    sendAutomodLog,
    startTempBanSweeper,
    // Exporté pour permettre une levée immédiate des bannissements échus, sans
    // attendre le prochain tour de boucle (tests, opération manuelle).
    sweepExpiredBans,
    ACTION_NAMES,
    SOURCES,
    SOURCE_LABELS,
    MAX_TIMEOUT_MS,
};
