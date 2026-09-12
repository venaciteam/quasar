const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');

// Première des deux commandes témoins du registre déclaratif (lot 0) : forme
// simple, sans option. Elle vaut contrôle du contrat de bout en bout — un
// descripteur, une dérivation en commande de plateforme, un contexte neutre —
// pour une commande dont la sortie est vérifiable à l'œil nu.
module.exports = definirCommande({
    nom: 'ping',
    description: 'Vérifier si Quasar est en ligne',
    // Ouverture DÉCLARÉE, pas déduite d'un champ absent : le registre refuse un
    // descripteur qui ne dit pas qui a accès, précisément pour qu'on ne puisse
    // pas confondre « ouverte exprès » et « oubli de migration ».
    accesParDefaut: true,
    // Aucune permission particulière : répondre suffit, et SEND_MESSAGES fait
    // partie du socle sans lequel le bot est muet de toute façon.
    permissionsBot: [],

    async executer(ctx) {
        // `creeLe` est l'horodatage de réception de la commande, et
        // `latencePasserelle` le battement de la connexion temps réel. Les deux
        // existent sur toute plateforme : aucune horloge propre à Discord ici.
        const latence = Date.now() - ctx.creeLe;

        await ctx.repondre(embed({
            titre: '🏓 Pong !',
            couleur: 0xc8a86e,
            champs: [
                { nom: 'Latence', valeur: `${latence}ms`, enLigne: true },
                { nom: 'API Discord', valeur: `${ctx.latencePasserelle ?? '—'}ms`, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
