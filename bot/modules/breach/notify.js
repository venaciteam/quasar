// ═══════════════════════════════════════════════════════════════
//  Notification de violation — Construction + envoi
//
//  Sous-lot C du lot 2 de conformité RGPD. La propriétaire de l'instance
//  (BOT_OWNER_ID) rédige une notification de violation ; ce module construit
//  l'embed correspondant et l'envoie à un destinataire (MP) ou, en repli, dans
//  un salon du serveur concerné.
//
//  Ce fichier ne décide de RIEN : il exécute un envoi et rend compte de son
//  résultat ({ ok, error }). La logique de file, de reprise et de repli est dans
//  index.js. La séparation est volontaire : un envoi qui échoue doit laisser une
//  trace exploitable (art. 33.5 — savoir qui n'a PAS reçu), pas lever une
//  exception qui remonte jusqu'à la boucle.
//
//  ─── Entièrement neutre ────────────────────────────────────────────────────
//
//  Les embeds sont NEUTRES (bot/platform/embed.js) et aucun `discord.js` n'est
//  importé ici. La voie historique — un `Client` discord.js — a été retirée à la
//  consolidation, en même temps que son seul appelant est passé à l'adaptateur
//  (`bot/modules/breach/index.js`).
//
//  Une PORTÉE est donc attendue partout : `ctx`, adaptateur, ou
//  `{ guildeId, api }`, reconnue par `resoudrePorteeNeutre`. Le droit d'écrire
//  dans un salon passe par `api.permissionsSurCanal`, et des permissions
//  illisibles valent refus — ce module trace qui n'a pas reçu (art. 33.5)
//  plutôt que de poster dans un salon dont il ne sait rien.
// ═══════════════════════════════════════════════════════════════

const { embed } = require('../../platform/embed');
const { resoudrePorteeNeutre } = require('../../utils/errors');
const { getLogConfig } = require('../../utils/logger');

// Rouge « alerte », cohérent avec bot/utils/errors.js — une notification de
// violation n'est pas un message anodin.
const COLOR_BREACH = 0xED4245;

// Discord plafonne la description d'un embed à 4096 caractères. On tronque
// proprement plutôt que de laisser l'API rejeter l'embed entier : une
// notification tronquée (avec renvoi au point de contact) vaut infiniment mieux
// qu'une notification jamais partie.
const MAX_DESCRIPTION = 4096;

// Point de contact du sous-traitant (Venacity), imposé par l'art. 33.3.b.
const CONTACT = 'contact@vena.city';

// Pied commun aux deux embeds : une seule écriture du point de contact, qui est
// une mention réglementaire et non un ornement.
const FOOTER = `Point de contact : ${CONTACT} — Venacity, sous-traitant (RGPD art. 28)`;

/**
 * Tronque un texte à `max` caractères en coupant de préférence sur un espace,
 * et en signalant explicitement la troncature.
 */
function truncate(text, max = MAX_DESCRIPTION) {
    const body = String(text || '');
    if (body.length <= max) return body;

    const suffix = '\n\n[…] Message tronqué — la version complète est disponible auprès du point de contact.';
    const room = Math.max(0, max - suffix.length);
    let cut = body.slice(0, room);
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > room * 0.8) cut = cut.slice(0, lastSpace);
    return cut + suffix;
}

/**
 * Construit l'embed d'une notification de violation.
 * @param {object} incident — ligne breach_incidents (peut être partielle : title suffit)
 * @param {object} message  — ligne breach_messages (phase, body, created_at)
 * @returns {object} embed neutre
 */
function buildBreachEmbed(incident, message) {
    const phase = Number(message?.phase) || 1;
    const phaseLabel = phase === 1
        ? 'Phase 1 — notification initiale'
        : `Phase ${phase} — information complémentaire`;

    return embed({
        titre: '⚠️ Notification de violation de données',
        couleur: COLOR_BREACH,
        description: truncate(message?.body),
        champs: [{ nom: 'Notification', valeur: phaseLabel }],
        pied: { texte: FOOTER },
        // `created_at` est en secondes : l'horodatage de l'embed est celui de la
        // RÉDACTION du message, pas celui de l'envoi, qui peut arriver bien plus
        // tard après plusieurs tentatives.
        horodatage: message?.created_at ? message.created_at * 1000 : Date.now(),
        // `auteur` seulement quand l'incident porte un titre : un auteur vide
        // serait rendu comme un bandeau sans texte.
        auteur: incident?.title ? { nom: `Incident : ${incident.title}`.slice(0, 256) } : undefined,
    });
}

/**
 * Embed du REPLI SALON : un pointeur NEUTRE, sans aucun détail de la violation
 * (ni le corps du message, ni les catégories, ni la nature). Un salon — même un
 * salon de logs — reste plus exposé qu'un MP : le contenu sensible ne doit y
 * apparaître à aucun moment. Il redirige simplement vers les MP et le dashboard,
 * où la notification complète est disponible.
 */
function buildBreachPointerEmbed() {
    return embed({
        titre: '⚠️ Notification importante',
        couleur: COLOR_BREACH,
        description:
            'Une notification de sécurité vous attend.\n\n' +
            'Consultez vos messages privés ainsi que le tableau de bord Quasar.',
        pied: { texte: FOOTER },
        horodatage: true,
    });
}

/**
 * Réduit une exception à une chaîne courte et exploitable, stockée dans
 * breach_deliveries.error. On garde le code de la plateforme quand il existe : il
 * suffit à comprendre pourquoi un destinataire n'a pas reçu (MP fermés = 50007,
 * permission manquante = 50013…).
 *
 * Volontairement `err.code` et non `codeNeutre(err)` : c'est une TRACE, pas une
 * décision. Aucune branche de ce fichier ne compare ce code à quoi que ce soit,
 * et le vocabulaire neutre (« permission », « introuvable ») serait ici moins
 * précis que le numéro exact rendu par la plateforme.
 */
function describeError(err) {
    if (!err) return 'erreur inconnue';
    const code = (err.code !== undefined && err.code !== null) ? `[${err.code}] ` : '';
    return (code + (err.message || String(err))).slice(0, 500);
}

/**
 * Envoie l'embed en message privé à un utilisateur.
 *
 * @param {object} cible  portée neutre (`ctx`, adaptateur, `{ guildeId, api }`)
 * @param {string} userId
 * @param {object} contenu embed neutre
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function sendDM(cible, userId, contenu) {
    if (!cible || !userId) return { ok: false, error: 'client ou destinataire indisponible' };

    const portee = resoudrePorteeNeutre(cible);
    if (!portee) return { ok: false, error: 'client ou destinataire indisponible' };

    try {
        // Deux appels et pas un : le contrat neutre ouvre le salon privé
        // (`ouvrirMessagePrive`) puis y poste comme dans n'importe quel
        // salon. `user.send()` faisait les deux d'un coup côté discord.js.
        const canalId = await portee.api.ouvrirMessagePrive(userId);
        await portee.api.envoyerMessage(canalId, contenu);
        return { ok: true, error: null };
    } catch (err) {
        return { ok: false, error: describeError(err) };
    }
}

/**
 * Repli salon : poste un POINTEUR NEUTRE (jamais le contenu de la violation) dans
 * le salon de LOGS de modération du serveur — un salon admin, pas un salon de
 * discussion. La cible est résolue via la config du module 'moderation'
 * (`getLogConfig(guildId).logChannel`).
 *
 * Si aucun salon de logs n'est configuré, introuvable, ou non écrivable par le
 * bot : on N'ÉCRIT nulle part ailleurs (ni salon système, ni premier salon venu)
 * et on renvoie un échec, pour que la boucle le trace (art. 33.5 — qui n'a pas
 * reçu). La bannière dashboard reste le filet indépendant.
 *
 * @param {object} cible  portée neutre (`ctx`, adaptateur, `{ guildeId, api }`)
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function sendToGuildChannel(cible, guildId) {
    if (!cible || !guildId) return { ok: false, error: 'client ou serveur indisponible' };

    // Cible imposée : le salon de logs de modération. Aucun repli vers un salon
    // de discussion. Les trois cas d'indisponibilité partagent la même issue :
    // échec tracé, rien de posté.
    const NO_LOG_CHANNEL = 'aucun salon de logs configure pour le repli';

    // Lu seulement une fois le serveur atteignable : la lecture touche la base
    // et journalise une configuration illisible. La payer avant le contrôle de
    // serveur produirait cette trace pour un serveur que le bot a quitté.
    const salonDeLogs = () => {
        try {
            return getLogConfig(guildId)?.logChannel || null;
        } catch {
            return null;
        }
    };

    const portee = resoudrePorteeNeutre(cible);
    if (!portee) return { ok: false, error: 'client ou serveur indisponible' };

    // `obtenirGuilde` rend null quand le bot n'est plus sur ce serveur, et
    // LÈVE sur une panne. Les deux se traitent ici de la même façon — on
    // n'envoie pas — parce que la boucle retentera de toute manière.
    const guilde = await portee.api.obtenirGuilde(guildId).catch(() => null);
    if (!guilde) return { ok: false, error: 'serveur introuvable dans le cache du bot' };
    // Identité du bot inconnue = adaptateur pas encore connecté.
    if (!portee.moiId) return { ok: false, error: 'membre bot introuvable sur le serveur' };

    const logChannelId = salonDeLogs();
    if (!logChannelId) return { ok: false, error: NO_LOG_CHANNEL };
    const canal = await portee.api.obtenirCanal(logChannelId).catch(() => null);
    if (!canal) return { ok: false, error: NO_LOG_CHANNEL };

    // Droit d'écrire dans CE salon. `null` — permissions illisibles — vaut
    // refus : ce module trace qui n'a pas reçu (art. 33.5) plutôt que de
    // poster dans un salon dont il ne sait rien.
    const permissions = await portee.api.permissionsSurCanal(logChannelId, portee.moiId).catch(() => null);
    const peutEcrire = Boolean(permissions
        && permissions.aPermission('VIEW_CHANNEL')
        && permissions.aPermission('SEND_MESSAGES'));
    if (!peutEcrire) return { ok: false, error: NO_LOG_CHANNEL };

    try {
        await portee.api.envoyerMessage(logChannelId, buildBreachPointerEmbed());
        return { ok: true, error: null };
    } catch (err) {
        return { ok: false, error: describeError(err) };
    }
}

module.exports = {
    COLOR_BREACH,
    MAX_DESCRIPTION,
    CONTACT,
    truncate,
    buildBreachEmbed,
    buildBreachPointerEmbed,
    describeError,
    sendDM,
    sendToGuildChannel,
};
