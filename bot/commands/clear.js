const { definirCommande } = require('../platform/commands');
const { reportIncident } = require('../utils/errors');

// Profondeur de recherche quand la purge vise une personne : on relit les cent
// derniers messages du salon, puis on filtre. C'est le maximum d'une page
// d'historique, et le message d'erreur le dit quand rien n'en ressort.
const PROFONDEUR_RECHERCHE = 100;

module.exports = definirCommande({
    nom: 'clear',
    description: 'Supprimer des messages',
    permission: 'MANAGE_MESSAGES',
    // Lire l'historique est aussi nécessaire que supprimer : sans
    // READ_MESSAGE_HISTORY, il n'y a rien à passer à la suppression en lot.
    permissionsBot: ['MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY'],

    options: [
        { nom: 'nombre', type: 'entier', requis: true, min: 1, max: 100, description: 'Nombre de messages à supprimer (1-100)' },
        { nom: 'membre', type: 'utilisateur', requis: false, description: 'Supprimer uniquement les messages de ce membre' },
    ],

    async executer(ctx) {
        const amount = ctx.options.get('nombre');
        const cible = ctx.options.get('membre');

        // Acquittement AVANT le travail : relire cent messages puis les
        // supprimer en lot dépasse régulièrement les trois secondes que la
        // plateforme laisse pour répondre.
        await ctx.differer({ ephemere: true });

        try {
            if (cible) {
                // Récupérer les messages et filtrer par utilisateur
                const messages = await ctx.api.listerMessages(ctx.canalId, { limite: PROFONDEUR_RECHERCHE });
                const siens = messages.filter(m => m.auteur?.id === cible.id).slice(0, amount);

                if (siens.length === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Aucun message à supprimer',
                        cause: `Je n'ai trouvé aucun message de ${cible.mention} parmi les ${PROFONDEUR_RECHERCHE} derniers messages de ce salon.`,
                        action: `Cette personne n'a peut-être rien écrit récemment ici. La recherche ne remonte pas au-delà de ${PROFONDEUR_RECHERCHE} messages.`,
                    });
                }

                // `supprimerMessagesEnLot` écarte lui-même les messages de plus
                // de 14 jours, que la plateforme refuse en lot — et rejette
                // sinon le lot ENTIER. `supprimes` ne compte donc que ce qui est
                // réellement parti, comme le faisait le filtre d'avant.
                const { supprimes } = await ctx.api.supprimerMessagesEnLot(ctx.canalId, siens.map(m => m.id));
                await ctx.repondre(`🗑️ **${supprimes}** message(s) de ${cible.mention} supprimé(s).`);
            } else {
                const messages = await ctx.api.listerMessages(ctx.canalId, { limite: amount });
                const { supprimes } = await ctx.api.supprimerMessagesEnLot(ctx.canalId, messages.map(m => m.id));
                await ctx.repondre(`🗑️ **${supprimes}** message(s) supprimé(s).`);
            }
        } catch (e) {
            return reportIncident(ctx, e, { command: '/clear' });
        }
    },
});
