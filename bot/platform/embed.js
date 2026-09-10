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

// Champs qui n'existent QUE dans le vocabulaire neutre.
//
// `description` et `image` portent le même nom qu'en API Discord : les tester
// pour reconnaître un embed neutre ferait passer un `APIEmbed` brut pour l'un
// des nôtres, et le rendu perdrait alors titre, couleur, champs et pied sans un
// mot. Il reste 146 `EmbedBuilder` à migrer : le piège se déclencherait.
const CHAMPS_EXCLUSIFS = Object.freeze(
    CHAMPS_EMBED.filter(champ => champ !== 'description' && champ !== 'image')
);

// Champs d'un embed au format Discord. Servent uniquement à produire un message
// d'erreur qui DÉSIGNE la faute (« passez par embed() ») au lieu d'un « Cannot
// send an empty message » émis très loin de sa cause.
const CHAMPS_DISCORD = Object.freeze([
    'title', 'color', 'footer', 'fields', 'thumbnail', 'author', 'timestamp', 'url',
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
 * Un embed neutre ? Le marqueur d'abord, la forme ensuite.
 *
 * Une structure recopiée (`{ ...embed }`, `structuredClone`, aller-retour JSON)
 * perd le symbole mais reste un embed valide : on la reconnaît à la présence
 * d'un champ EXCLUSIVEMENT neutre. Jamais à `description` ni à `image`, que le
 * format Discord porte sous le même nom — un `APIEmbed` reconnu à moitié perdrait
 * tout le reste en silence.
 */
function estEmbed(valeur) {
    if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) return false;
    if (valeur[MARQUEUR_EMBED] === true) return true;
    return CHAMPS_EXCLUSIFS.some(champ => champ in valeur);
}

/**
 * L'objet ressemble-t-il à un embed au format Discord (APIEmbed ou
 * EmbedBuilder) ? Sert au diagnostic, pas au rendu : un embed Discord n'est
 * JAMAIS accepté par la couche neutre, il est refusé avec une explication.
 */
function ressembleAEmbedDiscord(valeur) {
    if (!valeur || typeof valeur !== 'object') return false;
    // EmbedBuilder : porte ses champs dans `data` et sait se sérialiser.
    if (typeof valeur.toJSON === 'function' && valeur.data && typeof valeur.data === 'object') return true;
    return CHAMPS_DISCORD.some(champ => champ in valeur);
}

module.exports = {
    embed,
    estEmbed,
    ressembleAEmbedDiscord,
    CHAMPS_EMBED,
    CHAMPS_EXCLUSIFS,
    CHAMPS_DISCORD,
    MARQUEUR_EMBED,
};
