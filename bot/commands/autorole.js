const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { describeRefusal } = require('../utils/assignableRole');

// Seconde commande témoin du registre déclaratif (lot 0) : forme à
// sous-commandes, avec options. Avec /ping, elle couvre les deux seules formes
// que prennent les 29 commandes du bot.
//
// Ce que le contrat neutre remplace ici, point par point :
//   interaction.options.getRole()          -> ctx.options.get('role')
//   checkAssignableRole(guild, role)       -> ctx.api.verifierRoleAttribuable()
//   getDb()                                -> ctx.db
//   userError(interaction, …)              -> ctx.erreurUtilisateur(…)
//   new EmbedBuilder()                     -> embed({ … })
module.exports = definirCommande({
    nom: 'autorole',
    description: 'Gérer les rôles attribués automatiquement à l\'arrivée',
    permission: 'MANAGE_ROLES',
    // Permission du BOT, à ne pas confondre avec `permission` ci-dessus qui
    // porte sur le membre. C'est elle qui alimente le contrôle du masque du lien
    // d'invitation : sans MANAGE_ROLES, la configuration s'enregistre mais
    // l'attribution échoue plus tard, à l'arrivée d'un membre.
    permissionsBot: ['MANAGE_ROLES'],

    sousCommandes: [
        {
            nom: 'add',
            description: 'Ajouter un rôle automatique',
            options: [
                { nom: 'role', type: 'role', requis: true, description: 'Le rôle à attribuer' },
            ],
            async executer(ctx) {
                const role = ctx.options.get('role');

                const refus = await ctx.api.verifierRoleAttribuable(ctx.guildeId, role.id);
                if (refus) {
                    // `describeRefusal` lit encore `role.name` : elle vit dans
                    // bot/utils/assignableRole.js, hors périmètre du lot 0 et
                    // migrée au lot 2. L'adaptation tient en une ligne, elle
                    // disparaîtra avec elle.
                    const { title, cause, action } = describeRefusal(refus, { name: role.nom });
                    return ctx.erreurUtilisateur({ titre: title, cause, action });
                }

                ctx.db.prepare('INSERT OR IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)')
                    .run(ctx.guildeId, role.id);

                await ctx.repondre(embed({
                    titre: '✅ Autorole ajouté',
                    couleur: 0xc86e8e,
                    description: `${role.mention} sera attribué automatiquement à chaque nouveau membre.`,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'remove',
            description: 'Retirer un rôle automatique',
            options: [
                { nom: 'role', type: 'role', requis: true, description: 'Le rôle à retirer' },
            ],
            async executer(ctx) {
                const role = ctx.options.get('role');
                const resultat = ctx.db.prepare('DELETE FROM autoroles WHERE guild_id = ? AND role_id = ?')
                    .run(ctx.guildeId, role.id);

                if (resultat.changes === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Ce rôle n\'est pas un autorôle',
                        cause: 'Il ne fait pas partie des rôles attribués automatiquement à l\'arrivée.',
                        action: 'Consultez la liste avec `/autorole list`.',
                    });
                }

                await ctx.repondre(embed({
                    titre: '🗑️ Autorole retiré',
                    couleur: 0xe74c3c,
                    description: `${role.mention} ne sera plus attribué automatiquement.`,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'list',
            description: 'Voir les rôles automatiques configurés',
            async executer(ctx) {
                const roles = ctx.db.prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').all(ctx.guildeId);

                if (roles.length === 0) {
                    return ctx.repondre('Aucun autorole configuré.', { ephemere: true });
                }

                await ctx.repondre(embed({
                    titre: '🎭 Autoroles',
                    couleur: 0x6e8ec8,
                    description: roles.map(r => `<@&${r.role_id}>`).join('\n'),
                    horodatage: true,
                }));
            },
        },
    ],
});
