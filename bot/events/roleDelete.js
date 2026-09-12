const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

// Pas de garde `role.gere` ici, contrairement à `roleCree` : la suppression d'un
// rôle géré par une intégration est journalisée, elle. Asymétrie d'origine,
// conservée telle quelle.
module.exports = definirEvenement({
    nom: 'roleSupprime',
    async executer(ctx, role) {
        await sendLog({ guildeId: role.guildeId, api: ctx.api }, 'server_role', embed({
            titre: '🎭 Rôle supprimé',
            couleur: 0xe74c3c,
            champs: [
                { nom: 'Nom', valeur: role.nom, enLigne: true },
                { nom: 'Couleur', valeur: role.couleur, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
