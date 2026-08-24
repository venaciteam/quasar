// ═══════════════════════════════════════════════════════════════
//  Scheduler — Rappels / Messages programmés
//  Timezone configurable par guild (fallback Europe/Paris). Tick : 60s.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');
const { buildMentionPayload, hasMentions } = require('../../../api/services/mentions');
const { buildDiscordEmbed } = require('../../commands/embed');

const DEFAULT_TIMEZONE = 'Europe/Paris';
const TICK_MS = 60_000;

let tickHandle = null;
let clientRef = null;

// ─── Helpers timezone (zoned ↔ UTC, DST-safe) ─────────────────

function isValidTimezone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

function getGuildTimezone(guildId) {
    try {
        const db = getDb();
        const row = db.prepare('SELECT timezone FROM guilds WHERE guild_id = ?').get(guildId);
        if (row && isValidTimezone(row.timezone)) return row.timezone;
    } catch {}
    return DEFAULT_TIMEZONE;
}

function getZonedParts(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    let hour = +parts.hour;
    if (hour === 24) hour = 0; // certains runtimes renvoient 24 pour minuit
    return {
        year: +parts.year,
        month: +parts.month,
        day: +parts.day,
        hour,
        minute: +parts.minute,
        second: +parts.second,
        // Jour de semaine (0=dim, 1=lun, … 6=sam) calculé sur la date zonée
        weekday: new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day)).getUTCDay()
    };
}

// Convertit une heure locale (year/month/day/hour/minute) d'une TZ donnée en timestamp UTC ms.
// Gère le DST : si l'heure n'existe pas (saut de printemps) ou existe deux fois (recul automne),
// le résultat est l'approximation la plus naturelle.
function zonedToUtcMs(year, month, day, hour, minute, tz) {
    // Première estimation : on suppose zone == UTC
    let guess = Date.UTC(year, month - 1, day, hour, minute);
    // Itération de correction (2 passes suffisent pour absorber le DST)
    for (let i = 0; i < 2; i++) {
        const p = getZonedParts(new Date(guess), tz);
        const diff =
            Date.UTC(year, month - 1, day, hour, minute) -
            Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
        if (diff === 0) break;
        guess += diff;
    }
    return guess;
}

// ─── Calcul next_run ──────────────────────────────────────────

function computeNextRun(row, fromMs = Date.now(), timezone = DEFAULT_TIMEZONE) {
    const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
    if (!row.schedule_time || !/^\d{2}:\d{2}$/.test(row.schedule_time)) return null;
    const [hh, mm] = row.schedule_time.split(':').map(Number);
    const fromDate = new Date(fromMs);

    if (row.schedule_type === 'once') {
        if (!row.schedule_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.schedule_date)) return null;
        const [y, mo, d] = row.schedule_date.split('-').map(Number);
        const t = zonedToUtcMs(y, mo, d, hh, mm, tz);
        return t > fromMs ? t : null;
    }

    if (row.schedule_type === 'daily') {
        const p = getZonedParts(fromDate, tz);
        let t = zonedToUtcMs(p.year, p.month, p.day, hh, mm, tz);
        if (t <= fromMs) {
            // Demain (en re-passant par la zone pour le DST)
            const tomorrowUtc = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
            const pt = getZonedParts(tomorrowUtc, tz);
            t = zonedToUtcMs(pt.year, pt.month, pt.day, hh, mm, tz);
        }
        return t;
    }

    if (row.schedule_type === 'weekly') {
        // Multi-jours : on lit schedule_days (JSON array) si présent, sinon fallback
        // sur schedule_day (un seul jour, pour rétro-compat).
        let targetDows = [];
        if (row.schedule_days) {
            try {
                const parsed = JSON.parse(row.schedule_days);
                if (Array.isArray(parsed)) {
                    targetDows = parsed
                        .map(Number)
                        .filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
                }
            } catch {}
        }
        if (targetDows.length === 0 && Number.isInteger(Number(row.schedule_day))) {
            const d = Number(row.schedule_day);
            if (d >= 0 && d <= 6) targetDows = [d];
        }
        if (targetDows.length === 0) return null;

        const p = getZonedParts(fromDate, tz);
        for (let i = 0; i < 8; i++) {
            const probeUtc = new Date(Date.UTC(p.year, p.month - 1, p.day + i, 12));
            const pp = getZonedParts(probeUtc, tz);
            if (!targetDows.includes(pp.weekday)) continue;
            const t = zonedToUtcMs(pp.year, pp.month, pp.day, hh, mm, tz);
            if (t > fromMs) return t;
        }
        return null;
    }

    if (row.schedule_type === 'monthly') {
        const targetDay = Number(row.schedule_day);
        if (!Number.isInteger(targetDay) || targetDay < 1 || targetDay > 31) return null;
        const p = getZonedParts(fromDate, tz);
        for (let offset = 0; offset < 13; offset++) {
            const y = p.year + Math.floor((p.month - 1 + offset) / 12);
            const m = ((p.month - 1 + offset) % 12) + 1;
            // Dernier jour réel du mois (gestion 28/29/30/31)
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const d = Math.min(targetDay, lastDay);
            const t = zonedToUtcMs(y, m, d, hh, mm, tz);
            if (t > fromMs) return t;
        }
        return null;
    }

    return null;
}

// ─── Envoi d'un message programmé ─────────────────────────────

async function sendScheduledMessage(row) {
    const guild = clientRef.guilds.cache.get(row.guild_id);
    if (!guild) throw new Error(`guild ${row.guild_id} introuvable`);
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
        throw new Error(`channel ${row.channel_id} introuvable ou non textuel`);
    }

    // Un embed sauvegardé peut lui aussi porter des mentions (cf. builder du
    // dashboard). Précédence explicite : les mentions du rappel gagnent ; on ne
    // retombe sur celles de l'embed que si le rappel n'en définit aucune. Sans
    // cette règle, les deux configurations s'additionneraient = double ping.
    let mentionSource = row;
    let discordEmbed = null;

    if (row.content_type === 'embed' && row.embed_id) {
        const db = getDb();
        const embedRow = db.prepare(
            'SELECT data, mention_roles, mention_users, mention_everyone, mention_here FROM embeds WHERE id = ?'
        ).get(row.embed_id);
        if (!embedRow) throw new Error(`embed ${row.embed_id} introuvable`);
        let embedData;
        try { embedData = JSON.parse(embedRow.data); }
        catch { throw new Error(`embed ${row.embed_id} données invalides`); }
        discordEmbed = buildDiscordEmbed(embedData);
        if (!hasMentions(row)) mentionSource = embedRow;
    }

    const { content: mentionsStr, allowedMentions } = buildMentionPayload(mentionSource);
    const payload = { allowedMentions };

    if (discordEmbed) {
        payload.embeds = [discordEmbed];
        if (mentionsStr) payload.content = mentionsStr;
    } else {
        const text = row.content_text || '';
        payload.content = mentionsStr ? `${mentionsStr}\n${text}`.trim() : text;
        if (!payload.content) throw new Error('contenu vide');
    }

    await channel.send(payload);
}

// ─── Tick ─────────────────────────────────────────────────────

async function runDueMessages() {
    if (!clientRef) return;
    const db = getDb();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    let due;
    try {
        due = db.prepare(`
            SELECT * FROM scheduled_messages
            WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
        `).all(nowSec);
    } catch (e) {
        console.error('[Scheduler] Erreur lecture rappels dus:', e.message);
        return;
    }

    for (const row of due) {
        try {
            await sendScheduledMessage(row);
            console.log(`[Scheduler] Rappel envoyé id=${row.id} guild=${row.guild_id} channel=${row.channel_id}`);
            const next = computeNextRun(row, now);
            if (row.schedule_type === 'once' || next === null) {
                db.prepare(`
                    UPDATE scheduled_messages
                    SET last_run = ?, enabled = 0, next_run = NULL, updated_at = ?
                    WHERE id = ?
                `).run(nowSec, nowSec, row.id);
            } else {
                db.prepare(`
                    UPDATE scheduled_messages
                    SET last_run = ?, next_run = ?, updated_at = ?
                    WHERE id = ?
                `).run(nowSec, Math.floor(next / 1000), nowSec, row.id);
            }
        } catch (err) {
            console.error(`[Scheduler] Erreur envoi rappel ${row.id}:`, err.message);
            // On avance next_run pour ne pas retomber dessus en boucle
            const next = computeNextRun(row, now);
            try {
                db.prepare(`
                    UPDATE scheduled_messages SET next_run = ?, updated_at = ? WHERE id = ?
                `).run(next ? Math.floor(next / 1000) : null, nowSec, row.id);
            } catch {}
        }
    }
}

// ─── Lifecycle ────────────────────────────────────────────────

function start(client) {
    clientRef = client;
    const db = getDb();

    // Recalcul next_run au boot pour tous les rappels enabled sans next_run
    try {
        const rows = db.prepare(
            'SELECT * FROM scheduled_messages WHERE enabled = 1 AND next_run IS NULL'
        ).all();
        for (const row of rows) {
            const tz = getGuildTimezone(row.guild_id);
            const next = computeNextRun(row, Date.now(), tz);
            if (next) {
                db.prepare('UPDATE scheduled_messages SET next_run = ? WHERE id = ?')
                    .run(Math.floor(next / 1000), row.id);
            }
        }
        if (rows.length > 0) {
            console.log(`[Scheduler] Recalcul next_run pour ${rows.length} rappel(s) au boot`);
        }
    } catch (e) {
        console.error('[Scheduler] Erreur recalcul boot:', e.message);
    }

    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => {
        runDueMessages().catch(e => console.error('[Scheduler] Erreur tick:', e));
    }, TICK_MS);
    if (tickHandle.unref) tickHandle.unref();

    // Tick initial 5s après le boot pour rattraper rapidement les retards
    setTimeout(() => runDueMessages().catch(() => {}), 5000);

    console.log(`[Scheduler] Démarré (tick chaque ${TICK_MS / 1000}s, timezone par défaut ${DEFAULT_TIMEZONE})`);
}

function stop() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
    clientRef = null;
}

module.exports = {
    start,
    stop,
    computeNextRun,
    isValidTimezone,
    getGuildTimezone,
    DEFAULT_TIMEZONE
};
