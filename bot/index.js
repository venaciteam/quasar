const { Client, GatewayIntentBits, Collection, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../api/services/database');
const { deployCommands } = require('./utils/deploy-commands');
const { DISABLED_COMMAND_FILES } = require('./utils/disabledCommands');

function createBot() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.MessageContent
        ],
        partials: [
            Partials.Message,
            Partials.Reaction
        ]
    });

    // Collection de commandes
    client.commands = new Collection();

    // Charger les commandes
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js') && !DISABLED_COMMAND_FILES.includes(f));

    for (const file of commandFiles) {
        const mod = require(path.join(commandsPath, file));
        // Fichier avec exports multiples (ex: musiccontrols.js)
        if (!mod.data && typeof mod === 'object') {
            for (const key of Object.keys(mod)) {
                const command = mod[key];
                if (command?.data && command?.execute) {
                    client.commands.set(command.data.name, command);
                    console.log(`[Quasar] Commande chargée: /${command.data.name}`);
                }
            }
        } else if (mod.data && mod.execute) {
            client.commands.set(mod.data.name, mod);
            console.log(`[Quasar] Commande chargée: /${mod.data.name}`);
        }
    }

    // Charger les events
    const eventsPath = path.join(__dirname, 'events');
    if (fs.existsSync(eventsPath)) {
        const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
        for (const file of eventFiles) {
            const event = require(path.join(eventsPath, file));
            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args));
            } else {
                client.on(event.name, (...args) => event.execute(...args));
            }
            console.log(`[Quasar] Event chargé: ${event.name}`);
        }
    }

    // Handler d'interactions
    const { handleTempVoiceInteraction } = require('./interactions/tempvoice');
    const { handleTicketInteraction } = require('./interactions/ticket');

    // Rate limit autocomplete : max 5 par utilisateur par 10 secondes
    const autocompleteLimits = new Map();
    const AC_LIMIT = 5;
    const AC_WINDOW = 10_000;
    setInterval(() => autocompleteLimits.clear(), AC_WINDOW);

    client.on('interactionCreate', async (interaction) => {
        // Autocomplétion (avec rate limit)
        if (interaction.isAutocomplete()) {
            const key = interaction.user.id;
            const count = (autocompleteLimits.get(key) || 0) + 1;
            autocompleteLimits.set(key, count);
            if (count > AC_LIMIT) return;

            const command = client.commands.get(interaction.commandName);
            if (command?.autocomplete) {
                try { await command.autocomplete(interaction); } catch (e) { console.error('[Quasar] Autocomplete error:', e); }
            }
            return;
        }

        // TempVoice : boutons, select menus, modals
        if (interaction.isButton() || interaction.isUserSelectMenu() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('tv_')) {
                try { await handleTempVoiceInteraction(interaction); } catch (e) {
                    console.error('[Quasar] Erreur interaction TempVoice:', e);
                    if (!interaction.replied && !interaction.deferred) {
                        interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true }).catch(() => {});
                    }
                }
                return;
            }

            if (interaction.customId.startsWith('ticket_')) {
                try { await handleTicketInteraction(interaction); } catch (e) {
                    console.error('[Quasar] Erreur interaction Ticket:', e);
                    if (!interaction.replied && !interaction.deferred) {
                        interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true }).catch(() => {});
                    }
                }
                return;
            }
        }

        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            // Vérifier si c'est une commande custom
            const { getDb } = require('../api/services/database');
            const db = getDb();
            const customCmd = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?')
                .get(interaction.guild?.id, interaction.commandName);

            if (customCmd) {
                try {
                    if (customCmd.embed_id) {
                        const embedRow = db.prepare('SELECT data FROM embeds WHERE id = ?').get(customCmd.embed_id);
                        if (embedRow) {
                            const { buildDiscordEmbed } = require('./commands/embed');
                            const embed = buildDiscordEmbed(JSON.parse(embedRow.data));
                            return interaction.reply({ embeds: [embed] });
                        }
                    }
                    if (customCmd.response) {
                        return interaction.reply({ content: customCmd.response });
                    }
                } catch (err) {
                    console.error('[Quasar] Erreur commande custom:', err);
                }
            }
            return;
        }

        try {
            await command.execute(interaction);

            // Log commande utilisée
            const { sendLog } = require('./utils/logger');
            const { EmbedBuilder } = require('discord.js');
            const cmdEmbed = new EmbedBuilder()
                .setTitle('⚡ Commande utilisée')
                .setColor(0xc8a86e)
                .addFields(
                    { name: 'Commande', value: `\`/${interaction.commandName}\``, inline: true },
                    { name: 'Par', value: `${interaction.user}`, inline: true },
                    { name: 'Channel', value: `<#${interaction.channel?.id}>`, inline: true }
                )
                .setTimestamp();
            sendLog(interaction.guild, 'quasar_command', cmdEmbed).catch(() => {});
        } catch (error) {
            console.error(`[Quasar] Erreur commande /${interaction.commandName}:`, error);
            const reply = { content: '❌ Une erreur est survenue.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    });

    client.once('ready', async () => {
        console.log(`[Quasar] Connecté en tant que ${client.user.tag}`);
        console.log(`[Quasar] Présent sur ${client.guilds.cache.size} serveur(s)`);

        // Aucune télémétrie. Le heartbeat vers un hub central (identifiant d'instance
        // persistant + nombre de serveurs) a été retiré en v3.3.0 : Quasar ne contacte
        // aucun service tiers, rien ne sort de la machine qui l'héberge.

        // Enregistrer les guilds en DB
        const db = getDb();
        const upsert = db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)');
        client.guilds.cache.forEach(guild => {
            upsert.run(guild.id, guild.name);
        });

        // Déployer les commandes slash
        await deployCommands(client);

        // Charger la présence depuis la DB (ou fallback)
        try {
            const presence = db.prepare('SELECT * FROM bot_presence WHERE id = 1').get();
            if (presence) {
                if (presence.activity_type === -1) {
                    // Aucune activité — statut uniquement
                    client.user.setPresence({
                        status: presence.status,
                        activities: []
                    });
                    console.log(`[Quasar] Présence chargée: ${presence.status} (aucune activité)`);
                } else {
                    client.user.setPresence({
                        status: presence.status,
                        activities: [{
                            name: presence.activity_text,
                            type: presence.activity_type
                        }]
                    });
                    console.log(`[Quasar] Présence chargée: ${presence.status} — ${presence.activity_text}`);
                }
            } else {
                client.user.setActivity('atlas.vena.city', { type: 3 });
                console.log('[Quasar] Présence par défaut: Watching atlas.vena.city');
            }
        } catch (e) {
            client.user.setActivity('atlas.vena.city', { type: 3 });
            console.log('[Quasar] Présence fallback (erreur DB):', e.message);
        }

        // TempVoice — Charger les IDs actifs dans le Set (pour filtrage channelCreate/Delete)
        try {
            const { tempvoiceChannelIds } = require('./events/voiceStateUpdate');
            const allActive = db.prepare('SELECT channel_id FROM tempvoice_active').all();
            for (const row of allActive) tempvoiceChannelIds.add(row.channel_id);
            if (allActive.length > 0) console.log(`[Quasar] TempVoice: ${allActive.length} ID(s) chargé(s) dans le tracker`);
        } catch (e) {
            console.error('[Quasar] Erreur chargement TempVoice IDs:', e.message || e);
        }

        // TempVoice — Nettoyage des vocaux orphelins au boot
        try {
            const tvActive = db.prepare('SELECT * FROM tempvoice_active').all();
            let cleaned = 0;
            for (const row of tvActive) {
                const g = client.guilds.cache.get(row.guild_id);
                const ch = g?.channels.cache.get(row.channel_id);
                if (!ch || ch.members.size === 0) {
                    if (ch) await ch.delete().catch(() => {});
                    db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(row.channel_id);
                    cleaned++;
                }
            }
            if (cleaned > 0) console.log(`[Quasar] TempVoice boot cleanup: ${cleaned} salon(s) orphelin(s) supprimé(s)`);
        } catch (e) {
            // Tables pas encore créées au premier boot, on ignore
        }

        // Scheduler — Démarrer la boucle d'envoi des rappels programmés
        try {
            const scheduler = require('./modules/scheduler');
            scheduler.start(client);
        } catch (e) {
            console.error('[Quasar] Erreur démarrage scheduler:', e.message || e);
        }
    });

    return client;
}

module.exports = { createBot };
