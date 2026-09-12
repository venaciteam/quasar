const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

// Configuration des salons vocaux temporaires (« Join to Create »).
//
// Cette commande ne manipule que la table `tempvoice_triggers` : la création,
// la suppression et le panneau des salons vivent dans `bot/events/voiceStateUpdate.js`.
// Elle est donc intégralement portable — aucun objet vocal ne la traverse.
//
// Ce que le contrat neutre remplace ici, point par point :
//   interaction.options.getChannel()       -> ctx.options.get('salon')
//   guild.channels.cache.get()             -> ctx.api.obtenirCanal()
//   getDb()                                -> ctx.db
//   userError(interaction, …)              -> ctx.erreurUtilisateur(…)
//   new EmbedBuilder()                     -> embed({ … })
module.exports = definirCommande({
    nom: 'tempvoice',
    description: 'Configurer les salons vocaux temporaires',
    permission: 'MANAGE_GUILD',
    // Permissions du BOT, à ne pas confondre avec `permission` ci-dessus qui
    // porte sur le membre. Elles ne servent pas à cette commande-ci mais à ce
    // qu'elle configure : créer et supprimer le salon temporaire
    // (MANAGE_CHANNELS), puis y déplacer la personne (MOVE_MEMBERS). Sans
    // elles, la configuration s'enregistre et rien ne se produit à l'usage.
    permissionsBot: ['MANAGE_CHANNELS', 'MOVE_MEMBERS'],

    sousCommandes: [
        {
            nom: 'setup',
            description: 'Ajouter un salon trigger (Join to Create)',
            options: [
                { nom: 'salon', type: 'canal', typesCanal: ['vocal'], requis: true, description: 'Le salon vocal trigger' },
            ],
            async executer(ctx) {
                const salon = ctx.options.get('salon');
                const categorieId = salon.parentId || '';

                // Vérifier qu'il n'y a pas déjà un trigger dans cette catégorie
                const existant = ctx.db.prepare('SELECT channel_id FROM tempvoice_triggers WHERE guild_id = ? AND category_id = ?')
                    .get(ctx.guildeId, categorieId);

                if (existant && existant.channel_id !== salon.id) {
                    const salonExistant = await ctx.api.obtenirCanal(existant.channel_id);
                    return ctx.repondre(
                        `❌ Il y a déjà un trigger dans cette catégorie : <#${existant.channel_id}>${salonExistant ? '' : ' (supprimé)'}. `
                        + 'Retirez-le d\'abord avec `/tempvoice remove`.',
                        { ephemere: true },
                    );
                }

                ctx.db.prepare(`
                    INSERT INTO tempvoice_triggers (guild_id, channel_id, category_id, enabled)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT(guild_id, channel_id) DO UPDATE SET enabled = 1
                `).run(ctx.guildeId, salon.id, categorieId);

                await ctx.repondre(embed({
                    titre: '🎧 Trigger ajouté',
                    description: `<#${salon.id}> est maintenant un salon "Join to Create".\n\nLes membres qui le rejoindront auront un vocal créé automatiquement dans la même catégorie.`,
                    couleur: 0xc86e8e,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'remove',
            description: 'Retirer un salon trigger',
            options: [
                { nom: 'salon', type: 'canal', typesCanal: ['vocal'], requis: true, description: 'Le salon vocal trigger à retirer' },
            ],
            async executer(ctx) {
                const salon = ctx.options.get('salon');

                const supprime = ctx.db.prepare('DELETE FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ?')
                    .run(ctx.guildeId, salon.id);

                if (supprime.changes === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Ce salon n\'est pas un salon d\'accueil',
                        cause: 'Ce salon vocal ne déclenche pas la création de salons temporaires.',
                        action: 'Consultez les salons d\'accueil configurés avec `/tempvoice list`.',
                    });
                }

                await ctx.repondre(embed({
                    titre: '🎧 Trigger retiré',
                    description: `<#${salon.id}> n'est plus un salon trigger.`,
                    couleur: 0xe74c3c,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'disable',
            description: 'Désactiver tous les vocaux temporaires',
            async executer(ctx) {
                const resultat = ctx.db.prepare('UPDATE tempvoice_triggers SET enabled = 0 WHERE guild_id = ?').run(ctx.guildeId);
                if (resultat.changes === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Aucun salon d\'accueil configuré',
                        cause: 'Les salons vocaux temporaires ne sont pas encore activés sur ce serveur.',
                        action: 'Configurez un salon d\'accueil avec `/tempvoice setup`.',
                    });
                }
                await ctx.repondre(embed({
                    titre: '🎧 Vocaux temporaires désactivés',
                    description: 'Tous les triggers sont désactivés. Les salons actifs resteront jusqu\'à ce qu\'ils soient vidés.',
                    couleur: 0xe74c3c,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'enable',
            description: 'Réactiver tous les vocaux temporaires',
            async executer(ctx) {
                const resultat = ctx.db.prepare('UPDATE tempvoice_triggers SET enabled = 1 WHERE guild_id = ?').run(ctx.guildeId);
                if (resultat.changes === 0) {
                    return ctx.erreurUtilisateur({
                        titre: 'Aucun salon d\'accueil configuré',
                        cause: 'Les salons vocaux temporaires ne sont pas encore activés sur ce serveur.',
                        action: 'Configurez un salon d\'accueil avec `/tempvoice setup`.',
                    });
                }
                await ctx.repondre(embed({
                    titre: '🎧 Vocaux temporaires réactivés',
                    description: 'Tous les triggers sont de nouveau actifs.',
                    couleur: 0xc86e8e,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'info',
            description: 'Afficher la configuration actuelle',
            async executer(ctx) {
                const triggers = ctx.db.prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ?').all(ctx.guildeId);

                if (triggers.length === 0) {
                    return ctx.repondre('🎧 Aucun trigger configuré. Utilisez `/tempvoice setup` pour commencer.', { ephemere: true });
                }

                const actifs = ctx.db.prepare('SELECT COUNT(*) as count FROM tempvoice_active WHERE guild_id = ?').get(ctx.guildeId).count;
                const preferences = ctx.db.prepare('SELECT COUNT(*) as count FROM tempvoice_preferences WHERE guild_id = ?').get(ctx.guildeId).count;

                // Le nom de la catégorie passe par le client REST normalisé : il
                // n'y a pas de cache de salons sur la voie neutre, et une
                // catégorie supprimée rend `null` — exactement ce que rendait le
                // cache, à la même place.
                const lignes = await Promise.all(triggers.map(async (trigger) => {
                    const categorie = trigger.category_id ? await ctx.api.obtenirCanal(trigger.category_id) : null;
                    const etat = trigger.enabled ? '✅' : '❌';
                    return `${etat} <#${trigger.channel_id}> → ${categorie ? categorie.nom : 'Sans catégorie'}`;
                }));

                await ctx.repondre(embed({
                    titre: '🎧 Vocaux temporaires — Config',
                    couleur: 0xc86e8e,
                    champs: [
                        { nom: 'Triggers', valeur: lignes.join('\n') },
                        { nom: 'Vocaux actifs', valeur: `${actifs}`, enLigne: true },
                        { nom: 'Préférences sauvées', valeur: `${preferences}`, enLigne: true },
                    ],
                    horodatage: true,
                }));
            },
        },
    ],
});
