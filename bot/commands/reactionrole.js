const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { describeRefusal } = require('../utils/assignableRole');

// Les panneaux de rôles-réactions ne passent PAS par `ctx.choose` : ils reposent
// sur de vraies réactions emoji posées sur un message durable, et c'est déjà la
// forme que rendra l'adaptateur Fluxer. Le panneau est donc posté par
// `api.envoyerMessage`, ses réactions par `api.ajouterReaction`, et les clics
// arrivent par l'événement `reactionAjoutee` (bot/events/messageReactionAdd.js).
//
// ⚠️ `reaction_roles.emoji` stocke la CHAÎNE SAISIE par l'administrateur —
// « 🎮 » pour un unicode, « <:nom:id> » ou « <a:nom:id> » pour un personnalisé.
// C'est cette forme exacte que `emoji.cle` du payload neutre reproduit, et c'est
// à elle que la comparaison se fait. Ne jamais stocker `emoji.id` : les unicode
// continueraient de fonctionner par coïncidence, les personnalisés cesseraient
// d'attribuer leur rôle sans erreur ni journal.

const COULEUR_PANNEAU = 0xc86e8e;
const DESCRIPTION_PAR_DEFAUT = 'Cliquez sur un emoji pour obtenir le rôle correspondant.';

/** Message d'erreur commun aux quatre sous-commandes qui visent un panel. */
const PANEL_INTROUVABLE = {
    titre: 'Panel introuvable',
    cause: 'Aucun panel de rôles-réactions ne porte cet identifiant sur ce serveur.',
    action: 'Retrouvez le bon identifiant avec `/reactionrole list`.',
};

/** Le panel de ce serveur, ou `null` — la lecture que font quatre sous-commandes. */
function lirePanel(ctx, panelId) {
    return ctx.db.prepare('SELECT * FROM reaction_panels WHERE id = ? AND guild_id = ?')
        .get(panelId, ctx.guildeId) || null;
}

module.exports = definirCommande({
    nom: 'reactionrole',
    description: 'Gérer les panels de reaction roles',
    permission: 'MANAGE_ROLES',
    // Permissions du BOT, à ne pas confondre avec `permission` ci-dessus qui
    // porte sur le membre. Les trois sont nécessaires au cycle complet d'un
    // panneau, et deux d'entre elles ne se consomment qu'après la commande :
    //   ADD_REACTIONS    — le bot pose lui-même les réactions du panneau ;
    //   MANAGE_MESSAGES  — il retire celle du membre à chaque bascule de rôle,
    //                      ce qui tient lieu d'accusé de réception ;
    //   MANAGE_ROLES     — l'attribution elle-même.
    // Les déclarer ici est ce qui les maintient dans le lien d'invitation :
    // `test/invite-permissions.test.js` ne balaye que les commandes, et un
    // événement n'a nulle part où déclarer ce dont il a besoin.
    permissionsBot: ['MANAGE_ROLES', 'ADD_REACTIONS', 'MANAGE_MESSAGES'],

    sousCommandes: [
        {
            nom: 'create',
            description: 'Créer un panel de reaction roles',
            options: [
                { nom: 'channel', type: 'canal', requis: true, description: 'Channel où poster le panel', typesCanal: ['texte'] },
                { nom: 'titre', type: 'texte', requis: true, description: 'Titre du panel' },
                { nom: 'description', type: 'texte', requis: false, description: 'Description du panel' },
                {
                    nom: 'mode',
                    type: 'choix',
                    requis: false,
                    description: 'unique = un seul rôle, multiple = cumul',
                    choix: [
                        { nom: 'Multiple (cumul)', valeur: 'multiple' },
                        { nom: 'Unique (exclusif)', valeur: 'unique' },
                    ],
                },
            ],
            async executer(ctx) {
                const salon = ctx.options.get('channel');
                const titre = ctx.options.get('titre');
                const description = ctx.options.get('description') || DESCRIPTION_PAR_DEFAUT;
                const mode = ctx.options.get('mode') || 'multiple';

                const resultat = ctx.db.prepare(`
                    INSERT INTO reaction_panels (guild_id, channel_id, title, mode)
                    VALUES (?, ?, ?, ?)
                `).run(ctx.guildeId, salon.id, titre, mode);

                const panelId = resultat.lastInsertRowid;

                // Le message posté est rendu NORMALISÉ par le client REST : son
                // `id` part directement en base, sans que ce fichier ait à
                // connaître la forme de la réponse de la plateforme.
                const message = await ctx.api.envoyerMessage(salon.id, embed({
                    titre,
                    description: `${description}\n\n*(Aucun rôle configuré — utilisez \`/reactionrole add\` pour en ajouter)*`,
                    couleur: COULEUR_PANNEAU,
                    pied: { texte: `Panel #${panelId} • Mode ${mode}` },
                }));

                ctx.db.prepare('UPDATE reaction_panels SET message_id = ? WHERE id = ?').run(message.id, panelId);

                await ctx.repondre(embed({
                    titre: '✅ Panel créé',
                    couleur: 0x2ecc71,
                    champs: [
                        { nom: 'ID Panel', valeur: `#${panelId}`, enLigne: true },
                        { nom: 'Channel', valeur: salon.mention, enLigne: true },
                        { nom: 'Mode', valeur: mode, enLigne: true },
                    ],
                    description: `Utilisez \`/reactionrole add panel_id:${panelId} emoji:🎮 role:@Role\` pour ajouter des rôles.`,
                    horodatage: true,
                }), { ephemere: true });
            },
        },
        {
            nom: 'add',
            description: 'Ajouter un emoji → rôle à un panel',
            options: [
                { nom: 'panel_id', type: 'entier', requis: true, description: 'ID du panel' },
                { nom: 'emoji', type: 'texte', requis: true, description: 'L\'emoji à utiliser' },
                { nom: 'role', type: 'role', requis: true, description: 'Le rôle associé' },
                { nom: 'description', type: 'texte', requis: false, description: 'Description optionnelle' },
            ],
            async executer(ctx) {
                const panelId = ctx.options.get('panel_id');
                const emojiSaisi = ctx.options.get('emoji');
                const role = ctx.options.get('role');
                const description = ctx.options.get('description') || null;

                const panel = lirePanel(ctx, panelId);
                if (!panel) return ctx.erreurUtilisateur(PANEL_INTROUVABLE);

                // Un rôle inattribuable ne se voit qu'au premier clic sur l'emoji,
                // dans les logs du bot : le refus arrive ici, avec son motif.
                const refus = await ctx.api.verifierRoleAttribuable(ctx.guildeId, role.id);
                if (refus) {
                    const { title, cause, action } = describeRefusal(refus, role);
                    return ctx.erreurUtilisateur({ titre: title, cause, action });
                }

                ctx.db.prepare(`
                    INSERT INTO reaction_roles (panel_id, emoji, role_id, description)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(panel_id, emoji) DO UPDATE SET role_id = ?, description = ?
                `).run(panelId, emojiSaisi, role.id, description, role.id, description);

                await ctx.repondre(embed({
                    titre: '✅ Rôle ajouté au panel',
                    couleur: COULEUR_PANNEAU,
                    champs: [
                        { nom: 'Emoji', valeur: emojiSaisi, enLigne: true },
                        { nom: 'Rôle', valeur: role.mention, enLigne: true },
                    ],
                    horodatage: true,
                }), { ephemere: true });

                // Mettre à jour l'embed du panel (après la réponse)
                await rafraichirPanneau(ctx, panel, panelId, 'Le rôle a été ajouté');
            },
        },
        {
            nom: 'remove',
            description: 'Retirer un emoji d\'un panel',
            options: [
                { nom: 'panel_id', type: 'entier', requis: true, description: 'ID du panel' },
                { nom: 'emoji', type: 'texte', requis: true, description: 'L\'emoji à retirer' },
            ],
            async executer(ctx) {
                const panelId = ctx.options.get('panel_id');
                const emojiSaisi = ctx.options.get('emoji');

                const panel = lirePanel(ctx, panelId);
                if (!panel) return ctx.erreurUtilisateur(PANEL_INTROUVABLE);

                ctx.db.prepare('DELETE FROM reaction_roles WHERE panel_id = ? AND emoji = ?').run(panelId, emojiSaisi);

                await ctx.repondre(`✅ Emoji ${emojiSaisi} retiré du panel #${panelId}.`, { ephemere: true });

                await rafraichirPanneau(ctx, panel, panelId, 'L\'emoji a été retiré');
            },
        },
        {
            nom: 'delete',
            description: 'Supprimer un panel entier',
            options: [
                { nom: 'panel_id', type: 'entier', requis: true, description: 'ID du panel' },
            ],
            async executer(ctx) {
                const panelId = ctx.options.get('panel_id');
                const panel = lirePanel(ctx, panelId);
                if (!panel) return ctx.erreurUtilisateur(PANEL_INTROUVABLE);

                // Le message ou son salon peuvent déjà avoir été supprimés : la
                // suppression du panel en base ne doit pas en dépendre.
                try {
                    await ctx.api.supprimerMessage(panel.channel_id, panel.message_id);
                } catch { /* Message or channel may already be deleted */ }

                ctx.db.prepare('DELETE FROM reaction_panels WHERE id = ?').run(panelId);

                await ctx.repondre(`✅ Panel #${panelId} supprimé.`, { ephemere: true });
            },
        },
        {
            nom: 'list',
            description: 'Lister les panels de reaction roles',
            async executer(ctx) {
                const panels = ctx.db.prepare('SELECT * FROM reaction_panels WHERE guild_id = ?').all(ctx.guildeId);

                if (panels.length === 0) {
                    return ctx.repondre('Aucun panel de reaction roles configuré.', { ephemere: true });
                }

                const lignes = panels.map(p => {
                    const nombre = ctx.db.prepare('SELECT COUNT(*) as c FROM reaction_roles WHERE panel_id = ?').get(p.id).c;
                    return `**#${p.id}** — ${p.title} • <#${p.channel_id}> • ${nombre} rôle(s) • mode: ${p.mode}`;
                });

                await ctx.repondre(embed({
                    titre: '🎭 Reaction Role Panels',
                    couleur: 0x6e8ec8,
                    description: lignes.join('\n'),
                    horodatage: true,
                }), { ephemere: true });
            },
        },
    ],
});

/**
 * Réécrit l'embed du panneau et prévient en cas d'échec.
 *
 * ⚠️ `redessinerPanneau` capture déjà ses propres erreurs : ce `catch` est donc
 * inatteignable en l'état, et le message d'avertissement n'a jamais été affiché.
 * Le comportement est conservé tel quel — ce lot est à comportement constant —
 * mais le défaut est signalé au lot de consolidation.
 */
async function rafraichirPanneau(ctx, panel, panelId, quoiDeFait) {
    try {
        await redessinerPanneau(ctx.api, panel.channel_id, panel.message_id, panelId, ctx.db);
    } catch (e) {
        console.error('[Quasar] Erreur refresh panel:', e.message);
        await ctx.suivre(`⚠️ ${quoiDeFait}, mais le panel n'a pas pu être mis à jour : ${e.message}`, { ephemere: true });
    }
}

/**
 * Réécrit le message du panneau à partir de la base, et repose les réactions
 * MANQUANTES.
 *
 * « Manquantes » au sens de `parMoi` : une réaction posée par un membre et non
 * par le bot doit être reposée, sans quoi elle disparaîtrait du panneau le jour
 * où ce membre la retire. C'est le critère d'origine, et `reactions[].parMoi`
 * du message normalisé est ce qui permet de le conserver — reposer les emojis à
 * l'aveugle coûterait un appel par entrée sur une route limitée en débit.
 */
async function redessinerPanneau(api, channelId, messageId, panelId, db) {
    try {
        const panel = db.prepare('SELECT * FROM reaction_panels WHERE id = ?').get(panelId);
        const entrees = db.prepare('SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY rowid ASC').all(panelId);

        // `null` couvre le message supprimé COMME le salon disparu : les deux
        // ressortent en « introuvable » du client REST. Une panne réseau, elle,
        // lève et part dans le catch ci-dessous, exactement comme avant.
        const message = await api.obtenirMessage(channelId, messageId);
        if (!message) return;

        let description = `${DESCRIPTION_PAR_DEFAUT}\n\n`;

        if (entrees.length === 0) {
            description += '*(Aucun rôle configuré)*';
        } else {
            description += entrees.map(e =>
                `${e.emoji} → <@&${e.role_id}>${e.description ? ` — *${e.description}*` : ''}`
            ).join('\n');
        }

        await api.modifierMessage(channelId, messageId, embed({
            titre: panel.title,
            description,
            couleur: COULEUR_PANNEAU,
            pied: { texte: `Panel #${panelId} • Mode ${panel.mode}` },
        }));

        // Dans l'ordre d'insertion : c'est lui qui décide de l'ordre d'affichage
        // des réactions sous le message.
        for (const entree of entrees) {
            // `cle` est la forme stockée en base, produite par la même fonction
            // que pour `reactionAjoutee` : la comparaison tient sur les emojis
            // personnalisés comme sur les unicode.
            const existante = message.reactions.find(r => r.emoji.cle === entree.emoji);
            if (!existante || !existante.parMoi) {
                await api.ajouterReaction(channelId, messageId, entree.emoji).catch(() => {});
            }
        }
    } catch (e) {
        console.error('[Quasar] Erreur refresh panel:', e.message);
    }
}
