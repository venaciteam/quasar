const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { describeRefusal } = require('../utils/assignableRole');

// Le sélecteur de salon filtre par TYPE, et le filtre se déclare en noms
// canoniques (bot/platform/channels.js) : `vocal` et `conference` dérivent vers
// les mêmes `ChannelType.GuildVoice` et `GuildStageVoice` qu'avant, sans que ce
// fichier connaisse les entiers de la plateforme.
const SALONS_VOCAUX = ['vocal', 'conference'];

/**
 * La table `voice_roles` n'est pas créée par le schéma de `database.js` : elle
 * l'est à la volée, à chaque exécution de la commande, depuis toujours. On
 * conserve ce fonctionnement tel quel — le déplacer dans le schéma serait une
 * correction, et ce lot est à comportement constant.
 */
function assurerTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS voice_roles (
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            PRIMARY KEY (guild_id, channel_id)
        )
    `);
}

module.exports = definirCommande({
    nom: 'voicerole',
    description: 'Gérer les rôles vocaux (attribués en vocal, retirés à la déconnexion)',
    permission: 'MANAGE_ROLES',
    // Permission du BOT : c'est `voiceStateUpdate` qui attribue et retire le
    // rôle, bien après cette commande. Sans elle, la configuration s'enregistre
    // et rien ne se passe jamais en vocal.
    permissionsBot: ['MANAGE_ROLES'],

    sousCommandes: [
        {
            nom: 'set',
            description: 'Définir un rôle pour un salon vocal',
            options: [
                { nom: 'salon', type: 'canal', requis: true, description: 'Le salon vocal', typesCanal: SALONS_VOCAUX },
                { nom: 'role', type: 'role', requis: true, description: 'Le rôle à attribuer' },
            ],
            async executer(ctx) {
                const db = ctx.db;
                assurerTable(db);

                const salon = ctx.options.get('salon');
                const role = ctx.options.get('role');

                // Un rôle vocal inattribuable échoue à chaque connexion en vocal,
                // en silence côté administrateur : autant refuser tout de suite.
                const refus = await ctx.api.verifierRoleAttribuable(ctx.guildeId, role.id);
                if (refus) {
                    const { title, cause, action } = describeRefusal(refus, role);
                    return ctx.erreurUtilisateur({ titre: title, cause, action });
                }

                db.prepare(`
                    INSERT INTO voice_roles (guild_id, channel_id, role_id)
                    VALUES (?, ?, ?)
                    ON CONFLICT(guild_id, channel_id)
                    DO UPDATE SET role_id = ?
                `).run(ctx.guildeId, salon.id, role.id, role.id);

                await ctx.repondre(embed({
                    titre: '🔊 Rôle vocal configuré',
                    couleur: 0xc86e8e,
                    champs: [
                        { nom: 'Salon', valeur: salon.mention, enLigne: true },
                        { nom: 'Rôle', valeur: role.mention, enLigne: true },
                    ],
                    description: 'Les membres recevront ce rôle en rejoignant le vocal et le perdront en partant.',
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'remove',
            description: 'Retirer le rôle vocal d\'un salon',
            options: [
                { nom: 'salon', type: 'canal', requis: true, description: 'Le salon vocal', typesCanal: SALONS_VOCAUX },
            ],
            async executer(ctx) {
                const db = ctx.db;
                assurerTable(db);

                const salon = ctx.options.get('salon');
                const supprimes = db.prepare('DELETE FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                    .run(ctx.guildeId, salon.id);

                if (supprimes.changes === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Aucun rôle vocal pour ce salon',
                        cause: 'Ce salon vocal n\'a pas de rôle associé : personne ne reçoit de rôle en le rejoignant.',
                        action: 'Consultez la configuration avec `/voicerole list`, ou ajoutez une règle avec `/voicerole set`.',
                    });
                }

                await ctx.repondre(embed({
                    titre: '🔇 Rôle vocal retiré',
                    couleur: 0xe74c3c,
                    description: `Le rôle vocal de ${salon.mention} a été supprimé.`,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'list',
            description: 'Voir les rôles vocaux configurés',
            async executer(ctx) {
                const db = ctx.db;
                assurerTable(db);

                const rolesVocaux = db.prepare('SELECT channel_id, role_id FROM voice_roles WHERE guild_id = ?')
                    .all(ctx.guildeId);

                if (rolesVocaux.length === 0) {
                    return ctx.repondre('Aucun rôle vocal configuré.', { ephemere: true });
                }

                await ctx.repondre(embed({
                    titre: '🔊 Rôles vocaux',
                    couleur: 0x6ecfc8,
                    description: rolesVocaux
                        .map(vr => `🔊 <#${vr.channel_id}> → <@&${vr.role_id}>`)
                        .join('\n'),
                    horodatage: true,
                }));
            },
        },
    ],
});
