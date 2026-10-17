// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des types de salon — Discord
//
//  Traduit les noms canoniques de `platform/channels.js` en `ChannelType`.
//  Fichier séparé pour être consommé sans cycle par `commands.js` (filtrage
//  d'un sélecteur de salon, sept commandes en ont un) et `api.js` (création de
//  salon).
// ═══════════════════════════════════════════════════════════════

const { ChannelType } = require('discord.js');
const { TYPES_CANAL } = require('../channels');

const TYPES = Object.freeze({
    texte: ChannelType.GuildText,
    vocal: ChannelType.GuildVoice,
    categorie: ChannelType.GuildCategory,
    conference: ChannelType.GuildStageVoice,
});

// Vérifiée exhaustive au chargement : un type ajouté au vocabulaire neutre sans
// être traduit ici doit faire échouer le démarrage, pas produire un `undefined`
// qui déploierait un sélecteur sans filtre.
const manquants = TYPES_CANAL.filter(nom => typeof TYPES[nom] !== 'number');
if (manquants.length > 0) {
    throw new Error(
        `Table des types de salon Discord incomplète : ${manquants.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/discord/channels.js.'
    );
}

// Sens inverse, pour normaliser un salon lu depuis l'API. Un type que Quasar ne
// manipule pas (forum, annonce, fil) rend `null` : le code métier voit alors
// « type inconnu de mon vocabulaire », ce qui est exact et testable.
const NOMS_PAR_TYPE = Object.freeze(
    Object.fromEntries(Object.entries(TYPES).map(([nom, type]) => [type, nom]))
);

/** @param {string[]|string} noms @returns {number[]} */
function versTypesDiscord(noms) {
    return (Array.isArray(noms) ? noms : [noms]).map((nom) => {
        const type = TYPES[nom];
        if (typeof type !== 'number') {
            throw new Error(`Type de salon inconnu côté Discord : "${nom}".`);
        }
        return type;
    });
}

/** @returns {string|null} nom canonique, ou null si hors vocabulaire de Quasar */
function versNomCanonique(type) {
    return NOMS_PAR_TYPE[type] ?? null;
}

module.exports = { TYPES, NOMS_PAR_TYPE, versTypesDiscord, versNomCanonique };
