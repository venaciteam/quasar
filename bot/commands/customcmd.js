const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { hasMentions } = require('../../api/services/mentions');
const { userError } = require('../utils/errors');

// Une commande custom répond à celui qui la tape, à la demande et sans limite de
// fréquence : y rejouer les mentions de l'embed transformerait n'importe quel
// membre en déclencheur de ping (@everyone compris). Les mentions d'un embed ne
// sont donc volontairement PAS appliquées ici — on se contente de le signaler à
// l'admin au moment où il lie un embed « qui ping » à une commande.
const MENTIONS_IGNOREES = 'ℹ️ Cet embed a des mentions configurées : elles ne sont **pas** appliquées aux commandes personnalisées (elles ne valent que pour `/embed send` et les rappels).';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('cmd')
        .setDescription('Gérer les commandes personnalisées')
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Créer une commande personnalisée')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de la commande (sans /)').setRequired(true))
            .addStringOption(opt => opt.setName('reponse').setDescription('Texte de la réponse').setRequired(false))
            .addStringOption(opt => opt.setName('embed').setDescription('Nom d\'un embed sauvegardé (prioritaire sur le texte)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Modifier une commande existante')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de la commande').setRequired(true))
            .addStringOption(opt => opt.setName('reponse').setDescription('Nouveau texte').setRequired(false))
            .addStringOption(opt => opt.setName('embed').setDescription('Nouvel embed (nom)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('delete')
            .setDescription('Supprimer une commande personnalisée')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de la commande').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('Lister toutes les commandes personnalisées')
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const db = getDb();

        if (sub === 'create' || sub === 'edit') {
            const nom = interaction.options.getString('nom').toLowerCase().replace(/\s+/g, '-');
            const reponse = interaction.options.getString('reponse');
            const embedNom = interaction.options.getString('embed');

            if (!reponse && !embedNom) {
                return userError(interaction, {
                    title: 'Commande sans contenu',
                    cause: 'Une commande personnalisée doit répondre quelque chose : un texte, ou un embed enregistré.',
                    action: 'Renseigne le champ `reponse`, ou indique un embed existant avec `embed`.',
                });
            }

            // Vérifier que l'embed existe si fourni
            let embedId = null;
            let embedPing = false;
            if (embedNom) {
                const embedRow = db.prepare(
                    'SELECT id, mention_roles, mention_users, mention_everyone, mention_here FROM embeds WHERE guild_id = ? AND name = ?'
                ).get(interaction.guild.id, embedNom);
                if (!embedRow) {
                    return userError(interaction, {
                        title: 'Embed introuvable',
                        cause: `Aucun embed enregistré ne s'appelle **${embedNom}** sur ce serveur.`,
                        action: 'Crée-le d\'abord avec `/embed create`, ou consulte les embeds existants avec `/embed list`.',
                    });
                }
                embedId = embedRow.id;
                embedPing = hasMentions(embedRow);
            }

            if (sub === 'create') {
                const existing = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);
                if (existing) {
                    return userError(interaction, {
                        title: 'Cette commande existe déjà',
                        cause: `Une commande personnalisée **/${nom}** est déjà enregistrée sur ce serveur.`,
                        action: 'Modifie-la avec `/cmd edit`, ou choisis un autre nom.',
                    });
                }

                db.prepare('INSERT INTO custom_commands (guild_id, name, response, embed_id) VALUES (?, ?, ?, ?)')
                    .run(interaction.guild.id, nom, reponse || null, embedId);

                // Déployer la commande slash
                await deployCustomCommand(interaction.client, interaction.guild.id, nom, reponse || `Commande ${nom}`);

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Commande créée')
                        .setColor(0xc86e8e)
                        .setDescription(`La commande \`/${nom}\` est disponible sur le serveur.${embedPing ? `\n\n${MENTIONS_IGNOREES}` : ''}`)
                        .addFields(
                            embedNom
                                ? { name: 'Réponse', value: `Embed: **${embedNom}**` }
                                : { name: 'Réponse', value: reponse }
                        )
                        .setTimestamp()],
                    ephemeral: true
                });

            } else {
                const result = db.prepare('UPDATE custom_commands SET response = ?, embed_id = ? WHERE guild_id = ? AND name = ?')
                    .run(reponse || null, embedId, interaction.guild.id, nom);

                if (result.changes === 0) return userError(interaction, {
                    title: 'Commande introuvable',
                    cause: `Aucune commande personnalisée **/${nom}** n'existe sur ce serveur.`,
                    action: 'Consulte la liste avec `/cmd list`.',
                });

                await interaction.reply({
                    content: `✅ Commande \`/${nom}\` mise à jour.${embedPing ? `\n${MENTIONS_IGNOREES}` : ''}`,
                    ephemeral: true
                });
            }

        } else if (sub === 'delete') {
            const nom = interaction.options.getString('nom').toLowerCase();
            const result = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?').run(interaction.guild.id, nom);

            if (result.changes === 0) return userError(interaction, {
                    title: 'Commande introuvable',
                    cause: `Aucune commande personnalisée **/${nom}** n'existe sur ce serveur.`,
                    action: 'Consulte la liste avec `/cmd list`.',
                });

            // Retirer la commande slash de la guild
            await removeCustomCommand(interaction.client, interaction.guild.id, nom);

            await interaction.reply({ content: `🗑️ Commande \`/${nom}\` supprimée.`, ephemeral: true });

        } else if (sub === 'list') {
            const cmds = db.prepare('SELECT name, response, embed_id FROM custom_commands WHERE guild_id = ?').all(interaction.guild.id);

            if (cmds.length === 0) return interaction.reply({ content: 'Aucune commande personnalisée.', ephemeral: true });

            const lines = cmds.map(c => {
                const reponse = c.embed_id ? '*(embed)*' : (c.response?.substring(0, 50) + (c.response?.length > 50 ? '…' : ''));
                return `⚡ \`/${c.name}\` — ${reponse}`;
            });

            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('⚡ Commandes personnalisées')
                    .setColor(0x6e8ec8)
                    .setDescription(lines.join('\n'))
                    .setTimestamp()],
                ephemeral: true
            });
        }
    }
};

async function deployCustomCommand(client, guildId, name, description) {
    const { REST, Routes } = require('discord.js');
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        // Récupérer les commandes existantes de la guild
        const existing = await rest.get(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId));
        const newCmd = { name, description: description.substring(0, 100), type: 1 };
        await rest.post(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), { body: newCmd });
    } catch (e) {
        console.error('[Quasar] Erreur déploiement commande custom:', e.message);
    }
}

async function removeCustomCommand(client, guildId, name) {
    const { REST, Routes } = require('discord.js');
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        const cmds = await rest.get(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId));
        const cmd = cmds.find(c => c.name === name);
        if (cmd) {
            await rest.delete(Routes.applicationGuildCommand(process.env.DISCORD_CLIENT_ID, guildId, cmd.id));
        }
    } catch (e) {
        console.error('[Quasar] Erreur suppression commande custom:', e.message);
    }
}
