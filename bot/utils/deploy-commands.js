const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { DISABLED_COMMAND_FILES } = require('./disabledCommands');

async function deployCommands(client) {
    const commands = [];
    const commandsPath = path.join(__dirname, '..', 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js') && !DISABLED_COMMAND_FILES.includes(f));

    for (const file of commandFiles) {
        const mod = require(path.join(commandsPath, file));
        // Fichier avec exports multiples (ex: musiccontrols.js)
        if (!mod.data && typeof mod === 'object') {
            for (const key of Object.keys(mod)) {
                if (mod[key]?.data) {
                    commands.push(mod[key].data.toJSON());
                }
            }
        } else if (mod.data) {
            commands.push(mod.data.toJSON());
        }
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log(`[Quasar] Déploiement de ${commands.length} commandes slash...`);

        // Déployer par guild (instantané) plutôt que global (jusqu'à 1h de délai)
        for (const guild of client.guilds.cache.values()) {
            await rest.put(
                Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guild.id),
                { body: commands }
            );
            console.log(`[Quasar] Commandes déployées sur: ${guild.name}`);
        }

        console.log('[Quasar] Commandes slash déployées ✓');
    } catch (error) {
        console.error('[Quasar] Erreur déploiement commandes:', error);
    }
}

module.exports = { deployCommands };
