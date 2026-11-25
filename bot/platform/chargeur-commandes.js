// ═══════════════════════════════════════════════════════════════
//  Chargeur de commandes — partie neutre
//
//  Parcourt `bot/commands/`, écarte les fichiers désactivés, refuse le format
//  historique, écarte les commandes indisponibles sur la plateforme active, et
//  enregistre les panneaux persistants déclarés par les descripteurs.
//
//  ─── Ce qui appartenait à l'adaptateur, et ce qui n'y appartenait pas ───────
//
//  Les deux adaptateurs portaient ce chargeur en double. La seule chose qui les
//  distinguait était la FABRIQUE D'ENTRÉE : un `SlashCommandBuilder` et un pont
//  vers `creerContexteCommande` côté Discord, une ligne d'usage préfixée et un
//  pont vers le parseur côté Fluxer. Tout le reste — l'ordre de lecture, la
//  gestion des fichiers à exports multiples, le refus du format historique, la
//  détection des collisions de panneaux — était identique.
//
//  Deux copies d'un chargeur, c'est la garantie qu'un correctif n'en touche
//  qu'une. Et le symptôme serait de ceux qui ne désignent pas leur cause : une
//  commande chargée sur une plateforme et absente de l'autre, sans erreur.
//
//  La fabrique est donc un PARAMÈTRE, et c'est le seul.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { estDescripteurNeutre, commandeDisponible } = require('./commands');

/**
 * Entrée normalisée d'une commande.
 *
 * @typedef {object} EntreeCommande
 * @property {string}   nom          nom de la commande
 * @property {object}   data         forme dérivée pour la plateforme
 * @property {Function} [execute]
 * @property {Function} [autocomplete]
 * @property {string}   fichier      nom du fichier d'origine, pour les journaux
 * @property {boolean}  neutre       toujours true — la clé survit parce que le
 *   déploiement et les tests la lisent, et parce qu'elle dit explicitement que
 *   l'entrée vient du registre et non d'un builder écrit à la main.
 * @property {object}   descripteur
 * @property {string[]} panneaux     noms des panneaux persistants déclarés
 */

/**
 * Refus d'un module resté au format historique.
 *
 * Nomme le fichier ET la correction : un « commande ignorée » anonyme enverrait
 * chercher le défaut dans le chargeur, et un simple `continue` silencieux ferait
 * disparaître une commande du bot sans un mot.
 */
function refuserModuleHistorique(nom, fichier) {
    return new Error(
        `bot/commands/${fichier} : la commande « ${nom} » est au format historique `
        + '`{ data: SlashCommandBuilder, execute(interaction) }`, que le chargeur n\'accepte plus. '
        + 'Décrivez-la avec `definirCommande({ nom, description, permission | accesParDefaut, options, executer(ctx) })` '
        + '(bot/platform/commands.js) : c\'est le descripteur que les deux plateformes dérivent.'
    );
}

/**
 * Convertit un objet exporté par un fichier de `bot/commands/` en entrée, ou
 * rend `null` si ce n'en est pas une.
 *
 * @param {object} valeur
 * @param {string} fichier
 * @param {object} contexte
 * @param {string}   contexte.nomPlateforme
 * @param {Function} contexte.fabriquerEntree  (descripteur, fichier) => EntreeCommande
 * @throws {Error} si la valeur est une commande au format historique
 */
function entreeDepuisExport(valeur, fichier, { nomPlateforme, fabriquerEntree }) {
    if (estDescripteurNeutre(valeur)) {
        // Une commande non disponible sur la plateforme active (`plateformes:
        // ['discord']` pour la famille musique) est écartée AU CHARGEMENT : la
        // charger puis refuser de l'exécuter afficherait une commande morte
        // dans le sélecteur Discord, et la proposerait dans l'aide dérivée de
        // Fluxer.
        if (!commandeDisponible(valeur, nomPlateforme)) return null;
        return fabriquerEntree(valeur, fichier);
    }
    // Le format historique se reconnaît à son builder. On LÈVE plutôt que de
    // rendre `null` : rendre `null` ici, c'est une commande qui disparaît du bot
    // et du déploiement sans erreur ni journal.
    if (typeof valeur?.data?.name === 'string' && typeof valeur?.execute === 'function') {
        throw refuserModuleHistorique(valeur.data.name, fichier);
    }
    return null;
}

/**
 * Enregistre les panneaux persistants déclarés par les commandes.
 *
 * C'est ce qui tient la promesse du registre : une commande déclare `panneaux`
 * dans son descripteur, ses clics sont routés, et aucun fichier partagé n'est
 * touché.
 *
 * Les collisions sont détectées par `surPanneau`, et pas ici, parce que
 * l'adaptateur connaît AUSSI les panneaux déclarés hors commande (modules de
 * `bot/panneaux/`) : les détecter ici ne verrait que la moitié des
 * déclarations.
 */
function enregistrerPanneaux(entrees, adaptateur) {
    for (const entree of entrees) {
        for (const [panneau, handler] of Object.entries(entree.descripteur?.panneaux || {})) {
            adaptateur.surPanneau(panneau, handler, `/${entree.nom}`);
        }
    }
}

/**
 * Charge toutes les commandes d'un dossier.
 *
 * @param {object} options
 * @param {string}   options.dossier        chemin de bot/commands/
 * @param {string[]} [options.exclus]       fichiers à ignorer (DISABLED_COMMAND_FILES)
 * @param {object}   [options.adaptateur]   requis pour EXÉCUTER et pour
 *   enregistrer les panneaux ; inutile pour seulement déployer ou inventorier
 * @param {string}   options.nomPlateforme
 * @param {Function} options.fabriquerEntree
 * @returns {EntreeCommande[]}
 */
function chargerCommandes({ dossier, exclus = [], adaptateur = null, nomPlateforme, fabriquerEntree } = {}) {
    if (typeof fabriquerEntree !== 'function') {
        throw new Error(
            'chargerCommandes : « fabriquerEntree » est obligatoire. C\'est la SEULE chose qui '
            + 'distingue le chargement d\'une plateforme à l\'autre — l\'omettre voudrait dire '
            + 'qu\'aucune commande ne serait dérivée.'
        );
    }

    const fichiers = fs.readdirSync(dossier)
        .filter(fichier => fichier.endsWith('.js') && !exclus.includes(fichier));

    const entrees = [];
    for (const fichier of fichiers) {
        const mod = require(path.join(dossier, fichier));

        // Un fichier peut exporter une commande unique ou plusieurs (ex :
        // musiccontrols.js). L'export direct est essayé d'abord ; s'il n'en est
        // pas un, on parcourt ses valeurs.
        const directe = entreeDepuisExport(mod, fichier, { nomPlateforme, fabriquerEntree });
        if (directe) {
            entrees.push(directe);
            continue;
        }
        if (mod && typeof mod === 'object') {
            for (const valeur of Object.values(mod)) {
                const entree = entreeDepuisExport(valeur, fichier, { nomPlateforme, fabriquerEntree });
                if (entree) entrees.push(entree);
            }
        }
    }

    if (adaptateur) enregistrerPanneaux(entrees, adaptateur);

    return entrees;
}

module.exports = {
    chargerCommandes,
    entreeDepuisExport,
    enregistrerPanneaux,
    refuserModuleHistorique,
};
