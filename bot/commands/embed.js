const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { userError } = require('../utils/errors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('embed')
        .setDescription('Créer et gérer des embeds personnalisés')
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Créer un nouvel embed')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom pour retrouver l\'embed').setRequired(true))
            .addStringOption(opt => opt.setName('titre').setDescription('Titre de l\'embed').setRequired(false))
            .addStringOption(opt => opt.setName('description').setDescription('Description (contenu principal)').setRequired(false))
            .addStringOption(opt => opt.setName('couleur').setDescription('Couleur hex (ex: #c86e8e)').setRequired(false))
            .addStringOption(opt => opt.setName('footer').setDescription('Texte en pied de page').setRequired(false))
            .addStringOption(opt => opt.setName('image').setDescription('URL d\'une image (grande, en bas)').setRequired(false))
            .addStringOption(opt => opt.setName('thumbnail').setDescription('URL d\'une miniature (petit, en haut à droite)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('send')
            .setDescription('Envoyer un embed sauvegardé dans un channel')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de l\'embed').setRequired(true).setAutocomplete(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel de destination').addChannelTypes(ChannelType.GuildText).setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Modifier un embed déjà envoyé (via l\'ID du message)')
            .addStringOption(opt => opt.setName('message_id').setDescription('ID du message à modifier').setRequired(true))
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de l\'embed à utiliser').setRequired(true).setAutocomplete(true))
            .addChannelOption(opt => opt.setName('channel').setDescription('Channel du message').addChannelTypes(ChannelType.GuildText).setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Voir les embeds sauvegardés')
        )
        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Supprimer un embed sauvegardé')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de l\'embed').setRequired(true).setAutocomplete(true))
        )
        .addSubcommand(sub => sub
            .setName('preview')
            .setDescription('Prévisualiser un embed (en éphémère)')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de l\'embed').setRequired(true).setAutocomplete(true))
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused().toLowerCase();
        const db = getDb();
        const embeds = db.prepare('SELECT name FROM embeds WHERE guild_id = ?').all(interaction.guild.id);
        const filtered = embeds
            .filter(e => e.name.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(e => ({ name: e.name, value: e.name }));
        await interaction.respond(filtered);
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const db = getDb();

        if (sub === 'create') {
            const nom = interaction.options.getString('nom');
            const titre = interaction.options.getString('titre');
            const description = interaction.options.getString('description');
            const couleur = interaction.options.getString('couleur') || '#c86e8e';
            const footer = interaction.options.getString('footer');
            const image = interaction.options.getString('image');
            const thumbnail = interaction.options.getString('thumbnail');

            if (!titre && !description) {
                return userError(interaction, {
                    title: 'Embed vide',
                    cause: 'Un embed sans titre ni description n\'affiche rien : Discord le refuserait.',
                    action: 'Renseigne au moins le titre ou la description.',
                });
            }

            const data = { couleur };
            if (titre) data.titre = titre;
            if (description) data.description = description;
            if (footer) data.footer = footer;
            if (image) data.image = image;
            if (thumbnail) data.thumbnail = thumbnail;

            // Vérifier si le nom existe déjà
            const existing = db.prepare('SELECT id FROM embeds WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);
            if (existing) {
                db.prepare('UPDATE embeds SET data = ?, updated_at = datetime(\'now\') WHERE guild_id = ? AND name = ?')
                    .run(JSON.stringify(data), interaction.guild.id, nom);
            } else {
                db.prepare('INSERT INTO embeds (guild_id, name, data) VALUES (?, ?, ?)').run(interaction.guild.id, nom, JSON.stringify(data));
            }

            const preview = buildDiscordEmbed(data);
            await interaction.reply({
                content: `✅ Embed **${nom}** ${existing ? 'mis à jour' : 'créé'} ! Aperçu :\n> 💡 **Astuce image** : pour utiliser une image sans hébergement externe, poste-la dans n'importe quel channel Discord, fais clic droit → "Copier le lien de l'image", et colle cette URL dans \`image:\` ou \`thumbnail:\`.`,
                embeds: [preview],
                ephemeral: true
            });

        } else if (sub === 'send') {
            const nom = interaction.options.getString('nom');
            const channel = interaction.options.getChannel('channel');

            const embedRow = db.prepare('SELECT data FROM embeds WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);
            if (!embedRow) return userError(interaction, {
                title: 'Embed introuvable',
                cause: `Aucun embed enregistré ne s'appelle **${nom}** sur ce serveur.`,
                action: 'Consulte la liste avec `/embed list` — les noms sont sensibles à la casse.',
            });

            const embed = buildDiscordEmbed(JSON.parse(embedRow.data));
            await channel.send({ embeds: [embed] });

            await interaction.reply({ content: `✅ Embed **${nom}** envoyé dans ${channel}.`, ephemeral: true });

        } else if (sub === 'edit') {
            const messageId = interaction.options.getString('message_id');
            const nom = interaction.options.getString('nom');
            const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

            const embedRow = db.prepare('SELECT data FROM embeds WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);
            if (!embedRow) return userError(interaction, {
                title: 'Embed introuvable',
                cause: `Aucun embed enregistré ne s'appelle **${nom}** sur ce serveur.`,
                action: 'Consulte la liste avec `/embed list` — les noms sont sensibles à la casse.',
            });

            try {
                const msg = await targetChannel.messages.fetch(messageId);
                if (msg.author.id !== interaction.client.user.id) {
                    return userError(interaction, {
                        title: 'Je ne peux pas modifier ce message',
                        cause: 'Discord n\'autorise un bot à modifier que les messages qu\'il a lui-même envoyés.',
                        action: 'Pour modifier cet embed, supprime le message et renvoie-le avec `/embed send`.',
                    });
                }

                const embed = buildDiscordEmbed(JSON.parse(embedRow.data));
                await msg.edit({ embeds: [embed] });
                await interaction.reply({ content: '✅ Message modifié avec succès.', ephemeral: true });
            } catch (e) {
                await userError(interaction, {
                    title: 'Message introuvable',
                    cause: 'Aucun message ne correspond à cet identifiant dans ce salon. Il a peut-être été supprimé, ou se trouve ailleurs.',
                    action: 'Vérifie l\'identifiant (clic droit sur le message → Copier l\'identifiant) et lance la commande depuis le bon salon.',
                });
            }

        } else if (sub === 'list') {
            const embeds = db.prepare('SELECT name, updated_at FROM embeds WHERE guild_id = ? ORDER BY updated_at DESC').all(interaction.guild.id);

            if (embeds.length === 0) return interaction.reply({ content: 'Aucun embed sauvegardé.', ephemeral: true });

            const lines = embeds.map(e => {
                const date = new Date(e.updated_at + 'Z').toLocaleDateString('fr-FR');
                return `📝 **${e.name}** — modifié le ${date}`;
            });

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('📝 Embeds sauvegardés')
                    .setColor(0x6e8ec8)
                    .setDescription(lines.join('\n'))
                    .setTimestamp()],
                ephemeral: true
            });

        } else if (sub === 'delete') {
            const nom = interaction.options.getString('nom');
            const result = db.prepare('DELETE FROM embeds WHERE guild_id = ? AND name = ?').run(interaction.guild.id, nom);

            if (result.changes === 0) return userError(interaction, {
                title: 'Embed introuvable',
                cause: `Aucun embed enregistré ne s'appelle **${nom}** sur ce serveur.`,
                action: 'Consulte la liste avec `/embed list` — les noms sont sensibles à la casse.',
            });
            await interaction.reply({ content: `🗑️ Embed **${nom}** supprimé.`, ephemeral: true });

        } else if (sub === 'preview') {
            const nom = interaction.options.getString('nom');
            const embedRow = db.prepare('SELECT data FROM embeds WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);

            if (!embedRow) return userError(interaction, {
                title: 'Embed introuvable',
                cause: `Aucun embed enregistré ne s'appelle **${nom}** sur ce serveur.`,
                action: 'Consulte la liste avec `/embed list` — les noms sont sensibles à la casse.',
            });

            const embed = buildDiscordEmbed(JSON.parse(embedRow.data));
            await interaction.reply({ content: `👁️ Aperçu de **${nom}** :`, embeds: [embed], ephemeral: true });
        }
    }
};

function buildDiscordEmbed(data) {
    const embed = new EmbedBuilder();

    if (data.couleur) {
        try { embed.setColor(data.couleur); } catch {} // Invalid color value = ignored
    }
    if (data.titre) embed.setTitle(data.titre);
    if (data.description) embed.setDescription(data.description);
    if (data.footer) embed.setFooter({ text: data.footer });
    if (data.image) embed.setImage(data.image);
    if (data.thumbnail) embed.setThumbnail(data.thumbnail);

    return embed;
}

module.exports.buildDiscordEmbed = buildDiscordEmbed;
