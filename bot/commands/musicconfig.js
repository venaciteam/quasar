const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

/**
 * Ajoute `allowed_channel` à `music_config` si la colonne manque.
 *
 * Migration en place, héritée : elle s'exécutait à chaque invocation de la
 * commande, quelle que soit la sous-commande. Comportement conservé tel quel —
 * le déplacer hors du parcours serait une correction, pas une migration.
 */
function assurerColonneSalon(db) {
    try {
        db.exec('ALTER TABLE music_config ADD COLUMN allowed_channel TEXT DEFAULT NULL');
    } catch { /* Colonne déjà existante = ignoré */ }
}

// Configuration du module musique.
//
// `plateformes: ['discord']` : la musique n'est pas portable — Fluxer fait sa
// voix en LiveKit et ne publie aucune signalisation, `@discordjs/voice` y est
// inutilisable (DA §1.2). La commande est donc écartée AVANT le déploiement sur
// toute autre plateforme, plutôt que déployée puis refusée à l'exécution.
//
// Le descripteur, lui, est parfaitement neutre : cette commande ne touche qu'à
// la base et à ses propres réponses, jamais à une connexion vocale.
module.exports = definirCommande({
    nom: 'music',
    description: 'Configurer le module musique',
    permission: 'ADMINISTRATOR',
    permissionsBot: [],
    plateformes: ['discord'],

    sousCommandes: [
        {
            nom: 'setchannel',
            description: 'Restreindre les commandes musique à un salon',
            options: [
                { nom: 'channel', type: 'canal', typesCanal: ['texte'], requis: true, description: 'Le salon musique' },
            ],
            async executer(ctx) {
                assurerColonneSalon(ctx.db);
                const salon = ctx.options.get('channel');

                ctx.db.prepare(`INSERT INTO music_config (guild_id, allowed_channel) VALUES (?, ?)
                    ON CONFLICT(guild_id) DO UPDATE SET allowed_channel = ?
                `).run(ctx.guildeId, salon.id, salon.id);

                await ctx.repondre(embed({
                    titre: '🎵 Salon musique configuré',
                    couleur: 0xc86e8e,
                    description: `Les commandes musique ne seront acceptées que dans ${salon.mention}.`,
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'removechannel',
            description: 'Retirer la restriction de salon (commandes partout)',
            async executer(ctx) {
                assurerColonneSalon(ctx.db);

                ctx.db.prepare(`INSERT INTO music_config (guild_id, allowed_channel) VALUES (?, NULL)
                    ON CONFLICT(guild_id) DO UPDATE SET allowed_channel = NULL
                `).run(ctx.guildeId);

                await ctx.repondre(embed({
                    titre: '🎵 Restriction retirée',
                    couleur: 0x6e8ec8,
                    description: 'Les commandes musique sont maintenant acceptées dans tous les salons.',
                    horodatage: true,
                }));
            },
        },
        {
            nom: 'status',
            description: 'Voir la configuration musique actuelle',
            async executer(ctx) {
                assurerColonneSalon(ctx.db);

                const config = ctx.db.prepare('SELECT allowed_channel FROM music_config WHERE guild_id = ?').get(ctx.guildeId);
                const salonId = config?.allowed_channel;

                await ctx.repondre(embed({
                    titre: '🎵 Configuration musique',
                    couleur: 0xc8a86e,
                    description: salonId
                        ? `Commandes musique restreintes à <#${salonId}>.`
                        : 'Commandes musique acceptées dans tous les salons.',
                    horodatage: true,
                }), { ephemere: true });
            },
        },
    ],
});
