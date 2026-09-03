const { Client, GatewayIntentBits, Collection, Partials, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getDb, effectiveAccessMode } = require('../api/services/database');
const { buildMentionPayload } = require('../api/services/mentions');
const { deployCommands } = require('./utils/deploy-commands');
const { DISABLED_COMMAND_FILES } = require('./utils/disabledCommands');
const { reportIncident, userError } = require('./utils/errors');
const { isSuspended } = require('./utils/suspension');

// ═══════════════════════════════════════════════════════════════
//  Commandes personnalisées — contrôle d'accès
//
//  Une commande custom est déclenchable à volonté par n'importe qui, et elle
//  rejoue désormais les mentions de son embed (@everyone compris) comme celles
//  écrites dans sa réponse texte. C'est ce contrôle d'accès, et lui seul, qui
//  empêche que `/faq` devienne un bouton « pinger tout le serveur » à
//  disposition de tous. Il est donc appliqué côté bot, à l'exécution — jamais
//  uniquement dans l'interface du dashboard.
//
//  Trois modes exclusifs, portés par la ligne `custom_commands` :
//    'everyone' → tout le monde (défaut, et comportement historique)
//    'admins'   → permission Administrateur de Discord, la même notion que
//                 celle utilisée par /log, /unlog et le middleware
//                 requireGuildAdmin du dashboard
//    'role'     → les porteurs d'un rôle précis (access_role_id)
//
//  Dans tous les modes, un administrateur du serveur passe (cf. le
//  contournement dans checkCustomCommandAccess) : « réservée au rôle X »
//  signifie donc en pratique « rôle X ou administrateur ».
// ═══════════════════════════════════════════════════════════════

// Un membre peut arriver en objet discord.js (roles = gestionnaire avec cache)
// ou en membre brut de l'API (roles = tableau d'IDs). Les deux sont gérés.
function memberHasRole(member, roleId) {
    const roles = member?.roles;
    if (!roles) return false;
    if (Array.isArray(roles)) return roles.includes(roleId);
    return !!roles.cache?.has(roleId);
}

// Permission Administrateur du membre à l'origine de l'interaction. discord.js
// l'expose soit sur l'interaction, soit sur le membre ; si aucun jeu de
// permissions exploitable n'est disponible, on répond « non » plutôt que de
// transformer un « je ne sais pas » en droit accordé.
function memberIsAdministrator(interaction) {
    const perms = interaction.memberPermissions || interaction.member?.permissions;
    return typeof perms?.has === 'function' && perms.has(PermissionFlagsBits.Administrator);
}

/**
 * @returns {null|{title:string,cause:string,action:string}} null = accès accordé,
 *          sinon le refus à afficher en éphémère.
 */
function checkCustomCommandAccess(interaction, row) {
    // Repli sur le plus restrictif si la valeur en base n'est pas reconnue
    // (cf. effectiveAccessMode). On le journalise : c'est le signe d'une base
    // incohérente, et la commande devient inaccessible aux non-administrateurs.
    const mode = effectiveAccessMode(row.access_mode);
    if (row.access_mode && mode !== row.access_mode) {
        console.warn(`[Quasar] Commande custom /${row.name} : mode d'accès inconnu "${row.access_mode}" — repli sur "${mode}".`);
    }

    if (mode === 'everyone') return null;

    // Hors serveur (message privé) il n'y a ni membre ni rôle : rien n'est
    // vérifiable, donc rien n'est accordé. En pratique les commandes custom sont
    // déployées par serveur et n'arrivent jamais en MP, mais on ne s'appuie pas
    // sur cette hypothèse pour décider d'un droit.
    if (!interaction.guild || !interaction.member) {
        return {
            title: 'Commande réservée au serveur',
            cause: 'L\'accès à cette commande dépend de tes rôles ou de tes permissions, et je n\'arrive pas à les consulter ici.',
            action: 'Relance-la depuis un salon du serveur concerné. Si tu y es déjà, réessaie dans un instant.',
        };
    }

    // Contournement administrateur — appliqué à TOUS les modes, et AVANT leur
    // évaluation. Ce n'est pas un trou de sécurité, c'est ce qui rend le réglage
    // réparable :
    //   1. on ne s'enferme pas dehors de sa propre commande (configurer un mode
    //      « rôle » sans s'être attribué ce rôle est l'erreur la plus courante) ;
    //   2. une configuration cassée — rôle supprimé du serveur, mode inconnu en
    //      base — resterait sinon bloquée pour tout le monde, y compris pour les
    //      seules personnes capables de la corriger.
    // Un administrateur peut de toute façon s'attribuer n'importe quel rôle :
    // la restriction ne lui interdisait rien, elle ne faisait que le gêner.
    if (memberIsAdministrator(interaction)) return null;

    if (mode === 'admins') {
        return {
            title: 'Commande réservée aux administrateurs',
            cause: 'Cette commande personnalisée est configurée pour les membres ayant la permission « Administrateur » sur ce serveur.',
            action: 'Demande à un administrateur de la lancer, ou d\'ouvrir son accès depuis le dashboard ou `/cmd edit`.',
        };
    }

    // mode === 'role'
    const roleId = row.access_role_id;

    // Rôle configuré puis supprimé du serveur : plus personne ne peut le porter.
    // On refuse (retomber sur « tout le monde » ouvrirait en grand une commande
    // volontairement restreinte) et on le dit clairement, pour que la personne
    // puisse le signaler plutôt que de croire à un bug. Les administrateurs, eux,
    // sont déjà passés plus haut : ils peuvent utiliser la commande et surtout la
    // reconfigurer.
    if (!roleId || !interaction.guild.roles.cache.has(roleId)) {
        return {
            title: 'Commande momentanément indisponible',
            cause: 'Cette commande est réservée à un rôle qui n\'existe plus sur le serveur : en dehors des administrateurs, personne ne peut donc l\'utiliser pour l\'instant.',
            action: 'Signale-le à un administrateur : il peut choisir un autre rôle depuis le dashboard ou `/cmd edit`.',
        };
    }

    if (memberHasRole(interaction.member, roleId)) return null;

    return {
        title: 'Commande réservée à un rôle',
        cause: `Cette commande personnalisée est réservée aux membres ayant le rôle <@&${roleId}>, ainsi qu'aux administrateurs du serveur.`,
        action: 'Si tu penses que ce rôle devrait t\'être attribué, demande-le à un administrateur.',
    };
}

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
    const { handleDeferInteraction } = require('./interactions/defer');

    // Rate limit autocomplete : max 5 par utilisateur par 10 secondes
    const autocompleteLimits = new Map();
    const AC_LIMIT = 5;
    const AC_WINDOW = 10_000;
    setInterval(() => autocompleteLimits.clear(), AC_WINDOW);

    client.on('interactionCreate', async (interaction) => {
        // Enforcement de la suspension (coupure ciblée, sous-lot E) : sur un serveur
        // suspendu par la propriétaire, Quasar ne répond plus à aucune interaction.
        // En tête du handler, avant l'autocomplétion et tout dispatch. Ne concerne
        // pas les DM (pas de interaction.guild).
        if (interaction.guild && isSuspended(interaction.guild.id)) {
            if (interaction.isAutocomplete && interaction.isAutocomplete()) return; // pas de reply possible
            try {
                await interaction.reply({
                    content: 'Quasar est temporairement suspendu sur ce serveur par la proprietaire de l\'instance.',
                    ephemeral: true,
                });
            } catch {}
            return;
        }

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
            // Même trace que pour les commandes. Les tickets et les salons vocaux
            // passent presque entièrement par des boutons : sans cette ligne, la
            // moitié de l'usage réel du bot resterait invisible dans les journaux.
            const kind = interaction.isModalSubmit() ? 'formulaire'
                : interaction.isButton() ? 'bouton' : 'menu';
            console.log(
                `[Quasar] → ${kind} ${interaction.customId} ` +
                `| guild=${interaction.guild?.id || 'MP'} | user=${interaction.user?.id}`
            );

            if (interaction.customId.startsWith('tv_')) {
                try { await handleTempVoiceInteraction(interaction); } catch (e) {
                    reportIncident(interaction, e, { command: `bouton ${interaction.customId}` });
                }
                return;
            }

            if (interaction.customId.startsWith('ticket_')) {
                try { await handleTicketInteraction(interaction); } catch (e) {
                    reportIncident(interaction, e, { command: `bouton ${interaction.customId}` });
                }
                return;
            }

            // Arbitrage : les boutons portent l'identifiant du cas et restent
            // fonctionnels après un redémarrage, sans état en mémoire.
            if (interaction.customId.startsWith('defer_')) {
                try { await handleDeferInteraction(interaction); } catch (e) {
                    reportIncident(interaction, e, { command: `bouton ${interaction.customId}` });
                }
                return;
            }

            if (interaction.customId.startsWith('signaler_')) {
                try {
                    const { handleReportModal } = require('./commands/signaler');
                    await handleReportModal(interaction);
                } catch (e) {
                    reportIncident(interaction, e, { command: `formulaire ${interaction.customId}` });
                }
                return;
            }

            if (interaction.customId.startsWith('mesdonnees_')) {
                try {
                    const { handleMesDonneesButton } = require('./commands/mesdonnees');
                    await handleMesDonneesButton(interaction);
                } catch (e) {
                    reportIncident(interaction, e, { command: `bouton ${interaction.customId}` });
                }
                return;
            }
        }

        if (!interaction.isChatInputCommand()) return;

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            // Vérifier si c'est une commande custom
            // SELECT * : la ligne porte déjà access_mode / access_role_id, le
            // contrôle d'accès ne coûte donc aucune requête supplémentaire.
            const db = getDb();
            const customCmd = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?')
                .get(interaction.guild?.id, interaction.commandName);

            if (customCmd) {
                try {
                    // Contrôle d'accès AVANT toute réponse : un refus est éphémère,
                    // rien n'est jamais posté dans le salon.
                    const refus = checkCustomCommandAccess(interaction, customCmd);
                    if (refus) return userError(interaction, refus);

                    if (customCmd.embed_id) {
                        const embedRow = db.prepare(
                            'SELECT data, mention_roles, mention_users, mention_everyone, mention_here FROM embeds WHERE id = ?'
                        ).get(customCmd.embed_id);
                        if (embedRow) {
                            const { buildDiscordEmbed } = require('./commands/embed');
                            const embed = buildDiscordEmbed(JSON.parse(embedRow.data));
                            // Mentions de l'embed appliquées à l'identique de
                            // `/embed send` et des rappels programmés : même helper,
                            // même payload à configuration égale. C'est le contrôle
                            // d'accès ci-dessus qui protège de l'abus.
                            const { content, allowedMentions } = buildMentionPayload(embedRow);
                            const payload = { embeds: [embed], allowedMentions };
                            if (content) payload.content = content;
                            return interaction.reply(payload);
                        }
                    }
                    if (customCmd.response) {
                        // Réponse texte : volontairement SANS allowedMentions, à
                        // l'inverse du chemin embed juste au-dessus. Ce qui est
                        // écrit dans la réponse doit pinger normalement (@everyone,
                        // rôles, membres) — c'est le comportement d'origine, et le
                        // contrôle d'accès ci-dessus limite déjà qui peut déclencher
                        // la commande.
                        // Les deux chemins divergent délibérément : l'embed rejoue
                        // strictement les mentions cochées sur lui (parse: [] + listes
                        // explicites), le texte laisse Discord analyser son contenu.
                        // Ne pas les « harmoniser ».
                        return interaction.reply({ content: customCmd.response });
                    }
                } catch (err) {
                    reportIncident(interaction, err, { command: `commande personnalisée /${interaction.commandName}` });
                }
            }
            return;
        }

        // Trace d'entrée. Sans elle, impossible de savoir si une commande a seulement
        // atteint le bot : une interaction rejetée par Discord en amont et une
        // commande qui échoue en silence laissent exactement les mêmes journaux — un
        // incident réel a coûté une demi-heure de diagnostic pour cette raison.
        const sub = interaction.options?.getSubcommand?.(false);
        console.log(
            `[Quasar] → /${interaction.commandName}${sub ? ' ' + sub : ''} ` +
            `| guild=${interaction.guild?.id || 'MP'} | user=${interaction.user?.id}`
        );

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
            reportIncident(interaction, error, {
                command: `/${interaction.commandName}${sub ? ' ' + sub : ''}`,
            });
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

        // Rétention — Purge des serveurs quittés et des sanctions expirées
        try {
            const retention = require('./modules/retention');
            retention.start(client);
        } catch (e) {
            console.error('[Quasar] Erreur démarrage rétention:', e.message || e);
        }

        // Notification de violation (art. 33) — Boucle qui dépile et envoie les
        // notifications enfilées depuis le dashboard owner.
        try {
            require('./modules/breach').start(client);
        } catch (e) {
            console.error('[Quasar] Erreur demarrage notification de violation:', e.message || e);
        }

        // Effacement (art. 17) — Boucle de suivi des demandes de suppression
        // (échéances légales, alertes owner).
        try {
            require('./modules/erasure').start(client);
        } catch (e) {
            console.error('[Quasar] Erreur demarrage effacement:', e.message || e);
        }

        // Modération automatique — Levée des bannissements temporaires arrivés à
        // terme. Discord n'a pas de ban à durée : sans ce balayage, un `tempban`
        // serait un ban définitif. La boucle ne fait rien tant qu'aucune échéance
        // n'est en base (un SELECT indexé par minute).
        try {
            require('./utils/punishments').startTempBanSweeper(client);
        } catch (e) {
            console.error('[Quasar] Erreur demarrage bannissements temporaires:', e.message || e);
        }
    });

    return client;
}

module.exports = { createBot };
