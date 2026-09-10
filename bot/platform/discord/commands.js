// ═══════════════════════════════════════════════════════════════
//  Rendu Discord du registre de commandes
//
//  Deux responsabilités :
//    1. dériver un `SlashCommandBuilder` d'un descripteur neutre, à l'identique
//       de ce que produisaient les builders écrits à la main ;
//    2. charger bot/commands/ en acceptant LES DEUX formats — descripteur
//       neutre et module discord.js historique — pendant la migration.
//
//  Ce chargeur est le seul du projet à parcourir bot/commands/ : `bot/index.js`
//  (exécution) et `bot/utils/deploy-commands.js` (déploiement) en avaient chacun
//  une copie, avec des règles subtilement différentes sur les fichiers à exports
//  multiples. Deux copies finissent par diverger, et une commande chargée mais
//  jamais déployée — ou l'inverse — est un symptôme qui ne désigne pas sa cause.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const { bitfield } = require('./permissions');
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
    // L'autocomplétion et les choix figés s'excluent : Discord refuse une option
    // qui déclare les deux.
    if (option.autocompletion && option.type !== 'choix') constructeurOption.setAutocomplete(true);

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

    if (descripteur.permission) {
        builder.setDefaultMemberPermissions(bitfield(descripteur.permission));
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
 * @property {boolean}  neutre       true si issue d'un descripteur du registre
 * @property {object}   [descripteur]
 */

/** Construit l'entrée d'un descripteur neutre. */
function entreeDepuisDescripteur(descripteur, fichier, adaptateur) {
    const entree = {
        nom: descripteur.nom,
        data: construireSlashCommand(descripteur),
        fichier,
        neutre: true,
        descripteur,
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

/** Construit l'entrée d'un module discord.js historique. */
function entreeDepuisModuleHistorique(mod, fichier) {
    return {
        nom: mod.data.name,
        data: mod.data,
        execute: typeof mod.execute === 'function' ? mod.execute.bind(mod) : undefined,
        autocomplete: typeof mod.autocomplete === 'function' ? mod.autocomplete.bind(mod) : undefined,
        fichier,
        neutre: false,
    };
}

/**
 * Convertit un objet exporté par un fichier de bot/commands/ en entrée, ou rend
 * `null` si ce n'en est pas une.
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
    if (valeur?.data?.name) return entreeDepuisModuleHistorique(valeur, fichier);
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

    return entrees;
}

module.exports = {
    construireSlashCommand,
    chargerCommandes,
    AJOUT_OPTION,
    NOM_PLATEFORME,
};
