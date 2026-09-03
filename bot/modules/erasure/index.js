// ═══════════════════════════════════════════════════════════════
//  Effacement — Boucle de relance des demandes échues
//
//  Une demande de suppression (RGPD art. 17) est routée à l'admin responsable, qui
//  DÉCIDE (cf. api/routes/erasure.js). Cette boucle ne décide ni n'efface RIEN :
//  elle repère les demandes 'pending' dont l'échéance légale (1 mois, art. 12.3)
//  approche ou est dépassée, JOURNALISE une relance (trace de la diligence de
//  Venacity) et notifie le propriétaire pour qu'il puisse relancer l'admin.
//
//  L'inaction de l'admin reste SA responsabilité (il est responsable de traitement).
//  Rythme large (6 h) : ces échéances se comptent en jours.
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');

const TICK_MS = 6 * 60 * 60 * 1000;   // 6 heures
const BOOT_DELAY_MS = 90 * 1000;      // laisse le bot finir de se connecter
const REMINDER_WINDOW_DAYS = 7;       // relance quand l'échéance est à < 7 jours (ou dépassée)

let tickHandle = null;
let bootHandle = null;

/**
 * Demandes 'pending' dont l'échéance approche (< REMINDER_WINDOW_DAYS) ou est dépassée.
 * Lecture seule : ne modifie aucune donnée.
 * @returns {Array<{ id, guild_id, subject_id, category, requested_at, due_at, overdue }>}
 */
function checkOverdue() {
    try {
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        const horizon = now + REMINDER_WINDOW_DAYS * 24 * 60 * 60;

        const rows = db.prepare(`
            SELECT id, guild_id, subject_id, category, requested_at, due_at
            FROM erasure_requests
            WHERE status = 'pending' AND due_at <= ?
            ORDER BY due_at ASC
        `).all(horizon);

        return rows.map(r => ({ ...r, overdue: r.due_at < now }));
    } catch (err) {
        // Dégradation gracieuse : table potentiellement absente au tout premier boot.
        console.error('[Quasar Effacement] Lecture des demandes échues impossible :', err.message);
        return [];
    }
}

/**
 * Notifie le propriétaire du bot (BOT_OWNER_ID) par message direct — best-effort.
 * Contenu minimal : identifiants de demande, serveur et échéance. Pas de subject_id
 * (donnée nominative) dans le DM : l'owner le retrouve dans le dashboard s'il agit.
 */
async function notifyOwner(client, pending) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId || !client?.users) return;

    try {
        const owner = await client.users.fetch(ownerId);
        const lines = pending.map(p => {
            const dueStr = new Date(p.due_at * 1000).toISOString().slice(0, 10);
            const state = p.overdue ? 'DÉPASSÉE' : 'proche';
            return `• Demande #${p.id} — serveur \`${p.guild_id}\` — échéance ${dueStr} (${state})`;
        });

        await owner.send(
            "⚖️ **Demandes d'effacement en attente**\n" +
            `${pending.length} demande(s) approchent ou dépassent le délai légal d'un mois. ` +
            "L'admin responsable du serveur doit décider (effacer / refuser motivé) ; " +
            "cette relance documente la diligence de Venacity.\n\n" +
            lines.join('\n')
        );
    } catch (err) {
        // Le DM peut échouer (DM fermés, owner introuvable) : la trace console reste
        // le filet indépendant. On n'interrompt pas la boucle pour autant.
        console.error('[Quasar Effacement] Notification du propriétaire échouée :', err.message);
    }
}

async function tick(client) {
    const pending = checkOverdue();
    if (pending.length === 0) return;

    const overdue = pending.filter(p => p.overdue).length;
    console.log(
        `[Quasar Effacement] Relance : ${pending.length} demande(s) d'effacement en attente, ` +
        `dont ${overdue} au-delà du délai légal d'un mois.`
    );
    for (const p of pending) {
        const dueStr = new Date(p.due_at * 1000).toISOString().slice(0, 10);
        // On journalise id/serveur/échéance — pas le subject_id (donnée nominative),
        // conformément à la sobriété de log du reste des boucles (cf. rétention).
        console.log(
            `[Quasar Effacement]   • demande #${p.id} — serveur ${p.guild_id} — ` +
            `échéance ${dueStr}${p.overdue ? ' — DÉPASSÉE' : ''}`
        );
    }

    await notifyOwner(client, pending);
}

function start(client) {
    if (tickHandle) return;

    console.log(
        `[Quasar Effacement] Boucle de relance active — vérification toutes les ` +
        `${TICK_MS / (60 * 60 * 1000)} h, relance à < ${REMINDER_WINDOW_DAYS} jour(s) de l'échéance.`
    );

    // tick() gère ses propres erreurs ; ce catch ne couvre que l'imprévu, pour ne pas
    // transformer un incident en rejet de promesse non traité.
    const safeTick = () => Promise.resolve(tick(client))
        .catch(err => console.error('[Quasar Effacement] Erreur inattendue :', err.message));

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

module.exports = { start, stop, tick, checkOverdue, notifyOwner };
