const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

module.exports = definirEvenement({
    nom: 'canalSupprime',
    async executer(ctx, canal) {
        if (!canal.guildeId) return;

        // Skip les vocaux dans une catégorie TempVoice
        if (canal.type === 'vocal' && canal.parentId) {
            try {
                const trouve = ctx.db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND category_id = ? AND enabled = 1')
                    .get(canal.guildeId, canal.parentId);
                if (trouve) return;
            } catch (e) {
                console.error('[Quasar] Erreur vérification TempVoice (channelDelete):', e.message || e);
            }
        }

        // Même libellé de repli qu'à la création : `type` ne nomme que les quatre
        // salons que Quasar manipule, l'entier de la plateforme couvre le reste.
        const libelle = canal.type === 'texte' ? 'Textuel'
            : canal.type === 'vocal' ? 'Vocal'
                : `Type ${canal.typeNatif}`;

        await sendLog({ guildeId: canal.guildeId, api: ctx.api }, 'server_channel', embed({
            titre: '📝 Channel supprimé',
            couleur: 0xe74c3c,
            champs: [
                { nom: 'Nom', valeur: `#${canal.nom}`, enLigne: true },
                { nom: 'Type', valeur: libelle, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
