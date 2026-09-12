const path = require('path');
const { resolvePlatform } = require('./platform');
const { getDb } = require('../api/services/database');
const { buildMentionPayload } = require('../api/services/mentions');
const { deployCommands } = require('./platform/discord/deploy');
const { DISABLED_COMMAND_FILES } = require('./utils/disabledCommands');
const { reportIncident, userError } = require('./utils/errors');
const { isSuspended } = require('./utils/suspension');

// ═══════════════════════════════════════════════════════════════
//  Commandes personnalisées — contrôle d'accès
//
//  Une commande personnalisée est déclenchable à volonté par n'importe qui, et
//  elle rejoue les mentions de son embed (@everyone compris) comme celles
//  écrites dans sa réponse texte. C'est ce contrôle d'accès, et lui seul, qui
//  empêche que `/faq` devienne un bouton « pinger tout le serveur » à
//  disposition de tous. Il est donc appliqué côté bot, à l'exécution — jamais
//  uniquement dans l'interface du dashboard.
//
//  ⚠️ La règle vit dans `bot/platform/accesCommandePersonnalisee.js` et est
//  exposée par les deux adaptateurs sous `platform.verifierAccesCommandePersonnalisee`.
//  Ce fichier en portait sa PROPRE copie, écrite pour discord.js, pendant que le
//  parseur Fluxer en portait une seconde. Deux copies d'un contrôle d'accès
//  divergent, et la divergence ne se voit pas : elle s'observe le jour où une
//  commande restreinte répond à quelqu'un qui n'aurait pas dû pouvoir la lancer.
//  Le bootstrap se contente donc de fournir ce que la règle demande — le membre
//  NORMALISÉ et les rôles du serveur — et de traduire son refus en éphémère.
// ═══════════════════════════════════════════════════════════════

/**
 * Câble le bot sur la plateforme active et rend l'ADAPTATEUR, pas le client.
 *
 * C'est le point de bascule du chantier multiplateforme : tout ce qui vit
 * au-dessus de `bot/platform/` ne connaît plus que le contrat neutre. Le client
 * natif reste accessible par `plateforme.client` tant que `api/` et le
 * dashboard le consomment directement (lot 7).
 *
 * @param {{plateforme?: object}} [options] plateforme injectable pour les tests
 * @returns {object} adaptateur de plateforme (cf. bot/platform/index.js)
 */
function createBot({ plateforme = null } = {}) {
    const platform = plateforme || resolvePlatform();
    const client = platform.client;

    // Registre d'exécution des commandes, indexé par nom. Une simple Map : rien
    // ici n'a besoin des méthodes supplémentaires d'une Collection discord.js.
    client.commands = new Map();

    // Chargement des commandes par le registre de la plateforme. Il accepte les
    // DEUX formats pendant la migration — descripteur neutre (/ping, /autorole)
    // et module discord.js historique (les 27 autres) — et rend dans les deux
    // cas la même entrée { nom, data, execute, autocomplete }.
    const entrees = platform.chargerCommandes({
        dossier: path.join(__dirname, 'commands'),
        exclus: DISABLED_COMMAND_FILES,
    });

    // Le jeu COMPLET, y compris les entrées sans handler : ce sont deux
    // questions distinctes, et les confondre retirerait du déploiement une
    // commande simplement pas exécutable.
    client.commandEntries = entrees;

    for (const entree of entrees) {
        // Une entrée sans handler est déployable mais pas exécutable : c'était
        // déjà la règle des deux chargeurs d'origine, on ne l'enregistre pas.
        if (typeof entree.execute !== 'function') continue;
        client.commands.set(entree.nom, entree);
        console.log(`[Quasar] Commande chargée: /${entree.nom}`);
    }

    // Panneaux persistants déclarés par les commandes. Ils sont enregistrés par
    // le chargeur lui-même ; la ligne de journal est là pour le diagnostic le
    // plus probable — « mon panneau n'est pas routé » se règle en regardant
    // d'abord s'il a seulement été déclaré.
    for (const entree of entrees) {
        for (const panneau of entree.panneaux || []) {
            console.log(`[Quasar] Panneau enregistré: ${panneau} (/${entree.nom})`);
        }
    }

    // Charger les events
    //
    // La promesse rendue par event.execute était flottante, et six fichiers
    // d'events n'ont aucun try : une exception y remontait donc soit en rejet non
    // capté, soit — pour un throw synchrone — jusqu'à l'EventEmitter, sans jamais
    // dire de QUEL event elle venait. Le scénario réel : une ligne modules.config
    // corrompue fait lever le JSON.parse de bot/utils/logger.js, donc sendLog,
    // donc guildMemberAdd rejette AVANT le message de bienvenue et les autorôles.
    // L'administrateur constate « les autorôles ne marchent plus », sans aucun
    // lien visible avec la cause.
    //
    // Le branchement passe désormais par le chargeur de la plateforme, qui
    // accepte les DEUX formats — descripteur neutre `{ nom, executer }` et
    // handler discord.js historique `{ name, execute }`. Sans lui, un handler
    // migré serait abonné à `client.on('roleCree')`, un événement que discord.js
    // n'émet jamais : pas d'erreur, pas de journal, la fonctionnalité disparaît.
    // Le filet d'incident, lui, reste ici : c'est la politique du bootstrap, pas
    // celle de la couche d'abstraction.
    const { newIncidentCode, alertIncident } = require('../api/services/incidents');

    const signalerIncidentEvent = (err, { evenement }) => {
        const code = newIncidentCode();
        console.error(
            `[Quasar] ⚠️  INCIDENT ${code} | event ${evenement} | ` +
            `${err?.name || 'Error'}: ${err?.message || err}`,
        );
        console.error(err?.stack || err);
        alertIncident(err, {
            code,
            source: `event ${evenement}`,
            details: { Event: evenement },
        });
    };

    const evenements = platform.chargerEvenements({
        dossier: path.join(__dirname, 'events'),
        surErreur: signalerIncidentEvent,
    });

    // Panneaux persistants sans commande — ceux des modules configurés depuis le
    // dashboard, comme l'arbitrage des sanctions. Chargés APRÈS les commandes :
    // une collision de nom doit désigner la déclaration qui arrive, pas celle
    // qui était déjà là.
    const panneauxAutonomes = platform.chargerPanneaux({
        dossier: path.join(__dirname, 'panneaux'),
        surErreur: (err, { panneau }) => signalerIncidentEvent(err, { evenement: `panneau ${panneau}` }),
    });
    for (const panneau of panneauxAutonomes) {
        console.log(
            panneau.enregistre
                ? `[Quasar] Panneau enregistré: ${panneau.nom} (module)`
                : `[Quasar] Panneau ignoré: ${panneau.nom} — capacité absente sur ${platform.nom}.`
        );
    }

    for (const evenement of evenements) {
        // Un handler écarté faute de capacité doit se VOIR : c'est normal côté
        // Fluxer (pas d'AutoMod), et ce serait un défaut côté Discord.
        console.log(
            evenement.branche
                ? `[Quasar] Event chargé: ${evenement.nom}`
                : `[Quasar] Event ignoré: ${evenement.nom} — capacité absente sur ${platform.nom}.`
        );
    }

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

        // Composants et formulaires : boutons, menus, modals.
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

            // SEULE voie de routage d'un clic : le registre de panneaux de la
            // plateforme. Le routage par préfixes écrits en dur (`tv_`,
            // `ticket_`, `defer_`, `signaler_`, `mesdonnees_`) a été retiré à la
            // consolidation, avec les deux modules qui n'existaient que pour
            // lui (`bot/interactions/{ticket,defer}.js`) — il était la dernière
            // connaissance de composants Discord dans ce fichier, et il doublait
            // un routage que la couche fait déjà.
            //
            // Rien ne revendique ce customId ? Deux cas, aucun à traiter ici :
            //   • il appartient à un COLLECTEUR (`qprompt:`, `qchoose:`,
            //     `qmembre:`), qui l'attend de son côté ;
            //   • il vient d'un panneau posé par une version ANTÉRIEURE de
            //     Quasar (`ticket_open`, `tv_lock`…). Discord affichera
            //     « L'interaction a échoué » : c'est le point de la note de
            //     version, qui demande de relancer `/ticket setup`. La ligne de
            //     journal ci-dessus reste, elle, le seul indice nécessaire pour
            //     rattacher un signalement à sa cause.
            const routage = platform.routerPanneau(interaction);
            if (routage) {
                try { await routage; } catch (e) {
                    reportIncident(interaction, e, { command: `panneau ${interaction.customId}` });
                }
            }
            return;
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
                    // Contexte NEUTRE, y compris ici : une commande
                    // personnalisée n'a pas de descripteur — elle est définie en
                    // base, serveur par serveur — mais elle répond par la même
                    // voie que les autres. C'était le dernier endroit du bot à
                    // construire un corps de message Discord à la main, et le
                    // dernier appelant de `buildDiscordEmbed`.
                    //
                    // Construit AVANT le contrôle d'accès, et ce n'est pas un
                    // relâchement : créer un contexte n'écrit rien nulle part,
                    // et c'est lui qui porte le membre normalisé que la règle
                    // d'accès attend. Un refus reste éphémère, et rien n'est
                    // jamais posté dans le salon.
                    const ctx = platform.contexteCommandePersonnalisee(interaction, interaction.commandName);

                    // Règle partagée avec le parseur de l'autre plateforme. Les
                    // rôles du serveur ne servent qu'à distinguer « rôle
                    // supprimé » de « rôle que vous n'avez pas » : omis, le
                    // contrôle d'existence est simplement sauté.
                    const refus = platform.verifierAccesCommandePersonnalisee(customCmd, ctx.membre, {
                        roles: interaction.guild?.roles?.cache || null,
                    });
                    if (refus) return userError(interaction, refus);

                    if (customCmd.embed_id) {
                        const embedRow = db.prepare(
                            'SELECT data, mention_roles, mention_users, mention_everyone, mention_here FROM embeds WHERE id = ?'
                        ).get(customCmd.embed_id);
                        if (embedRow) {
                            const { construireEmbedEnregistre } = require('./commands/embed');
                            // Mentions de l'embed appliquées à l'identique de
                            // `/embed send` et des rappels programmés : même helper,
                            // même payload à configuration égale. C'est le contrôle
                            // d'accès ci-dessus qui protège de l'abus.
                            const { content, allowedMentions } = buildMentionPayload(embedRow);
                            return ctx.repondre({
                                // `undefined` et non `''` : une clé `contenu`
                                // vide produirait un `content: ""` que le corps
                                // d'origine n'envoyait pas.
                                contenu: content || undefined,
                                embeds: [construireEmbedEnregistre(JSON.parse(embedRow.data))],
                                mentionsAutorisees: allowedMentions,
                            });
                        }
                    }
                    if (customCmd.response) {
                        // Réponse texte : volontairement SANS mentions autorisées, à
                        // l'inverse du chemin embed juste au-dessus. Ce qui est
                        // écrit dans la réponse doit pinger normalement (@everyone,
                        // rôles, membres) — c'est le comportement d'origine, et le
                        // contrôle d'accès ci-dessus limite déjà qui peut déclencher
                        // la commande.
                        // Les deux chemins divergent délibérément : l'embed rejoue
                        // strictement les mentions cochées sur lui (parse: [] + listes
                        // explicites), le texte laisse Discord analyser son contenu.
                        // Ne pas les « harmoniser ».
                        return ctx.repondre(customCmd.response);
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

            // Log commande utilisée. Portée d'écriture NEUTRE et embed neutre :
            // c'était le dernier embed brut du fichier, et la dernière écriture
            // qui passait par le cache de salons de discord.js.
            const { sendLog } = require('./utils/logger');
            const { embed } = require('./platform/embed');
            sendLog({ guildeId: interaction.guild?.id, api: platform.api }, 'quasar_command', embed({
                titre: '⚡ Commande utilisée',
                couleur: 0xc8a86e,
                champs: [
                    { nom: 'Commande', valeur: `\`/${interaction.commandName}\``, enLigne: true },
                    { nom: 'Par', valeur: `<@${interaction.user?.id}>`, enLigne: true },
                    { nom: 'Channel', valeur: `<#${interaction.channel?.id}>`, enLigne: true },
                ],
                horodatage: true,
            })).catch(() => {});
        } catch (error) {
            reportIncident(interaction, error, {
                command: `/${interaction.commandName}${sub ? ' ' + sub : ''}`,
            });
        }
    });

    // Le handler est asynchrone : sans ce .catch, un rejet partirait dans le filet
    // global du processus, qui journalise et LAISSE VIVRE. Le bot resterait donc en
    // ligne sans aucun de ses balayages : aucun rappel programmé, aucun bannissement
    // temporaire levé (un tempban devient définitif), aucun mode panique levé (un
    // serveur reste fermé indéfiniment), aucune purge de rétention. Et rien ne le
    // signalerait.
    client.once('clientReady', () => {
        demarrerServices(client, platform).catch((err) => {
            console.error('[Quasar] ❌ Échec du démarrage des services :', err?.message || err);
            console.error(err?.stack || err);
            process.exit(1);
        });
    });

    return platform;
}

/**
 * @param {object} client   client natif de la plateforme
 * @param {object} [platform] adaptateur. Facultatif : les tests appellent cette
 *   fonction avec un client factice pour contrôler le garde de base de données,
 *   et le déploiement retombe alors sur `deployCommands`.
 */
async function demarrerServices(client, platform = null) {
    console.log(`[Quasar] Connecté en tant que ${client.user.tag}`);
    console.log(`[Quasar] Présent sur ${client.guilds.cache.size} serveur(s)`);

    // Aucune télémétrie. Le heartbeat vers un hub central (identifiant d'instance
    // persistant + nombre de serveurs) a été retiré en v3.3.0 : Quasar ne contacte
    // aucun service tiers, rien ne sort de la machine qui l'héberge.

    // Ouverture de la base et enregistrement des serveurs.
    //
    // Erreur FATALE et explicite, volontairement : un bot sans base n'a rien à
    // faire en ligne. getDb() échoue pour une raison très concrète et déjà
    // rencontrée — un volume monté appartenant à root après un redéploiement —
    // et l'échec passait jusqu'ici dans le filet global, qui laissait le
    // processus continuer. Le bot répondait alors aux commandes tout en ayant
    // perdu ses balayages, sans que rien ne l'indique.
    let db;
    try {
        db = getDb();
        const upsert = db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)');
        client.guilds.cache.forEach(guild => {
            upsert.run(guild.id, guild.name);
        });
    } catch (err) {
        console.error('[Quasar] ❌ Base de données inaccessible au démarrage :', err?.message || err);
        console.error('[Quasar]    Vérifiez les droits du dossier data/ (en conteneur, le volume peut appartenir à root).');
        throw err;
    }

    // Déploiement des commandes slash. Un échec ici n'est PAS fatal : les
    // commandes déjà déployées sur Discord restent utilisables, et le bot rend
    // encore tous ses autres services. Il doit en revanche se voir.
    try {
        // `commandEntries` évite de relire bot/commands/ et de reconstruire les
        // builders : ils viennent d'être produits par le chargeur. Absent (client
        // factice des tests), `deployCommands` relit le dossier comme avant.
        if (platform) await platform.enregistrerCommandes(client.commandEntries || null);
        else await deployCommands(client);
    } catch (err) {
        console.error('[Quasar] ⚠️  Déploiement des commandes slash impossible :', err?.message || err);
        console.error('[Quasar]    Les commandes déjà enregistrées sur Discord restent utilisables.');
    }

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
    //
    // Passe par le client REST normalisé : `obtenirCanal` rend `null` quand le
    // salon n'existe plus, et `listerMembresVocal` rend la liste des personnes
    // connectées — les deux questions que `guild.channels.cache` et
    // `channel.members.size` posaient au cache de discord.js.
    //
    // ⚠️ `listerMembresVocal` peut rendre `null` (salon illisible, connexion
    // incomplète) : on ne supprime PAS dans ce cas. « Je ne sais pas qui est
    // dedans » et « il est vide » sont deux réponses différentes, et les
    // confondre fermerait un salon occupé au redémarrage.
    try {
        // Sans adaptateur (tests du garde de base de données), il n'y a pas de
        // client REST : on ne touche à rien plutôt que de supprimer des lignes
        // sur la foi d'une lecture qu'on n'a pas faite.
        const tvActive = platform ? db.prepare('SELECT * FROM tempvoice_active').all() : [];
        let cleaned = 0;
        for (const row of tvActive) {
            const canal = await platform.api.obtenirCanal(row.channel_id).catch(() => undefined);
            // `undefined` = lecture en échec : on laisse la ligne pour le
            // prochain démarrage plutôt que d'oublier un salon bien vivant.
            if (canal === undefined) continue;

            let occupants = null;
            if (canal) {
                occupants = await platform.api.listerMembresVocal(row.channel_id).catch(() => null);
                if (occupants === null || occupants.length > 0) continue;
            }

            if (canal) await platform.api.supprimerCanal(row.channel_id, 'Salon temporaire vide au démarrage').catch(() => {});
            db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(row.channel_id);
            cleaned++;
        }
        if (cleaned > 0) console.log(`[Quasar] TempVoice boot cleanup: ${cleaned} salon(s) orphelin(s) supprimé(s)`);
    } catch (e) {
        // Tables pas encore créées au premier boot, on ignore
    }

    // Scheduler — Démarrer la boucle d'envoi des rappels programmés
    try {
        // L'ADAPTATEUR, pas le client : le planificateur poste par le client
        // REST normalisé, et son garde « connexion incomplète » lit l'identité
        // du bot. `platform` peut être nulle (tests du garde de base de
        // données) : on ne démarre alors aucun balayage, plutôt que de passer un
        // client que plus rien ne sait lire.
        if (platform) require('./modules/scheduler').start(platform);
    } catch (e) {
        console.error('[Quasar] Erreur démarrage scheduler:', e.message || e);
    }

    // Rétention — Purge des serveurs quittés et des sanctions expirées
    try {
        // L'ADAPTATEUR : ce module SUPPRIME des données, et il lui faut la
        // distinction que le cache de discord.js ne savait pas exprimer —
        // `listerGuildes()` rend `null` quand la connexion n'est pas établie,
        // `[]` quand le bot n'est réellement sur aucun serveur.
        if (platform) require('./modules/retention').start(platform);
    } catch (e) {
        console.error('[Quasar] Erreur démarrage rétention:', e.message || e);
    }

    // Notification de violation (art. 33) — Boucle qui dépile et envoie les
    // notifications enfilées depuis le dashboard owner.
    try {
        // L'ADAPTATEUR : les envois passent par `ouvrirMessagePrive` +
        // `envoyerMessage`, et le garde « connexion incomplète » lit l'identité
        // du bot plutôt que le cache de serveurs.
        if (platform) require('./modules/breach').start(platform);
    } catch (e) {
        console.error('[Quasar] Erreur demarrage notification de violation:', e.message || e);
    }

    // Effacement (art. 17) — Boucle de suivi des demandes de suppression
    // (échéances légales, alertes owner).
    try {
        // L'ADAPTATEUR : la relance part en message privé par `ouvrirMessagePrive`
        // puis `envoyerMessage`, et non plus par `client.users.fetch()`.
        if (platform) require('./modules/erasure').start(platform);
    } catch (e) {
        console.error('[Quasar] Erreur demarrage effacement:', e.message || e);
    }

    // Modération automatique — Levée des bannissements temporaires arrivés à
    // terme. Discord n'a pas de ban à durée : sans ce balayage, un `tempban`
    // serait un ban définitif. La boucle ne fait rien tant qu'aucune échéance
    // n'est en base (un SELECT indexé par minute).
    try {
        // L'ADAPTATEUR, pas le client : le balayeur emprunte la voie neutre
        // (client REST normalisé, codes d'erreur neutres) et distingue « bot
        // retiré du serveur » d'une panne réseau — la confusion qui
        // transformerait un bannissement temporaire en bannissement définitif.
        if (platform) require('./utils/punishments').startTempBanSweeper(platform);
    } catch (e) {
        console.error('[Quasar] Erreur demarrage bannissements temporaires:', e.message || e);
    }

    // Anti-raid — Levée des modes panique arrivés a terme. Meme raison que
    // ci-dessus, en plus critique : un mode panique pose puis oublie parce que
    // le processus a redemarre laisserait un serveur ferme indefiniment. Le
    // balayage relit l'echeance en base et rend au serveur son etat d'origine.
    try {
        // L'ADAPTATEUR, comme pour les bannissements temporaires : `listerGuildes`
        // distingue « pas encore connecté » (null) de « sur aucun serveur » ([]),
        // ce que le cache de discord.js ne sait pas exprimer — et c'est cette
        // distinction qui évite de laisser un serveur fermé indéfiniment.
        if (platform) require('./modules/antiraid').startPanicSweeper(platform);
    } catch (e) {
        console.error('[Quasar] Erreur demarrage anti-raid:', e.message || e);
    }
}

module.exports = { createBot, demarrerServices };
