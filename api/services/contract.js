// =============================================================================
// Module partagé : contrat de sous-traitance (Lot 2 conformité RGPD, art. 28)
//
// Source de vérité pour la version du contrat et la logique d'acceptation. Toute
// la logique de gating (sous-lot B) et l'annonce d'une nouvelle version lisent la
// constante CONTRACT_VERSION exportée ici : un bump = nouvelle acceptation exigée.
//
// Le contrat de référence est rédigé dans :
//   ~/DEV/Juridique/Contrat de sous-traitance - Instance Quasar Venacity.md (v1.0)
// =============================================================================

const { getDb } = require('./database');

// Version du contrat en vigueur. Un incrément déclenche une nouvelle acceptation
// (gating basé sur cette valeur, cf. Conventions partagées de la DA).
const CONTRACT_VERSION = '1.0';

// URL publique du texte complet du contrat, affichée sur l'écran d'acceptation.
// Publié sur Strata (site légal public), au même titre que les CGU et la politique
// de confidentialité. Doit rester alignée sur le slug de l'article Strata.
const DEFAULT_CONTRACT_PUBLIC_URL = 'https://strata.vena.city/contrat-quasar';

// N'accepter que des URL http(s) : une valeur mal saisie — ou un `javascript:` —
// ne doit jamais se retrouver dans un href de l'ecran d'acceptation.
// Meme garde-fou que api/routes/instance.js.
function sanitizeUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value).trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.href;
    } catch {
        return null;
    }
}

// URL publique du texte integral, configurable par l'operateur de l'instance.
// Un tiers qui ouvre sa propre instance publie SON contrat et pointe ici dessus,
// sans avoir a modifier le code. A defaut, le contrat de l'instance Venacity.
function getContractPublicUrl() {
    return sanitizeUrl(process.env.CONTRACT_PUBLIC_URL) || DEFAULT_CONTRACT_PUBLIC_URL;
}

// Points clés du contrat, fidèles au texte v1.0, pour l'écran d'acceptation.
// Résumé informatif : le lien vers le texte intégral (CONTRACT_PUBLIC_URL) reste
// la référence juridique. À revoir si le contrat change de version.
const CONTRACT_SUMMARY = [
    'Venacity est sous-traitant au sens de l\'article 28 du RGPD. En tant qu\'administratrice ou administrateur d\'un serveur connecté, vous restez le responsable de traitement : vous décidez, Venacity exécute vos réglages.',
    'Données traitées : uniquement des identifiants techniques Discord, les sanctions de modération, les métadonnées de tickets (jamais le contenu des conversations) et vos configurations de serveur. Ni nom, ni e-mail, ni mot de passe.',
    'Venacity ne traite ces données que sur vos instructions (réglages du tableau de bord et commandes), sans finalité propre : aucune revente, aucune exploitation commerciale, aucun transfert hors de l\'Union européenne. Hébergement en Allemagne (netcup), acheminement via Cloudflare.',
    'Toute violation de données vous concernant vous est notifiée sous 24 heures maximum, par message direct, repli en salon si besoin et bannière persistante dans le tableau de bord, avec traçabilité des envois.',
    'Les demandes d\'exercice des droits (dont l\'effacement) vous sont routées : c\'est vous qui décidez, avec une décision motivée obligatoire en cas de refus, sous un délai d\'un mois. Venacity relaie et exécute votre décision, sans se substituer à vous.',
    'Fin de relation : au retrait du bot d\'un serveur, ses données sont supprimées après un délai de grâce de 7 jours (les bannissements encore en vigueur sont conservés). Réinviter le bot avant l\'échéance annule la suppression.',
];

// Le contrat n'a de sens que sur l'instance publique opérée par Venacity : c'est
// elle, et elle seule, qui est sous-traitante des administrateur·rices qui s'y
// connectent. Une instance auto-hébergée (QUASAR_MODE=bot, le défaut) a son propre
// opérateur — lui imposer le contrat de Venacity, qui nomme une autre personne comme
// sous-traitant, n'aurait aucun sens juridique. Toute valeur autre que "public"
// désactive donc l'exigence : on n'impose jamais un contrat par défaut.
//
// Un tiers qui exploite sa PROPRE instance ouverte à d'autres administrateur·rices a
// le même besoin juridique, mais avec SON contrat : il lui revient de remplacer le
// texte servi (dashboard/legal/contrat.html) et le contenu de ce module. La licence
// AGPL-3.0 lui en donne le droit ; le README le documente.
function isContractRequired() {
    return (process.env.QUASAR_MODE || '').trim().toLowerCase() === 'public';
}

// True si l'admin a déjà accepté la version courante du contrat.
function hasAcceptedCurrent(adminId) {
    const db = getDb();
    const row = db.prepare(
        'SELECT 1 FROM contract_acceptances WHERE admin_id = ? AND contract_version = ?'
    ).get(adminId, CONTRACT_VERSION);
    return !!row;
}

// Enregistre l'acceptation de la version courante par l'admin.
// INSERT OR IGNORE : idempotent grâce à la PK (admin_id, contract_version), une
// double soumission ne crée pas de doublon ni d'erreur. Horodatage en unixepoch
// (secondes), cohérent avec le reste des nouvelles colonnes du lot 2.
function recordAcceptance(adminId) {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    return db.prepare(
        'INSERT OR IGNORE INTO contract_acceptances (admin_id, contract_version, accepted_at) VALUES (?, ?, ?)'
    ).run(adminId, CONTRACT_VERSION, now);
}

module.exports = {
    CONTRACT_VERSION,
    isContractRequired,
    DEFAULT_CONTRACT_PUBLIC_URL,
    getContractPublicUrl,
    CONTRACT_SUMMARY,
    hasAcceptedCurrent,
    recordAcceptance,
};
