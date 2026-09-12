const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { buildMentionPayload, silentMentions, hasMentions } = require('../../api/services/mentions');

// Colonnes de mention de l'embed (configurées dans le builder du dashboard).
// Elles sont postées en contenu du message, au-dessus de l'embed.
const MENTION_COLUMNS = 'mention_roles, mention_users, mention_everyone, mention_here';

module.exports = definirCommande({
    nom: 'embed',
    description: 'Créer et gérer des embeds personnalisés',
    permission: 'MANAGE_MESSAGES',
    // MANAGE_MESSAGES porte sur le MEMBRE, pas sur le bot : `/embed edit` ne
    // modifie que les messages que le bot a lui-même envoyés, ce que l'API
    // autorise sans permission. Le reste — poster un embed dans un salon, relire
    // un message pour le modifier — relève de SEND_MESSAGES, EMBED_LINKS et
    // READ_MESSAGE_HISTORY, le socle déjà exigé par le lien d'invitation.
    permissionsBot: [],

    sousCommandes: [
        {
            nom: 'create',
            description: 'Créer un nouvel embed',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom pour retrouver l\'embed' },
                { nom: 'titre', type: 'texte', requis: false, description: 'Titre de l\'embed' },
                { nom: 'description', type: 'texte', requis: false, description: 'Description (contenu principal)' },
                { nom: 'couleur', type: 'texte', requis: false, description: 'Couleur hex (ex: #c86e8e)' },
                { nom: 'footer', type: 'texte', requis: false, description: 'Texte en pied de page' },
                { nom: 'image', type: 'texte', requis: false, description: 'URL d\'une image (grande, en bas)' },
                { nom: 'thumbnail', type: 'texte', requis: false, description: 'URL d\'une miniature (petit, en haut à droite)' },
            ],
        },
        {
            nom: 'send',
            description: 'Envoyer un embed sauvegardé dans un channel',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de l\'embed', autocompletion: true },
                { nom: 'channel', type: 'canal', requis: true, description: 'Channel de destination', typesCanal: ['texte'] },
            ],
        },
        {
            nom: 'edit',
            description: 'Modifier un embed déjà envoyé (via l\'ID du message)',
            options: [
                { nom: 'message_id', type: 'texte', requis: true, description: 'ID du message à modifier' },
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de l\'embed à utiliser', autocompletion: true },
                { nom: 'channel', type: 'canal', requis: false, description: 'Channel du message', typesCanal: ['texte'] },
            ],
        },
        {
            nom: 'list',
            description: 'Voir les embeds sauvegardés',
        },
        {
            nom: 'delete',
            description: 'Supprimer un embed sauvegardé',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de l\'embed', autocompletion: true },
            ],
        },
        {
            nom: 'preview',
            description: 'Prévisualiser un embed (en éphémère)',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de l\'embed', autocompletion: true },
            ],
        },
    ],

    async completer(ctx) {
        const focused = String(ctx.saisie?.value ?? '').toLowerCase();
        const embeds = ctx.db.prepare('SELECT name FROM embeds WHERE guild_id = ?').all(ctx.guildeId);
        const filtered = embeds
            .filter(e => e.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(e => ({ nom: e.name, valeur: e.name }));
        await ctx.repondre(filtered);
    },

    async executer(ctx) {
        const sub = ctx.options.sousCommande;
        const db = ctx.db;

        if (sub === 'create') {
            const nom = ctx.options.get('nom');
            const titre = ctx.options.get('titre');
            const description = ctx.options.get('description');
            const couleur = ctx.options.get('couleur') || '#c86e8e';
            const footer = ctx.options.get('footer');
            const image = ctx.options.get('image');
            const thumbnail = ctx.options.get('thumbnail');

            if (!titre && !description) {
                return ctx.erreurUtilisateur({
                    titre: 'Embed vide',
                    cause: 'Un embed sans titre ni description n\'affiche rien : Discord le refuserait.',
                    action: 'Renseignez au moins le titre ou la description.',
                });
            }

            const data = { couleur };
            if (titre) data.titre = titre;
            if (description) data.description = description;
            if (footer) data.footer = footer;
            if (image) data.image = image;
            if (thumbnail) data.thumbnail = thumbnail;

            // Vérifier si le nom existe déjà
            const existing = db.prepare('SELECT id FROM embeds WHERE guild_id = ? AND name = ?').get(ctx.guildeId, nom);
            if (existing) {
                db.prepare('UPDATE embeds SET data = ?, updated_at = datetime(\'now\') WHERE guild_id = ? AND name = ?')
                    .run(JSON.stringify(data), ctx.guildeId, nom);
            } else {
                db.prepare('INSERT INTO embeds (guild_id, name, data) VALUES (?, ?, ?)').run(ctx.guildeId, nom, JSON.stringify(data));
            }

            await ctx.repondre({
                contenu: `✅ Embed **${nom}** ${existing ? 'mis à jour' : 'créé'} ! Aperçu :\n> 💡 **Astuce image** : pour utiliser une image sans hébergement externe, postez-la dans n'importe quel channel Discord, faites un clic droit → "Copier le lien de l'image", et collez cette URL dans \`image:\` ou \`thumbnail:\`.`,
                embeds: [construireEmbedEnregistre(data)],
            }, { ephemere: true });

        } else if (sub === 'send') {
            const nom = ctx.options.get('nom');
            const canal = ctx.options.get('channel');

            const embedRow = db.prepare(`SELECT data, ${MENTION_COLUMNS} FROM embeds WHERE guild_id = ? AND name = ?`)
                .get(ctx.guildeId, nom);
            if (!embedRow) return ctx.erreurUtilisateur(EMBED_INTROUVABLE(nom));

            // Mentions configurées sur l'embed : postées comme contenu du message,
            // avec un allowedMentions verrouillé sur ces seuls IDs.
            const { content: mentionsStr, allowedMentions } = buildMentionPayload(embedRow);
            const corps = {
                embeds: [construireEmbedEnregistre(JSON.parse(embedRow.data))],
                mentionsAutorisees: allowedMentions,
            };
            if (mentionsStr) corps.contenu = mentionsStr;
            await ctx.api.envoyerMessage(canal.id, corps);

            await ctx.repondre({
                contenu: `✅ Embed **${nom}** envoyé dans ${canal.mention}.${mentionsStr ? ` Mentions : ${mentionsStr}` : ''}`,
                mentionsAutorisees: silentMentions(), // le récap ne doit pinger personne
            }, { ephemere: true });

        } else if (sub === 'edit') {
            const messageId = ctx.options.get('message_id');
            const nom = ctx.options.get('nom');
            const canalId = ctx.options.get('channel')?.id || ctx.canalId;

            const embedRow = db.prepare('SELECT data FROM embeds WHERE guild_id = ? AND name = ?').get(ctx.guildeId, nom);
            if (!embedRow) return ctx.erreurUtilisateur(EMBED_INTROUVABLE(nom));

            try {
                // `obtenirMessage` rend `null` quand le message ou son salon
                // n'existe plus, et LÈVE sur une panne : les deux aboutissaient
                // déjà au même message côté utilisateur, on le conserve.
                const message = await ctx.api.obtenirMessage(canalId, messageId);
                if (!message) return ctx.erreurUtilisateur(MESSAGE_INTROUVABLE);

                if (message.auteur?.id !== ctx.moi.id) {
                    return ctx.erreurUtilisateur({
                        titre: 'Je ne peux pas modifier ce message',
                        cause: 'Discord n\'autorise un bot à modifier que les messages qu\'il a lui-même envoyés.',
                        action: 'Pour modifier cet embed, supprimez le message et renvoyez-le avec `/embed send`.',
                    });
                }

                // Seul l'embed est remplacé : la ligne de mentions du message d'origine
                // est laissée telle quelle. Discord ne notifie personne sur une édition,
                // donc réappliquer les mentions n'aurait aucun effet de ping — ça ne
                // ferait qu'écraser du contenu (ex. les mentions propres à un rappel).
                // allowedMentions verrouillé par sécurité : une édition ne peut rien pinger.
                await ctx.api.modifierMessage(canalId, messageId, {
                    embeds: [construireEmbedEnregistre(JSON.parse(embedRow.data))],
                    mentionsAutorisees: silentMentions(),
                });
                await ctx.repondre('✅ Message modifié avec succès (embed uniquement, les mentions du message d\'origine sont conservées).', { ephemere: true });
            } catch (e) {
                await ctx.erreurUtilisateur(MESSAGE_INTROUVABLE);
            }

        } else if (sub === 'list') {
            const embeds = db.prepare(`SELECT name, updated_at, ${MENTION_COLUMNS} FROM embeds WHERE guild_id = ? ORDER BY updated_at DESC`)
                .all(ctx.guildeId);

            if (embeds.length === 0) return ctx.repondre('Aucun embed sauvegardé.', { ephemere: true });

            const lines = embeds.map(e => {
                const date = new Date(e.updated_at + 'Z').toLocaleDateString('fr-FR');
                // 👥 signale les embeds qui pingent à l'envoi (cf. builder du dashboard)
                return `📝 **${e.name}** — modifié le ${date}${hasMentions(e) ? ' 👥' : ''}`;
            });

            await ctx.repondre(embed({
                titre: '📝 Embeds sauvegardés',
                couleur: 0x6e8ec8,
                description: lines.join('\n') + (embeds.some(hasMentions) ? '\n\n👥 = mentions configurées (pingées à chaque `/embed send`)' : ''),
                horodatage: true,
            }), { ephemere: true });

        } else if (sub === 'delete') {
            const nom = ctx.options.get('nom');
            const result = db.prepare('DELETE FROM embeds WHERE guild_id = ? AND name = ?').run(ctx.guildeId, nom);

            if (result.changes === 0) return ctx.erreurUtilisateur(EMBED_INTROUVABLE(nom));
            await ctx.repondre(`🗑️ Embed **${nom}** supprimé.`, { ephemere: true });

        } else if (sub === 'preview') {
            const nom = ctx.options.get('nom');
            const embedRow = db.prepare(`SELECT data, ${MENTION_COLUMNS} FROM embeds WHERE guild_id = ? AND name = ?`)
                .get(ctx.guildeId, nom);

            if (!embedRow) return ctx.erreurUtilisateur(EMBED_INTROUVABLE(nom));

            // L'aperçu MONTRE la ligne de mentions telle qu'elle sera postée, mais
            // allowedMentions est totalement verrouillé : rien ne notifie personne.
            const { content: previewMentions } = buildMentionPayload(embedRow);
            const header = `👁️ Aperçu de **${nom}** :`;
            await ctx.repondre({
                contenu: previewMentions
                    ? `${header}\n${previewMentions}\n-# ☝️ Ces mentions pingeront à l'envoi réel (aucune notification depuis cet aperçu).`
                    : header,
                embeds: [construireEmbedEnregistre(JSON.parse(embedRow.data))],
                mentionsAutorisees: silentMentions(),
            }, { ephemere: true });
        }
    },
});

// Les deux erreurs d'usage répétées par quatre sous-commandes. Écrites une fois :
// deux formulations pour la même règle finiraient par décrire deux règles.
const EMBED_INTROUVABLE = (nom) => ({
    titre: 'Embed introuvable',
    cause: `Aucun embed enregistré ne s'appelle **${nom}** sur ce serveur.`,
    action: 'Consultez la liste avec `/embed list` — les noms sont sensibles à la casse.',
});

const MESSAGE_INTROUVABLE = {
    titre: 'Message introuvable',
    cause: 'Aucun message ne correspond à cet identifiant dans ce salon. Il a peut-être été supprimé, ou se trouve ailleurs.',
    action: 'Vérifiez l\'identifiant (clic droit sur le message → Copier l\'identifiant) et lancez la commande depuis le bon salon.',
};

/**
 * Ligne `embeds.data` -> embed NEUTRE. Source unique de la forme d'un embed
 * enregistré : `/embed`, les commandes personnalisées et les rappels programmés
 * affichent tous le même objet à partir des mêmes colonnes.
 */
function construireEmbedEnregistre(data) {
    return embed({
        titre: data.titre,
        description: data.description,
        couleur: data.couleur,
        pied: data.footer ? { texte: data.footer } : undefined,
        image: data.image,
        vignette: data.thumbnail,
    });
}

// Le descripteur reste l'export principal : le chargeur de commandes le lit, et
// ne fait qu'accompagner `construireEmbedEnregistre` — la SOURCE UNIQUE de la
// forme d'un embed enregistré, partagée avec les commandes personnalisées
// (`bot/index.js`) et les rappels programmés (`bot/modules/scheduler/`).
//
// Le pont `buildDiscordEmbed`, qui rendait ce même embed en `EmbedBuilder`, a
// été retiré à la consolidation : ses deux appelants postent désormais par le
// client REST normalisé, qui accepte l'embed neutre directement.
Object.assign(module.exports, { construireEmbedEnregistre });
