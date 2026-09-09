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

// Verrou de ré-entrance. Le tick est de 60 s, mais un lot de rappels réglés à la
// même heure part en série : sous limitation de débit Discord, un tour peut
// dépasser 60 s. Sans ce verrou, le tick suivant relirait les MÊMES lignes et
// renverrait chaque rappel une seconde fois, mentions @everyone comprises. Le
// verrou porte sur runDueMessages lui-même, pas sur le timer, pour couvrir aussi
// les appels directs (tick de rattrapage du boot, tests, déclenchement manuel).
// Modèle : bot/modules/breach/index.js.
let running = false;

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

async function sendScheduledMessage(row, client = clientRef) {
    const guild = client.guilds.cache.get(row.guild_id);
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

/**
 * Envoie les rappels arrivés à échéance.
 * @returns {Promise<{ claimed:number, sent:number, failed:number, reentrant?:boolean }>}
 *          — compte rendu du tour, utile aux tests et à un déclenchement manuel.
 */
async function runDueMessages(client = clientRef) {
    if (!client) return { claimed: 0, sent: 0, failed: 0 };

    // Verrou de ré-entrance : si le tour précédent envoie encore (série longue,
    // limitation de débit), ne pas relire la file en parallèle. Le tour en cours
    // videra les rappels dus ; les suivants seront pris au prochain tick.
    if (running) return { claimed: 0, sent: 0, failed: 0, reentrant: true };
    running = true;

    let claimed = 0;
    let sent = 0;
    let failed = 0;
    try {
        // Garde-fou repris de breach/retention : un cache de serveurs vide, c'est
        // une connexion incomplète, pas un bot sans serveur. L'échéance étant
        // désormais avancée AVANT l'envoi, traiter la file dans cet état
        // consommerait des rappels sans rien envoyer.
        if (!client?.guilds?.cache || client.guilds.cache.size === 0) return { claimed, sent, failed };

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
            console.error('[Quasar Planificateur] Erreur lecture rappels dus:', e.message);
            return { claimed, sent, failed };
        }

        for (const row of due) {
            // ─── ORDRE DES ÉCRITURES ───────────────────────────────────────
            // L'échéance est avancée AVANT l'envoi, jamais après. Le verrou
            // ci-dessus ne protège que dans CE processus : un SIGTERM entre
            // l'envoi et l'écriture (redéploiement) laisserait next_run dans le
            // passé, et le rappel repartirait au redémarrage — avec ses mentions.
            //
            // La mise à jour est conditionnée à `next_run = <valeur lue>` : c'est
            // une prise de jeton atomique. Si une autre écriture est passée entre
            // la lecture et ici (second processus, modification depuis le
            // dashboard), changes vaut 0 et la ligne est laissée à qui l'a prise.
            //
            // Contrepartie assumée : un arrêt du processus entre la prise et
            // l'envoi fait sauter CETTE occurrence. Pour un rappel programmé,
            // un exemplaire manquant vaut mieux qu'un double ping @everyone ;
            // une occurrence récurrente repartira à la suivante.
            // Le fuseau du serveur, et non le défaut. Il manquait ici alors que
            // la planification initiale de `start()` le passait correctement :
            // un rappel récurrent sur un serveur hors Europe/Paris était donc
            // posé à la bonne heure au démarrage, puis recalculé en heure de
            // Paris dès son premier déclenchement. Le réglage « fuseau par
            // serveur » ne tenait pas au-delà de la première occurrence.
            const next = computeNextRun(row, now, getGuildTimezone(row.guild_id));
            let claim;
            try {
                if (row.schedule_type === 'once' || next === null) {
                    claim = db.prepare(`
                        UPDATE scheduled_messages
                        SET last_run = ?, enabled = 0, next_run = NULL, updated_at = ?
                        WHERE id = ? AND next_run = ?
                    `).run(nowSec, nowSec, row.id, row.next_run);
                } else {
                    claim = db.prepare(`
                        UPDATE scheduled_messages
                        SET last_run = ?, next_run = ?, updated_at = ?
                        WHERE id = ? AND next_run = ?
                    `).run(nowSec, Math.floor(next / 1000), nowSec, row.id, row.next_run);
                }
            } catch (e) {
                // Échéance non écrite : ne PAS envoyer. Un envoi sans écriture est
                // exactement le scénario du double envoi.
                console.error(`[Quasar Planificateur] Échéance du rappel ${row.id} non avancée, envoi annulé:`, e.message);
                continue;
            }

            // La ligne a déjà été prise par un autre tour ou modifiée entre-temps.
            if (claim.changes === 0) continue;
            claimed++;

            // `last_run` marque la tentative, pas le succès : le rappel a bien été
            // consommé pour ce tour, que l'envoi aboutisse ou non.
            try {
                await sendScheduledMessage(row, client);
                sent++;
                console.log(`[Quasar Planificateur] Rappel envoyé id=${row.id} guild=${row.guild_id} channel=${row.channel_id}`);
            } catch (err) {
                failed++;
                // Plus rien à réparer en base : l'échéance est déjà avancée, donc
                // aucune boucle d'échec possible sur la même occurrence.
                console.error(`[Quasar Planificateur] Erreur envoi rappel ${row.id}:`, err.message);
            }
        }

        return { claimed, sent, failed };
    } finally {
        // finally obligatoire : sans lui, une exception laisserait le verrou posé
        // et la boucle serait morte jusqu'au prochain redémarrage.
        running = false;
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
            console.log(`[Quasar Planificateur] Recalcul next_run pour ${rows.length} rappel(s) au boot`);
        }
    } catch (e) {
        console.error('[Quasar Planificateur] Erreur recalcul boot:', e.message);
    }

    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => {
        runDueMessages().catch(e => console.error('[Quasar Planificateur] Erreur tick:', e));
    }, TICK_MS);
    if (tickHandle.unref) tickHandle.unref();

    // Tick initial 5s après le boot pour rattraper rapidement les retards
    setTimeout(() => runDueMessages().catch(() => {}), 5000);

    console.log(`[Quasar Planificateur] Démarré (tick chaque ${TICK_MS / 1000}s, timezone par défaut ${DEFAULT_TIMEZONE})`);
}

function stop() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
    clientRef = null;
}

module.exports = {
    start,
    stop,
    // Exporté pour permettre un passage immédiat sans attendre le tour de boucle
    // (tests, déclenchement manuel).
    runDueMessages,
    computeNextRun,
    isValidTimezone,
    getGuildTimezone,
    DEFAULT_TIMEZONE
};
