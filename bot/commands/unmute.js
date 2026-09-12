const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'unmute',
    description: 'Unmute un membre',
    permission: 'MODERATE_MEMBERS',
    permissionsBot: ['MODERATE_MEMBERS'],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à unmute' },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');
        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);

        if (!membre) {
            return ctx.erreurUtilisateur({
                titre: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur.',
                action: 'Vérifiez qu\'elle en est toujours membre.',
            });
        }

        // `timeoutJusqua` porte l'échéance de l'exclusion, ou null. Sans ce
        // garde, la commande annoncerait une levée là où il n'y avait rien à
        // lever — l'exclusion a souvent simplement expiré.
        if (!membre.timeoutJusqua) {
            return ctx.erreurUtilisateur({
                titre: 'Ce membre n\'est pas exclu',
                cause: 'Aucune exclusion temporaire n\'est en cours pour cette personne — elle a peut-être déjà expiré.',
                action: 'Aucune action nécessaire.',
            });
        }

        try {
            // Une échéance nulle LÈVE l'exclusion : c'est la même méthode que
            // pour la poser, dans l'autre sens.
            await ctx.api.appliquerTimeout(ctx.guildeId, cible.id, null);
        } catch {
            return ctx.erreurUtilisateur({
                titre: 'Je ne peux pas lever cette exclusion',
                cause: 'Soit il me manque la permission **Exclure temporairement des membres**, soit ce membre a un rôle situé au-dessus du mien.',
                action: 'Vérifiez mes permissions, et placez mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
            });
        }

        await ctx.repondre(embed({
            titre: '🔊 Unmute',
            couleur: 0x2ecc71,
            champs: [
                { nom: 'Membre', valeur: `${cible.mention} (${cible.etiquette})`, enLigne: true },
                { nom: 'Unmute par', valeur: ctx.auteur.mention, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
