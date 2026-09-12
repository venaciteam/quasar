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
//
//  ─── Le chargeur est ici, et non dans chaque adaptateur ─────────────────────
//
//  `chargerPanneaux` vivait en double, à l'identique, dans `discord/panneaux.js`
//  et `fluxer/panneaux.js`. Il ne contenait AUCUNE connaissance de plateforme :
//  il lit un dossier, teste une capacité, pose un filet d'erreur et appelle
//  `adaptateur.surPanneau`. Deux copies d'un chargeur, c'est la garantie qu'un
//  correctif n'en touche qu'une — et le symptôme serait un panneau routé d'un
//  côté et muet de l'autre, sans erreur ni journal.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

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

/**
 * Filet d'erreur par défaut d'un panneau.
 *
 * Posé ICI et pas chez l'appelant : un clic sur un panneau part d'un
 * utilisateur, pas d'une commande, et un rejet non capté partirait dans le filet
 * global du processus sans dire de QUEL panneau il vient.
 */
function surErreurPanneauParDefaut(err, { panneau }) {
    console.error(
        `[Quasar] ⚠️  Panneau ${panneau} | ${err?.name || 'Error'}: ${err?.message || err}`
    );
    if (err?.stack) console.error(err.stack);
}

/**
 * Charge `bot/panneaux/` et enregistre chaque panneau auprès de l'adaptateur.
 *
 * Ne concerne QUE les panneaux sans commande. Ceux qu'une commande porte sont
 * enregistrés par le chargeur de commandes, depuis la clé `panneaux` du
 * descripteur.
 *
 * @param {object} options
 * @param {string}   options.dossier
 * @param {object}   options.adaptateur  doit exposer `capacites` et `surPanneau`
 * @param {Function} [options.surErreur] (err, { panneau, cle }) => void
 * @returns {Array<{nom: string, fichier: string, enregistre: boolean}>}
 */
function chargerPanneaux({ dossier, adaptateur, surErreur } = {}) {
    if (!dossier || !fs.existsSync(dossier)) return [];
    const charges = [];

    for (const fichier of fs.readdirSync(dossier).filter(f => f.endsWith('.js'))) {
        const mod = require(path.join(dossier, fichier));
        if (!estDescripteurPanneau(mod)) continue;

        // Un panneau qui exige une capacité absente n'est pas enregistré : même
        // mécanique que pour les événements, et le code métier ne teste jamais
        // le nom de la plateforme.
        if (mod.capaciteRequise && !adaptateur.capacites[mod.capaciteRequise]) {
            charges.push({ nom: mod.nom, fichier, enregistre: false });
            continue;
        }

        const handler = (ctx, cle) => Promise.resolve()
            .then(() => mod.executer(ctx, cle))
            .catch((err) => (surErreur || surErreurPanneauParDefaut)(err, { panneau: mod.nom, cle }));

        adaptateur.surPanneau(mod.nom, handler, `le module ${fichier.replace(/\.js$/, '')}`);
        charges.push({ nom: mod.nom, fichier, enregistre: true });
    }

    return charges;
}

module.exports = {
    CLES_PANNEAU,
    definirPanneau,
    estDescripteurPanneau,
    chargerPanneaux,
    surErreurPanneauParDefaut,
};
