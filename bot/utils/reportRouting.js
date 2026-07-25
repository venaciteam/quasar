// ═══════════════════════════════════════════════════════════════
//  Routage des signalements
//
//  Deux natures de signalement, deux destinataires différents — les confondre
//  serait à la fois inutile et indiscret :
//
//   • BUG DU LOGICIEL — « la commande plante », « le dashboard affiche n'importe
//     quoi ». Concerne le code : le destinataire est la personne qui développe
//     Quasar. Par défaut Venacity, qui l'écrit ; un fork peut pointer ailleurs.
//
//   • ABUS D'USAGE — « ce serveur se sert du bot pour harceler », « le staff
//     détourne les tickets ». Ne concerne pas le code mais l'exploitation de
//     cette instance-là. Le destinataire est l'opérateur de l'instance, pas
//     l'auteur du logiciel. Envoyer ça à Venacity depuis l'instance d'un tiers
//     reviendrait à lui transmettre des signalements qui ne la regardent pas,
//     et sur lesquels elle n'a aucun pouvoir d'action.
//
//  D'où deux destinations distinctes et configurables séparément.
// ═══════════════════════════════════════════════════════════════

// Bug logiciel : destination par défaut, l'équipe qui maintient Quasar.
const DEFAULT_BUG_RELAY = 'https://sema.vena.city';

/**
 * Où partent les signalements de bug du logiciel.
 * Toujours défini : à défaut de configuration, l'auteur du logiciel.
 */
function getBugRelayUrl() {
    return (process.env.REPORT_RELAY_URL || DEFAULT_BUG_RELAY).replace(/\/+$/, '');
}

/**
 * Où partent les signalements d'abus d'usage.
 * Volontairement VIDE par défaut : sans configuration explicite de l'opérateur,
 * aucun signalement d'abus ne quitte l'instance. Un auto-hébergeur qui n'a rien
 * configuré ne doit pas voir les plaintes de ses membres partir chez un tiers.
 */
function getAbuseRelayUrl() {
    const raw = process.env.ABUSE_REPORT_URL;
    if (!raw || !raw.trim()) return null;
    try {
        const url = new URL(raw.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.href.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/**
 * Coordonnées de signalement affichées quand aucun relais d'abus n'est configuré :
 * à qui l'utilisateur doit s'adresser directement.
 */
function getAbuseContact() {
    const contact = process.env.INSTANCE_ABUSE_CONTACT;
    return contact && contact.trim() ? contact.trim().slice(0, 300) : null;
}

function getOperatorName() {
    const name = process.env.INSTANCE_OPERATOR_NAME;
    return name && name.trim() ? name.trim().slice(0, 120) : null;
}

/**
 * Transmet un signalement au relais indiqué, au format attendu par l'API publique
 * de report (multipart/form-data).
 *
 * @returns {Promise<{ ok: boolean, status: number|null, error: string|null }>}
 */
async function sendReport({ relayUrl, kind, description, contact, guildId, serviceVersion }) {
    const form = new FormData();
    form.append('type', kind === 'abuse' ? 'bug' : 'bug'); // l'API ne connaît que bug|suggestion
    form.append('service', 'Quasar');
    form.append('service_version', serviceVersion || '');
    form.append('description', description);
    if (contact) form.append('contact', contact);
    form.append('platform', 'Discord');
    form.append('url', 'discord://signalement');

    // `context` porte la nature réelle du signalement et sa provenance : c'est ce
    // qui permet de distinguer un bug d'un abus à la réception, et de savoir de
    // quelle instance il vient.
    form.append('context', JSON.stringify({
        kind,
        source: 'commande /signaler',
        guild_id: guildId || null,
        operator: getOperatorName(),
    }));

    try {
        const response = await fetch(`${relayUrl}/api/public/report`, {
            method: 'POST',
            body: form,
        });
        if (!response.ok) {
            return { ok: false, status: response.status, error: `HTTP ${response.status}` };
        }
        return { ok: true, status: response.status, error: null };
    } catch (err) {
        return { ok: false, status: null, error: err.message };
    }
}

module.exports = {
    DEFAULT_BUG_RELAY,
    getBugRelayUrl,
    getAbuseRelayUrl,
    getAbuseContact,
    getOperatorName,
    sendReport,
};
