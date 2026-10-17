const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'sanctions',
    description: 'Voir l\'historique complet des sanctions d\'un membre',
    permission: 'MODERATE_MEMBERS',
    // Lecture seule en base, puis une réponse : rien à demander à la plateforme.
    permissionsBot: [],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à vérifier' },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');

        const sanctions = ctx.db.prepare(`
            SELECT id, type, moderator_id, reason, duration, created_at, active
            FROM sanctions
            WHERE guild_id = ? AND user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `).all(ctx.guildeId, cible.id);

        if (sanctions.length === 0) {
            return ctx.repondre(`✅ ${cible.mention} n'a aucune sanction.`, { ephemere: true });
        }

        const icons = { warn: '⚠️', mute: '🔇', kick: '🔴', ban: '🔨' };
        const lines = sanctions.map(s => {
            const icon = icons[s.type] || '📋';
            const status = s.active ? '' : ' *(retiré)*';
            const date = new Date(s.created_at + 'Z').toLocaleDateString('fr-FR');
            const duration = s.duration ? ` (${s.duration})` : '';
            return `${icon} **#${s.id}** ${s.type}${duration} — ${s.reason} (par <@${s.moderator_id}> le ${date})${status}`;
        });

        await ctx.repondre(embed({
            titre: `📋 Sanctions de ${cible.etiquette}`,
            couleur: 0xc8a86e,
            description: lines.join('\n'),
            pied: { texte: `${sanctions.length} sanction(s) affichée(s)` },
            horodatage: true,
        }));
    },
});
