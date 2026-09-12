const { definirCommande } = require('../platform/commands');

// Suffixe de verrouillage accolé au nom du salon. Écrit une fois : il est posé
// par `lock`, retiré par `unlock`, et le panneau du salon fait exactement la
// même chose (bot/commands/tempvoice.js).
const SUFFIXE_VERROU = ' 🔒';

/**
 * Le salon vocal temporaire dont la personne est PROPRIÉTAIRE, et dans lequel
 * elle se trouve en ce moment.
 *
 * Les deux conditions comptent, et la seconde est celle que la base ne connaît
 * pas : `tempvoice_active` dit qui possède quoi, `ctx.membre.canalVocalId` dit
 * où la personne est connectée. Se passer du second laisserait piloter son
 * salon à distance, ce que la commande n'a jamais permis.
 *
 * @returns {{canalId: string, categorieId: string}|null}
 */
function salonPossede(ctx) {
    const canalVocalId = ctx.membre?.canalVocalId;
    if (!canalVocalId) return null;

    const actif = ctx.db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ? AND owner_id = ?')
        .get(canalVocalId, ctx.auteur.id);

    return actif ? { canalId: canalVocalId, categorieId: actif.category_id } : null;
}

// Personnalisation de son propre salon vocal temporaire.
//
// Ce que le contrat neutre remplace ici, point par point :
//   member.voice.channel                   -> ctx.membre.canalVocalId
//   channel.setName / setUserLimit         -> ctx.api.modifierCanal()
//   channel.permissionOverwrites.edit()    -> ctx.api.definirOverwrite()
//   guild.roles.everyone                   -> ctx.guilde.roleParDefautId
//   member.voice.disconnect()              -> ctx.api.modifierMembre({ canalVocalId: null })
//   userError(interaction, …)              -> ctx.erreurUtilisateur(…)
//
// Un `executer` à la racine plutôt qu'un par sous-commande : les sept partagent
// le même contrôle de propriété, et le dupliquer sept fois serait sept endroits
// où l'oublier.
module.exports = definirCommande({
    nom: 'voice',
    description: 'Personnaliser votre salon vocal temporaire',
    // Ouverture DÉCLARÉE : la commande est faite pour tout le monde, chacun n'y
    // pilote que le salon dont il est propriétaire. C'était déjà le cas avant
    // migration (aucun `setDefaultMemberPermissions`), et le registre exige
    // qu'on le dise au lieu de le déduire d'un champ absent.
    accesParDefaut: true,
    // Permissions du BOT : renommer le salon, changer sa limite et écrire ses
    // overwrites (MANAGE_CHANNELS), en expulser quelqu'un (MOVE_MEMBERS).
    permissionsBot: ['MANAGE_CHANNELS', 'MOVE_MEMBERS'],

    sousCommandes: [
        {
            nom: 'name',
            description: 'Renommer votre salon',
            options: [
                { nom: 'nom', type: 'texte', requis: true, max: 100, description: 'Nouveau nom du salon' },
            ],
        },
        {
            nom: 'limit',
            description: 'Limiter le nombre de places',
            options: [
                { nom: 'places', type: 'entier', requis: true, min: 0, max: 99, description: 'Nombre de places (0 = illimité)' },
            ],
        },
        { nom: 'lock', description: 'Verrouiller votre salon (personne ne peut rejoindre)' },
        { nom: 'unlock', description: 'Déverrouiller votre salon' },
        {
            nom: 'permit',
            description: 'Autoriser quelqu\'un à rejoindre (si verrouillé)',
            options: [
                { nom: 'utilisateur', type: 'utilisateur', requis: true, description: 'L\'utilisateur à autoriser' },
            ],
        },
        {
            nom: 'kick',
            description: 'Expulser quelqu\'un de votre salon',
            options: [
                { nom: 'utilisateur', type: 'utilisateur', requis: true, description: 'L\'utilisateur à expulser' },
            ],
        },
        { nom: 'reset', description: 'Réinitialiser vos préférences mémorisées' },
    ],

    async executer(ctx) {
        const db = ctx.db;
        const guildId = ctx.guildeId;
        const userId = ctx.auteur.id;
        const sub = ctx.options.sousCommande;

        const owned = salonPossede(ctx);
        if (!owned) {
            return ctx.erreurUtilisateur({
                titre: 'Vous n\'êtes pas dans un salon vocal temporaire',
                cause: 'Cette commande ne fonctionne que si vous êtes connecté·e à un salon vocal temporaire dont vous êtes propriétaire.',
                action: 'Rejoignez le salon d\'accueil pour créer votre salon, puis relancez la commande depuis celui-ci.',
            });
        }

        const { canalId, categorieId } = owned;

        if (sub === 'name') {
            const name = ctx.options.get('nom');
            await ctx.api.modifierCanal(canalId, { nom: name });

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, channel_name, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET channel_name = excluded.channel_name, updated_at = unixepoch()
            `).run(guildId, userId, categorieId, name);

            return ctx.repondre(`✅ Salon renommé en **${name}**`, { ephemere: true });
        }

        if (sub === 'limit') {
            const limit = ctx.options.get('places');
            await ctx.api.modifierCanal(canalId, { limiteUtilisateurs: limit });

            db.prepare(`
                INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, user_limit, updated_at)
                VALUES (?, ?, ?, ?, unixepoch())
                ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET user_limit = excluded.user_limit, updated_at = unixepoch()
            `).run(guildId, userId, categorieId, limit);

            return ctx.repondre(limit === 0 ? '✅ Limite retirée (illimité)' : `✅ Limite fixée à **${limit}** places`, { ephemere: true });
        }

        if (sub === 'lock') {
            // ⚠️ Overwrite UNITAIRE. `modifierCanal({ permissions })`
            // remplacerait le jeu ENTIER du salon : le propriétaire perdrait à
            // chaque verrouillage les droits que la création lui a donnés, et
            // les autorisations accordées par `permit` disparaîtraient avec.
            // `definirOverwrite` ne réécrit que l'entrée de @everyone.
            await ctx.api.definirOverwrite(canalId, ctx.guilde.roleParDefautId, { CONNECT: false }, { type: 'role' });
            const canal = await ctx.api.obtenirCanal(canalId);
            const name = canal.nom.replace(/ 🔒$/, '');
            await ctx.api.modifierCanal(canalId, { nom: `${name}${SUFFIXE_VERROU}` });
            return ctx.repondre('🔒 Salon verrouillé — plus personne ne peut rejoindre.', { ephemere: true });
        }

        if (sub === 'unlock') {
            // `null` rend la permission à l'héritage, sur les DEUX masques :
            // c'est le `Connect: null` d'avant migration, pas un `false`.
            await ctx.api.definirOverwrite(canalId, ctx.guilde.roleParDefautId, { CONNECT: null }, { type: 'role' });
            const canal = await ctx.api.obtenirCanal(canalId);
            if (canal.nom.endsWith(SUFFIXE_VERROU)) {
                await ctx.api.modifierCanal(canalId, { nom: canal.nom.replace(/ 🔒$/, '') });
            }
            return ctx.repondre('🔓 Salon déverrouillé.', { ephemere: true });
        }

        if (sub === 'permit') {
            const target = ctx.options.get('utilisateur');
            await ctx.api.definirOverwrite(canalId, target.id, { CONNECT: true, VIEW_CHANNEL: true }, { type: 'membre' });
            return ctx.repondre(`✅ ${target.mention} peut maintenant rejoindre votre salon.`, { ephemere: true });
        }

        if (sub === 'kick') {
            const target = ctx.options.get('utilisateur');
            const targetMember = await ctx.api.obtenirMembre(guildId, target.id);

            if (!targetMember || targetMember.canalVocalId !== canalId) {
                return ctx.erreurUtilisateur({
                    titre: 'Cette personne n\'est pas dans votre salon',
                    cause: 'Elle a quitté le salon, ou n\'y est jamais entrée.',
                    action: 'Vérifiez qui est connecté à votre salon vocal.',
                });
            }

            if (targetMember.id === userId) {
                return ctx.erreurUtilisateur({
                    titre: 'Vous ne pouvez pas vous expulser vous-même',
                    cause: 'Vous êtes propriétaire de ce salon.',
                    action: 'Pour partir, quitte simplement le salon vocal — il se supprimera s\'il devient vide.',
                });
            }

            await ctx.api.modifierMembre(guildId, target.id, { canalVocalId: null }, 'Expulsé par le propriétaire du vocal');
            return ctx.repondre(`✅ ${target.mention} a été expulsé du salon.`, { ephemere: true });
        }

        if (sub === 'reset') {
            db.prepare('DELETE FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
                .run(guildId, userId, categorieId);
            return ctx.repondre('✅ Vos préférences pour cette catégorie ont été réinitialisées.', { ephemere: true });
        }
    },
});
