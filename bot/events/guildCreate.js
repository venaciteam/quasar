const { getDb } = require('../../api/services/database');
const { cancelPurge } = require('../modules/retention/purge');

module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild) {
        console.log(`[Quasar] Rejoint le serveur: ${guild.name} (${guild.id})`);
        const db = getDb();
        db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)')
            .run(guild.id, guild.name);

        // Le bot avait été retiré et est réinvité avant la fin du délai de grâce :
        // la suppression programmée n'a plus lieu d'être, la configuration est conservée.
        try {
            if (cancelPurge(guild.id)) {
                console.log(`[Quasar Rétention] Suppression programmée annulée pour ${guild.id} (bot réinvité).`);
            }
        } catch (err) {
            console.error(`[Quasar Rétention] Erreur à l'annulation de la purge de ${guild.id} :`, err.message);
        }
    }
};
