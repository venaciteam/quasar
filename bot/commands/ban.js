const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { sendModLog } = require('../utils/modlog');
const { reportIncident } = require('../utils/errors');

// Un jour de messages, en secondes : l'option se saisit en jours, l'API se
// paramètre en secondes.
const SECONDES_PAR_JOUR = 86400;

module.exports = definirCommande({
    nom: 'ban',
    description: 'Bannir un membre',
    permission: 'BAN_MEMBERS',
    permissionsBot: ['BAN_MEMBERS'],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à bannir' },
        { nom: 'raison', type: 'texte', requis: false, description: 'Raison du ban' },
        { nom: 'supprimer', type: 'entier', requis: false, min: 0, max: 7, description: 'Supprimer les messages des X derniers jours (0-7)' },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');
        const raison = ctx.options.get('raison') || 'Aucune raison spécifiée';
        const deleteDays = ctx.options.get('supprimer') || 0;
        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);

        // Bannir quelqu'un qui n'est PLUS sur le serveur reste possible : c'est
        // le seul contrôle qu'on ne fait que si la personne est encore membre.
        if (membre && await ctx.api.verifierMembreSanctionnable(ctx.guildeId, cible.id, 'ban')) {
            return ctx.erreurUtilisateur({
                titre: 'Je ne peux pas bannir ce membre',
                cause: 'Soit il me manque la permission **Bannir des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
                action: 'Vérifiez mes permissions, et placez mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
            });
        }

        try {
            await ctx.api.bannirMembre(ctx.guildeId, cible.id, raison, {
                supprimerMessagesSecondes: deleteDays * SECONDES_PAR_JOUR,
            });
        } catch (e) {
            // Vraie exception : code d'incident pour retrouver la trace.
            return reportIncident(ctx, e, { command: '/ban' });
        }

        ctx.db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'ban', ?)
        `).run(ctx.guildeId, cible.id, ctx.auteur.id, raison);

        const bannissement = embed({
            titre: '🔨 Bannissement',
            couleur: 0xe74c3c,
            champs: [
                { nom: 'Membre', valeur: `${cible.mention} (${cible.etiquette})`, enLigne: true },
                { nom: 'Modérateur', valeur: ctx.auteur.mention, enLigne: true },
                { nom: 'Raison', valeur: raison },
                { nom: 'Messages supprimés', valeur: `${deleteDays} jour(s)`, enLigne: true },
            ],
            horodatage: true,
        });

        await ctx.repondre(bannissement);
        await sendModLog(ctx, bannissement, 'mod_ban');
    },
});
