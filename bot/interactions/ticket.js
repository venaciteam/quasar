// ═══════════════════════════════════════════════════════════════
//  Boutons de tickets — pont de compatibilité
//
//  TRANSITION : format historique, à retirer au lot de consolidation.
//
//  Tout le parcours des tickets vit désormais dans le descripteur de
//  `/ticket` : le panneau est déclaré dans sa clé `panneaux`, posé par
//  `ctx.poserPanneau` et routé par le registre. Les `customId` produits sont
//  `ticket:ouvrir` et `ticket:fermer`.
//
//  Ce fichier ne subsiste que pour les panneaux POSÉS AVANT la mise à jour, qui
//  portent encore `ticket_open`, `ticket_close` et `ticket_close_reason` — des
//  identifiants qu'aucun routage neutre ne peut capter (le séparateur diffère :
//  « _ » contre « : »). `bot/index.js` les lui envoie toujours, et le laisser
//  muet afficherait « L'interaction a échoué » sans rien expliquer.
//
//  Il ne réimplémente donc PAS l'ancien parcours : il dit ce qui s'est passé et
//  ce qu'il faut faire. Le jour où le routage `ticket_` disparaît de
//  `bot/index.js`, ce fichier disparaît avec lui.
// ═══════════════════════════════════════════════════════════════

const { userError } = require('../utils/errors');

// Les trois identifiants que l'ancien parcours produisait.
const IDENTIFIANTS_HISTORIQUES = Object.freeze(['ticket_open', 'ticket_close', 'ticket_close_reason']);

async function handleTicketInteraction(interaction) {
    if (!IDENTIFIANTS_HISTORIQUES.includes(interaction.customId)) return;

    // Le bouton d'ouverture vit sur le panneau public : c'est un administrateur
    // qui doit le reposer. Le bouton de fermeture vit dans le salon du ticket :
    // la personne peut s'en passer, `/ticket close` fait la même chose.
    const ouverture = interaction.customId === 'ticket_open';

    return userError(interaction, {
        title: 'Ce bouton date d\'une version antérieure',
        cause: 'Il a été posé avant la dernière mise à jour de Quasar et n\'est plus reconnu.',
        action: ouverture
            ? 'Prévenez un administrateur : il doit relancer `/ticket setup` pour reposer le panneau.'
            : 'Utilisez `/ticket close` dans ce salon pour fermer le ticket.',
    });
}

module.exports = { handleTicketInteraction, IDENTIFIANTS_HISTORIQUES };
