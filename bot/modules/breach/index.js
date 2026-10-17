// ═══════════════════════════════════════════════════════════════
//  Notification de violation — Boucle d'envoi
//
//  Dépile les breach_deliveries en 'pending' et tente leur envoi. Rien n'est
//  envoyé depuis la route HTTP (voir api/routes/breach.js) : la route se
//  contente d'ENFILER les envois après prévisualisation + confirmation. Cette
//  boucle est le seul canal d'envoi réel.
//
//  Elle reçoit l'ADAPTATEUR de plateforme, jamais le client natif : c'est ce qui
//  a permis de retirer la voie historique de `./notify.js`.
//
//  Propriétés (art. 33.5 — traçabilité de qui a / n'a pas reçu) :
//   • Étalement : un délai entre deux envois pour ne pas se faire limiter.
//   • Retry borné : jusqu'à MAX_ATTEMPTS tentatives, avec backoff.
//   • Repli salon : un MP définitivement en échec déclenche un envoi de secours
//     dans un salon du serveur (une seule fois par message et par serveur).
//   • Reprise au boot : seules les lignes 'pending' sont traitées ; 'sent' et
//     'failed' sont laissées telles quelles. La boucle est donc idempotente et
//     reprenable après un redémarrage.
//   • Marquage AVANT l'envoi : la ligne passe par un état 'sending' avant l'appel
//     Discord, jamais après (voir le commentaire ORDRE DES ÉCRITURES plus bas).
//
//  Modèle : bot/modules/retention/index.js (tick, boot delay, unref, safeTick).
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../../api/services/database');
const { buildBreachEmbed, sendDM, sendToGuildChannel } = require('./notify');

const TICK_MS = 30 * 1000;       // 30 s : les notifications de violation sont urgentes (engagement 24 h)
const BOOT_DELAY_MS = 20 * 1000; // laisse le bot finir de se connecter avant le premier passage
const SPREAD_MS = 1200;          // étalement entre deux envois réels d'un même tick
const MAX_ATTEMPTS = 5;          // au-delà, l'envoi est marqué 'failed' (et repli salon si c'était un MP)
// Au-delà de ce délai, une ligne restée 'sending' ne peut plus être un envoi en
// cours : le verrou de ré-entrance interdit deux traitements simultanés dans ce
// processus, donc une telle ligne est forcément le résidu d'un arrêt brutal.
// Large à dessein : un envoi Discord fortement limité en débit doit rester très
// loin de cette borne, sous peine de reprise sur un envoi encore vivant.
const STALE_SENDING_S = 300;

let tickHandle = null;
let bootHandle = null;

// Verrou de ré-entrance. Un setInterval de 30 s peut refirer un tick pendant que
// le précédent dort encore entre deux envois (sleep SPREAD_MS) sur un gros backlog :
// sans ce verrou, deux exécutions reliraient les MÊMES lignes 'pending' pas encore
// marquées 'sent' et enverraient chaque notification DEUX fois — double-envoi
// irréversible, et sous-comptage de la traçabilité (art. 33.5). Le verrou porte sur
// processPending lui-même (pas seulement sur la boucle) pour couvrir aussi les
// appels directs (test / déclenchement à la demande).
let running = false;

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Délai minimal (secondes) avant de re-tenter une ligne selon son nombre de
 * tentatives déjà faites. Backoff exponentiel borné : 30 s, 60 s, 120 s… max 1 h.
 */
function backoffSeconds(attempts) {
    const base = 30;
    return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), 3600);
}

/**
 * Programme un repli salon pour un couple (message, serveur), une seule fois.
 * Un MP en échec définitif ne doit pas produire un post par admin : on poste une
 * fois dans le salon du serveur, pour tous.
 */
function ensureGuildFallback(db, messageId, guildId) {
    const existing = db.prepare(
        "SELECT 1 FROM breach_deliveries WHERE message_id = ? AND guild_id = ? AND channel = 'guild_channel'"
    ).get(messageId, guildId);
    if (existing) return false;

    db.prepare(
        `INSERT INTO breach_deliveries (message_id, guild_id, recipient_id, channel, status, attempts)
         VALUES (?, ?, NULL, 'guild_channel', 'pending', 0)`
    ).run(messageId, guildId);
    console.log(`[Quasar Violation] Repli salon programmé — serveur ${guildId}, message ${messageId}.`);
    return true;
}

/**
 * Remet en file les envois interrompus par un arrêt du processus.
 *
 * Une ligne 'sending' veut dire : « le marquage est passé, la suite est
 * inconnue ». Le message est peut-être parti, peut-être pas. Pour une
 * notification de violation, l'arbitrage ne se fait PAS comme pour un rappel
 * programmé : l'information doit parvenir aux personnes concernées (art. 34),
 * donc le doute se tranche en faveur d'une nouvelle tentative. Le doublon
 * possible est borné par MAX_ATTEMPTS et tracé dans la colonne `error`, ce qui
 * laisse la traçabilité (art. 33.5) lisible : « statut d'envoi incertain » est
 * une information, « rien » n'en est pas une.
 */
function recoverInterrupted(db) {
    const cutoff = nowSec() - STALE_SENDING_S;
    const stuck = db.prepare(
        "SELECT * FROM breach_deliveries WHERE status = 'sending' AND (last_attempt_at IS NULL OR last_attempt_at <= ?)"
    ).all(cutoff);

    for (const row of stuck) {
        if (row.attempts >= MAX_ATTEMPTS) {
            // Plus de tentative disponible : la ligne est close en échec, avec la
            // mention exacte du doute plutôt qu'un « envoyé » qui mentirait.
            db.prepare("UPDATE breach_deliveries SET status = 'failed', error = ? WHERE id = ?")
                .run('Envoi interrompu par un arrêt du service, statut incertain, plus aucune tentative disponible.', row.id);
            continue;
        }
        db.prepare("UPDATE breach_deliveries SET status = 'pending', error = ? WHERE id = ?")
            .run('Envoi interrompu par un arrêt du service, statut incertain : nouvelle tentative.', row.id);
    }
    if (stuck.length > 0) {
        console.warn(`[Quasar Violation] ${stuck.length} envoi(s) interrompu(s) repris après un arrêt du service.`);
    }
}

/**
 * Traite toutes les livraisons en attente. Peut être appelé directement (test,
 * déclenchement à la demande) ou par la boucle.
 * @returns {Promise<{ processed:number, sent:number, failed:number, skipped:number }>}
 */
async function processPending(plateforme) {
    // Verrou de ré-entrance : si un traitement est déjà en cours (il peut dormir
    // entre deux envois), ne pas relire la file en parallèle — sinon les mêmes
    // lignes 'pending' seraient envoyées deux fois. Le traitement courant videra
    // la file ; les nouvelles lignes seront prises au tick suivant.
    if (running) {
        return { processed: 0, sent: 0, failed: 0, skipped: 0, reentrant: true };
    }
    running = true;
    try {
        // Garde-fou : tant que l'adaptateur ne connaît pas l'identité du bot, la
        // connexion n'est pas faite. On ne tente rien, les pending repartiront au
        // tick suivant. Le cache de serveurs de discord.js disait la même chose
        // en moins bien — il ne distinguait pas « pas encore connecté » de
        // « connecté et sur aucun serveur ».
        if (!plateforme?.moi?.id) {
            return { processed: 0, sent: 0, failed: 0, skipped: 0 };
        }

        const db = getDb();

        // Avant de lire la file : récupérer les lignes laissées 'sending' par un
        // arrêt brutal, sans quoi elles n'y reviendraient jamais.
        recoverInterrupted(db);

        const pending = db.prepare(
            "SELECT * FROM breach_deliveries WHERE status = 'pending' ORDER BY id ASC"
        ).all();

        let processed = 0;
        let sent = 0;
        let failed = 0;
        let skipped = 0;

        for (const row of pending) {
            // Backoff : ne pas re-tenter une ligne trop tôt après son dernier essai.
            if (row.last_attempt_at && nowSec() < row.last_attempt_at + backoffSeconds(row.attempts)) {
                skipped++;
                continue;
            }

            const message = db.prepare('SELECT * FROM breach_messages WHERE id = ?').get(row.message_id);
            if (!message) {
                // Message disparu (incident purgé en cascade) : livraison orpheline, on la clôt.
                db.prepare("UPDATE breach_deliveries SET status = 'failed', error = ?, last_attempt_at = ? WHERE id = ?")
                    .run('message associé introuvable', nowSec(), row.id);
                failed++;
                processed++;
                continue;
            }
            // Étalement entre deux envois réels (pas avant le premier).
            if (processed > 0) await sleep(SPREAD_MS);

            // ─── ORDRE DES ÉCRITURES ────────────────────────────────────────
            // La ligne est marquée AVANT l'appel Discord, jamais après. Le verrou
            // de ré-entrance ne protège que dans ce processus : un SIGTERM entre
            // l'envoi et le marquage (redéploiement) laisserait la ligne
            // 'pending', et la boucle renverrait au redémarrage la notification
            // d'une violation de données personnelles à quelqu'un qui l'a déjà
            // reçue — la pire conséquence possible pour ce module.
            //
            // Le marquage n'est PAS un simple « fait » : ce serait échanger le
            // double envoi contre un non-envoi silencieux, inacceptable pour une
            // obligation d'information (art. 34). L'état 'sending' dit « tentative
            // en cours, issue inconnue » et reste distinct de 'sent' ; c'est
            // recoverInterrupted qui décide de sa suite au tour suivant.
            //
            // La condition `status = 'pending'` fait de ce marquage une prise de
            // jeton atomique : si une autre écriture est passée entre la lecture
            // de la file et ici, changes vaut 0 et la ligne est laissée.
            const claim = db.prepare(
                "UPDATE breach_deliveries SET status = 'sending', attempts = ?, last_attempt_at = ? WHERE id = ? AND status = 'pending'"
            ).run(row.attempts + 1, nowSec(), row.id);
            if (claim.changes === 0) {
                skipped++;
                continue;
            }

            let res;
            if (row.channel === 'guild_channel') {
                // Repli salon : POINTEUR NEUTRE dans le salon de logs de modération.
                // Jamais le contenu de la violation — il reste en MP + bannière dashboard.
                res = await sendToGuildChannel(plateforme, row.guild_id);
            } else {
                // MP : embed COMPLET (contenu de la notification).
                const incident = db.prepare('SELECT * FROM breach_incidents WHERE id = ?').get(message.incident_id);
                const embed = buildBreachEmbed(incident, message);
                res = await sendDM(plateforme, row.recipient_id, embed);
            }

            const attempts = row.attempts + 1; // déjà écrit par le marquage ci-dessus
            const ts = nowSec();
            processed++;

            if (res.ok) {
                db.prepare(
                    "UPDATE breach_deliveries SET status = 'sent', attempts = ?, last_attempt_at = ?, delivered_at = ?, error = NULL WHERE id = ?"
                ).run(attempts, ts, ts, row.id);
                sent++;
                continue;
            }

            if (attempts >= MAX_ATTEMPTS) {
                // Échec définitif : on trace l'erreur (qui n'a PAS reçu).
                db.prepare(
                    "UPDATE breach_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, error = ? WHERE id = ?"
                ).run(attempts, ts, res.error, row.id);
                failed++;

                // Un MP qui échoue définitivement déclenche le repli salon.
                if (row.channel === 'dm') {
                    ensureGuildFallback(db, row.message_id, row.guild_id);
                }
            } else {
                // Retour en 'pending' pour re-tentative (la ligne est en 'sending'
                // depuis le marquage), en conservant l'erreur.
                db.prepare(
                    "UPDATE breach_deliveries SET status = 'pending', attempts = ?, last_attempt_at = ?, error = ? WHERE id = ?"
                ).run(attempts, ts, res.error, row.id);
            }
        }

        return { processed, sent, failed, skipped };
    } finally {
        running = false;
    }
}

async function tick(plateforme) {
    try {
        const r = await processPending(plateforme);
        if (r.processed > 0) {
            console.log(
                `[Quasar Violation] File traitée : ${r.sent} envoyé(s), ${r.failed} en échec définitif, ` +
                `${r.skipped} différé(s) (backoff).`
            );
        }
    } catch (err) {
        console.error('[Quasar Violation] Erreur de traitement de la file :', err.message);
    }
}

/** @param {object} plateforme adaptateur de plateforme (bot/platform/index.js) */
function start(plateforme) {
    if (tickHandle) return;

    console.log('[Quasar Violation] Boucle de notification active (tick 30 s, repli salon + bannière dashboard en filet).');

    const safeTick = () => Promise.resolve(tick(plateforme))
        .catch(err => console.error('[Quasar Violation] Erreur inattendue :', err.message));

    bootHandle = setTimeout(safeTick, BOOT_DELAY_MS);
    if (bootHandle.unref) bootHandle.unref();

    // setInterval simple : si un tick long (gros backlog + étalement) déborde sur le
    // suivant, le verrou de ré-entrance de processPending fait retourner le second
    // immédiatement — aucune ligne n'est traitée deux fois.
    tickHandle = setInterval(safeTick, TICK_MS);
    if (tickHandle.unref) tickHandle.unref();
}

function stop() {
    if (bootHandle) clearTimeout(bootHandle);
    if (tickHandle) clearInterval(tickHandle);
    bootHandle = null;
    tickHandle = null;
}

module.exports = {
    start,
    stop,
    tick,
    processPending,
    ensureGuildFallback,
    backoffSeconds,
    MAX_ATTEMPTS,
};
