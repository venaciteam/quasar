const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { resolveVariables, buildEmbed } = require('../utils/welcomeMessage');
const { sendLog } = require('../utils/logger');

// Même taille qu'à l'arrivée : les deux lignes de journal se lisent côte à côte.
const TAILLE_AVATAR_LOG = 64;

module.exports = definirEvenement({
    nom: 'membreParti',

    async executer(ctx, membre, guilde) {
        const portee = { guildeId: guilde?.id ?? null, guilde, api: ctx.api, moi: ctx.moi };
        const db = ctx.db;
        const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(guilde.id);

        // Log membre quitte
        await sendLog(portee, 'member_leave', embed({
            titre: '📤 Membre parti',
            couleur: 0xe74c3c,
            vignette: membre.avatar(TAILLE_AVATAR_LOG),
            champs: [
                { nom: 'Membre', valeur: `${membre.etiquette}`, enLigne: true },
                { nom: 'Membres', valeur: `${guilde.membreCount}`, enLigne: true },
            ],
            horodatage: true,
        }));

        if (!config || !config.leave_enabled || !config.leave_channel) return;

        const apercu = buildEmbed(config.leave_embed, membre, guilde);
        const contenu = config.leave_message ? resolveVariables(config.leave_message, membre, guilde) : null;

        try {
            // Comme à l'arrivée : le salon n'est plus relu dans un cache avant
            // l'envoi, un salon supprimé ressort donc en erreur attrapée ici.
            if (apercu) {
                await ctx.api.envoyerMessage(config.leave_channel, { contenu: contenu || undefined, embeds: [apercu] });
            } else if (contenu) {
                await ctx.api.envoyerMessage(config.leave_channel, contenu);
            }
        } catch (e) {
            console.error('[Quasar] Erreur message leave:', e.message);
        }
    },
});
