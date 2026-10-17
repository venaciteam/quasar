// ═══════════════════════════════════════════════════════════════
//  Registre d'événements déclaratif — partie neutre
//
//  Symétrique de `platform/commands.js`, et pour la même raison : sans lui, un
//  handler migré en `{ nom: 'roleCree', executer }` ne serait JAMAIS appelé.
//  `bot/index.js` posait `client.on(event.name, …)`, donc `client.on('roleCree')`
//  — un événement que discord.js n'émet pas. Aucune erreur, aucun journal, la
//  fonctionnalité disparaît simplement.
//
//  Les dix-sept noms ci-dessous sont le vocabulaire du contrat (DA §4.4 et
//  §7.2). Chaque adaptateur doit savoir les traduire tous, sauf ceux que sa
//  plateforme n'a pas — et dans ce cas le déclarer, pas les ignorer.
// ═══════════════════════════════════════════════════════════════

const EVENEMENTS_NEUTRES = Object.freeze([
    'pret',
    'messageCree',
    'messageModifie',
    'messageSupprime',
    'reactionAjoutee',
    'reactionRetiree',
    'membreRejoint',
    'membreParti',
    'membreModifie',
    'guildeRejointe',
    'guildeQuittee',
    'canalCree',
    'canalSupprime',
    'roleCree',
    'roleSupprime',
    'etatVocalModifie',
    'sanctionAutomatique',
]);

const ENSEMBLE_EVENEMENTS = new Set(EVENEMENTS_NEUTRES);

// Clés reconnues d'un descripteur d'événement. Comme pour les commandes et les
// capacités, une clé inconnue LÈVE : un `once: true` écrit à la place de
// `une: true` produirait un abonnement permanent là où on en voulait un seul.
const CLES_EVENEMENT = Object.freeze(['nom', 'une', 'executer', 'capaciteRequise']);

function estEvenementNeutre(nom) {
    return typeof nom === 'string' && ENSEMBLE_EVENEMENTS.has(nom);
}

/**
 * Valide un descripteur d'événement.
 *
 * @param {object} descripteur
 * @param {string}   descripteur.nom              nom neutre (cf. EVENEMENTS_NEUTRES)
 * @param {boolean}  [descripteur.une]            abonnement unique (`once`)
 * @param {string}   [descripteur.capaciteRequise] le handler n'est branché que si
 *   la plateforme déclare cette capacité. C'est ainsi que `sanctionAutomatique`
 *   se cantonne aux plateformes qui ont un AutoMod, SANS que le handler ait à
 *   tester le nom de la plateforme.
 * @param {Function} descripteur.executer         (ctx, ...donnees) => Promise<void>
 */
function definirEvenement(descripteur) {
    if (!descripteur || typeof descripteur !== 'object') {
        throw new Error('definirEvenement attend un objet descripteur.');
    }
    for (const cle of Object.keys(descripteur)) {
        if (!CLES_EVENEMENT.includes(cle)) {
            throw new Error(
                `Descripteur d'événement « ${descripteur.nom || '?'} » : clé inconnue « ${cle} ». `
                + `Clés reconnues : ${CLES_EVENEMENT.join(', ')}.`
            );
        }
    }
    if (!estEvenementNeutre(descripteur.nom)) {
        throw new Error(
            `Événement neutre inconnu : « ${descripteur.nom} ». `
            + `Noms acceptés : ${EVENEMENTS_NEUTRES.join(', ')}.`
        );
    }
    if (typeof descripteur.executer !== 'function') {
        throw new Error(`Descripteur d'événement « ${descripteur.nom} » : « executer » est obligatoire.`);
    }
    return descripteur;
}

/**
 * Descripteur neutre ou handler discord.js historique ?
 *
 * Même critère que pour les commandes : `executer` (neutre) contre `execute`
 * (hérité). Un module qui porte les deux est une migration à moitié faite, et
 * on le signale plutôt que de choisir à sa place.
 */
function estDescripteurEvenement(mod) {
    if (!mod || typeof mod !== 'object') return false;
    const neutre = typeof mod.nom === 'string' && typeof mod.executer === 'function';
    if (neutre && typeof mod.execute === 'function') {
        throw new Error(
            `L'événement « ${mod.nom} » porte à la fois « executer » (neutre) et « execute » (discord.js). `
            + 'Un handler migré ne garde que « executer ».'
        );
    }
    return neutre;
}

module.exports = {
    EVENEMENTS_NEUTRES,
    CLES_EVENEMENT,
    definirEvenement,
    estEvenementNeutre,
    estDescripteurEvenement,
};
