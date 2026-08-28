const { getDb } = require('../../api/services/database');

module.exports = {
    name: 'messageReactionAdd',
    once: false,
    async execute(reaction, user) {
        if (user.bot) return;

        // Fetch partiel si nécessaire
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }

        const db = getDb();
        const panel = db.prepare('SELECT * FROM reaction_panels WHERE message_id = ?').get(reaction.message.id);
        if (!panel) return;

        const emoji = reaction.emoji.id
            ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
            : reaction.emoji.name;

        const entry = db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? AND emoji = ?').get(panel.id, emoji);
        if (!entry) return;

        const guild = reaction.message.guild;
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member) return;

        // Retirer immédiatement la réaction de l'utilisateur (garder le panel propre)
        try {
            await reaction.users.remove(user.id);
        } catch {} // May lack MANAGE_MESSAGES permission

        // Aucun retour n'est envoyé dans le salon, volontairement : un message de
        // confirmation ordinaire notifie tout le salon à chaque bascule de rôle
        // (et le supprimer après quelques secondes n'annule pas la notification).
        // Le retrait de la réaction ci-dessus fait office d'accusé de réception.
        try {
            const hasRole = member.roles.cache.has(entry.role_id);

            if (hasRole) {
                // Retirer le rôle
                await member.roles.remove(entry.role_id);
            } else {
                // Mode unique : retirer les autres rôles du panel d'abord
                if (panel.mode === 'unique') {
                    const allEntries = db.prepare('SELECT role_id FROM reaction_roles WHERE panel_id = ?').all(panel.id);
                    for (const e of allEntries) {
                        if (e.role_id !== entry.role_id && member.roles.cache.has(e.role_id)) {
                            await member.roles.remove(e.role_id).catch(() => {});
                        }
                    }
                }

                // Donner le rôle
                await member.roles.add(entry.role_id);
            }
        } catch (e) {
            // Échec silencieux côté membre (pas de message dans le salon) : le log
            // serveur est le seul canal de diagnostic, il doit être exploitable.
            console.error(`[Quasar] Erreur toggle rôle réaction (guild ${guild.id}, panel ${panel.id}, rôle ${entry.role_id}, membre ${user.id}):`, e.message);
        }
    }
};
