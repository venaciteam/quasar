const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

module.exports = definirEvenement({
    nom: 'roleCree',
    async executer(ctx, role) {
        if (role.gere) return; // Rôles de bots

        // `guildeId` est porté par le rôle : l'événement neutre ne transmet pas
        // de serveur, et un contexte d'événement n'en vise aucun en propre.
        await sendLog({ guildeId: role.guildeId, api: ctx.api }, 'server_role', embed({
            titre: '🎭 Rôle créé',
            couleur: 0x2ecc71,
            champs: [
                { nom: 'Nom', valeur: role.nom, enLigne: true },
                // `role.couleur` est la forme « #rrggbb » minuscule qu'affichait
                // déjà `hexColor`, « #000000 » pour un rôle sans couleur.
                { nom: 'Couleur', valeur: role.couleur, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
