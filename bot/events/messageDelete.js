const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

module.exports = definirEvenement({
    nom: 'messageSupprime',

    async executer(ctx, message) {
        if (!message.guildeId || message.auteur?.estBot) return;
        if (message.partiel) return; // Pas assez d'infos

        const contenu = message.contenu?.slice(0, 1024) || '*contenu non disponible*';
        const champs = [
            {
                nom: 'Auteur',
                valeur: message.auteur ? `${message.auteur.mention} (${message.auteur.etiquette})` : 'Inconnu',
                enLigne: true,
            },
            { nom: 'Channel', valeur: `<#${message.canalId}>`, enLigne: true },
            { nom: 'Contenu', valeur: contenu },
        ];

        // Les pièces jointes ne sont listées que par leur nom, et c'est souvent
        // la seule trace qu'il en reste : le fichier, lui, est parti avec le
        // message.
        if (message.piecesJointes.length > 0) {
            champs.push({ nom: '📎 Pièces jointes', valeur: message.piecesJointes.map(p => p.nom).join(', ') });
        }

        // Portée d'écriture construite à la main : le contexte d'un événement ne
        // porte pas de serveur, c'est le payload qui le désigne.
        await sendLog({ guildeId: message.guildeId, api: ctx.api }, 'msg_delete', embed({
            titre: '🗑️ Message supprimé',
            couleur: 0xe74c3c,
            champs,
            horodatage: true,
        }));
    },
});
