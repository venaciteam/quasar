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
    analyserCle,
    getCase,
    claimCase,
    buildResolvedEmbed,
} = require('../modules/defer');
const { applyPunishments, parsePunishments } = require('../utils/punishments');

/** Ligne de compte rendu par action, affichée dans le message d'arbitrage. */
function formatOutcome(result) {
    if (result.ok) return `✅ \`${result.action}\`${result.note ? ` — ${result.note}` : ''}`;
    return `⚠️ \`${result.action}\` — ${result.error || 'échec'}`;
}

/**
 * Réécrit le message d'arbitrage.
 *
 * ⚠️ Passe par `api.modifierMessage` et non par `ctx.modifierPanneau` : ce
 * dernier appelle `editReply`, qui exige une interaction déjà acquittée, et un
 * clic de panneau arrive vierge. Les boutons sont RETIRÉS (`composants: []`)
 * là où la version d'origine les laissait grisés : rien dans le contrat ne
 * permet de reposer des choix désactivés sur un message existant. Le détail de
 * ce qui était proposé reste lisible — c'est un champ de l'embed.
 */
function reecrireCas(ctx, row, contenuEmbed) {
    return ctx.api.modifierMessage(
        row.channel_id || ctx.canalId,
        ctx.panneau.messageId || row.message_id,
        { embeds: [contenuEmbed], composants: [] },
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

        // Réponse différée à partir d'ici : bannir, expulser et écrire les logs
        // dépasse facilement les trois secondes accordées à une interaction, et
        // c'est aussi le seul acquittement dont dispose le contrat neutre.
        await ctx.differer({ ephemere: true });

        if (row.status !== 'pending') {
            // Cas déjà tranché — typiquement deux personnes qui cliquent en même
            // temps, ou un vieux message rouvert. On rafraîchit l'affichage pour que
            // le salon cesse de mentir sur l'état du cas.
            await reecrireCas(ctx, row, buildResolvedEmbed(row, {
                resolvedBy: row.resolved_by, outcomeLines: [],
            })).catch(() => {});
            return ctx.repondre('Ce cas a déjà été tranché.', { ephemere: true });
        }

        const nouveauStatut = analyse.verb === 'apply' ? 'approved' : 'rejected';
        if (!claimCase(row.id, nouveauStatut, ctx.auteur.id)) {
            // Perdu la course : quelqu'un vient de trancher entre la lecture et
            // l'écriture. Aucune sanction n'est appliquée deux fois.
            const frais = getCase(row.id) || row;
            await reecrireCas(ctx, frais, buildResolvedEmbed(frais, {
                resolvedBy: frais.resolved_by, outcomeLines: [],
            })).catch(() => {});
            return ctx.repondre('Ce cas vient d\'être tranché par quelqu\'un d\'autre.', { ephemere: true });
        }

        const resolu = getCase(row.id) || { ...row, status: nouveauStatut, resolved_by: ctx.auteur.id };

        if (nouveauStatut !== 'approved') {
            await reecrireCas(ctx, resolu, buildResolvedEmbed(resolu, {
                resolvedBy: ctx.auteur.id,
                outcomeLines: ['Aucune sanction appliquée.'],
            })).catch(() => {});
            return ctx.repondre('Cas ignoré : aucune sanction appliquée.', { ephemere: true });
        }

        const { punishments } = parsePunishments(resolu.proposed_punishments || '');
        // `defer` est retiré de la proposition : un cas ne peut pas rouvrir un cas.
        const aAppliquer = punishments.filter(p => p.action !== 'defer');

        let outcomeLines = [];
        if (!aAppliquer.length) {
            outcomeLines = ['Aucune sanction à appliquer : le cas était un signalement seul.'];
        } else {
            const membre = await ctx.api.obtenirMembre(ctx.guildeId, resolu.target_user_id).catch(() => null);
            const resultats = await applyPunishments(aAppliquer, {
                // `portee` et jamais `guild` : ce dernier repart en voie
                // historique, donc en discord.js, sans le dire.
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

        await reecrireCas(ctx, resolu, buildResolvedEmbed(resolu, {
            resolvedBy: ctx.auteur.id,
            outcomeLines,
        })).catch(() => {});
        return ctx.repondre('Sanctions appliquées.', { ephemere: true });
    },
});
