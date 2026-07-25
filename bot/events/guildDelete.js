const { schedulePurge } = require('../modules/retention/purge');
const { getGraceDays } = require('../modules/retention');

module.exports = {
    name: 'guildDelete',
    once: false,
    async execute(guild) {
        // Une panne côté Discord peut rendre un serveur temporairement indisponible.
        // Purger dans ce cas détruirait les données de serveurs parfaitement actifs :
        // on ne réagit qu'à un vrai retrait.
        if (guild.available === false) {
            console.log(`[Quasar] Serveur ${guild.id} temporairement indisponible — aucune purge programmée.`);
            return;
        }

        const graceDays = getGraceDays();
        console.log(`[Quasar] Retiré du serveur: ${guild.name} (${guild.id})`);

        try {
            const purgeAfter = schedulePurge(guild.id, graceDays);

            if (graceDays === 0) {
                console.log(`[Quasar Rétention] Purge immédiate programmée pour ${guild.id}.`);
            } else {
                const when = new Date(purgeAfter * 1000).toISOString().slice(0, 10);
                console.log(
                    `[Quasar Rétention] Données du serveur ${guild.id} programmées pour suppression le ${when} ` +
                    `(délai de grâce : ${graceDays} jour(s)). Réinviter le bot avant cette date annule la suppression.`
                );
            }
        } catch (err) {
            console.error(`[Quasar Rétention] Impossible de programmer la purge de ${guild.id} :`, err.message);
        }
    }
};
