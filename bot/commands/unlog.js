const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'unlog',
    description: 'Retirer le channel de logs de modération',
    permission: 'ADMINISTRATOR',
    // Écriture en base et réponse : rien à demander à la plateforme.
    permissionsBot: [],

    async executer(ctx) {
        const existing = ctx.db.prepare(`
            SELECT config FROM modules WHERE guild_id = ? AND module_name = 'moderation'
        `).get(ctx.guildeId);

        if (!existing) {
            return ctx.erreurUtilisateur({
                titre: 'Aucun salon de logs configuré',
                cause: 'Il n\'y a rien à retirer : aucun salon de logs n\'est défini sur ce serveur.',
                action: 'Pour en définir un, utilisez `/log #salon`.',
            });
        }

        const config = JSON.parse(existing.config || '{}');
        delete config.logChannel;

        ctx.db.prepare(`
            UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = 'moderation'
        `).run(JSON.stringify(config), ctx.guildeId);

        await ctx.repondre(embed({
            titre: '📝 Logs de modération',
            couleur: 0xe74c3c,
            description: 'Les logs de modération ont été désactivés.',
            horodatage: true,
        }));
    },
});
