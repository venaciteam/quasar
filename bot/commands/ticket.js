const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { buildTranscriptFile, deliverTranscript } = require('../utils/transcriptArchive');
const { sendLog } = require('../utils/logger');

const ACCENT_COLOR = 0xDE3163;

// Nom du panneau persistant des tickets. Le MÊME mot aux trois endroits du
// contrat : déclaration (`panneaux`), pose (`ctx.poserPanneau`) et routage du
// clic. Il remplace les préfixes `ticket_open` / `ticket_close` que
// `bot/index.js` portait en dur — fichier interdit aux lots parallèles.
const PANNEAU = 'ticket';

// Les deux boutons du parcours. Séparés en constantes parce qu'ils sont posés à
// deux endroits différents — le panneau public d'un côté, le message d'accueil
// d'un ticket de l'autre — et qu'ils doivent rester identiques à eux-mêmes.
const CHOIX_OUVRIR = Object.freeze({
    cle: 'ouvrir', libelle: 'Ouvrir un ticket', emoji: '🎫', style: 'primaire',
});
const CHOIX_FERMER = Object.freeze({
    cle: 'fermer', libelle: 'Fermer le ticket', emoji: '🔒', style: 'danger',
});

// Collecte du transcript : 5 pages de 100 messages, soit 500 au maximum.
const PAGES_TRANSCRIPT = 5;
const MESSAGES_PAR_PAGE = 100;

// Délai avant suppression du salon, pour laisser lire le message de fermeture.
const DELAI_SUPPRESSION_MS = 5000;

module.exports = definirCommande({
    nom: 'ticket',
    description: 'Gérer le système de tickets',
    // Équivalent exact du `setDefaultMemberPermissions(0)` d'origine : la
    // commande n'apparaît qu'aux administrateurs. Aucun nom de permission ne
    // l'exprime, et « aucune » ouvrirait `config`, `add` et `remove` à tout le
    // monde.
    accesParDefaut: false,
    // Permissions du BOT, à ne pas confondre avec l'accès ci-dessus. Créer le
    // salon de ticket (MANAGE_CHANNELS), lui poser ses overwrites
    // (MANAGE_ROLES), remettre le transcript en pièce jointe (ATTACH_FILES) et
    // relire la conversation pour le constituer (READ_MESSAGE_HISTORY).
    permissionsBot: ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'ATTACH_FILES', 'READ_MESSAGE_HISTORY'],

    // Panneau PERSISTANT : ses clics sont routés par le registre, sans
    // collecteur et sans état en mémoire, donc après un redémarrage. Le handler
    // reçoit une interaction vierge — `ctx.prompt` y ouvre le formulaire de
    // fermeture sans précaution (DA §6.2).
    panneaux: {
        [PANNEAU]: async (ctx, cle) => {
            if (cle === CHOIX_OUVRIR.cle) return ouvrirTicket(ctx);
            if (cle !== CHOIX_FERMER.cle) return;

            const reponses = await ctx.prompt([{
                cle: 'raison',
                libelle: 'Raison de la fermeture (optionnel)',
                exemple: 'Problème résolu, spam, etc.',
                style: 'paragraphe',
                max: 1000,
                requis: false,
            }], { titre: 'Fermer le ticket' });

            // Formulaire fermé ou expiré : rien n'a été acquitté, rien à faire.
            if (!reponses) return;
            return fermerTicket(ctx, reponses.raison || 'Aucune raison fournie');
        },
    },

    sousCommandes: [
        {
            nom: 'setup',
            description: 'Configurer le système de tickets',
            options: [
                {
                    nom: 'salon', type: 'canal', requis: true, typesCanal: ['texte'],
                    description: 'Le salon où envoyer le message d\'ouverture de ticket',
                },
                {
                    nom: 'staff', type: 'role', requis: true,
                    description: 'Le rôle staff qui aura accès aux tickets',
                },
                {
                    nom: 'categorie', type: 'canal', requis: false, typesCanal: ['categorie'],
                    description: 'La catégorie où créer les tickets',
                },
                {
                    nom: 'message', type: 'texte', requis: false,
                    description: 'Message d\'accueil custom (affiché à l\'ouverture du ticket)',
                },
            ],
            executer: configurerTickets,
        },
        {
            nom: 'close',
            description: 'Fermer le ticket actuel',
            options: [
                { nom: 'raison', type: 'texte', requis: false, description: 'Raison de la fermeture' },
            ],
            async executer(ctx) {
                return fermerTicket(ctx, ctx.options.get('raison') || 'Aucune raison fournie');
            },
        },
        {
            nom: 'add',
            description: 'Ajouter un membre au ticket',
            options: [
                { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à ajouter' },
            ],
            async executer(ctx) {
                if (await refuserHorsTicket(ctx)) return undefined;
                const membre = ctx.options.get('membre');

                // Overwrite UNITAIRE : `definirOverwrite` lit l'entrée existante,
                // applique les deltas et réécrit celle-là seule. Un
                // `modifierCanal({ permissions })` effacerait les droits du
                // staff et de la personne qui a ouvert le ticket.
                await ctx.api.definirOverwrite(ctx.canalId, membre.id, {
                    VIEW_CHANNEL: true,
                    SEND_MESSAGES: true,
                    READ_MESSAGE_HISTORY: true,
                }, { type: 'membre' });

                return ctx.repondre(embed({
                    description: `✅ ${membre.mention} a été ajouté au ticket.`,
                    couleur: ACCENT_COLOR,
                }));
            },
        },
        {
            nom: 'remove',
            description: 'Retirer un membre du ticket',
            options: [
                { nom: 'membre', type: 'utilisateur', requis: true, description: 'Le membre à retirer' },
            ],
            async executer(ctx) {
                if (await refuserHorsTicket(ctx)) return undefined;
                const membre = ctx.options.get('membre');

                await ctx.api.supprimerOverwrite(ctx.canalId, membre.id);

                return ctx.repondre(embed({
                    description: `✅ ${membre.mention} a été retiré du ticket.`,
                    couleur: ACCENT_COLOR,
                }));
            },
        },
        {
            nom: 'config',
            description: 'Voir la configuration actuelle des tickets',
            executer: afficherConfiguration,
        },
    ],
});

// ─── Sous-commandes ──────────────────────────────────────────────────────────

async function configurerTickets(ctx) {
    if (!ctx.membre.aPermission('MANAGE_GUILD')) {
        return ctx.erreurUtilisateur({
            titre: 'Permission insuffisante',
            cause: 'Configurer les tickets demande la permission **Gérer le serveur**, que vous n\'avez pas sur ce serveur.',
            action: 'Demandez à un administrateur de lancer cette commande, ou de vous accorder cette permission.',
        });
    }

    const salon = ctx.options.get('salon');
    const roleStaff = ctx.options.get('staff');
    const categorie = ctx.options.get('categorie');
    const messageAccueil = ctx.options.get('message') || null;

    // Vérifier les permissions AVANT d'écrire en base : sans ça, un salon
    // inaccessible laisse une configuration enregistrée mais inutilisable,
    // et le message d'erreur ne dit pas laquelle des deux étapes a échoué.
    const permissions = await ctx.api.permissionsSurCanal(salon.id, ctx.moi.id);
    const manquantes = [];
    // `permissions` vaut `null` quand le salon est illisible : on compte alors
    // les trois comme manquantes, exactement comme le `perms?.has()` d'origine.
    if (!permissions?.aPermission('VIEW_CHANNEL')) manquantes.push('Voir le salon');
    if (!permissions?.aPermission('SEND_MESSAGES')) manquantes.push('Envoyer des messages');
    if (!permissions?.aPermission('EMBED_LINKS')) manquantes.push('Intégrer des liens');

    if (manquantes.length > 0) {
        return ctx.erreurUtilisateur({
            titre: 'Je ne peux pas écrire dans ce salon',
            cause: `Il me manque ${manquantes.length > 1 ? 'ces permissions' : 'cette permission'} sur ${salon.mention} : **${manquantes.join('**, **')}**.`,
            action: `Ouvrez les paramètres de ${salon.mention} → Permissions, accordez-les à mon rôle, puis relancez la commande. Vous pouvez aussi choisir un autre salon.`,
        });
    }

    if (categorie) {
        const permissionsCategorie = await ctx.api.permissionsSurCanal(categorie.id, ctx.moi.id);
        if (!permissionsCategorie?.aPermission('MANAGE_CHANNELS')) {
            return ctx.erreurUtilisateur({
                titre: 'Je ne peux pas créer de tickets dans cette catégorie',
                cause: `Il me manque la permission **Gérer les salons** sur la catégorie **${categorie.nom}**, nécessaire pour y créer les salons de ticket.`,
                action: 'Accordez-moi cette permission sur la catégorie, ou laissez le champ vide pour créer les tickets à la racine du serveur.',
            });
        }
    }

    ctx.db.prepare(`
        INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, enabled)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(guild_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            category_id = excluded.category_id,
            staff_role_id = excluded.staff_role_id,
            welcome_message = excluded.welcome_message,
            enabled = 1
    `).run(ctx.guildeId, salon.id, categorie?.id || null, roleStaff.id, messageAccueil);

    // Titre et description du panneau se règlent au dashboard : l'insertion
    // ci-dessus ne les touche pas, on relit donc la ligne complète.
    const panneauConfig = ctx.db.prepare('SELECT panel_title, panel_description FROM ticket_config WHERE guild_id = ?')
        .get(ctx.guildeId);

    // Le panneau va dans le salon CHOISI, pas dans celui d'où part la commande :
    // c'est tout l'objet de `poserPanneau`, que `ctx.choose` ne sait pas faire
    // puisqu'il répond à l'interaction en cours.
    await ctx.poserPanneau(
        salon.id,
        embed({
            titre: panneauConfig?.panel_title || '🎫 Support — Ouvrir un ticket',
            description: panneauConfig?.panel_description
                || 'Cliquez sur le bouton ci-dessous pour ouvrir un ticket.\nUn membre du staff vous répondra dès que possible.',
            couleur: ACCENT_COLOR,
            horodatage: true,
        }),
        [CHOIX_OUVRIR],
        { panneau: PANNEAU },
    );

    const champs = [
        { nom: 'Salon', valeur: `<#${salon.id}>`, enLigne: true },
        { nom: 'Rôle staff', valeur: `<@&${roleStaff.id}>`, enLigne: true },
        { nom: 'Catégorie', valeur: categorie ? categorie.nom : 'Aucune (racine)', enLigne: true },
    ];
    if (messageAccueil) {
        champs.push({ nom: 'Message d\'accueil', valeur: messageAccueil });
    }

    return ctx.repondre(embed({
        titre: '🎫 Système de tickets configuré',
        couleur: ACCENT_COLOR,
        champs,
        horodatage: true,
    }), { ephemere: true });
}

async function afficherConfiguration(ctx) {
    if (!ctx.membre.aPermission('MANAGE_GUILD')) {
        return ctx.erreurUtilisateur({
            titre: 'Permission insuffisante',
            cause: 'Consulter la configuration des tickets demande la permission **Gérer le serveur**.',
            action: 'Demandez à un administrateur du serveur.',
        });
    }

    const config = ctx.db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(ctx.guildeId);

    if (!config) {
        return ctx.erreurUtilisateur({
            titre: 'Les tickets ne sont pas encore configurés',
            cause: 'Aucun salon d\'ouverture ni rôle staff n\'a été défini sur ce serveur.',
            action: 'Lancez `/ticket setup` en indiquant le salon où afficher le bouton et le rôle qui gérera les tickets.',
        });
    }

    const ouverts = ctx.db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ? AND closed_at IS NULL').get(ctx.guildeId).count;
    const total = ctx.db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?').get(ctx.guildeId).count;

    const champs = [
        { nom: 'Statut', valeur: config.enabled ? '✅ Activé' : '❌ Désactivé', enLigne: true },
        { nom: 'Salon', valeur: `<#${config.channel_id}>`, enLigne: true },
        { nom: 'Rôle staff', valeur: `<@&${config.staff_role_id}>`, enLigne: true },
        { nom: 'Catégorie', valeur: config.category_id ? `<#${config.category_id}>` : 'Aucune (racine)', enLigne: true },
        { nom: 'Tickets ouverts', valeur: `${ouverts}`, enLigne: true },
        { nom: 'Total tickets', valeur: `${total}`, enLigne: true },
    ];
    if (config.welcome_message) {
        champs.push({ nom: 'Message d\'accueil', valeur: config.welcome_message });
    }

    return ctx.repondre(embed({
        titre: '🎫 Configuration des tickets',
        couleur: ACCENT_COLOR,
        champs,
        horodatage: true,
    }), { ephemere: true });
}

// ─── Parcours du panneau ─────────────────────────────────────────────────────

/**
 * Ouvre un ticket. Déclenché par le bouton du panneau public, jamais par une
 * sous-commande : c'est le seul point d'entrée, comme avant.
 */
async function ouvrirTicket(ctx) {
    const db = ctx.db;
    const guildeId = ctx.guildeId;
    const auteurId = ctx.auteur.id;

    const config = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ? AND enabled = 1').get(guildeId);
    if (!config) {
        return ctx.erreurUtilisateur({
            titre: 'Les tickets ne sont pas configurés',
            cause: 'Aucun salon d\'ouverture ni rôle staff n\'a été défini sur ce serveur.',
            action: 'Un administrateur doit lancer `/ticket setup` pour activer le système.',
        });
    }

    // Un seul ticket ouvert à la fois par personne.
    const existant = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND closed_at IS NULL')
        .get(guildeId, auteurId);
    if (existant) {
        const salonExistant = await ctx.api.obtenirCanal(existant.channel_id);
        if (salonExistant) {
            return ctx.erreurUtilisateur({
                titre: 'Vous avez déjà un ticket ouvert',
                cause: `Votre ticket en cours est <#${existant.channel_id}>. Un seul ticket à la fois est autorisé, pour éviter les doublons côté staff.`,
                action: 'Poursuivez la discussion dans ce salon. S\'il est résolu, fermez-le avec `/ticket close` avant d\'en ouvrir un nouveau.',
            });
        }
        // Salon supprimé mais ticket pas fermé — nettoyer.
        db.prepare("UPDATE tickets SET closed_at = datetime('now'), closed_by = 'system', close_reason = 'Channel supprimé' WHERE id = ?")
            .run(existant.id);
    }

    // `etiquette` est le pseudonyme unique du compte : depuis la bascule de
    // Discord, il vaut exactement l'ancien `username`. Le contrat neutre
    // n'expose pas d'autre forme brute du pseudo.
    const pseudo = (ctx.auteur.etiquette || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20) || 'user';
    const compte = db.prepare('SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?').get(guildeId).count;
    const nomSalon = `ticket-${pseudo}-${compte + 1}`;

    // Jeu d'overwrites COMPLET, posé à la création : c'est un salon neuf, il n'y
    // a rien à préserver. `@everyone` porte l'identifiant du serveur, sur les
    // deux plateformes.
    const permissions = [
        { id: guildeId, type: 'role', refuse: ['VIEW_CHANNEL'] },
        {
            id: auteurId, type: 'membre',
            autorise: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ATTACH_FILES'],
        },
        {
            id: config.staff_role_id, type: 'role',
            autorise: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'MANAGE_MESSAGES'],
        },
        {
            id: ctx.moi.id, type: 'membre',
            autorise: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS', 'READ_MESSAGE_HISTORY'],
        },
    ];

    let salonTicket;
    try {
        salonTicket = await ctx.api.creerCanal(guildeId, {
            nom: nomSalon,
            type: 'texte',
            parentId: config.category_id || undefined,
            permissions,
        });
    } catch (e) {
        console.error('[Quasar] Erreur création ticket channel:', e);
        return ctx.erreurUtilisateur({
            titre: 'Impossible de créer le ticket',
            cause: 'Je n\'ai pas pu créer le salon. Il me manque probablement la permission **Gérer les salons**, ou la catégorie configurée a été supprimée.',
            action: 'Prévenez un administrateur : il doit vérifier mes permissions et relancer `/ticket setup` si la catégorie n\'existe plus.',
        });
    }

    const resultat = db.prepare(`
        INSERT INTO tickets (guild_id, channel_id, user_id, opened_at)
        VALUES (?, ?, ?, datetime('now'))
    `).run(guildeId, salonTicket.id, auteurId);
    const ticketId = resultat.lastInsertRowid;

    const texteAccueil = config.welcome_message
        || 'Un membre du staff va vous répondre sous peu. Décrivez votre problème en détail.';

    // ⚠️ Les mentions partent dans un message SÉPARÉ du panneau d'accueil.
    // `poserPanneau` n'accepte qu'une chaîne OU un embed, jamais un corps
    // composé : le message unique d'origine (`content` + `embeds` +
    // `components`) n'est pas reproductible en un seul envoi. Ce sont les
    // mentions qui notifient — celles d'un embed ne notifient pas — donc c'est
    // cette ligne qu'on préserve, quitte à la poster à part. Discord affiche les
    // deux blocs l'un au-dessus de l'autre, comme avant. À refondre en un seul
    // envoi le jour où `poserPanneau` accepte `{ contenu, embeds }`.
    await ctx.api.envoyerMessage(salonTicket.id, `${ctx.auteur.mention} | <@&${config.staff_role_id}>`);

    await ctx.poserPanneau(
        salonTicket.id,
        embed({
            titre: `🎫 Ticket #${ticketId}`,
            description: `Bienvenue ${ctx.auteur.mention} !\n\n${texteAccueil}`,
            couleur: ACCENT_COLOR,
            champs: [
                { nom: 'Ouvert par', valeur: ctx.auteur.mention, enLigne: true },
                { nom: 'Staff', valeur: `<@&${config.staff_role_id}>`, enLigne: true },
            ],
            horodatage: true,
        }),
        [CHOIX_FERMER],
        { panneau: PANNEAU },
    );

    await ctx.repondre(`✅ Votre ticket a été créé : <#${salonTicket.id}>`, { ephemere: true });

    sendLog(ctx, 'ticket_open', embed({
        titre: '🎫 Ticket ouvert',
        couleur: ACCENT_COLOR,
        champs: [
            { nom: 'Ticket', valeur: `#${ticketId} — <#${salonTicket.id}>`, enLigne: true },
            { nom: 'Par', valeur: ctx.auteur.mention, enLigne: true },
        ],
        horodatage: true,
    })).catch(() => {});
    return undefined;
}

/**
 * Ferme le ticket du salon courant. Appelée par `/ticket close` comme par le
 * bouton « Fermer le ticket », avec le même contexte neutre dans les deux cas.
 */
async function fermerTicket(ctx, raison) {
    const db = ctx.db;
    const ticket = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ? AND closed_at IS NULL')
        .get(ctx.guildeId, ctx.canalId);

    if (!ticket) {
        return ctx.erreurUtilisateur({
            titre: 'Ce salon n\'est pas un ticket ouvert',
            cause: 'Soit ce salon n\'est pas un ticket, soit il a déjà été fermé.',
            action: 'Utilisez cette commande dans le salon d\'un ticket encore ouvert.',
        });
    }

    // La collecte des messages puis l'envoi du fichier prennent plus de 3 secondes
    // sur un ticket fourni : on prend le délai avant de commencer.
    await ctx.differer();

    // L'ordre compte. Le salon va être supprimé et la conversation n'est plus
    // conservée en base : tant que le transcript n'a pas été remis à
    // l'administrateur, la fermeture ne doit pas avoir lieu.
    const { transcript, messageCount } = await collecterTranscript(ctx);
    const salon = await ctx.api.obtenirCanal(ctx.canalId);

    const embedJournal = embed({
        titre: '🎫 Ticket fermé',
        couleur: ACCENT_COLOR,
        champs: [
            { nom: 'Ticket', valeur: `#${ticket.id} — ${salon?.nom ?? ''}`, enLigne: true },
            { nom: 'Ouvert par', valeur: `<@${ticket.user_id}>`, enLigne: true },
            { nom: 'Fermé par', valeur: ctx.auteur.mention, enLigne: true },
            { nom: 'Raison', valeur: raison },
        ],
        horodatage: true,
    });

    const { fichier, truncated } = buildTranscriptFile({
        ticketId: ticket.id,
        guilde: ctx.guilde,
        ticket,
        closedBy: ctx.auteur.id,
        reason: raison,
        transcript,
        messageCount,
    });

    const remise = await deliverTranscript({
        portee: ctx,
        moderateurId: ctx.auteur.id,
        embed: embedJournal,
        fichier,
        truncated,
    });

    // Échec des deux destinations : on refuse de fermer plutôt que de supprimer le
    // salon avec la conversation dedans. Le ticket reste ouvert, rien n'est perdu.
    if (!remise.ok) {
        console.error(`[Quasar] Fermeture du ticket #${ticket.id} refusée — transcript non remis : ${remise.error}`);
        return ctx.repondre(embed({
            titre: '❌ Fermeture annulée — transcript non archivé',
            description:
                'Quasar ne conserve pas les conversations de tickets : le transcript doit être ' +
                'remis avant que le salon soit supprimé. Ici, aucune des deux voies n\'a fonctionné.\n\n' +
                '**Pour débloquer, au choix :**\n' +
                '• configurer un salon de logs auquel Quasar peut écrire (`/log`) ;\n' +
                '• ou ouvrir vos messages privés pour ce serveur, puis relancer la fermeture.\n\n' +
                '_Le ticket reste ouvert, aucun message n\'a été perdu._',
            couleur: 0xED4245,
            horodatage: true,
        }));
    }

    // Archivage acquis : on peut clore. Le transcript n'est PAS écrit en base.
    db.prepare(`
        UPDATE tickets SET closed_at = datetime('now'), closed_by = ?, close_reason = ?
        WHERE id = ?
    `).run(ctx.auteur.id, raison, ticket.id);

    // Tracer aussi le succès : un échec journalisé et un silence ne doivent pas
    // être les deux seuls états observables. On note la destination et le volume,
    // jamais le contenu de la conversation.
    console.log(
        `[Quasar] Ticket #${ticket.id} fermé — transcript remis ` +
        `(${remise.via === 'dm' ? 'message privé' : 'salon de logs'}, ` +
        `${messageCount} message(s)${truncated ? ', tronqué' : ''})`
    );

    const avis = [];
    if (remise.via === 'dm') {
        avis.push('📄 Le transcript t\'a été envoyé en message privé (aucun salon de logs disponible).');
    } else {
        avis.push('📄 Le transcript a été archivé dans le salon de logs.');
    }
    if (remise.truncated) {
        avis.push('⚠️ La conversation était trop longue : le transcript a été tronqué.');
    }

    await ctx.repondre(embed({
        titre: '🎫 Ticket fermé',
        description: `Fermé par ${ctx.auteur.mention}\n**Raison :** ${raison}\n\n${avis.join('\n')}`,
        couleur: ACCENT_COLOR,
        horodatage: true,
    }));

    // Supprimer le salon après 5 secondes.
    const canalId = ctx.canalId;
    const api = ctx.api;
    setTimeout(async () => {
        try {
            await api.supprimerCanal(canalId);
        } catch (e) {
            console.error('[Quasar] Erreur suppression ticket:', e.message);
        }
    }, DELAI_SUPPRESSION_MS);
    return undefined;
}

// ─── Outils internes ─────────────────────────────────────────────────────────

/**
 * Refuse une sous-commande lancée hors d'un salon de ticket ouvert.
 * @returns {Promise<boolean>} true si la commande a été refusée
 */
async function refuserHorsTicket(ctx) {
    const ticket = ctx.db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ? AND closed_at IS NULL')
        .get(ctx.guildeId, ctx.canalId);
    if (ticket) return false;

    await ctx.erreurUtilisateur({
        titre: 'Ce salon n\'est pas un ticket',
        cause: 'Cette commande ne fonctionne qu\'à l\'intérieur d\'un salon de ticket encore ouvert.',
        action: 'Allez dans le salon du ticket concerné, puis relancez la commande.',
    });
    return true;
}

/**
 * Collecte les messages du salon pour en faire un transcript remis à
 * l'administrateur. Le résultat n'est jamais persisté : il part directement en
 * pièce jointe.
 */
async function collecterTranscript(ctx) {
    const messages = [];
    let dernierId;

    // Récupérer jusqu'à 500 messages, du plus récent au plus ancien.
    for (let page = 0; page < PAGES_TRANSCRIPT; page++) {
        const lot = await ctx.api.listerMessages(ctx.canalId, {
            limite: MESSAGES_PAR_PAGE,
            avant: dernierId,
        });
        if (!lot || lot.length === 0) break;

        for (const message of lot) {
            messages.push({
                auteur: message.auteur?.etiquette || 'Inconnu',
                contenu: message.contenu || '',
                piecesJointes: (message.piecesJointes || []).map(piece => piece.url).join(', '),
                horodatage: new Date(message.creeLe ?? Date.now()).toISOString(),
            });
        }

        dernierId = lot[lot.length - 1].id;
        if (lot.length < MESSAGES_PAR_PAGE) break;
    }

    messages.reverse();

    const lignes = messages.map(m => {
        let ligne = `[${m.horodatage}] ${m.auteur}: ${m.contenu}`;
        if (m.piecesJointes) ligne += ` [Pièces jointes: ${m.piecesJointes}]`;
        return ligne;
    });

    return { transcript: lignes.join('\n'), messageCount: messages.length };
}
