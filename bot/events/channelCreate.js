const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

module.exports = definirEvenement({
    nom: 'canalCree',
    async executer(ctx, canal) {
        if (!canal.guildeId) return;

        // Skip les vocaux créés dans une catégorie TempVoice
        if (canal.type === 'vocal' && canal.parentId) {
            try {
                const trouve = ctx.db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND category_id = ? AND enabled = 1')
                    .get(canal.guildeId, canal.parentId);
                if (trouve) return;
            } catch (e) {
                console.error('[Quasar] Erreur vérification TempVoice (channelCreate):', e.message || e);
            }
        }

        // Le libellé de repli reprend l'entier de la plateforme, comme avant :
        // `type` ne nomme que les quatre salons que Quasar manipule, et un forum
        // ou un fil ressortirait sinon en « Type null ».
        const libelle = canal.type === 'texte' ? 'Textuel'
            : canal.type === 'vocal' ? 'Vocal'
                : `Type ${canal.typeNatif}`;

        // La portée d'écriture est explicite : un contexte d'événement porte
        // `api` mais pas de serveur — il n'en vise aucun en propre.
        await sendLog({ guildeId: canal.guildeId, api: ctx.api }, 'server_channel', embed({
            titre: '📝 Channel créé',
            couleur: 0x2ecc71,
            champs: [
                { nom: 'Nom', valeur: `#${canal.nom}`, enLigne: true },
                { nom: 'Type', valeur: libelle, enLigne: true },
            ],
            horodatage: true,
        }));
    },
});
