// Plus nécessaire pour les reaction roles (le bot retire la réaction de l'user immédiatement)
// Ce fichier est gardé vide pour éviter les erreurs de chargement
const { definirEvenement } = require('../platform/events');

module.exports = definirEvenement({
    nom: 'reactionRetiree',
    async executer() {
        // Intentionnellement vide
    },
});
