// ═══════════════════════════════════════════════════════════════
//  Poser un panneau persistant depuis l'API
//
//  Un panneau posé par le dashboard doit être STRICTEMENT le même que celui que
//  pose la commande : même nom de panneau, mêmes clés de choix. C'est ce qui
//  décide si ses boutons seront routés — le routage neutre lit `panneau:cle`
//  dans l'identifiant du composant, et rien d'autre. Un panneau de tickets posé
//  avec l'ancien `ticket_open` s'affiche parfaitement et ne répond jamais.
//
//  ⚠️ TRANSITION. Le contrat ne publie pas encore de méthode de POSE au niveau
//  de l'adaptateur : `ctx.poserPanneau` existe sur les contextes de commande et
//  d'événement, `api.modifierPanneau` sait réécrire un panneau déjà posé, mais
//  rien ne permet d'en poser un quand on n'a qu'un adaptateur — ce qui est
//  exactement la situation d'une route.
//
//  Signature proposée, symétrique de `ctx.poserPanneau` et de
//  `api.modifierPanneau` (cf. compte-rendu du lot 7) :
//
//      adaptateur.poserPanneau(canalId, contenuOuEmbed, choix, { panneau, guildeId })
//          -> Promise<{ canalId, messageId }>
//
//  En attendant, ce module l'emprunte dès qu'elle existe, et retombe sinon sur
//  un rendu Discord local. Le repli est identique au comportement d'avant
//  migration À UNE CHOSE PRÈS, qui est un correctif : l'identifiant du bouton
//  devient `ticket:ouvrir` au lieu de `ticket_open`. Depuis la consolidation,
//  `bot/index.js` ne route plus les préfixes historiques : un panneau posé
//  depuis le dashboard portait un bouton définitivement inerte.
//
//  Le `require('discord.js')` du repli est PARESSEUX et n'est évalué que sur
//  cette voie : un processus Fluxer ne l'atteint pas — il n'y a pas de bouton à
//  construire, et la méthode du contrat y répondra la première.
// ═══════════════════════════════════════════════════════════════

/**
 * @param {object} adaptateur
 * @param {string} canalId
 * @param {object|string} contenuOuEmbed  embed NEUTRE, ou texte
 * @param {Array<{cle: string, libelle: string, emoji?: string, style?: string}>} choix
 * @param {{panneau: string, guildeId?: string}} options
 * @returns {Promise<{canalId: string, messageId: string|null}>}
 */
async function poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, { panneau, guildeId } = {}) {
    if (!panneau) throw new Error('poserPanneau : le nom du panneau est obligatoire.');
    if (!adaptateur?.api) throw new Error('Le bot n\'est pas connecté.');

    if (typeof adaptateur.poserPanneau === 'function') {
        return adaptateur.poserPanneau(canalId, contenuOuEmbed, choix, { panneau, guildeId });
    }

    // TRANSITION : en attente de `adaptateur.poserPanneau` (voir l'en-tête).
    const message = await adaptateur.api.envoyerMessage(canalId, {
        embeds: [contenuOuEmbed],
        composants: composantsDiscord(choix, panneau),
    });
    return { canalId, messageId: message?.id ?? null };
}

/** Styles neutres -> `ButtonStyle`. Même table que bot/platform/discord/render.js. */
const STYLES = { primaire: 1, secondaire: 2, succes: 3, danger: 4 };

/**
 * Rangée de boutons au format REST, à partir de choix NEUTRES.
 * Repli uniquement : la table ci-dessus est une duplication assumée et
 * temporaire de celle de l'adaptateur.
 */
function composantsDiscord(choix, panneau) {
    const { ActionRowBuilder, ButtonBuilder } = require('discord.js');
    const rangee = new ActionRowBuilder().addComponents(
        (choix || []).map((c) => {
            const bouton = new ButtonBuilder()
                .setCustomId(`${panneau}:${c.cle}`)
                .setLabel(c.libelle)
                .setStyle(STYLES[c.style] || STYLES.secondaire);
            if (c.emoji) bouton.setEmoji(c.emoji);
            return bouton;
        }),
    );
    return [rangee.toJSON()];
}

module.exports = { poserPanneau };
