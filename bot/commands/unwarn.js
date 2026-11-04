const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'unwarn',
    description: 'Retirer un avertissement',
    permission: 'MODERATE_MEMBERS',
    // Écriture en base et réponse : rien à demander à la plateforme.
    permissionsBot: [],

    options: [
        { nom: 'id', type: 'entier', requis: true, description: 'ID de la sanction à retirer' },
    ],

    async executer(ctx) {
        const sanctionId = ctx.options.get('id');

        const sanction = ctx.db.prepare(`
            SELECT * FROM sanctions WHERE id = ? AND guild_id = ? AND type = 'warn'
        `).get(sanctionId, ctx.guildeId);

        if (!sanction) {
            return ctx.erreurUtilisateur({
                titre: 'Avertissement introuvable',
                cause: 'Aucun avertissement ne porte cet identifiant sur ce serveur. Il a peut-être été supprimé, ou l\'identifiant appartient à un autre serveur.',
                action: 'Retrouvez le bon identifiant avec `/warns @membre` — il est affiché à côté de chaque avertissement.',
            });
        }

        if (!sanction.active) {
            return ctx.erreurUtilisateur({
                titre: 'Avertissement déjà retiré',
                cause: 'Cet avertissement a déjà été retiré : il ne compte plus dans le total du membre.',
                action: 'Aucune action nécessaire. `/warns @membre` affiche les avertissements encore actifs.',
            });
        }

        ctx.db.prepare('UPDATE sanctions SET active = 0 WHERE id = ?').run(sanctionId);

        await ctx.repondre(embed({
            titre: '✅ Avertissement retiré',
            couleur: 0x2ecc71,
            champs: [
                { nom: 'Sanction', valeur: `#${sanctionId}`, enLigne: true },
                { nom: 'Membre', valeur: `<@${sanction.user_id}>`, enLigne: true },
                { nom: 'Retiré par', valeur: ctx.auteur.mention, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
