const { definirEvenement } = require('../platform/events');
const { schedulePurge } = require('../modules/retention/purge');
const { getGraceDays } = require('../modules/retention');

module.exports = definirEvenement({
    nom: 'guildeQuittee',

    async executer(ctx, guilde) {
        // Une panne côté plateforme peut rendre un serveur temporairement
        // indisponible, et l'événement de départ est émis à l'identique. Purger
        // dans ce cas détruirait les données de serveurs parfaitement actifs :
        // on ne réagit qu'à un vrai retrait.
        if (guilde.disponible === false) {
            console.log(`[Quasar] Serveur ${guilde.id} temporairement indisponible — aucune purge programmée.`);
            return;
        }

        const graceDays = getGraceDays();
        console.log(`[Quasar] Retiré du serveur: ${guilde.nom} (${guilde.id})`);

        try {
            const purgeAfter = schedulePurge(guilde.id, graceDays);

            if (graceDays === 0) {
                console.log(`[Quasar Rétention] Purge immédiate programmée pour ${guilde.id}.`);
            } else {
                const when = new Date(purgeAfter * 1000).toISOString().slice(0, 10);
                console.log(
                    `[Quasar Rétention] Données du serveur ${guilde.id} programmées pour suppression le ${when} ` +
                    `(délai de grâce : ${graceDays} jour(s)). Réinviter le bot avant cette date annule la suppression.`
                );
            }
        } catch (err) {
            console.error(`[Quasar Rétention] Impossible de programmer la purge de ${guilde.id} :`, err.message);
        }
    },
});
