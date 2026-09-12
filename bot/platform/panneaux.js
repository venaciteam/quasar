// ═══════════════════════════════════════════════════════════════
//  Registre de panneaux déclaratif — partie neutre
//
//  Un panneau persistant appartient le plus souvent à une commande, et se
//  déclare alors dans la clé `panneaux` de son descripteur. Mais pas toujours :
//  le module d'arbitrage des sanctions (`defer`) n'a AUCUNE commande — il se
//  configure au dashboard — et ses boutons ne pouvaient donc être ni posés ni
//  routés. Un panneau devait s'accrocher à une commande qui n'existe pas.
//
//  Ce registre est la seconde porte : un fichier de `bot/panneaux/` déclare un
//  panneau, `chargerPanneaux` l'enregistre, et le routage est le même. Le
//  `customId` produit est identique dans les deux cas — `panneau:cle` — donc
//  l'origine de la déclaration ne change rien.
//
//  Vocabulaire complet des panneaux : bot/platform/commands.js.
// ═══════════════════════════════════════════════════════════════

// Comme partout ailleurs dans les registres, une clé inconnue LÈVE : un
// `executer` écrit `execute` produirait un panneau déclaré mais jamais routé,
// sans erreur ni journal.
const CLES_PANNEAU = Object.freeze(['nom', 'executer', 'capaciteRequise']);

// Le nom d'un panneau ne peut pas contenir le séparateur que l'adaptateur place
// entre le panneau et la clé du choix.
const SEPARATEUR_INTERDIT = ':';

/**
 * Valide un descripteur de panneau autonome.
 *
 * @param {object} descripteur
 * @param {string}   descripteur.nom             nom du panneau, sans « : »
 * @param {string}   [descripteur.capaciteRequise] le panneau n'est enregistré
 *   que si la plateforme déclare cette capacité — même mécanique que pour les
 *   événements, et même raison : ne jamais tester le nom de la plateforme.
 * @param {(ctx: object, cle: string) => Promise<void>} descripteur.executer
 */
function definirPanneau(descripteur) {
    if (!descripteur || typeof descripteur !== 'object') {
        throw new Error('definirPanneau attend un objet descripteur.');
    }
    for (const cle of Object.keys(descripteur)) {
        if (!CLES_PANNEAU.includes(cle)) {
            throw new Error(
                `Descripteur de panneau « ${descripteur.nom || '?'} » : clé inconnue « ${cle} ». `
                + `Clés reconnues : ${CLES_PANNEAU.join(', ')}.`
            );
        }
    }
    const nom = descripteur.nom;
    if (typeof nom !== 'string' || !nom || nom.includes(SEPARATEUR_INTERDIT)) {
        throw new Error(
            `Descripteur de panneau : nom invalide « ${nom} ». Attendu une chaîne non vide `
            + `et sans « ${SEPARATEUR_INTERDIT} », qui sépare le panneau de la clé du choix.`
        );
    }
    if (typeof descripteur.executer !== 'function') {
        throw new Error(`Descripteur de panneau « ${nom} » : « executer » est obligatoire.`);
    }
    return descripteur;
}

/** Le module exporté est-il un descripteur de panneau ? */
function estDescripteurPanneau(mod) {
    return Boolean(mod)
        && typeof mod === 'object'
        && typeof mod.nom === 'string'
        && typeof mod.executer === 'function';
}

module.exports = { CLES_PANNEAU, definirPanneau, estDescripteurPanneau };
