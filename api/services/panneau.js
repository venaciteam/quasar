// ═══════════════════════════════════════════════════════════════
//  Poser un panneau persistant depuis l'API
//
//  Un panneau posé par le dashboard doit être STRICTEMENT le même que celui que
//  pose la commande : même nom de panneau, mêmes clés de choix. C'est ce qui
//  décide si ses boutons seront routés — le routage neutre lit `panneau:cle`
//  dans l'identifiant du composant, et rien d'autre. Un panneau de tickets posé
//  avec l'ancien `ticket_open` s'affiche parfaitement et ne répond jamais.
//
//  Ce module portait un repli : un rendu Discord LOCAL, avec sa propre table de
//  styles de bouton et son propre `require('discord.js')`, parce que le contrat
//  ne publiait pas de méthode de pose au niveau de l'adaptateur. Deux
//  constructions d'un même panneau, c'était la garantie qu'elles finiraient par
//  diverger — et la divergence se serait vue au pire endroit, sur un bouton
//  inerte que rien ne distingue d'un bouton vivant.
//
//  `adaptateur.poserPanneau` existe désormais (lot 0.8) et délègue, des deux
//  côtés, à la même fonction interne que `ctx.poserPanneau`. Ce module n'est
//  plus qu'une garde d'entrée : il n'y a plus qu'UNE façon de poser un panneau.
// ═══════════════════════════════════════════════════════════════

/**
 * @param {object} adaptateur
 * @param {string} canalId
 * @param {object|string} contenuOuEmbed  embed NEUTRE, texte, ou corps composé
 * @param {Array<{cle: string, libelle: string, emoji?: string, style?: string}>} choix
 * @param {{panneau: string, guildeId?: string}} options
 * @returns {Promise<{canalId: string, messageId: string|null}>}
 */
async function poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, { panneau, guildeId } = {}) {
    if (!panneau) throw new Error('poserPanneau : le nom du panneau est obligatoire.');
    // Le bot n'est pas connecté — le cas des tests qui montent l'API sans bot,
    // et celui d'un démarrage en cours. On le dit plutôt que de tomber en 500
    // sur une lecture de `undefined`.
    if (typeof adaptateur?.poserPanneau !== 'function') throw new Error('Le bot n\'est pas connecté.');

    return adaptateur.poserPanneau(canalId, contenuOuEmbed, choix, { panneau, guildeId });
}

module.exports = { poserPanneau };
