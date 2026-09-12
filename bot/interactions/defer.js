// ═══════════════════════════════════════════════════════════════
//  Boutons du salon d'arbitrage — pont de compatibilité
//
//  TRANSITION : format historique, à retirer au lot de consolidation.
//
//  Le parcours d'arbitrage vit désormais dans `bot/panneaux/defer.js`, déclaré
//  par `definirPanneau` et routé par le registre : les boutons portent
//  `defer:apply:42` et `defer:ignore:42`.
//
//  Ce fichier ne subsiste que pour les cas POSÉS AVANT la mise à jour, dont les
//  boutons portent encore `defer_apply_42` — des identifiants qu'aucun routage
//  neutre ne peut capter (« _ » contre « : »). `bot/index.js` les lui envoie
//  toujours, et le laisser muet afficherait « L'interaction a échoué » sans
//  rien expliquer.
//
//  Il ne réimplémente PAS l'ancien parcours. Conséquence assumée et sûre : un
//  cas antérieur reste « en attente » et AUCUNE sanction n'est appliquée — le
//  repli que le module choisit déjà partout ailleurs quand l'arbitrage est
//  indisponible.
// ═══════════════════════════════════════════════════════════════

const { userError } = require('../utils/errors');

/** `defer_apply_42` → { verb: 'apply', caseId: 42 } ; null si le format ne colle pas. */
function parseCustomId(customId) {
    const match = /^defer_(apply|ignore)_(\d+)$/.exec(customId || '');
    if (!match) return null;
    return { verb: match[1], caseId: Number(match[2]) };
}

async function handleDeferInteraction(interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    return userError(interaction, {
        title: 'Ce cas date d\'une version antérieure',
        cause: `Les boutons du cas #${parsed.caseId} ont été posés avant la dernière mise à jour de Quasar `
            + 'et ne sont plus reconnus. Le cas reste en attente et aucune sanction n\'a été appliquée.',
        action: 'Traitez la situation à la main. Les prochains cas d\'arbitrage seront de nouveau cliquables.',
    });
}

module.exports = { handleDeferInteraction, parseCustomId };
