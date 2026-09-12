// ═══════════════════════════════════════════════════════════════
//  Panneau du salon d'arbitrage
//
//  Deux choix, un cas : appliquer les sanctions proposées, ou ignorer.
//
//  Ce panneau n'appartient à aucune commande — l'arbitrage se configure au
//  dashboard — d'où sa déclaration ici plutôt que dans la clé `panneaux` d'un
//  descripteur. Le `customId` produit et le routage sont identiques dans les
//  deux cas : `defer:apply:42`, `defer:ignore:42`.
//
//  L'identifiant du cas est lu dans la clé du choix, jamais dans un état en
//  mémoire : c'est ce qui rend les boutons cliquables après un redémarrage.
// ═══════════════════════════════════════════════════════════════

const { definirPanneau } = require('../platform/panneaux');
const {
    PANNEAU,
    analyserCle,
    getCase,
    claimCase,
    buildCaseChoixResolus,
    buildResolvedEmbed,
} = require('../modules/defer');
const { applyPunishments, parsePunishments } = require('../utils/punishments');

/** Ligne de compte rendu par action, affichée dans le message d'arbitrage. */
function formatOutcome(result) {
    if (result.ok) return `✅ \`${result.action}\`${result.note ? ` — ${result.note}` : ''}`;
    return `⚠️ \`${result.action}\` — ${result.error || 'échec'}`;
}

/**
 * Réécrit le message d'arbitrage EN ACQUITTANT le clic.
 *
 * C'est `ctx.modifierPanneau`, et c'est la sémantique d'`interaction.update()` :
 * sur un clic vierge — ce qu'est toujours un clic de panneau — il réécrit le
 * message ET acquitte, en un seul appel et sans laisser le moindre message
 * éphémère. Les boutons sont REPOSÉS désactivés, comme avant migration : un
 * message d'arbitrage sans boutons ne dit plus à quoi le clic correspondait.
 *
 * Le contournement d'avant consolidation — `ctx.differer({ ephemere: true })`
 * puis `api.modifierMessage` puis `ctx.repondre()` — coûtait quatre messages
 * éphémères que l'original n'avait pas. Il n'existait que parce que
 * `ctx.modifierPanneau` appelait `editReply` sur une interaction non acquittée.
 */
function acquitterEtReecrire(ctx, row, contenuEmbed) {
    return ctx.modifierPanneau(contenuEmbed, buildCaseChoixResolus(row.id), { panneau: PANNEAU });
}

/**
 * Réécrit le message d'arbitrage APRÈS coup, par ses coordonnées.
 *
 * Pour le seul cas où le travail dépasse les trois secondes accordées à une
 * interaction : le clic a déjà été acquitté par `acquitterEtReecrire`, et il
 * s'agit maintenant d'ajouter le résultat des sanctions. C'est le
 * `interaction.message.edit()` d'avant migration, dans le vocabulaire du
 * contrat.
 */
function reecrireCas(ctx, row, contenuEmbed) {
    return ctx.api.modifierPanneau(
        row.channel_id || ctx.canalId,
        ctx.panneau.messageId || row.message_id,
        contenuEmbed,
        buildCaseChoixResolus(row.id),
        { panneau: PANNEAU },
    );
}

module.exports = definirPanneau({
    nom: 'defer',

    async executer(ctx, cle) {
        const analyse = analyserCle(cle);
        if (!analyse) return;

        if (!ctx.guildeId) {
            return ctx.erreurUtilisateur({
                titre: 'Arbitrage indisponible ici',
                cause: 'Ce bouton ne fonctionne que dans le serveur où le cas a été ouvert.',
                action: 'Retournez dans le salon d\'arbitrage du serveur concerné.',
            });
        }

        // Le salon d'arbitrage peut être visible par plus de monde que l'équipe de
        // modération : le droit d'agir se vérifie ici, pas seulement par les
        // permissions du salon.
        if (!ctx.membre?.aPermission('MODERATE_MEMBERS')) {
            return ctx.erreurUtilisateur({
                titre: 'Arbitrage réservé à la modération',
                cause: 'Trancher un cas exige la permission « Exclure temporairement des membres » sur ce serveur.',
                action: 'Demandez à un membre de l\'équipe de modération de traiter ce cas.',
            });
        }

        const row = getCase(analyse.caseId);
        if (!row || row.guild_id !== ctx.guildeId) {
            return ctx.erreurUtilisateur({
                titre: 'Cas introuvable',
                cause: 'Ce cas d\'arbitrage n\'existe plus : il a pu être purgé avec les données du serveur.',
                action: 'Vous pouvez ignorer ce message, il ne correspond plus à rien.',
            });
        }

        if (row.status !== 'pending') {
            // Cas déjà tranché — typiquement deux personnes qui cliquent en même
            // temps, ou un vieux message rouvert. On rafraîchit l'affichage pour que
            // le salon cesse de mentir sur l'état du cas. Rien d'autre à dire :
            // le message réécrit EST la réponse.
            return acquitterEtReecrire(ctx, row, buildResolvedEmbed(row, {
                resolvedBy: row.resolved_by, outcomeLines: [],
            })).catch(() => {});
        }

        const nouveauStatut = analyse.verb === 'apply' ? 'approved' : 'rejected';
        if (!claimCase(row.id, nouveauStatut, ctx.auteur.id)) {
            // Perdu la course : quelqu'un vient de trancher entre la lecture et
            // l'écriture. Aucune sanction n'est appliquée deux fois.
            const frais = getCase(row.id) || row;
            return acquitterEtReecrire(ctx, frais, buildResolvedEmbed(frais, {
                resolvedBy: frais.resolved_by, outcomeLines: [],
            })).catch(() => {});
        }

        const resolu = getCase(row.id) || { ...row, status: nouveauStatut, resolved_by: ctx.auteur.id };

        if (nouveauStatut !== 'approved') {
            return acquitterEtReecrire(ctx, resolu, buildResolvedEmbed(resolu, {
                resolvedBy: ctx.auteur.id,
                outcomeLines: ['Aucune sanction appliquée.'],
            })).catch(() => {});
        }

        // ─── Cas approuvé : le travail dépasse les trois secondes ────────────
        //
        // Bannir, expulser et écrire les logs prend du temps. Le clic est donc
        // acquitté TOUT DE SUITE en posant l'état « tranché » sur le message,
        // puis le résultat des sanctions y est ajouté une fois connu. Deux
        // écritures, comme avant migration (`deferUpdate()` puis
        // `message.edit()`), et toujours aucun message éphémère.
        await acquitterEtReecrire(ctx, resolu, buildResolvedEmbed(resolu, {
            resolvedBy: ctx.auteur.id, outcomeLines: [],
        })).catch(() => {});

        const { punishments } = parsePunishments(resolu.proposed_punishments || '');
        // `defer` est retiré de la proposition : un cas ne peut pas rouvrir un cas.
        const aAppliquer = punishments.filter(p => p.action !== 'defer');

        let outcomeLines = [];
        if (!aAppliquer.length) {
            outcomeLines = ['Aucune sanction à appliquer : le cas était un signalement seul.'];
        } else {
            const membre = await ctx.api.obtenirMembre(ctx.guildeId, resolu.target_user_id).catch(() => null);
            const resultats = await applyPunishments(aAppliquer, {
                portee: ctx,
                member: membre,
                userId: resolu.target_user_id,
                reason: `Arbitrage du cas #${resolu.id} : ${resolu.reason || 'modération automatique'}`,
                source: resolu.source,
                // Le modérateur qui tranche est le vrai auteur de la sanction :
                // c'est son identifiant qui doit apparaître dans l'historique,
                // pas celui du bot.
                moderatorId: ctx.auteur.id,
                allowDefer: false,
            });
            outcomeLines = resultats.map(formatOutcome);
        }

        return reecrireCas(ctx, resolu, buildResolvedEmbed(resolu, {
            resolvedBy: ctx.auteur.id,
            outcomeLines,
        })).catch(() => {});
    },
});
