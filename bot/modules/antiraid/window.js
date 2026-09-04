// ═══════════════════════════════════════════════════════════════
//  Anti-raid — fenêtre glissante des arrivées
//
//  « N arrivées en X secondes ». Tout l'état vit EN MÉMOIRE, jamais en base.
//  Une écriture SQLite par arrivée serait exactement le mauvais comportement au
//  pire moment : pendant une vague de plusieurs milliers de comptes, sur une
//  instance auto-hébergée qui tourne parfois sur un Raspberry Pi.
//
//  ─── Conséquence assumée : un redémarrage vide la fenêtre ───
//  Si le processus redémarre au milieu d'une vague, le comptage repart de zéro
//  et la vague peut passer. C'est acceptable — le pire cas est une détection
//  manquée, jamais une sanction erronée — et c'est le prix d'un module qui ne
//  touche pas au disque. Le MODE PANIQUE, lui, ne suit PAS cette règle : il est
//  persisté, parce qu'un verrou posé puis oublié laisserait un serveur fermé
//  indéfiniment (voir panic.js).
//
//  ─── Mémoire bornée par construction ───
//  On ne conserve JAMAIS plus de `joinCount` arrivées par serveur. Pour savoir
//  si N arrivées tiennent dans X secondes, la (N+1)-ième plus ancienne est déjà
//  inutile : la garder ne ferait qu'enfler le processus pendant le raid. Une
//  vague de 5 000 comptes occupe donc exactement la même place qu'une vague de
//  10 sur un seuil réglé à 10.
//
//  ─── Notion de « vague » ───
//  Une fois le seuil franchi, les arrivées suivantes appartiennent à la MÊME
//  vague tant qu'elles s'enchaînent (moins de X secondes entre deux). Sans
//  cette notion, un raid de 300 comptes sur un seuil de 10 déclencherait
//  30 alertes et 30 modes panique successifs pour un seul et même événement.
// ═══════════════════════════════════════════════════════════════

/**
 * guildId → {
 *   entries: Array<{ t: number, member: GuildMember }>,  // au plus joinCount
 *   waveUntil: number,        // 0 = aucune vague en cours
 *   punished: number,         // membres traités depuis le début de la vague
 * }
 */
const states = new Map();

// Plafond de membres sanctionnés pour une même vague. Au-delà, la vague est
// bien plus large que ce que la modération peut absorber : chaque sanction
// coûte un appel d'API, une ligne d'historique et un message de journal.
// Continuer à en empiler saturerait la file d'attente de discord.js et le salon
// de logs, sans rien protéger de plus — c'est le mode panique (mise en pause
// des invitations) qui coupe la vague à la source, pas la 300ᵉ expulsion.
const MAX_PUNISHED_PER_WAVE = 100;

function stateFor(guildId) {
    let state = states.get(guildId);
    if (!state) {
        state = { entries: [], waveUntil: 0, punished: 0 };
        states.set(guildId, state);
    }
    return state;
}

/**
 * Enregistre une arrivée et dit ce qu'elle déclenche.
 *
 * @param {string} guildId
 * @param {import('discord.js').GuildMember} member
 * @param {{ joinCount: number, windowMs: number }} config
 * @param {number} [now]
 * @returns {{
 *   status: 'quiet'|'triggered'|'ongoing'|'saturated',
 *   batch: Array<import('discord.js').GuildMember>,  // membres à sanctionner
 *   size: number,        // arrivées comptées dans la fenêtre au déclenchement
 * }}
 *
 * - `quiet`      : rien à faire, le cas de très loin le plus fréquent.
 * - `triggered`  : le seuil vient d'être franchi. `batch` contient TOUTE la
 *                  fenêtre, membre courant compris : sanctionner seulement le
 *                  dernier arrivant laisserait passer les N-1 précédents, qui
 *                  sont justement le raid.
 * - `ongoing`    : la vague continue. `batch` ne contient que l'arrivant.
 * - `saturated`  : la vague continue mais le plafond de sanctions est atteint.
 */
function registerJoin(guildId, member, config, now = Date.now()) {
    const { joinCount, windowMs } = config;
    const state = stateFor(guildId);

    // Vague déjà en cours : chaque nouvelle arrivée la prolonge et se fait
    // traiter individuellement. On ne repasse pas par le seuil, il est franchi.
    if (state.waveUntil > now) {
        state.waveUntil = now + windowMs;
        if (state.punished >= MAX_PUNISHED_PER_WAVE) {
            return { status: 'saturated', batch: [], size: state.punished };
        }
        state.punished += 1;
        return { status: 'ongoing', batch: [member], size: state.punished };
    }

    // Vague terminée : on repart d'une fenêtre propre plutôt que de traîner un
    // compteur qui ferait re-déclencher immédiatement.
    if (state.waveUntil) {
        state.waveUntil = 0;
        state.punished = 0;
        state.entries.length = 0;
    }

    const cutoff = now - windowMs;
    // Les entrées sont insérées dans l'ordre chronologique : purger revient à
    // couper le préfixe périmé, sans parcourir tout le tableau.
    let expired = 0;
    while (expired < state.entries.length && state.entries[expired].t <= cutoff) expired += 1;
    if (expired) state.entries.splice(0, expired);

    state.entries.push({ t: now, member });

    // Borne dure de la mémoire : au plus `joinCount` entrées par serveur.
    const overflow = state.entries.length - joinCount;
    if (overflow > 0) state.entries.splice(0, overflow);

    if (state.entries.length < joinCount) {
        return { status: 'quiet', batch: [], size: state.entries.length };
    }

    // Seuil franchi. La fenêtre est vidée : ses membres partent en sanction, et
    // la vague prend le relais du comptage.
    const batch = state.entries.map(entry => entry.member);
    state.entries.length = 0;
    state.waveUntil = now + windowMs;
    state.punished = batch.length;

    return { status: 'triggered', batch, size: batch.length };
}

/**
 * Oublie les serveurs sans activité : ni arrivée récente, ni vague en cours.
 * Appelé périodiquement par le balayage du mode panique — sans ce ménage, la
 * Map garderait une entrée par serveur ayant vu une seule arrivée depuis le
 * démarrage, ce qui est une fuite lente sur une instance à mille serveurs.
 *
 * @returns {number} nombre de serveurs oubliés
 */
function sweepIdle(windowMsHint = 60_000, now = Date.now()) {
    let dropped = 0;
    for (const [guildId, state] of states) {
        if (state.waveUntil > now) continue;
        const last = state.entries.length ? state.entries[state.entries.length - 1].t : 0;
        if (now - last <= windowMsHint) continue;
        states.delete(guildId);
        dropped += 1;
    }
    return dropped;
}

/** Remise à zéro complète — tests, et retrait du bot d'un serveur. */
function forget(guildId) {
    if (guildId === undefined) states.clear();
    else states.delete(guildId);
}

module.exports = {
    registerJoin,
    sweepIdle,
    forget,
    MAX_PUNISHED_PER_WAVE,
    // Exporté pour les tests : la taille de la Map est la mesure directe de la
    // borne mémoire annoncée en tête de fichier.
    _states: states,
};
