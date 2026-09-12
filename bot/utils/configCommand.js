// ═══════════════════════════════════════════════════════════════
//  Fabrique des commandes d'accueil et de départ
//
//  /welcome et /leave sont la MÊME commande à onze réglages près : deux
//  libellés, deux couleurs, quatre colonnes de base et trois textes par défaut.
//  Tout le reste — six sous-commandes, la prévisualisation, l'écriture en base,
//  les six réponses — est identique au caractère près.
//
//  La fabrique est donc conservée, et convertie en fabrique de DESCRIPTEURS
//  neutres. Écrire les deux commandes en direct aurait dupliqué deux cents
//  lignes et, surtout, les huit noms de colonnes : une divergence entre
//  `welcome_embed` et `leave_embed` ne se serait vue qu'à l'usage, sur un
//  serveur, après coup.
// ═══════════════════════════════════════════════════════════════

const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { resolveVariables, buildEmbed, TAILLE_AVATAR } = require('./welcomeMessage');

/**
 * Descripteur neutre d'une commande de configuration d'accueil ou de départ.
 *
 * @param {object} opts
 * @param {string}   opts.name              'welcome' | 'leave'
 * @param {string}   opts.description
 * @param {string}   opts.emoji             '👋' | '🚪'
 * @param {number}   opts.color             couleur des embeds de confirmation
 * @param {string}   opts.defaultColor      couleur par défaut de l'embed configuré
 * @param {string}   opts.channelCol        colonne du salon de destination
 * @param {string}   opts.messageCol        colonne du message texte
 * @param {string}   opts.embedCol          colonne de l'embed (JSON)
 * @param {string}   opts.enabledCol        colonne d'activation
 * @param {string}   opts.defaultEmbedTitle
 * @param {string}   opts.defaultEmbedDesc
 * @param {Function} opts.defaultTestMsg    (membre, guilde) => string
 */
function createConfigCommand(opts) {
    const {
        name,
        description,
        emoji,
        color,
        defaultColor,
        channelCol,
        messageCol,
        embedCol,
        enabledCol,
        defaultEmbedTitle,
        defaultEmbedDesc,
        defaultTestMsg,
    } = opts;

    // Les deux mots qui distinguent les libellés. Calculés une fois : ils
    // apparaissent dans huit descriptions, et le JSON déployé doit rester
    // identique à celui des builders d'origine.
    const quoi = name === 'welcome' ? 'bienvenue' : 'départ';
    const label = name === 'welcome' ? 'Welcome' : 'Leave';

    return definirCommande({
        nom: name,
        description,
        permission: 'MANAGE_GUILD',
        // `/welcome test` poste dans le salon d'accueil, et l'arrivée d'un
        // membre y postera de même : SEND_MESSAGES et EMBED_LINKS suffisent, et
        // font partie du socle du lien d'invitation.
        permissionsBot: [],

        sousCommandes: [
            {
                nom: 'channel',
                description: `Définir le channel de ${quoi}`,
                options: [
                    { nom: 'channel', type: 'canal', requis: true, description: 'Le channel', typesCanal: ['texte'] },
                ],
            },
            {
                nom: 'message',
                description: `Définir le message de ${quoi}`,
                options: [
                    { nom: 'texte', type: 'texte', requis: true, description: 'Variables : {user} {username} {server} {membercount}' },
                ],
            },
            {
                nom: 'test',
                description: `Prévisualiser le message de ${quoi}`,
            },
            {
                nom: 'embed',
                description: `Activer un embed de ${quoi} (avec avatar de l'utilisateur)`,
                options: [
                    { nom: 'titre', type: 'texte', requis: false, description: 'Titre. Variables : {username} {server}' },
                    { nom: 'description', type: 'texte', requis: false, description: 'Description. Variables : {user} {username} {server} {membercount}' },
                    { nom: 'couleur', type: 'texte', requis: false, description: `Couleur hex (ex: ${defaultColor})` },
                ],
            },
            {
                nom: 'embedoff',
                description: `Retirer l'embed de ${quoi}`,
            },
            {
                nom: 'off',
                description: `Désactiver les messages de ${quoi}`,
            },
        ],

        // Un seul `executer` : les six sous-commandes partagent la ligne
        // d'initialisation en base et ne font ensuite qu'une écriture chacune.
        async executer(ctx) {
            const sub = ctx.options.sousCommande;
            const db = ctx.db;

            db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(ctx.guildeId);

            if (sub === 'channel') {
                const canal = ctx.options.get('channel');
                db.prepare(`UPDATE welcome_config SET ${channelCol} = ?, ${enabledCol} = 1 WHERE guild_id = ?`)
                    .run(canal.id, ctx.guildeId);

                await ctx.repondre(embed({
                    titre: `${emoji} ${label} configuré`,
                    couleur: color,
                    description: `Les messages seront envoyés dans ${canal.mention}.`,
                    horodatage: true,
                }));

            } else if (sub === 'message') {
                const texte = ctx.options.get('texte');
                db.prepare(`UPDATE welcome_config SET ${messageCol} = ? WHERE guild_id = ?`)
                    .run(texte, ctx.guildeId);

                await ctx.repondre(embed({
                    titre: `${emoji} Message mis à jour`,
                    couleur: color,
                    description: `**Aperçu :** ${resolveVariables(texte, ctx.membre, ctx.guilde)}`,
                    horodatage: true,
                }));

            } else if (sub === 'test') {
                const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(ctx.guildeId);

                if (!config?.[channelCol]) {
                    return ctx.erreurUtilisateur({
                        titre: 'Aucun salon configuré',
                        cause: `Le module **${name}** n'a pas encore de salon de destination.`,
                        action: `Définissez-le avec \`/${name} channel #salon\`.`,
                    });
                }

                // Le salon est relu AVANT d'annoncer l'envoi : sans ce contrôle,
                // on confirmerait « message de test envoyé » pour un salon
                // supprimé entre-temps.
                const canal = await ctx.api.obtenirCanal(config[channelCol]);
                if (!canal) {
                    return ctx.erreurUtilisateur({
                        titre: 'Salon introuvable',
                        cause: 'Le salon configuré a été supprimé, ou je n\'y ai plus accès.',
                        action: `Reconfigurez-le avec \`/${name} channel\`.`,
                    });
                }

                const apercu = buildEmbed(config[embedCol], ctx.membre, ctx.guilde);
                const contenu = config[messageCol] ? resolveVariables(config[messageCol], ctx.membre, ctx.guilde) : null;

                await ctx.repondre('✅ Message de test envoyé !', { ephemere: true });

                if (apercu) {
                    await ctx.api.envoyerMessage(canal.id, { contenu: contenu || undefined, embeds: [apercu] });
                } else if (contenu) {
                    await ctx.api.envoyerMessage(canal.id, contenu);
                } else {
                    await ctx.api.envoyerMessage(canal.id, defaultTestMsg(ctx.membre, ctx.guilde));
                }

            } else if (sub === 'embed') {
                const titre = ctx.options.get('titre') || defaultEmbedTitle;
                const description = ctx.options.get('description') || defaultEmbedDesc;
                const couleur = ctx.options.get('couleur') || defaultColor;

                const embedConfig = { title: titre, description, color: couleur, thumbnail: 'avatar' };
                db.prepare(`UPDATE welcome_config SET ${embedCol} = ? WHERE guild_id = ?`)
                    .run(JSON.stringify(embedConfig), ctx.guildeId);

                await ctx.repondre({
                    contenu: `✅ Embed de ${quoi} configuré ! Aperçu :`,
                    embeds: [embed({
                        titre: resolveVariables(titre, ctx.membre, ctx.guilde),
                        description: resolveVariables(description, ctx.membre, ctx.guilde),
                        couleur,
                        vignette: ctx.membre.avatar(TAILLE_AVATAR),
                    })],
                });

            } else if (sub === 'embedoff') {
                db.prepare(`UPDATE welcome_config SET ${embedCol} = NULL WHERE guild_id = ?`).run(ctx.guildeId);
                await ctx.repondre(embed({
                    titre: `${emoji} Embed retiré`,
                    couleur: color,
                    description: 'Le message repassera en texte simple.',
                    horodatage: true,
                }));

            } else if (sub === 'off') {
                db.prepare(`UPDATE welcome_config SET ${enabledCol} = 0 WHERE guild_id = ?`).run(ctx.guildeId);
                await ctx.repondre(embed({
                    titre: `${emoji} ${label} désactivé`,
                    couleur: 0xe74c3c,
                    description: `Les messages de ${quoi} ont été désactivés.`,
                    horodatage: true,
                }));
            }
        },
    });
}

module.exports = { createConfigCommand };
