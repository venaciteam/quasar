const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { resolveVariables, buildEmbed } = require('./welcomeMessage');
const { userError } = require('./errors');

/**
 * Factory pour créer une commande de config welcome/leave
 * Évite la duplication entre welcome.js et leave.js
 */
function createConfigCommand(opts) {
    const {
        name,               // 'welcome' | 'leave'
        description,        // Description de la commande
        emoji,              // '👋' | '🚪'
        color,              // 0xc86e8e | 0x6e8ec8
        defaultColor,       // '#c86e8e' | '#6e8ec8'
        channelCol,         // 'welcome_channel' | 'leave_channel'
        messageCol,         // 'welcome_message' | 'leave_message'
        embedCol,           // 'welcome_embed' | 'leave_embed'
        enabledCol,         // 'welcome_enabled' | 'leave_enabled'
        defaultEmbedTitle,  // Titre par défaut de l'embed
        defaultEmbedDesc,   // Description par défaut de l'embed
        defaultTestMsg,     // Fonction (member) => string pour le message test par défaut
    } = opts;

    return {
        data: new SlashCommandBuilder()
            .setName(name)
            .setDescription(description)
            .addSubcommand(sub => sub
                .setName('channel')
                .setDescription(`Définir le channel de ${name === 'welcome' ? 'bienvenue' : 'départ'}`)
                .addChannelOption(opt => opt.setName('channel').setDescription('Le channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('message')
                .setDescription(`Définir le message de ${name === 'welcome' ? 'bienvenue' : 'départ'}`)
                .addStringOption(opt => opt.setName('texte').setDescription('Variables : {user} {username} {server} {membercount}').setRequired(true))
            )
            .addSubcommand(sub => sub
                .setName('test')
                .setDescription(`Prévisualiser le message de ${name === 'welcome' ? 'bienvenue' : 'départ'}`)
            )
            .addSubcommand(sub => sub
                .setName('embed')
                .setDescription(`Activer un embed de ${name === 'welcome' ? 'bienvenue' : 'départ'} (avec avatar de l'utilisateur)`)
                .addStringOption(opt => opt.setName('titre').setDescription('Titre. Variables : {username} {server}').setRequired(false))
                .addStringOption(opt => opt.setName('description').setDescription('Description. Variables : {user} {username} {server} {membercount}').setRequired(false))
                .addStringOption(opt => opt.setName('couleur').setDescription(`Couleur hex (ex: ${defaultColor})`).setRequired(false))
            )
            .addSubcommand(sub => sub
                .setName('embedoff')
                .setDescription(`Retirer l'embed de ${name === 'welcome' ? 'bienvenue' : 'départ'}`)
            )
            .addSubcommand(sub => sub
                .setName('off')
                .setDescription(`Désactiver les messages de ${name === 'welcome' ? 'bienvenue' : 'départ'}`)
            )
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

        async execute(interaction) {
            const sub = interaction.options.getSubcommand();
            const db = getDb();
            const label = name === 'welcome' ? 'Welcome' : 'Leave';

            db.prepare('INSERT OR IGNORE INTO welcome_config (guild_id) VALUES (?)').run(interaction.guild.id);

            if (sub === 'channel') {
                const channel = interaction.options.getChannel('channel');
                db.prepare(`UPDATE welcome_config SET ${channelCol} = ?, ${enabledCol} = 1 WHERE guild_id = ?`)
                    .run(channel.id, interaction.guild.id);

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`${emoji} ${label} configuré`)
                        .setColor(color)
                        .setDescription(`Les messages seront envoyés dans ${channel}.`)
                        .setTimestamp()]
                });

            } else if (sub === 'message') {
                const texte = interaction.options.getString('texte');
                db.prepare(`UPDATE welcome_config SET ${messageCol} = ? WHERE guild_id = ?`)
                    .run(texte, interaction.guild.id);

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`${emoji} Message mis à jour`)
                        .setColor(color)
                        .setDescription(`**Aperçu :** ${resolveVariables(texte, interaction.member)}`)
                        .setTimestamp()]
                });

            } else if (sub === 'test') {
                const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(interaction.guild.id);

                if (!config?.[channelCol]) {
                    return userError(interaction, {
                        title: 'Aucun salon configuré',
                        cause: `Le module **${name}** n'a pas encore de salon de destination.`,
                        action: `Définis-le avec \`/${name} channel #salon\`.`,
                    });
                }

                const channel = interaction.guild.channels.cache.get(config[channelCol]);
                if (!channel) {
                    return userError(interaction, {
                        title: 'Salon introuvable',
                        cause: 'Le salon configuré a été supprimé, ou je n\'y ai plus accès.',
                        action: `Reconfigure-le avec \`/${name} channel\`.`,
                    });
                }

                const embed = buildEmbed(config[embedCol], interaction.member);
                const content = config[messageCol] ? resolveVariables(config[messageCol], interaction.member) : null;

                await interaction.reply({ content: '✅ Message de test envoyé !', ephemeral: true });

                if (embed) {
                    await channel.send({ content: content || undefined, embeds: [embed] });
                } else if (content) {
                    await channel.send({ content });
                } else {
                    await channel.send({ content: defaultTestMsg(interaction.member) });
                }

            } else if (sub === 'embed') {
                const titre = interaction.options.getString('titre') || defaultEmbedTitle;
                const description = interaction.options.getString('description') || defaultEmbedDesc;
                const couleur = interaction.options.getString('couleur') || defaultColor;

                const embedConfig = { title: titre, description, color: couleur, thumbnail: 'avatar' };
                db.prepare(`UPDATE welcome_config SET ${embedCol} = ? WHERE guild_id = ?`)
                    .run(JSON.stringify(embedConfig), interaction.guild.id);

                const previewEmbed = {
                    title: resolveVariables(titre, interaction.member),
                    description: resolveVariables(description, interaction.member),
                    color: parseInt(couleur.replace('#', ''), 16),
                    thumbnail: { url: interaction.user.displayAvatarURL({ size: 128 }) }
                };

                await interaction.reply({ content: `✅ Embed de ${name === 'welcome' ? 'bienvenue' : 'départ'} configuré ! Aperçu :`, embeds: [previewEmbed] });

            } else if (sub === 'embedoff') {
                db.prepare(`UPDATE welcome_config SET ${embedCol} = NULL WHERE guild_id = ?`).run(interaction.guild.id);
                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`${emoji} Embed retiré`)
                        .setColor(color)
                        .setDescription('Le message repassera en texte simple.')
                        .setTimestamp()]
                });

            } else if (sub === 'off') {
                db.prepare(`UPDATE welcome_config SET ${enabledCol} = 0 WHERE guild_id = ?`).run(interaction.guild.id);
                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle(`${emoji} ${label} désactivé`)
                        .setColor(0xe74c3c)
                        .setDescription(`Les messages de ${name === 'welcome' ? 'bienvenue' : 'départ'} ont été désactivés.`)
                        .setTimestamp()]
                });
            }
        }
    };
}

module.exports = { createConfigCommand };
