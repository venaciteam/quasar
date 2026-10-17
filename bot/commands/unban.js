const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { CODES_NEUTRES, codeNeutre } = require('../platform/erreurs');
const { reportIncident } = require('../utils/errors');

module.exports = definirCommande({
    nom: 'unban',
    description: 'Débannir un utilisateur',
    permission: 'BAN_MEMBERS',
    permissionsBot: ['BAN_MEMBERS'],

    options: [
        { nom: 'id', type: 'texte', requis: true, description: 'L\'ID de l\'utilisateur à débannir' },
    ],

    async executer(ctx) {
        const userId = ctx.options.get('id');

        try {
            // Le bannissement est LU avant d'être levé : c'est lui qui porte
            // l'étiquette affichée en retour, seule façon de vérifier qu'on a
            // bien débanni la personne visée et pas un identifiant voisin.
            const bannissement = await ctx.api.obtenirBannissement(ctx.guildeId, userId);
            if (!bannissement) return pasBanni(ctx);

            await ctx.api.debannirMembre(ctx.guildeId, userId);

            await ctx.repondre(embed({
                titre: '✅ Débannissement',
                couleur: 0x2ecc71,
                champs: [
                    { nom: 'Utilisateur', valeur: `${bannissement.utilisateur.etiquette} (${userId})`, enLigne: true },
                    { nom: 'Débanni par', valeur: ctx.auteur.mention, enLigne: true },
                ],
                horodatage: true,
            }));
        } catch (e) {
            // « Déjà fait » est le cas courant, pas un incident : quelqu'un a levé
            // le bannissement entre la lecture et la levée. Le reste est un vrai
            // problème.
            if (codeNeutre(e) === CODES_NEUTRES.deja_fait) return pasBanni(ctx);
            return reportIncident(ctx, e, { command: '/unban' });
        }
    },
});

function pasBanni(ctx) {
    return ctx.erreurUtilisateur({
        titre: 'Cette personne n\'est pas bannie',
        cause: 'Aucun bannissement en cours ne correspond à cet identifiant sur ce serveur.',
        action: 'Vérifiez l\'identifiant dans Paramètres du serveur → Bannissements. Il s\'agit de l\'identifiant Discord, pas du pseudo.',
    });
}
