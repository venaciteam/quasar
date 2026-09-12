const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { sendModLog } = require('../utils/modlog');
const { reportIncident } = require('../utils/errors');

module.exports = definirCommande({
    nom: 'kick',
    description: 'Expulser un membre',
    permission: 'KICK_MEMBERS',
    permissionsBot: ['KICK_MEMBERS'],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à expulser' },
        { nom: 'raison', type: 'texte', requis: false, description: 'Raison du kick', reste: true },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');
        const raison = ctx.options.get('raison') || 'Aucune raison spécifiée';
        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);

        if (!membre) {
            return ctx.erreurUtilisateur({
                titre: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur — elle est peut-être déjà partie.',
                action: 'Vérifiez la liste des membres du serveur.',
            });
        }

        // Équivalent neutre de `member.kickable` : il sépare la hiérarchie des
        // rôles de la permission manquante, mais le message rendu reste celui
        // d'avant, qui couvre les deux causes en une phrase.
        if (await ctx.api.verifierMembreSanctionnable(ctx.guildeId, cible.id, 'kick')) {
            return ctx.erreurUtilisateur({
                titre: 'Je ne peux pas expulser ce membre',
                cause: 'Soit il me manque la permission **Expulser des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
                action: 'Vérifiez mes permissions, et placez mon rôle au-dessus du sien dans Paramètres du serveur → Rôles.',
            });
        }

        try {
            await ctx.api.exclureMembre(ctx.guildeId, cible.id, raison);
        } catch (e) {
            // Vraie exception : code d'incident pour retrouver la trace.
            return reportIncident(ctx, e, { command: '/kick' });
        }

        ctx.db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'kick', ?)
        `).run(ctx.guildeId, cible.id, ctx.auteur.id, raison);

        const expulsion = embed({
            titre: '🔴 Expulsion',
            couleur: 0xe74c3c,
            champs: [
                { nom: 'Membre', valeur: `${cible.mention} (${cible.etiquette})`, enLigne: true },
                { nom: 'Modérateur', valeur: ctx.auteur.mention, enLigne: true },
                { nom: 'Raison', valeur: raison },
            ],
            horodatage: true,
        });

        await ctx.repondre(expulsion);
        await sendModLog(ctx, expulsion, 'mod_kick');
    },
});
