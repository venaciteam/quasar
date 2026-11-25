const { definirEvenement } = require('../platform/events');

// ⚠️ `emoji.cle` est la forme STOCKÉE EN BASE, pas l'identifiant : « 🎮 » pour un
// unicode, « <:nom:id> » ou « <a:nom:id> » pour un personnalisé. C'est
// exactement la chaîne que `/reactionrole add` enregistre dans
// `reaction_roles.emoji`, et la comparaison ci-dessous ne tient que par là. La
// reconstruction manuelle qui vivait ici est passée dans l'adaptateur
// (`cleEmoji`), et un test croise les deux formes.
module.exports = definirEvenement({
    nom: 'reactionAjoutee',
    async executer(ctx, reaction, utilisateur) {
        if (utilisateur.estBot) return;

        // Aucun `fetch` préalable : le payload neutre porte déjà l'identifiant du
        // message, son salon, son serveur et l'emoji, y compris pour un message
        // antérieur au démarrage — c'est précisément ce que le fetch allait
        // chercher.
        const panel = ctx.db.prepare('SELECT * FROM reaction_panels WHERE message_id = ?').get(reaction.messageId);
        if (!panel) return;

        const entree = ctx.db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? AND emoji = ?')
            .get(panel.id, reaction.emoji.cle);
        if (!entree) return;

        const membre = await ctx.api.obtenirMembre(reaction.guildeId, utilisateur.id);
        if (!membre) return;

        // Retirer immédiatement la réaction de l'utilisateur (garder le panel propre)
        try {
            await ctx.api.retirerReaction(reaction.canalId, reaction.messageId, reaction.emoji.cle, utilisateur.id);
        } catch { /* May lack MANAGE_MESSAGES permission */ }

        // Aucun retour n'est envoyé dans le salon, volontairement : un message de
        // confirmation ordinaire notifie tout le salon à chaque bascule de rôle
        // (et le supprimer après quelques secondes n'annule pas la notification).
        // Le retrait de la réaction ci-dessus fait office d'accusé de réception.
        try {
            const aLeRole = membre.roles.includes(entree.role_id);

            if (aLeRole) {
                // Retirer le rôle
                await ctx.api.retirerRole(reaction.guildeId, utilisateur.id, entree.role_id);
            } else {
                // Mode unique : retirer les autres rôles du panel d'abord
                if (panel.mode === 'unique') {
                    const toutes = ctx.db.prepare('SELECT role_id FROM reaction_roles WHERE panel_id = ?').all(panel.id);
                    for (const e of toutes) {
                        if (e.role_id !== entree.role_id && membre.roles.includes(e.role_id)) {
                            await ctx.api.retirerRole(reaction.guildeId, utilisateur.id, e.role_id).catch(() => {});
                        }
                    }
                }

                // Donner le rôle
                await ctx.api.ajouterRole(reaction.guildeId, utilisateur.id, entree.role_id);
            }
        } catch (e) {
            // Échec silencieux côté membre (pas de message dans le salon) : le log
            // serveur est le seul canal de diagnostic, il doit être exploitable.
            console.error(`[Quasar] Erreur toggle rôle réaction (guild ${reaction.guildeId}, panel ${panel.id}, rôle ${entree.role_id}, membre ${utilisateur.id}):`, e.message);
        }
    },
});
