const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { sendModLog } = require('../utils/modlog');
const { countWarnsInEscalationWindow, getRetentionMonths } = require('../modules/retention/sanctions');
const { runWarnEscalation, formatEscalationFeedback } = require('../utils/warnEscalation');

module.exports = definirCommande({
    nom: 'warn',
    description: 'Avertir un membre',
    permission: 'MODERATE_MEMBERS',
    // /warn n'écrit qu'en base et répond : rien à demander à la plateforme. Les
    // sanctions que l'escalade peut déclencher (exclusion, expulsion,
    // bannissement) sont déclarées par /mute, /kick et /ban, qui les appliquent
    // aussi à la main — les redéclarer ici ne changerait pas le masque
    // d'invitation et laisserait croire que /warn sanctionne de lui-même.
    permissionsBot: [],

    options: [
        { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à avertir' },
        { nom: 'raison', type: 'texte', requis: false, description: 'Raison de l\'avertissement', reste: true },
    ],

    async executer(ctx) {
        const cible = ctx.options.get('membre');
        const raison = ctx.options.get('raison') || 'Aucune raison spécifiée';
        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);

        if (!membre) {
            return ctx.erreurUtilisateur({
                titre: 'Membre introuvable',
                cause: 'Cette personne n\'est plus sur le serveur, ou son compte n\'existe plus.',
                action: 'Vérifiez qu\'elle est toujours membre. Pour sanctionner quelqu\'un qui est parti, utilisez `/ban` avec son identifiant.',
            });
        }

        if (cible.id === ctx.auteur.id) {
            return ctx.erreurUtilisateur({
                titre: 'Vous ne pouvez pas vous avertir vous-même',
                cause: 'Un modérateur ne peut pas s\'appliquer une sanction à lui-même.',
                action: 'Choisissez un autre membre.',
            });
        }

        if (cible.estBot) {
            return ctx.erreurUtilisateur({
                titre: 'Les bots ne peuvent pas être avertis',
                cause: 'Un avertissement s\'adresse à une personne : il n\'a aucun effet sur un bot.',
                action: 'Si un bot pose problème, retirez-le du serveur ou contactez la personne qui l\'a ajouté.',
            });
        }

        // Enregistrer le warn
        const result = ctx.db.prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
            VALUES (?, ?, ?, 'warn', ?)
        `).run(ctx.guildeId, cible.id, ctx.auteur.id, raison);

        // Compter les warns qui pèsent encore dans l'escalade. Le comptage est borné
        // par la durée de conservation du serveur : un warn trop ancien pour être
        // conservé ne peut pas déclencher un auto-kick ou un auto-ban.
        const warnCount = countWarnsInEscalationWindow(ctx.guildeId, cible.id);

        // Le libellé dit explicitement sur quelle période porte le compte : sans ça,
        // un modérateur qui voit « 2 warns » alors que le membre en a cinq dans
        // l'historique croit à un bug.
        const months = getRetentionMonths(ctx.guildeId);
        const warnCountLabel = months === 0
            ? 'Warns actifs'
            : `Warns actifs (${months} mois)`;

        const avertissement = embed({
            titre: '⚠️ Avertissement',
            couleur: 0xf1c40f,
            champs: [
                { nom: 'Membre', valeur: `${cible.mention} (${cible.etiquette})`, enLigne: true },
                { nom: 'Modérateur', valeur: ctx.auteur.mention, enLigne: true },
                { nom: 'Raison', valeur: raison },
                { nom: warnCountLabel, valeur: `${warnCount}`, enLigne: true },
                { nom: 'ID sanction', valeur: `#${result.lastInsertRowid}`, enLigne: true },
            ],
            horodatage: true,
        });

        await ctx.repondre(avertissement);

        // Escalade automatique. UN SEUL chemin d'escalade existe désormais : la
        // cascade if/else if qui lisait modules.config.autoSanctions a été
        // retirée d'ici au profit de bot/utils/warnEscalation.js, et les paliers
        // qu'elle portait ont été repris en base par la migration
        // warn_escalation_from_autosanctions_v1. Faire cohabiter les deux aurait
        // appliqué deux sanctions pour un même avertissement.
        //
        // `warnCount` est passé tel quel : il est déjà borné par la durée de
        // conservation du serveur (voir plus haut). Le recompter dans le module
        // d'escalade ferait sauter cette limite sans que personne ne le voie.
        const escalation = await runWarnEscalation({
            portee: ctx,
            member: membre,
            userId: cible.id,
            warnCount,
            moderatorId: ctx.moi?.id,
            canalId: ctx.canalId,
        });

        const feedback = formatEscalationFeedback(escalation, warnCount);
        if (feedback) {
            // Un échec d'envoi ici ne doit pas transformer un avertissement
            // enregistré et une sanction appliquée en commande en erreur.
            await ctx.suivre(feedback).catch(err => {
                console.error('[Quasar Escalade] Message de suivi non envoyé :', err.message);
            });
        }

        // Log
        await sendModLog(ctx, avertissement, 'mod_warn');
    },
});
