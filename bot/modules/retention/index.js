// ═══════════════════════════════════════════════════════════════
//  Rétention — Boucle de nettoyage
//
//  Applique les durées de conservation : purge des serveurs quittés une fois le
//  délai de grâce écoulé. Tourne toutes les heures ; la granularité fine est
//  inutile ici, ces échéances se comptent en jours ou en mois.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');
const {
    schedulePurge,
    runDuePurges,
    formatPurgeReport,
    INSTANCE_ROW_ID,
} = require('./purge');
const { purgeAllSanctions, DEFAULT_RETENTION_MONTHS } = require('./sanctions');

const TICK_MS = 60 * 60 * 1000;  // 1 heure
const BOOT_DELAY_MS = 60 * 1000; // laisse le bot finir de se connecter avant le premier passage

const DEFAULT_GRACE_DAYS = 7;

let tickHandle = null;
let bootHandle = null;

/**
 * Délai de grâce avant suppression des données d'un serveur quitté, en jours.
 * 0 = suppression dès le prochain passage de la boucle.
 */
function getGraceDays() {
    const raw = process.env.GUILD_PURGE_GRACE_DAYS;
    if (raw === undefined || raw === '') return DEFAULT_GRACE_DAYS;

    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        console.warn(
            `[Quasar Rétention] GUILD_PURGE_GRACE_DAYS invalide ("${raw}") — ` +
            `valeur par défaut appliquée (${DEFAULT_GRACE_DAYS} jours).`
        );
        return DEFAULT_GRACE_DAYS;
    }
    return parsed;
}

/**
 * Aligne les purges programmées sur la réalité, dans les deux sens. Les événements
 * `guildDelete` et `guildCreate` ne se déclenchent pas quand le bot est hors ligne :
 * sans ce rattrapage, il suffirait de l'éteindre avant de le retirer pour que ses
 * données restent indéfiniment — et un bot réinvité hors ligne verrait ses données
 * supprimées alors qu'il est bel et bien dans le serveur.
 */
function reconcileGuilds(client) {
    // Garde-fou : un cache vide signale une connexion incomplète, pas un bot sans
    // serveur. Programmer des purges dans cet état serait catastrophique.
    if (!client?.guilds?.cache || client.guilds.cache.size === 0) {
        console.log('[Quasar Rétention] Cache des serveurs vide — réconciliation ignorée par précaution.');
        return { scheduled: 0, cancelled: 0 };
    }

    const db = getDb();
    const graceDays = getGraceDays();

    // Sens 1 — le bot a été réinvité hors ligne : la suppression n'a plus lieu d'être.
    let cancelled = 0;
    const pending = db.prepare('SELECT guild_id FROM pending_guild_purges').all();
    for (const row of pending) {
        if (!client.guilds.cache.has(row.guild_id)) continue;
        db.prepare('DELETE FROM pending_guild_purges WHERE guild_id = ?').run(row.guild_id);
        cancelled++;
    }
    if (cancelled > 0) {
        console.log(`[Quasar Rétention] ${cancelled} suppression(s) annulée(s) — bot de nouveau présent sur ces serveurs.`);
    }

    // Sens 2 — le bot a été retiré hors ligne : programmer la suppression.
    const known = db.prepare('SELECT guild_id FROM guilds WHERE guild_id != ?').all(INSTANCE_ROW_ID);
    let scheduled = 0;
    for (const row of known) {
        if (client.guilds.cache.has(row.guild_id)) continue;

        const alreadyPending = db.prepare('SELECT 1 FROM pending_guild_purges WHERE guild_id = ?')
            .get(row.guild_id);
        if (alreadyPending) continue;

        schedulePurge(row.guild_id, graceDays);
        scheduled++;
    }
    if (scheduled > 0) {
        console.log(
            `[Quasar Rétention] ${scheduled} serveur(s) quitté(s) hors ligne détecté(s) — ` +
            `suppression programmée dans ${graceDays} jour(s).`
        );
    }

    return { scheduled, cancelled };
}

async function tick(client) {
    try {
        reconcileGuilds(client);
    } catch (err) {
        console.error('[Quasar Rétention] Erreur de réconciliation :', err.message);
    }

    try {
        const purged = runDuePurges();
        for (const entry of purged) {
            console.log(
                `[Quasar Rétention] Données supprimées pour le serveur ${entry.guildId} : ` +
                `${entry.total} ligne(s) — ${formatPurgeReport(entry.perTable)}`
            );
        }
    } catch (err) {
        console.error('[Quasar Rétention] Erreur de purge :', err.message);
    }

    // Sanctions échues, serveur par serveur, selon la durée fixée par chaque admin.
    try {
        const results = await purgeAllSanctions(client);
        for (const entry of results) {
            const kept = entry.keptActiveBans > 0
                ? ` — ${entry.keptActiveBans} bannissement(s) en vigueur conservé(s)`
                : '';
            if (entry.deleted > 0) {
                console.log(
                    `[Quasar Rétention] ${entry.deleted} sanction(s) expirée(s) supprimée(s) ` +
                    `sur le serveur ${entry.guildId}${kept}`
                );
            }
        }
    } catch (err) {
        console.error('[Quasar Rétention] Erreur de purge des sanctions :', err.message);
    }
}

function start(client) {
    if (tickHandle) return;

    const graceDays = getGraceDays();
    console.log(
        `[Quasar Rétention] Boucle active — délai de grâce après retrait d'un serveur : ` +
        `${graceDays} jour(s). Conservation des sanctions : réglable par serveur ` +
        `(défaut ${DEFAULT_RETENTION_MONTHS} mois).`
    );

    // tick() gère ses propres erreurs ; ce catch ne couvre que l'imprévu, pour ne
    // pas transformer un incident de purge en rejet de promesse non traité.
    const safeTick = () => Promise.resolve(tick(client))
        .catch(err => console.error('[Quasar Rétention] Erreur inattendue :', err.message));

    bootHandle = setTimeout(safeTick, BOOT_DELAY_MS);
    if (bootHandle.unref) bootHandle.unref();

    tickHandle = setInterval(safeTick, TICK_MS);
    if (tickHandle.unref) tickHandle.unref();
}

function stop() {
    if (bootHandle) clearTimeout(bootHandle);
    if (tickHandle) clearInterval(tickHandle);
    bootHandle = null;
    tickHandle = null;
}

module.exports = { start, stop, getGraceDays, reconcileGuilds, tick };
