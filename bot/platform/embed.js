// ═══════════════════════════════════════════════════════════════
//  Embed neutre
//
//  Les 146 usages d'`EmbedBuilder` du dépôt deviennent des appels à `embed()`.
//  Ce que rend cette fonction est une structure de données INERTE : aucune
//  méthode, aucune dépendance, rien qui sache ce qu'est Discord. C'est
//  `render.js` de chaque adaptateur qui la traduit — `EmbedBuilder` côté
//  Discord, objet JSON REST côté Fluxer.
//
//  Le champ `couleur` accepte un entier (0xc8a86e, la forme historique du
//  dépôt) ou une chaîne « #rrggbb ». La conversion appartient au rendu : ici on
//  ne touche à rien, pour qu'un embed reste comparable à ce qu'on a écrit.
// ═══════════════════════════════════════════════════════════════

// Marqueur non énumérable : il distingue un embed d'une chaîne ou d'un objet
// quelconque sans polluer la structure — `JSON.stringify`, `Object.keys` et une
// comparaison profonde en tests voient exactement les neuf champs du contrat.
const MARQUEUR_EMBED = Symbol.for('quasar.platform.embed');

// Les seuls champs du contrat. Tout le reste est ignoré à la construction :
// un champ inventé ne serait rendu par aucun adaptateur, autant qu'il ne
// traverse pas la couche.
const CHAMPS_EMBED = Object.freeze([
    'titre', 'description', 'couleur', 'champs', 'pied', 'horodatage', 'auteur', 'image', 'vignette',
]);

/**
 * Construit un embed neutre.
 *
 * @param {object} [spec]
 * @param {string}  [spec.titre]
 * @param {string}  [spec.description]
 * @param {number|string} [spec.couleur]      entier 0xrrggbb ou « #rrggbb »
 * @param {Array<{nom: string, valeur: string, enLigne?: boolean}>} [spec.champs]
 * @param {{texte: string, icone?: string}}   [spec.pied]
 * @param {boolean|Date|number|string}        [spec.horodatage]  true = maintenant
 * @param {{nom: string, icone?: string, url?: string}} [spec.auteur]
 * @param {string}  [spec.image]              URL
 * @param {string}  [spec.vignette]           URL
 * @returns {object} structure inerte
 */
function embed({ titre, description, couleur, champs = [], pied, horodatage, auteur, image, vignette } = {}) {
    const structure = { titre, description, couleur, champs, pied, horodatage, auteur, image, vignette };
    Object.defineProperty(structure, MARQUEUR_EMBED, { value: true, enumerable: false });
    return structure;
}

/**
 * Un embed neutre ? Le marqueur d'abord, la forme ensuite : une structure
 * recopiée (`{ ...embed }`, `structuredClone`, aller-retour JSON) perd le
 * symbole mais reste un embed parfaitement valide, et les adaptateurs doivent
 * continuer de la rendre comme telle.
 */
function estEmbed(valeur) {
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return false;
    if (valeur[MARQUEUR_EMBED] === true) return true;
    return CHAMPS_EMBED.some(champ => champ in valeur);
}

module.exports = { embed, estEmbed, CHAMPS_EMBED, MARQUEUR_EMBED };
