// ═══════════════════════════════════════════════════════════════
//  Archivage des transcripts de tickets
//
//  Un ticket contient une conversation privée entre un membre et le staff. À la
//  fermeture, le salon est supprimé : si le transcript était conservé en base,
//  celle-ci deviendrait la seule copie subsistante de cette conversation.
//  Quasar ne veut pas de ce rôle — d'autant que la Discord Developer Policy
//  (point 16) interdit d'obtenir via l'API des données sensibles au sens des lois
//  applicables, ce qu'une conversation de support peut parfaitement contenir.
//
//  Le transcript est donc remis à l'administrateur, dans le salon de logs ou en
//  message privé, sous sa responsabilité, et n'est jamais écrit en base.
//
//  Entièrement neutre : la pièce jointe voyage sous la forme `{ nom, donnees,
//  description }` du contrat, et les deux envois passent par `api.envoyerMessage`.
// ═══════════════════════════════════════════════════════════════

const { getLogConfig } = require('./logger');
const { resoudrePorteeNeutre } = require('./errors');

// Marge très en dessous de la limite d'upload Discord la plus basse (8 Mo sur les
// anciens paliers). Un transcript de 500 messages pèse en pratique quelques dizaines
// de Ko : ce plafond ne sert qu'aux cas pathologiques.
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

/**
 * Construit le fichier .txt à joindre.
 * Le format texte est délibéré : lisible tel quel dans Discord, et aucun risque
 * d'interprétation du contenu (contrairement à du HTML).
 *
 * @param {object} spec
 * @param {{id: string, nom: string}} spec.guilde  guilde NORMALISÉE (`ctx.guilde`)
 * @returns {{ fichier: {nom: string, donnees: Buffer, description: string},
 *             truncated: boolean, bytes: number }}
 */
function buildTranscriptFile({ ticketId, guilde, ticket, closedBy, reason, transcript, messageCount }) {
    const header = [
        `Transcript du ticket #${ticketId}`,
        `Serveur      : ${guilde.nom} (${guilde.id})`,
        `Ouvert par   : ${ticket.user_id}`,
        `Ouvert le    : ${ticket.opened_at || 'inconnu'}`,
        `Fermé par    : ${closedBy}`,
        `Fermé le     : ${new Date().toISOString()}`,
        `Raison       : ${reason}`,
        `Messages     : ${messageCount}`,
        '',
        'Ce fichier est la seule copie de cette conversation. Quasar n\'en conserve aucune',
        'trace : sa conservation, sa diffusion et sa suppression relèvent de l\'administrateur',
        'de ce serveur.',
        '='.repeat(78),
        '',
    ].join('\n');

    let body = transcript || '(aucun message)';
    let truncated = false;

    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (headerBytes + Buffer.byteLength(body, 'utf8') > MAX_ATTACHMENT_BYTES) {
        // Tronquer par la fin : on garde le début de la conversation, généralement
        // le plus utile pour comprendre la demande.
        const budget = MAX_ATTACHMENT_BYTES - headerBytes - 256;
        body = Buffer.from(body, 'utf8').subarray(0, Math.max(0, budget)).toString('utf8');
        body += '\n\n[...] Transcript tronqué : la conversation dépassait la taille maximale ' +
                'd\'une pièce jointe Discord.';
        truncated = true;
    }

    const content = header + body;
    const safeDate = new Date().toISOString().slice(0, 10);

    return {
        fichier: {
            nom: `ticket-${ticketId}-${safeDate}.txt`,
            donnees: Buffer.from(content, 'utf8'),
            description: `Transcript du ticket #${ticketId}`,
        },
        truncated,
        bytes: Buffer.byteLength(content, 'utf8'),
    };
}

/**
 * Remet le transcript à l'administrateur. Deux destinations, dans l'ordre :
 *
 *  1. le salon de logs du serveur, s'il est configuré et joignable ;
 *  2. à défaut, un message privé au modérateur qui ferme le ticket.
 *
 * Aucun repli sur la base de données : c'est précisément la conservation qu'on
 * supprime. Si les deux échouent, l'appelant doit refuser la fermeture plutôt que
 * de détruire le salon avec la conversation dedans.
 *
 * Note : le réglage `ticket_close` des logs commande l'embed de notification, pas
 * l'archivage. Un serveur qui a configuré un salon de logs y reçoit son transcript
 * même s'il a désactivé la notification — sans quoi le comportement par défaut
 * (notification désactivée) enverrait un message privé à chaque fermeture.
 *
 * ⚠️ Le salon de logs disparu ne se distingue plus d'un envoi refusé : la voie
 * historique consultait le cache de discord.js avant d'écrire, le client REST
 * neutre n'a pas de cache. Les deux cas mènent au même repli — le message privé —
 * et à la même ligne de journal.
 *
 * @param {object} spec
 * @param {object} spec.portee         `ctx` neutre, ou `{ guildeId, api }`
 * @param {string} spec.moderateurId   destinataire du repli en message privé
 * @param {object} spec.embed          embed NEUTRE de notification
 * @param {object} spec.fichier        { nom, donnees, description }
 * @returns {Promise<{ ok: boolean, via: 'log'|'dm'|null, truncated: boolean, error: string|null }>}
 */
async function deliverTranscript({ portee, moderateurId, embed, fichier, truncated = false }) {
    const resolue = resoudrePorteeNeutre(portee);
    if (!resolue || !resolue.guildeId) {
        return { ok: false, via: null, truncated, error: 'portée neutre inutilisable' };
    }

    const fichiers = [fichier];

    // 1. Salon de logs
    const config = getLogConfig(resolue.guildeId);
    if (config.logChannel) {
        try {
            await resolue.api.envoyerMessage(config.logChannel, { embeds: [embed], fichiers });
            return { ok: true, via: 'log', truncated, error: null };
        } catch (err) {
            console.error(`[Quasar] Transcript : envoi au salon de logs impossible (${err.message}) — repli sur message privé.`);
        }
    }

    // 2. Message privé au modérateur
    try {
        const canalPrive = await resolue.api.ouvrirMessagePrive(moderateurId);
        await resolue.api.envoyerMessage(canalPrive, {
            contenu:
                '📄 Transcript du ticket que vous venez de fermer.\n' +
                'Il t\'arrive en privé parce que ce serveur n\'a pas de salon de logs configuré, ' +
                'ou que Quasar ne peut pas y écrire. Ce fichier est la seule copie de la conversation : ' +
                'le bot n\'en garde aucune.',
            embeds: [embed],
            fichiers,
        });
        return { ok: true, via: 'dm', truncated, error: null };
    } catch (err) {
        return {
            ok: false,
            via: null,
            truncated,
            error: err.message,
        };
    }
}

module.exports = { buildTranscriptFile, deliverTranscript, MAX_ATTACHMENT_BYTES };
