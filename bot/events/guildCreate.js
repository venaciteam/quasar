const { getDb } = require('../../api/services/database');
const { cancelPurge } = require('../modules/retention/purge');
const { deployCommandsForGuild } = require('../utils/deploy-commands');

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

        // Déploiement des commandes slash sur le serveur qui vient d'inviter le
        // bot. Sans cela, elles n'arrivaient qu'au prochain démarrage du
        // processus : la procédure d'installation documentée lance le bot AVANT
        // l'invitation, si bien que la toute première expérience d'une nouvelle
        // installation était un bot en ligne, un dashboard fonctionnel, et
        // AUCUNE commande sur le serveur.
        //
        // En try/catch, et volontairement non fatal : un échec de déploiement ne
        // doit pas empêcher l'enregistrement du serveur ni l'annulation de la
        // purge, qui sont déjà faits ci-dessus. Le prochain démarrage rattrapera.
        try {
            await deployCommandsForGuild(guild);
        } catch (err) {
            console.error(`[Quasar] Déploiement des commandes impossible sur ${guild.name} :`, err.message);
        }
    }
};
