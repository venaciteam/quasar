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
//
//  ─── Bi-format, le temps de la migration multiplateforme ───────────────────
//
//  La signature publique de ce module est VERROUILLÉE hors de ce lot :
//  `api/routes/antiraid.js` appelle `enterPanic(guild, …)` / `liftPanic(guild, …)`
//  et `bot/index.js` appelle `startPanicSweeper(client)`. Aucun lot parallèle ne
//  peut corriger ces deux fichiers : chaque fonction publique accepte donc les
//  deux mondes, exactement comme `bot/utils/punishments.js`.
//
//    voie neutre     — une PORTÉE (`ctx`, adaptateur, ou `{ guildeId, api }`),
//                      reconnue par `resoudrePorteeNeutre`. Toute la mécanique
//                      passe par quatre méthodes du client REST normalisé :
//                      `mettreInvitationsEnPause`, `obtenirEtatInvitations`,
//                      `obtenirMembre` et, pour le balayage, `listerGuildes`.
//    voie historique — `Guild` discord.js, `Client` pour le balayeur.
//                      Comportement inchangé, marqué `// TRANSITION : format
//                      historique, à retirer au lot de consolidation`.
//
//  `discord.js` n'est plus importé en tête : les deux énumérations dont la voie
//  historique a encore besoin (`GuildFeature`, `PermissionFlagsBits`) sont
//  chargées PARESSEUSEMENT, dans la branche historique seule. Un processus
//  Fluxer n'évalue donc jamais la bibliothèque par ce fichier.
//
//  ⚠️ Une capacité garde la porte : `capacites.pauseInvitations`. Une plateforme
//  qui ne la déclare pas ressort en `{ ok: false, skipped: 'indisponible' }` —
//  jamais en erreur, parce qu'un serveur qui n'a pas d'action d'incident n'est
//  pas un serveur en panne.
//
//  ⚠️ Deux écarts assumés de la voie neutre, tous deux du côté prudent :
//   • `api.mettreInvitationsEnPause(id, null)` retire l'action d'incident ET la
//     fonction INVITES_DISABLED, là où la voie historique n'annulait que la
//     méthode réellement employée. Sans conséquence : la branche
//     `previous_invites_disabled` sort AVANT et protège la décision d'autrui.
//   • le repli « permanent » ne peut plus citer la cause du refus de l'action
//     d'incident — l'adaptateur l'absorbe. Le repli reste journalisé, pas son
//     motif.
// ═══════════════════════════════════════════════════════════════

const { embed } = require('../../platform/embed');
const { getDb } = require('../../../api/services/database');
const { resoudrePorteeNeutre } = require('../../utils/errors');
const { sendAutomodLog, formatDuration } = require('../../utils/punishments');

// Valeurs de la colonne `antiraid_panic.method`. Ce sont des données PERSISTÉES
// et lues par le dashboard : elles ne suivent pas le vocabulaire de la voie
// empruntée que rend `api.mettreInvitationsEnPause`, d'où la table ci-dessous.
const METHOD_INCIDENT_ACTIONS = 'incident_actions';
const METHOD_INVITES_DISABLED = 'invites_disabled';

// Voie rendue par le contrat -> méthode enregistrée en base.
// « levee » n'y figure pas : c'est la réponse d'une LEVÉE, jamais d'une pose.
const METHODE_PAR_VOIE = Object.freeze({
    incident: METHOD_INCIDENT_ACTIONS,
    permanent: METHOD_INVITES_DISABLED,
});

const REFUS_PERMISSION =
    'Permission « Gérer le serveur » manquante : je ne peux pas mettre les invitations en pause.';

// Cadence du balayage. Plus serrée que celle des bannissements temporaires
// (60 s) : un mode panique peut durer 30 secondes, une minute de retard à la
// levée y serait une minute de trop.
const SWEEP_TICK_MS = 15_000;
// Le balayage démarre vite après le `ready` : un mode panique dont l'échéance
// est passée pendant l'arrêt du bot doit être levé sans attendre.
const SWEEP_BOOT_DELAY_MS = 10_000;

let sweepHandle = null;
let sweepBootHandle = null;

// Verrou de ré-entrance du balayage. Le tick est de 15 s et une levée fait des
// appels réseau : sur plusieurs serveurs échus en même temps, un tour peut
// déborder sur le suivant, qui relirait alors les MÊMES lignes (elles ne sont
// supprimées qu'une fois la levée faite) et posterait un second message
// « Mode panique levé » dans le salon de logs. Modèle : bot/modules/breach/index.js.
let sweeping = false;

// Verrou par serveur. Le balayage n'est pas le seul chemin vers liftPanic : une
// levée manuelle (commande, dashboard) peut tomber exactement pendant celle du
// balayage, et le verrou de boucle ne la verrait pas passer. Deux levées
// simultanées sur un même serveur = deux messages de levée.
const lifting = new Set();

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
// TRANSITION : format historique, à retirer au lot de consolidation
function invitesAlreadyPaused(guild, now = Date.now()) {
    // Chargement paresseux : c'est la SEULE raison pour laquelle ce fichier
    // touche encore discord.js, et un processus Fluxer n'emprunte jamais cette
    // branche — donc n'évalue jamais la bibliothèque.
    const { GuildFeature } = require('discord.js');
    if (Array.isArray(guild?.features) && guild.features.includes(GuildFeature.InvitesDisabled)) return true;
    const until = guild?.incidentsData?.invitesDisabledUntil;
    return !!until && new Date(until).getTime() > now;
}

/** Même question, par le contrat : `{ enPauseJusqua, desactiveesEnDur } | null`. */
async function invitesDejaEnPauseNeutre(portee, guildeId, now) {
    const etat = await portee.api.obtenirEtatInvitations(guildeId).catch(() => null);
    // `null` = bot retiré du serveur, ou état illisible. On ne retient alors
    // AUCUN état d'origine : c'est le défaut qui rouvre à la levée, et donc le
    // seul qui ne laisse pas un serveur fermé par excès de prudence.
    if (!etat) return false;
    return etat.desactiveesEnDur || (!!etat.enPauseJusqua && etat.enPauseJusqua > now);
}

// TRANSITION : format historique, à retirer au lot de consolidation
function canManageGuild(guild) {
    const { PermissionFlagsBits } = require('discord.js');
    return !!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageGuild);
}

/**
 * Le bot a-t-il le droit de mettre les invitations en pause, sur la voie neutre ?
 *
 * Rend `null` — donc « on laisse passer » — quand la réponse est INDÉTERMINABLE
 * (adaptateur pas encore connecté, membre illisible). Même posture que
 * `refusPermissionBanNeutre` dans punishments.js : inventer un refus
 * empêcherait une mesure légitime, alors qu'en laissant passer c'est la
 * plateforme qui tranchera, et son erreur sera rapportée telle quelle.
 *
 * @returns {Promise<string|null>} motif du refus, ou null
 */
async function refusPermissionNeutre(portee, guildeId) {
    if (!portee.moiId) return null;
    const moi = await portee.api.obtenirMembre(guildeId, portee.moiId).catch(() => null);
    if (!moi || typeof moi.aPermission !== 'function') return null;
    return moi.aPermission('MANAGE_GUILD') ? null : REFUS_PERMISSION;
}

// ─── Pose ───────────────────────────────────────────────────────────────────

/**
 * Bascule le serveur en mode panique jusqu'à `durationSeconds`.
 * Ne lève jamais.
 *
 * @param {object}  cible  portée neutre (`ctx`, adaptateur, `{ guildeId, api }`),
 *   ou `Guild` discord.js sur la voie historique
 * @param {object}  options
 * @param {number}  options.durationSeconds — 0 : le mode panique est désactivé
 * @param {string}  options.reason
 * @param {string}  [options.triggeredBy]   — 'detection' ou un identifiant de personne
 * @param {string}  [options.logChannelId]
 * @returns {Promise<{ ok: boolean, skipped?: string, method?: string,
 *                     expiresAt?: number, extended?: boolean, error?: string }>}
 *   `skipped: 'disabled'`     — durée réglée à 0 sur ce serveur ;
 *   `skipped: 'indisponible'` — la plateforme ne sait pas suspendre ses invitations.
 */
async function enterPanic(cible, { durationSeconds, reason, triggeredBy = 'detection', logChannelId = null } = {}) {
    if (!cible) return { ok: false, error: 'Serveur indisponible.' };

    const seconds = Number(durationSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, skipped: 'disabled' };
    }

    const portee = resoudrePorteeNeutre(cible);
    const guildeId = portee ? portee.guildeId : cible.id;
    // Une portée neutre sans serveur ne désigne rien : même issue qu'une guilde
    // absente, plutôt qu'une ligne de mode panique écrite sur `null`.
    if (!guildeId) return { ok: false, error: 'Serveur indisponible.' };

    // Capacité, et pas nom de plateforme. Le test n'est posé que si l'appelant
    // DÉCLARE ses capacités : une portée littérale `{ guildeId, api }` n'en a
    // pas, et lui refuser la mesure pour cette raison serait absurde.
    const capacites = cible.capacites;
    if (portee && capacites && !capacites.pauseInvitations) {
        return { ok: false, skipped: 'indisponible' };
    }

    const refus = portee
        ? await refusPermissionNeutre(portee, guildeId)
        // TRANSITION : format historique, à retirer au lot de consolidation
        : (canManageGuild(cible) ? null : REFUS_PERMISSION);
    if (refus) return { ok: false, error: refus };

    const now = Date.now();
    const expiresAt = Math.floor(now / 1000) + Math.floor(seconds);
    const existing = getPanicRow(guildeId);
    const extended = !!existing && existing.expires_at * 1000 > now;

    // L'état d'origine n'est relevé qu'à la PREMIÈRE pose. Le relire pendant une
    // prolongation retiendrait l'état que je viens moi-même d'installer, et la
    // levée ne rouvrirait alors jamais les invitations.
    const previousInvitesDisabled = existing
        ? !!existing.previous_invites_disabled
        : (portee
            ? await invitesDejaEnPauseNeutre(portee, guildeId, now)
            // TRANSITION : format historique, à retirer au lot de consolidation
            : invitesAlreadyPaused(cible, now));

    let method = null;

    if (portee) {
        // Le contrat encapsule les deux mécanismes ET le repli de l'un sur
        // l'autre : il rend la voie réellement empruntée, qu'on traduit en
        // valeur de la colonne `method`.
        let voie;
        try {
            voie = await portee.api.mettreInvitationsEnPause(guildeId, expiresAt * 1000, reason);
        } catch (err) {
            return {
                ok: false,
                error: `Les invitations n'ont pas pu être mises en pause : ${err?.message || 'erreur inconnue'}.`,
            };
        }
        method = METHODE_PAR_VOIE[voie];
        if (!method) {
            // Un adaptateur qui rend autre chose que « incident » ou
            // « permanent » à une POSE est cassé. On ne devine pas une méthode :
            // la ligne écrite servirait ensuite à choisir comment lever.
            return { ok: false, error: `Voie de mise en pause inattendue : « ${voie} ».` };
        }
        if (method === METHOD_INVITES_DISABLED) {
            // Le repli n'a pas d'échéance côté plateforme : c'est le balayage
            // ci-dessous qui la tiendra, et c'est précisément pour ce cas que
            // l'état est persisté. Le motif du refus, lui, est absorbé par
            // l'adaptateur (cf. en-tête).
            console.warn('[Quasar Anti-raid] Action d\'incident refusée, repli sur INVITES_DISABLED : '
                + 'la levée dépend désormais du balayage.');
        }
    } else {
        // TRANSITION : format historique, à retirer au lot de consolidation
        let apiError = null;
        try {
            await cible.setIncidentActions({ invitesDisabledUntil: new Date(expiresAt * 1000) });
            method = METHOD_INCIDENT_ACTIONS;
        } catch (err) {
            apiError = err;
        }

        if (!method) {
            // Repli. Il n'a pas d'échéance côté Discord : c'est le balayage qui la
            // tiendra, et c'est précisément pour ce cas que l'état est persisté.
            try {
                await cible.disableInvites(true);
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
    }

    try {
        savePanicRow({
            guildId: guildeId, method, expiresAt,
            previousInvitesDisabled, reason, triggeredBy,
        });
    } catch (err) {
        // La posture est posée sur la plateforme mais l'échéance n'a pas pu être
        // écrite : avec la méthode native, la plateforme lèvera quand même. Avec
        // le repli, personne ne lèvera — on annule immédiatement plutôt que de
        // laisser un verrou sans horloge.
        console.error('[Quasar Anti-raid] Échéance de mode panique non enregistrée :', err.message);
        if (method === METHOD_INVITES_DISABLED && !previousInvitesDisabled) {
            if (portee) await portee.api.mettreInvitationsEnPause(guildeId, null, reason).catch(() => {});
            // TRANSITION : format historique, à retirer au lot de consolidation
            else await cible.disableInvites(false).catch(() => {});
            return { ok: false, error: 'L\'échéance du mode panique n\'a pas pu être enregistrée : rien n\'a été appliqué.' };
        }
    }

    await sendPanicLog(cible, {
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
 * @param {object} cible  portée neutre, ou `Guild` discord.js
 * @param {object} [options]
 * @param {object} [options.row]        — ligne déjà lue (évite un SELECT au balayage)
 * @param {string} [options.liftedBy]   — identifiant de personne, pour une levée manuelle
 * @param {string} [options.logChannelId]
 * @returns {Promise<{ ok: boolean, skipped?: string, retry?: boolean, error?: string }>}
 */
async function liftPanic(cible, { row = null, liftedBy = null, logChannelId = null } = {}) {
    if (!cible) return { ok: false, error: 'Serveur indisponible.' };

    const portee = resoudrePorteeNeutre(cible);
    const guildeId = portee ? portee.guildeId : cible.id;
    if (!guildeId) return { ok: false, error: 'Serveur indisponible.' };

    // Verrou de ré-entrance, à la maille du serveur : c'est là qu'un doublon se
    // verrait (deux messages de levée pour une seule levée).
    if (lifting.has(guildeId)) return { ok: false, skipped: 'in_progress' };
    lifting.add(guildeId);
    try {
        const state = row || getPanicRow(guildeId);
        if (!state) return { ok: false, skipped: 'not_active' };

        // Les invitations étaient déjà en pause avant mon intervention : je retire
        // mon échéance, pas la décision de quelqu'un d'autre.
        if (state.previous_invites_disabled) {
            forgetPanicRow(guildeId);
            await sendPanicLog(cible, { entering: false, method: state.method, liftedBy, restoredNothing: true, logChannelId });
            return { ok: true };
        }

        // ─── ORDRE DES ÉCRITURES ────────────────────────────────────────────
        // Méthode native : l'échéance est tenue par la plateforme, le serveur se
        // rouvre même si ce processus disparaît. La ligne est donc supprimée
        // AVANT l'appel : un SIGTERM entre l'appel et la suppression
        // (redéploiement) laisserait sinon la ligne échue en base, et le balayage
        // suivant posterait un SECOND message de levée.
        //
        // Le repli INVITES_DISABLED ne peut pas suivre la même règle : personne
        // d'autre que moi ne rouvrira les invitations. Supprimer la ligne d'abord
        // exposerait à un serveur fermé pour toujours si le processus meurt entre
        // les deux. Un message de levée en double est infiniment préférable, la
        // ligne n'est donc supprimée qu'après succès.
        const holdsOwnDeadline = state.method !== METHOD_INVITES_DISABLED;
        if (holdsOwnDeadline) forgetPanicRow(guildeId);

        try {
            // Une seule méthode neutre pour les deux mécanismes : elle retire
            // l'action d'incident ET la fonction de serveur. Voir l'en-tête —
            // c'est plus large que la voie historique, jamais plus risqué.
            if (portee) await portee.api.mettreInvitationsEnPause(guildeId, null);
            // TRANSITION : format historique, à retirer au lot de consolidation
            else if (state.method === METHOD_INVITES_DISABLED) await cible.disableInvites(false);
            else await cible.setIncidentActions({ invitesDisabledUntil: null });
        } catch (err) {
            // Le repli n'a pas d'échéance côté plateforme : tant qu'il n'est pas
            // levé, le serveur reste fermé. On garde la ligne et on retentera —
            // c'est la même règle que la levée des bannissements temporaires.
            if (state.method === METHOD_INVITES_DISABLED) {
                console.error('[Quasar Anti-raid] Levée du mode panique en échec, nouvelle tentative au prochain passage :', err?.message);
                return { ok: false, retry: true, error: err?.message || 'Erreur inconnue.' };
            }
            // Méthode native : l'échéance est tenue par la plateforme, le serveur
            // est déjà rouvert ou le sera à la seconde près. Insister n'apporterait rien.
            console.error('[Quasar Anti-raid] Retrait de l\'action d\'incident en échec (sans conséquence, la plateforme tient l\'échéance) :', err?.message);
        }

        if (!holdsOwnDeadline) forgetPanicRow(guildeId);
        await sendPanicLog(cible, { entering: false, method: state.method, liftedBy, logChannelId });
        return { ok: true };
    } finally {
        // finally obligatoire : une exception qui laisserait le verrou posé
        // rendrait ce serveur définitivement inlevable.
        lifting.delete(guildeId);
    }
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

    const champs = entering
        ? [
            { nom: 'Mesure', valeur: METHOD_LABELS[method] || method, enLigne: false },
            { nom: 'Durée', valeur: formatDuration(durationSeconds * 1000), enLigne: true },
            { nom: 'Levée automatique', valeur: `<t:${expiresAt}:R>`, enLigne: true },
            {
                nom: 'Déclenchement',
                valeur: triggeredBy && triggeredBy !== 'detection' ? `<@${triggeredBy}>` : 'Détection automatique',
                enLigne: true,
            },
            { nom: 'Motif', valeur: (reason || 'Vague d\'arrivées détectée').slice(0, 1024) },
        ]
        : [
            {
                nom: 'Levée',
                valeur: liftedBy ? `Manuelle, par <@${liftedBy}>` : 'Automatique, à l\'échéance',
                enLigne: true,
            },
            {
                nom: 'Invitations',
                valeur: restoredNothing
                    ? 'Laissées en pause : elles l\'étaient déjà avant le mode panique.'
                    : 'Rouvertes.',
            },
        ];

    await sendAutomodLog(guild, embed({
        couleur: entering ? 0xe74c3c : 0x2ecc71,
        titre: entering
            ? (extended ? '🚨 Mode panique prolongé' : '🚨 Mode panique activé')
            : '✅ Mode panique levé',
        champs,
        horodatage: true,
    }), 'mod_ban', logChannelId);
}

// ─── Balayage ───────────────────────────────────────────────────────────────

/**
 * Lève les modes panique arrivés à terme.
 * Exporté pour permettre une levée immédiate sans attendre le tour de boucle
 * (tests, opération manuelle).
 *
 * @param {object} cible  adaptateur de plateforme (voie neutre), ou `Client`
 *   discord.js sur la voie historique
 */
async function sweepExpiredPanics(cible, now = Date.now()) {
    // Verrou de ré-entrance : un tour qui déborde ne doit pas être doublé par le
    // suivant. Le tour en cours traitera la file entière.
    if (sweeping) return 0;
    sweeping = true;
    try {
        const portee = resoudrePorteeNeutre(cible);

        // Quels serveurs le bot connaît-il ? La distinction est VITALE : la
        // branche « serveur introuvable » ci-dessous SUPPRIME l'échéance, ce qui
        // laisserait un serveur fermé pour toujours si la réponse n'était en fait
        // que « je ne sais pas encore ».
        let guildes = null;
        if (portee) {
            const liste = await portee.api.listerGuildes();
            // `null` = indéterminable (connexion incomplète) : on ne touche à
            // RIEN. `[]` = connecté et réellement sur aucun serveur : les
            // échéances en base n'ont plus d'objet et seront oubliées, une par
            // une, par la boucle ci-dessous.
            if (liste === null) return 0;
            guildes = new Set(liste);
        } else if (!cible?.guilds?.cache || cible.guilds.cache.size === 0) {
            // TRANSITION : format historique, à retirer au lot de consolidation
            // Cache vide = connexion incomplète, pas un bot sans serveur. Le
            // cache de discord.js ne sait pas exprimer la différence, d'où cette
            // sortie plus prudente que celle de la voie neutre.
            return 0;
        }

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
            let porteeDuServeur;
            if (portee) {
                if (!guildes.has(row.guild_id)) {
                    // Bot retiré du serveur : il n'y a plus rien à lever, et garder
                    // l'échéance ferait retenter indéfiniment.
                    forgetPanicRow(row.guild_id);
                    continue;
                }
                // Portée d'écriture du serveur courant : l'adaptateur ne porte pas
                // de `guildeId`, et `liftPanic` en a besoin pour lire sa ligne,
                // poser son verrou et journaliser.
                porteeDuServeur = {
                    guildeId: row.guild_id,
                    api: portee.api,
                    moiId: portee.moiId,
                    capacites: cible.capacites,
                };
            } else {
                // TRANSITION : format historique, à retirer au lot de consolidation
                porteeDuServeur = cible.guilds.cache.get(row.guild_id);
                if (!porteeDuServeur) {
                    forgetPanicRow(row.guild_id);
                    continue;
                }
            }

            const result = await liftPanic(porteeDuServeur, { row }).catch(err => {
                console.error('[Quasar Anti-raid] Levée du mode panique en échec :', err?.message);
                return { ok: false, retry: true };
            });
            if (result.ok) lifted += 1;
        }
        return lifted;
    } finally {
        // finally obligatoire : sans lui, une exception fige le balayage jusqu'au
        // prochain redémarrage, et les modes panique ne seraient plus jamais levés.
        sweeping = false;
    }
}

/**
 * Démarre le balayage des modes panique arrivés à terme, et le ménage de la
 * fenêtre glissante. Idempotent : un second appel ne crée pas de seconde boucle.
 *
 * @param {object} cible  adaptateur de plateforme, ou `Client` discord.js
 */
function startPanicSweeper(cible) {
    if (sweepHandle) return;
    const { sweepIdle } = require('./window');

    const run = () => {
        sweepExpiredPanics(cible).catch(() => {});
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

/**
 * Arrête le balayage. Symétrique de `startPanicSweeper`, idempotent.
 *
 * Les deux timers sont `unref()`, donc ils ne retiennent pas le processus : ce
 * qu'on ferme ici, c'est la possibilité qu'un tour parte PENDANT le drainage,
 * après la fermeture de la base. Aujourd'hui l'erreur qui en résulterait serait
 * avalée et le processus sortirait juste après — autrement dit ça tient par
 * chance, pas par conception. Un arrêt ordonné n'a pas à reposer sur la chance.
 */
function stopPanicSweeper() {
    if (sweepBootHandle) { clearTimeout(sweepBootHandle); sweepBootHandle = null; }
    if (sweepHandle) { clearInterval(sweepHandle); sweepHandle = null; }
}

module.exports = {
    enterPanic,
    liftPanic,
    getPanicState,
    sweepExpiredPanics,
    startPanicSweeper,
    stopPanicSweeper,
};
