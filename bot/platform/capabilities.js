// ═══════════════════════════════════════════════════════════════
//  Capacités déclarées d'une plateforme
//
//  Règle structurante du chantier multiplateforme : aucun code métier ne teste
//  `platform.nom === 'fluxer'`. Il teste une CAPACITÉ. La différence n'est pas
//  cosmétique — Fluxer a les slash commands, les boutons et les modals à sa
//  feuille de route. Le jour où elles arrivent, un seul booléen bascule ici et
//  tout le code métier en bénéficie sans être relu. Un `nom === 'fluxer'` semé
//  dans cinquante fichiers demanderait, lui, cinquante relectures.
//
//  Corollaire : une capacité ne se déduit jamais d'une autre à l'usage. Si
//  `ephemere` dépend aujourd'hui de `interactions`, c'est l'adaptateur qui le
//  déclare, pas l'appelant qui le devine.
// ═══════════════════════════════════════════════════════════════

// Toutes à false : une plateforme neuve ne sait rien faire tant qu'elle ne l'a
// pas déclaré. Le défaut permissif serait l'erreur inverse — un adaptateur qui
// oublie de déclarer `audioBot: false` verrait le module musique tenter de
// publier un flux qu'il ne sait pas produire.
const CAPACITES_PAR_DEFAUT = Object.freeze({
    interactions: false,   // slash commands, boutons, menus, modals
    ephemere: false,       // réponse visible du seul destinataire
    automod: false,        // règles de modération automatique natives
    audioBot: false,       // le bot peut publier un flux audio
    timeout: false,        // timeout de communication natif
    bulkDelete: false,     // suppression de messages en lot
    fils: false,           // threads
    pauseInvitations: false, // suspension temporaire des invitations du serveur
});

const NOMS_CAPACITES = Object.freeze(Object.keys(CAPACITES_PAR_DEFAUT));

/**
 * Fabrique le jeu de capacités d'un adaptateur.
 *
 * Une clé inconnue lève, elle n'est pas ignorée : `capacites.interaction` (sans
 * « s ») écrit dans un adaptateur produirait sinon un `undefined` silencieux —
 * donc faux à l'usage — et le parcours riche disparaîtrait sans le moindre
 * message. Mieux vaut refuser de démarrer.
 *
 * @param {Partial<typeof CAPACITES_PAR_DEFAUT>} [surcharges]
 * @returns {Readonly<typeof CAPACITES_PAR_DEFAUT>}
 */
function creerCapacites(surcharges = {}) {
    for (const [cle, valeur] of Object.entries(surcharges)) {
        if (!(cle in CAPACITES_PAR_DEFAUT)) {
            throw new Error(
                `Capacité inconnue : "${cle}". Capacités déclarables : ${NOMS_CAPACITES.join(', ')}.`
            );
        }
        if (typeof valeur !== 'boolean') {
            throw new Error(`La capacité "${cle}" doit valoir true ou false (reçu : ${typeof valeur}).`);
        }
    }
    return Object.freeze({ ...CAPACITES_PAR_DEFAUT, ...surcharges });
}

module.exports = { CAPACITES_PAR_DEFAUT, NOMS_CAPACITES, creerCapacites };
