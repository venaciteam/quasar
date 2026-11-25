const { definirEvenement } = require('../platform/events');
const { cancelPurge } = require('../modules/retention/purge');

// Arrivée du bot sur un serveur.
//
// Le redéploiement des commandes slash à l'invitation — correctif v4.10.0 — ne
// figure PLUS ici : c'est une mécanique strictement Discord, portée par
// l'adaptateur sur son événement natif (cf. `brancherDeploiementAInvitation`
// dans bot/platform/discord/index.js). Ce fichier ne garde que la logique
// métier, valable sur n'importe quelle plateforme.
//
// Les deux sont indépendants par construction : un déploiement en échec
// n'empêche ni l'enregistrement du serveur ni l'annulation d'une purge
// programmée, et réciproquement.
module.exports = definirEvenement({
    nom: 'guildeRejointe',

    async executer(ctx, guilde) {
        console.log(`[Quasar] Rejoint le serveur: ${guilde.nom} (${guilde.id})`);

        ctx.db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)')
            .run(guilde.id, guilde.nom);

        // Le bot avait été retiré et est réinvité avant la fin du délai de grâce :
        // la suppression programmée n'a plus lieu d'être, la configuration est conservée.
        try {
            if (cancelPurge(guilde.id)) {
                console.log(`[Quasar Rétention] Suppression programmée annulée pour ${guilde.id} (bot réinvité).`);
            }
        } catch (err) {
            console.error(`[Quasar Rétention] Erreur à l'annulation de la purge de ${guilde.id} :`, err.message);
        }
    },
});
