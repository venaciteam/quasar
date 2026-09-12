// ═══════════════════════════════════════════════════════════════
//  Rendu Discord du registre de commandes
//
//  Deux responsabilités :
//    1. dériver un `SlashCommandBuilder` d'un descripteur neutre, à l'identique
//       de ce que produisaient les builders écrits à la main ;
//    2. charger bot/commands/ — descripteurs neutres EXCLUSIVEMENT. Le format
//       historique `{ data, execute }` a été accepté le temps des lots 1 à 5 ;
//       il est désormais REFUSÉ, avec un message qui nomme le fichier et dit
//       quoi faire. L'accepter encore laisserait une commande Discord-only
//       passer inaperçue jusqu'au premier démarrage en mode Fluxer.
//
//  Ce chargeur est le seul du projet à parcourir bot/commands/ : `bot/index.js`
//  (exécution) et `./deploy.js` (déploiement) en avaient chacun
//  une copie, avec des règles subtilement différentes sur les fichiers à exports
//  multiples. Deux copies finissent par diverger, et une commande chargée mais
//  jamais déployée — ou l'inverse — est un symptôme qui ne désigne pas sa cause.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const { bitfield } = require('./permissions');
const { versTypesDiscord } = require('./channels');
const {
    estDescripteurNeutre,
    commandeDisponible,
    trouverSousCommande,
} = require('../commands');

const NOM_PLATEFORME = 'discord';

// Type d'option neutre -> méthode du builder. `choix` passe par une option
// texte contrainte : c'est la forme qu'utilisent déjà les commandes du dépôt.
const AJOUT_OPTION = Object.freeze({
    texte: 'addStringOption',
    entier: 'addIntegerOption',
    booleen: 'addBooleanOption',
    utilisateur: 'addUserOption',
    canal: 'addChannelOption',
    role: 'addRoleOption',
    choix: 'addStringOption',
});

/** Pose une option neutre sur un builder d'option discord.js. */
function appliquerOption(constructeurOption, option) {
    constructeurOption
        .setName(option.nom)
        .setDescription(option.description)
        .setRequired(Boolean(option.requis));

    if (option.type === 'choix') {
        constructeurOption.setChoices(
            ...option.choix.map(choix => ({ name: choix.nom, value: choix.valeur }))
        );
    }
    // `min`/`max` portent la longueur sur un texte et la valeur sur un entier :
    // ce sont deux méthodes différentes côté discord.js, et se tromper produit
    // une commande refusée par l'API sans indication utile.
    if (option.type === 'texte') {
        if (option.min !== undefined) constructeurOption.setMinLength(option.min);
        if (option.max !== undefined) constructeurOption.setMaxLength(option.max);
    }
    if (option.type === 'entier') {
        if (option.min !== undefined) constructeurOption.setMinValue(option.min);
        if (option.max !== undefined) constructeurOption.setMaxValue(option.max);
    }
    // L'autocomplétion et les choix figés s'excluent ; le registre refuse déjà
    // la combinaison, ce test n'est qu'une ceinture.
    if (option.autocompletion && option.type !== 'choix') constructeurOption.setAutocomplete(true);

    // Filtrage du sélecteur de salon, déclaré en noms canoniques.
    if (option.typesCanal) constructeurOption.addChannelTypes(...versTypesDiscord(option.typesCanal));

    return constructeurOption;
}

function appliquerOptions(porteur, options = []) {
    for (const option of options) {
        const methode = AJOUT_OPTION[option.type];
        porteur[methode](constructeurOption => appliquerOption(constructeurOption, option));
    }
    return porteur;
}

/**
 * Descripteur neutre -> SlashCommandBuilder.
 *
 * Le JSON produit doit être strictement identique à celui du builder écrit à la
 * main qu'il remplace : c'est ce que vérifient les tests de dérivation. Une
 * différence, même sur un champ « cosmétique », se paie en re-déploiement
 * silencieux à chaque démarrage.
 */
function construireSlashCommand(descripteur) {
    const builder = new SlashCommandBuilder()
        .setName(descripteur.nom)
        .setDescription(descripteur.description);

    // Accès. Le registre garantit qu'exactement l'un des deux est déclaré.
    //   permission           -> setDefaultMemberPermissions(bitfield)
    //   accesParDefaut:false -> setDefaultMemberPermissions(0), soit « administrateurs
    //                           seulement » : c'est ce que porte /ticket aujourd'hui,
    //                           et aucun nom de permission ne l'exprime.
    //   accesParDefaut:true  -> rien : c'est le défaut de Discord, et le poser
    //                           explicitement changerait le JSON déployé.
    if (descripteur.permission) {
        builder.setDefaultMemberPermissions(bitfield(descripteur.permission));
    } else if (descripteur.accesParDefaut === false) {
        builder.setDefaultMemberPermissions(0);
    }
    // `dansMessagePrive: false` réserve la commande aux serveurs. Non posé par
    // défaut : la valeur par défaut de Discord (autorisée en MP) est celle des
    // commandes actuelles, et la changer en bloc modifierait leur comportement.
    if (descripteur.dansMessagePrive === false) builder.setDMPermission(false);

    if (Array.isArray(descripteur.sousCommandes)) {
        for (const sous of descripteur.sousCommandes) {
            builder.addSubcommand(constructeurSous => {
                constructeurSous.setName(sous.nom).setDescription(sous.description);
                return appliquerOptions(constructeurSous, sous.options);
            });
        }
    } else {
        appliquerOptions(builder, descripteur.options);
    }

    return builder;
}

/**
 * Entrée normalisée d'une commande, quel que soit son format d'origine.
 *
 * @typedef {object} EntreeCommande
 * @property {string}   nom          nom de la commande slash
 * @property {object}   data         SlashCommandBuilder (`.toJSON()` déployable)
 * @property {Function} [execute]    (interaction) => Promise<void>
 * @property {Function} [autocomplete]
 * @property {string}   fichier      nom du fichier d'origine, pour les journaux
 * @property {boolean}  neutre       toujours true — la clé survit parce que
 *   `deploy.js` et les tests la lisent, et parce qu'elle dit explicitement que
 *   l'entrée vient du registre et non d'un builder écrit à la main.
 * @property {object}   descripteur
 */

/** Construit l'entrée d'un descripteur neutre. */
function entreeDepuisDescripteur(descripteur, fichier, adaptateur) {
    const entree = {
        nom: descripteur.nom,
        data: construireSlashCommand(descripteur),
        fichier,
        neutre: true,
        descripteur,
        // Noms des panneaux persistants déclarés par la commande. Enregistrés
        // par `chargerCommandes`, pas ici : la détection des collisions entre
        // commandes suppose de les avoir toutes vues.
        panneaux: Object.keys(descripteur.panneaux || {}),
    };

    // Le pont vers le contexte neutre est différé : `context.js` dépend de
    // `render.js` et de la table des permissions, et le charger au sommet de ce
    // fichier créerait un cycle avec l'adaptateur qui l'instancie.
    entree.execute = async (interaction) => {
        if (!adaptateur) {
            throw new Error(
                `La commande /${descripteur.nom} a été chargée sans adaptateur : elle ne peut pas être exécutée. `
                + 'Passez `adaptateur` à chargerCommandes().'
            );
        }
        const { creerContexteCommande } = require('./context');
        const nomSous = interaction.options?.getSubcommand?.(false) || null;
        const sous = trouverSousCommande(descripteur, nomSous);
        const ctx = creerContexteCommande(interaction, { adaptateur, descripteur, sousCommande: sous });

        // Une sous-commande sans `executer` retombe sur celui de la commande :
        // c'est la forme qu'ont les commandes dont les sous-commandes partagent
        // tout leur corps. Si ni l'une ni l'autre n'en a, `definirCommande` a
        // déjà refusé le descripteur au chargement.
        const executer = sous?.executer || descripteur.executer;
        return executer(ctx);
    };

    if (typeof descripteur.completer === 'function') {
        entree.autocomplete = async (interaction) => {
            const { creerContexteCompletion } = require('./context');
            return descripteur.completer(creerContexteCompletion(interaction, { adaptateur, descripteur }));
        };
    }

    return entree;
}

/**
 * Refus d'un module resté au format historique.
 *
 * Nomme le fichier ET la correction : un « commande ignorée » anonyme
 * enverrait chercher le défaut dans le chargeur, et un simple `continue`
 * silencieux ferait disparaître une commande du bot sans un mot.
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
 * Convertit un objet exporté par un fichier de bot/commands/ en entrée, ou rend
 * `null` si ce n'en est pas une.
 *
 * @throws {Error} si la valeur est une commande au format historique.
 */
function entreeDepuisExport(valeur, fichier, adaptateur) {
    if (estDescripteurNeutre(valeur)) {
        // Une commande non disponible sur la plateforme active (`plateformes:
        // ['discord']` pour la famille musique) est écartée AVANT le
        // déploiement : la déployer puis refuser de l'exécuter afficherait une
        // commande morte dans le sélecteur.
        if (!commandeDisponible(valeur, NOM_PLATEFORME)) return null;
        return entreeDepuisDescripteur(valeur, fichier, adaptateur);
    }
    // Le format historique se reconnaît à son builder. On LÈVE plutôt que de
    // rendre `null` : rendre `null` ici, c'est une commande qui disparaît du
    // bot et du déploiement sans erreur ni journal.
    if (typeof valeur?.data?.name === 'string' && typeof valeur?.execute === 'function') {
        throw refuserModuleHistorique(valeur.data.name, fichier);
    }
    return null;
}

/**
 * Charge toutes les commandes d'un dossier.
 *
 * @param {object} options
 * @param {string}   options.dossier      chemin de bot/commands/
 * @param {string[]} [options.exclus]     fichiers à ignorer (DISABLED_COMMAND_FILES)
 * @param {object}   [options.adaptateur] requis pour EXÉCUTER, inutile pour déployer
 * @returns {EntreeCommande[]}
 */
function chargerCommandes({ dossier, exclus = [], adaptateur = null } = {}) {
    const fichiers = fs.readdirSync(dossier)
        .filter(fichier => fichier.endsWith('.js') && !exclus.includes(fichier));

    const entrees = [];
    for (const fichier of fichiers) {
        const mod = require(path.join(dossier, fichier));

        // Un fichier peut exporter une commande unique ou plusieurs (ex :
        // musiccontrols.js). L'export direct est essayé d'abord ; s'il n'en est
        // pas un, on parcourt ses valeurs.
        const directe = entreeDepuisExport(mod, fichier, adaptateur);
        if (directe) {
            entrees.push(directe);
            continue;
        }
        if (mod && typeof mod === 'object') {
            for (const valeur of Object.values(mod)) {
                const entree = entreeDepuisExport(valeur, fichier, adaptateur);
                if (entree) entrees.push(entree);
            }
        }
    }

    if (adaptateur) enregistrerPanneaux(entrees, adaptateur);

    return entrees;
}

/**
 * Enregistre les panneaux persistants déclarés par les commandes.
 *
 * C'est ce qui tient la promesse du registre : un lot déclare `panneaux` dans
 * son descripteur, ses clics sont routés, et aucun fichier partagé n'est
 * touché. Sans cette étape, `surPanneau` existait sans appelant et un lot
 * n'avait que deux issues, toutes deux interdites — appeler l'adaptateur
 * au chargement, ou écrire son préfixe en dur dans `bot/index.js`.
 *
 * Les collisions sont détectées ICI, et pas seulement par `surPanneau`, pour
 * que le message nomme LES DEUX commandes en cause : « déjà enregistré » ne dit
 * pas laquelle, et six agents travaillent en parallèle sur des fichiers qu'ils
 * ne se relisent pas.
 */
function enregistrerPanneaux(entrees, adaptateur) {
    for (const entree of entrees) {
        for (const [panneau, handler] of Object.entries(entree.descripteur?.panneaux || {})) {
            // La collision est détectée par `surPanneau`, qui connaît AUSSI les
            // panneaux déclarés hors commande (modules de `bot/panneaux/`) : la
            // détecter ici ne verrait que la moitié des déclarations.
            adaptateur.surPanneau(panneau, handler, `/${entree.nom}`);
        }
    }
}

module.exports = {
    construireSlashCommand,
    chargerCommandes,
    enregistrerPanneaux,
    AJOUT_OPTION,
    NOM_PLATEFORME,
};
