const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

module.exports = definirCommande({
    nom: 'log',
    description: 'Définir le channel de logs de modération',
    permission: 'ADMINISTRATOR',
    // La commande n'écrit qu'en base ; c'est la journalisation elle-même qui
    // aura besoin d'écrire dans le salon, et elle relève du socle d'envoi.
    permissionsBot: [],

    options: [
        { nom: 'channel', type: 'canal', requis: true, typesCanal: ['texte'], description: 'Le channel de logs' },
    ],

    async executer(ctx) {
        const channel = ctx.options.get('channel');

        // Upsert module moderation avec le logChannel
        const existing = ctx.db.prepare(`
            SELECT config FROM modules WHERE guild_id = ? AND module_name = 'moderation'
        `).get(ctx.guildeId);

        let config = {};
        if (existing) {
            config = JSON.parse(existing.config || '{}');
        }
        config.logChannel = channel.id;

        ctx.db.prepare(`
            INSERT INTO modules (guild_id, module_name, enabled, config)
            VALUES (?, 'moderation', 1, ?)
            ON CONFLICT(guild_id, module_name)
            DO UPDATE SET config = ?, enabled = 1
        `).run(ctx.guildeId, JSON.stringify(config), JSON.stringify(config));

        await ctx.repondre(embed({
            titre: '📝 Logs de modération',
            couleur: 0xc8a86e,
            description: `Les logs seront envoyés dans ${channel.mention}.`,
            horodatage: true,
        }));
    },
});
