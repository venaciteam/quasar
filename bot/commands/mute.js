const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { sendModLog } = require('../utils/modlog');

// Plafond de l'exclusion temporaire, imposé par la plateforme. Fluxer applique
// le même principe avec un plafond plus haut ; la valeur reste celle que la
// commande annonce depuis toujours dans son message d'erreur.
const DUREE_MAX_MS = 28 * 24 * 60 * 60 * 1000;

module.exports = definirCommande({
    nom: 'mute',
    description: 'Mute (timeout) un membre',
    permission: 'MODERATE_MEMBERS',
    permissionsBot: ['MODERATE_MEMBERS'],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à mute' },
        { nom: 'durée', type: 'texte', requis: true, description: 'Durée (ex: 10m, 1h, 1d)' },
        { nom: 'raison', type: 'texte', requis: false, description: 'Raison du mute', reste: true },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');
        const durationStr = ctx.options.get('durée');
        const raison = ctx.options.get('raison') || 'Aucune raison spécifiée';

        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);
        if (!membre) {
            return ctx.erreurUtilisateur({
                titre: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur.',
                action: 'Vérifiez qu\'elle en est toujours membre.',
            });
        }
        if (cible.estBot) {
            return ctx.erreurUtilisateur({
                titre: 'Les bots ne peuvent pas être exclus temporairement',
                cause: 'Discord n\'applique pas les exclusions temporaires aux bots.',
                action: 'Retirez ses permissions, ou expulsez-le du serveur.',
            });
        }

        // Parser la durée
        const ms = parseDuration(durationStr);
        if (!ms || ms > DUREE_MAX_MS) {
            return ctx.erreurUtilisateur({
                titre: 'Durée invalide',
                cause: 'Je n\'ai pas compris la durée, ou elle dépasse la limite de 28 jours imposée par Discord.',
                action: 'Utilisez un nombre suivi de `m` (minutes), `h` (heures) ou `d` (jours). Par exemple : `10m`, `2h`, `1d`.',
            });
        }

        // Pré-contrôle et échec de l'appel rendent le MÊME message : ce sont les
        // deux mêmes causes — hiérarchie des rôles, ou permission manquante —
        // et les distinguer changerait ce que voit la personne qui modère.
        if (await ctx.api.verifierMembreSanctionnable(ctx.guildeId, cible.id, 'timeout')) {
            return refusExclusion(ctx);
        }
        try {
            // `appliquerTimeout` attend une ÉCHÉANCE, pas une durée : c'est la
            // forme que porte réellement l'exclusion côté plateforme.
            await ctx.api.appliquerTimeout(ctx.guildeId, cible.id, Date.now() + ms, raison);
        } catch {
            return refusExclusion(ctx);
        }

        // Enregistrer en DB
        ctx.db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration)
            VALUES (?, ?, ?, 'mute', ?, ?)
        `).run(ctx.guildeId, cible.id, ctx.auteur.id, raison, durationStr);

        const exclusion = embed({
            titre: '🔇 Mute',
            couleur: 0xe67e22,
            champs: [
                { nom: 'Membre', valeur: `${cible.mention} (${cible.etiquette})`, enLigne: true },
                { nom: 'Modérateur', valeur: ctx.auteur.mention, enLigne: true },
                { nom: 'Durée', valeur: durationStr, enLigne: true },
                { nom: 'Raison', valeur: raison },
            ],
            horodatage: true,
        });

        await ctx.repondre(exclusion);
        await sendModLog(ctx, exclusion, 'mod_mute');
    },
});

/** Le seul message d'échec de l'exclusion : une seule phrase pour les deux causes. */
function refusExclusion(ctx) {
    return ctx.erreurUtilisateur({
        titre: 'Je ne peux pas exclure ce membre',
        cause: 'Soit il me manque la permission **Exclure temporairement des membres**, soit ce membre a un rôle situé au-dessus du mien dans la hiérarchie.',
        action: 'Vérifiez mes permissions, et placez mon rôle au-dessus de celui du membre dans Paramètres du serveur → Rôles.',
    });
}

function parseDuration(str) {
    const match = str.match(/^(\d+)(m|h|d|j)$/i);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': case 'j': return val * 24 * 60 * 60 * 1000;
        default: return null;
    }
}
