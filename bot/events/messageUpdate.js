const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

module.exports = definirEvenement({
    nom: 'messageModifie',

    async executer(ctx, avant, apres) {
        if (!apres.guildeId || apres.auteur?.estBot) return;
        if (avant.partiel || apres.partiel) return;
        if (avant.contenu === apres.contenu) return; // Embed preview, pas un edit

        await sendLog({ guildeId: apres.guildeId, api: ctx.api }, 'msg_edit', embed({
            titre: '✏️ Message modifié',
            couleur: 0x3498db,
            // Le lien pointe sur le message : sans lui, on lit un avant/après
            // sans pouvoir aller voir le fil de la conversation.
            lien: apres.lien,
            champs: [
                { nom: 'Auteur', valeur: `${apres.auteur.mention} (${apres.auteur.etiquette})`, enLigne: true },
                { nom: 'Channel', valeur: `<#${apres.canalId}>`, enLigne: true },
                { nom: 'Avant', valeur: (avant.contenu || '*vide*').slice(0, 1024) },
                { nom: 'Après', valeur: (apres.contenu || '*vide*').slice(0, 1024) },
            ],
            horodatage: true,
        }));
    },
});
