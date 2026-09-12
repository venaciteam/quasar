const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'warns',
    description: 'Voir les avertissements d\'un membre',
    permission: 'MODERATE_MEMBERS',
    // Lecture seule en base, puis une réponse : rien à demander à la plateforme.
    permissionsBot: [],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à vérifier' },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');

        const warns = ctx.db.prepare(`
            SELECT id, moderator_id, reason, created_at, active
            FROM sanctions
            WHERE guild_id = ? AND user_id = ? AND type = 'warn'
            ORDER BY created_at DESC
        `).all(ctx.guildeId, cible.id);

        if (warns.length === 0) {
            return ctx.repondre(`✅ ${cible.mention} n'a aucun avertissement.`, { ephemere: true });
        }

        const activeWarns = warns.filter(w => w.active);
        const lines = warns.slice(0, 15).map(w => {
            const status = w.active ? '🟡' : '⚪';
            const date = new Date(w.created_at + 'Z').toLocaleDateString('fr-FR');
            return `${status} **#${w.id}** — ${w.reason} (par <@${w.moderator_id}> le ${date})`;
        });

        await ctx.repondre(embed({
            titre: `📋 Avertissements de ${cible.etiquette}`,
            couleur: 0xf1c40f,
            description: lines.join('\n'),
            pied: { texte: `${activeWarns.length} actif(s) / ${warns.length} total` },
            horodatage: true,
        }));
    },
});
