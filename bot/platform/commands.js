// ═══════════════════════════════════════════════════════════════
//  Registre de commandes déclaratif — partie neutre
//
//  C'est la pièce qui remplace les 62 `SlashCommandBuilder` du dépôt. Une
//  commande se DÉCRIT une fois ; chaque adaptateur en DÉRIVE sa forme (slash
//  côté Discord, commande préfixée côté Fluxer). Ce fichier ne connaît aucune
//  plateforme : il porte le vocabulaire du descripteur et sa validation.
//
//  La validation est volontairement stricte et exécutée AU CHARGEMENT du
//  fichier de commande. Elle est le principal filet du chantier : 27 commandes
//  restent à migrer, et une faute de frappe sur un type d'option produirait
//  sinon une commande déployée sans son option, ou un lot entier refusé par
//  Discord — deux symptômes qui ne désignent pas leur cause.
// ═══════════════════════════════════════════════════════════════

const { estPermissionCanonique, PERMISSIONS } = require('./permissions');

// Types d'option du descripteur. La colonne Discord et la colonne Fluxer de la
// DA (§5.1) se dérivent toutes deux de cette liste ; l'adaptateur qui ne sait
// pas rendre un type doit le dire, pas l'ignorer.
const TYPES_OPTION = Object.freeze([
    'texte',        // chaîne libre
    'entier',       // nombre entier
    'booleen',      // vrai / faux
    'utilisateur',  // { id, nom, mention }
    'canal',        // { id, nom, type, mention }
    'role',         // { id, nom, mention }
    'choix',        // chaîne contrainte à `choix: [{ nom, valeur }]`
]);

const PLATEFORMES_CONNUES = Object.freeze(['discord', 'fluxer']);

function erreur(nomCommande, message) {
    return new Error(`Descripteur de commande « ${nomCommande || '?'} » invalide : ${message}`);
}

function validerOptions(nomCommande, contexte, options) {
    if (options === undefined) return [];
    if (!Array.isArray(options)) throw erreur(nomCommande, `${contexte} : « options » doit être un tableau.`);

    const vues = new Set();
    options.forEach((option, index) => {
        const ou = `${contexte}, option ${option?.nom || `#${index + 1}`}`;
        if (!option || typeof option.nom !== 'string' || !option.nom) {
            throw erreur(nomCommande, `${ou} : « nom » est obligatoire.`);
        }
        if (vues.has(option.nom)) throw erreur(nomCommande, `${ou} : nom d'option en double.`);
        vues.add(option.nom);

        if (typeof option.description !== 'string' || !option.description) {
            throw erreur(nomCommande, `${ou} : « description » est obligatoire (Discord la refuse vide).`);
        }
        if (!TYPES_OPTION.includes(option.type)) {
            throw erreur(nomCommande, `${ou} : type « ${option.type} » inconnu. Types acceptés : ${TYPES_OPTION.join(', ')}.`);
        }
        if (option.type === 'choix') {
            if (!Array.isArray(option.choix) || option.choix.length === 0) {
                throw erreur(nomCommande, `${ou} : un type « choix » exige un tableau « choix » non vide.`);
            }
            for (const choix of option.choix) {
                if (!choix || typeof choix.nom !== 'string' || choix.valeur === undefined) {
                    throw erreur(nomCommande, `${ou} : chaque choix doit porter { nom, valeur }.`);
                }
            }
        }

        // `reste: true` capte tout le reste de la ligne côté Fluxer : une option
        // qui la suivrait ne pourrait jamais être remplie. La règle est
        // inapplicable côté Discord (les options y sont nommées), mais elle est
        // vérifiée ici pour que le descripteur reste valable sur les DEUX
        // plateformes — c'est tout l'intérêt d'un registre unique.
        if (option.reste && index !== options.length - 1) {
            throw erreur(nomCommande, `${ou} : « reste: true » n'est possible que sur la DERNIÈRE option.`);
        }
        // Discord n'accepte pas une option facultative avant une option requise.
        if (option.requis && index > 0 && options.slice(0, index).some(o => !o.requis)) {
            throw erreur(nomCommande, `${ou} : une option requise ne peut pas suivre une option facultative.`);
        }
    });

    return options;
}

/**
 * Valide un descripteur et le rend prêt à être consommé par les adaptateurs.
 *
 * @param {object} descripteur
 * @param {string}   descripteur.nom
 * @param {string}   descripteur.description
 * @param {string}   [descripteur.permission]     nom canonique (cf. platform/permissions.js)
 * @param {string[]} [descripteur.plateformes]    omission = toutes
 * @param {Array}    [descripteur.options]
 * @param {Array}    [descripteur.sousCommandes]  chacune { nom, description, options?, executer }
 * @param {Function} [descripteur.executer]       (ctx) => Promise<void>
 * @param {Function} [descripteur.completer]      autocomplétion, optionnelle
 * @returns {object} le descripteur figé, augmenté du pont de compatibilité `data`
 */
function definirCommande(descripteur) {
    if (!descripteur || typeof descripteur !== 'object') {
        throw new Error('definirCommande attend un objet descripteur.');
    }
    const nom = descripteur.nom;
    if (typeof nom !== 'string' || !nom) throw erreur(nom, '« nom » est obligatoire.');
    if (typeof descripteur.description !== 'string' || !descripteur.description) {
        throw erreur(nom, '« description » est obligatoire.');
    }
    if (descripteur.permission !== undefined && !estPermissionCanonique(descripteur.permission)) {
        throw erreur(nom, `permission « ${descripteur.permission} » inconnue. Noms acceptés : ${PERMISSIONS.join(', ')}.`);
    }
    if (descripteur.plateformes !== undefined) {
        if (!Array.isArray(descripteur.plateformes) || descripteur.plateformes.length === 0) {
            throw erreur(nom, '« plateformes » doit être un tableau non vide (l\'omettre signifie « toutes »).');
        }
        for (const plateforme of descripteur.plateformes) {
            if (!PLATEFORMES_CONNUES.includes(plateforme)) {
                throw erreur(nom, `plateforme « ${plateforme} » inconnue. Valeurs acceptées : ${PLATEFORMES_CONNUES.join(', ')}.`);
            }
        }
    }

    const sousCommandes = descripteur.sousCommandes;
    if (sousCommandes !== undefined) {
        if (!Array.isArray(sousCommandes) || sousCommandes.length === 0) {
            throw erreur(nom, '« sousCommandes » doit être un tableau non vide.');
        }
        if (descripteur.options) {
            // Discord l'interdit : une commande porte des options OU des
            // sous-commandes, jamais les deux. Le lot serait refusé en bloc.
            throw erreur(nom, 'une commande à sous-commandes ne peut pas porter d\'options à sa racine.');
        }
        const vues = new Set();
        for (const sous of sousCommandes) {
            if (!sous || typeof sous.nom !== 'string' || !sous.nom) throw erreur(nom, 'chaque sous-commande doit porter un « nom ».');
            if (vues.has(sous.nom)) throw erreur(nom, `sous-commande « ${sous.nom} » en double.`);
            vues.add(sous.nom);
            if (typeof sous.description !== 'string' || !sous.description) {
                throw erreur(nom, `sous-commande « ${sous.nom} » : « description » est obligatoire.`);
            }
            if (typeof sous.executer !== 'function' && typeof descripteur.executer !== 'function') {
                throw erreur(nom, `sous-commande « ${sous.nom} » : « executer » manquant, et la commande n'en porte pas non plus.`);
            }
            validerOptions(nom, `sous-commande ${sous.nom}`, sous.options);
        }
    } else {
        if (typeof descripteur.executer !== 'function') {
            throw erreur(nom, '« executer » est obligatoire pour une commande sans sous-commandes.');
        }
        validerOptions(nom, 'racine', descripteur.options);
    }

    // ─── Pont de compatibilité, temporaire ───────────────────────────────────
    // `reservedCommandNames()` (bot/commands/customcmd.js) établit la liste des
    // noms déjà pris par Quasar en lisant `mod.data.name` sur chaque fichier de
    // bot/commands/. Un descripteur neutre n'a pas de `data` : sans ce pont,
    // /ping et /autorole sortiraient de cette liste et un homonyme personnalisé
    // pourrait être créé — puis resterait inerte (bot/index.js résout d'abord
    // ses propres commandes) et serait écarté au déploiement, sans qu'aucun
    // message ne relie le symptôme à sa cause.
    //
    // Volontairement réduit à `{ name }` et non énumérable : ce n'est PAS le
    // builder de la plateforme, et rien ne doit se mettre à appeler
    // `data.toJSON()` dessus. Le rendu passe par platform/discord/commands.js.
    // À retirer quand customcmd.js lira le registre (lot 3).
    Object.defineProperty(descripteur, 'data', {
        value: Object.freeze({ name: nom }),
        enumerable: false,
    });

    return descripteur;
}

/**
 * Descripteur neutre ou module discord.js historique ?
 *
 * Les deux formats cohabitent pendant les lots 1 à 5. Le critère est `executer`
 * (français, neutre) contre `execute` (anglais, hérité) : un module qui porte
 * les deux est une migration à moitié faite, et on le signale plutôt que de
 * choisir à sa place.
 */
function estDescripteurNeutre(mod) {
    if (!mod || typeof mod !== 'object') return false;
    const neutre = typeof mod.nom === 'string'
        && (typeof mod.executer === 'function' || Array.isArray(mod.sousCommandes));
    if (neutre && typeof mod.execute === 'function') {
        throw new Error(
            `La commande « ${mod.nom} » porte à la fois « executer » (neutre) et « execute » (discord.js). `
            + 'Une commande migrée ne garde que « executer ».'
        );
    }
    return neutre;
}

/** La commande est-elle déclarée disponible sur cette plateforme ? */
function commandeDisponible(descripteur, nomPlateforme) {
    if (!Array.isArray(descripteur?.plateformes)) return true;
    return descripteur.plateformes.includes(nomPlateforme);
}

/** La sous-commande visée, ou `undefined` si la commande n'en a pas. */
function trouverSousCommande(descripteur, nomSousCommande) {
    if (!Array.isArray(descripteur?.sousCommandes)) return undefined;
    return descripteur.sousCommandes.find(sous => sous.nom === nomSousCommande);
}

module.exports = {
    TYPES_OPTION,
    PLATEFORMES_CONNUES,
    definirCommande,
    estDescripteurNeutre,
    commandeDisponible,
    trouverSousCommande,
};
