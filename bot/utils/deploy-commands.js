const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { DISABLED_COMMAND_FILES } = require('./disabledCommands');
const { getDb } = require('../../api/services/database');
const {
    CHAT_INPUT_TYPE,
    CHAT_INPUT_COMMAND_CHARACTERS_MAX,
    GUILD_CHAT_INPUT_COMMANDS_MAX,
    countChatInputCommands,
    commandCharacterCost,
    validateChatInputName,
    buildCustomCommandDescription,
} = require('./slashCommandSpec');

// Une guild saturée peut produire des centaines de rejets. Les détailler tous
// noierait le démarrage : on nomme les premiers, on résume le reste.
const MAX_REJETS_DETAILLES = 10;

// Part du budget de caractères d'une commande au-delà de laquelle on alerte.
// Marge délibérément large : le but est de prévenir pendant qu'il reste de la
// place, pas de constater la panne.
const SEUIL_ALERTE_TAILLE_COMMANDE = 0.75;

// ═══════════════════════════════════════════════════════════════
//  ⚠ Le PUT applicationGuildCommands REMPLACE tout le jeu de commandes de la
//  guild : ce qui n'est pas dans le corps envoyé disparaît de Discord.
//
//  Les commandes personnalisées vivent en base (table `custom_commands`) et
//  n'étaient déployées qu'à leur création, par un POST unitaire. Elles étaient
//  donc effacées de Discord à CHAQUE redémarrage du bot, tout en restant
//  visibles dans le dashboard et dans `/cmd list` — d'où un bug très
//  déroutant à diagnostiquer.
//
//  Toute commande qui doit exister sur une guild doit donc figurer dans le
//  corps envoyé à cette guild. Ne jamais retirer les commandes personnalisées
//  de ce corps.
// ═══════════════════════════════════════════════════════════════

/** Charge les commandes issues des fichiers de bot/commands/ (communes à toutes les guilds). */
function loadFileCommands() {
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

    return commands;
}

/**
 * Commandes personnalisées de toutes les guilds, groupées par guild_id.
 *
 * Une seule lecture pour l'ensemble du déploiement : interroger la base dans la
 * boucle des guilds n'apporterait rien et multiplierait les points de panne.
 * En cas d'échec SQL on renvoie une table vide plutôt que de propager l'erreur :
 * perdre les commandes personnalisées est regrettable, ne plus déployer AUCUNE
 * commande serait bien pire.
 *
 * `ORDER BY rowid` n'est pas cosmétique : il fixe l'ordre de création. Sans lui
 * SQLite rend les lignes dans l'ordre de l'index de clé primaire, donc par
 * (guild_id, name) — un ordre alphabétique qui déciderait, au moment du plafond,
 * quelles commandes sont déployées. `custom_commands` est bien une table rowid
 * (pas de WITHOUT ROWID, clé primaire composite en TEXT), le rowid y est donc
 * disponible et croît avec les insertions.
 */
function loadCustomCommandsByGuild() {
    const parGuild = new Map();

    try {
        const rows = getDb().prepare('SELECT guild_id, name, response FROM custom_commands ORDER BY rowid').all();
        for (const row of rows) {
            if (!parGuild.has(row.guild_id)) parGuild.set(row.guild_id, []);
            parGuild.get(row.guild_id).push(row);
        }
    } catch (error) {
        console.error('[Quasar] Lecture des commandes personnalisées impossible, déploiement des commandes de fichiers seules :', error.message);
    }

    return parGuild;
}

/**
 * Corps du PUT pour une guild : les commandes de fichiers, plus les commandes
 * personnalisées de CETTE guild jugées conformes.
 *
 * Retourne aussi les entrées écartées et leur motif, pour que les journaux
 * disent précisément ce qui n'a pas été déployé et pourquoi.
 *
 * `customRows` doit arriver dans l'ordre de création (cf. loadCustomCommandsByGuild) :
 * c'est lui qui départage les commandes lorsque le plafond de Discord est atteint.
 */
function buildGuildCommands(fileCommands, customRows) {
    const body = [...fileCommands];
    const rejets = [];

    // En cas de collision, la commande de fichier gagne : une commande
    // personnalisée ne peut pas masquer `/ping` ou `/help`. Discord refuserait
    // de toute façon un lot contenant deux fois le même nom.
    const nomsDeQuasar = new Set(fileCommands.map(cmd => cmd.name));
    // Les doublons entre commandes personnalisées sont normalement exclus par la
    // clé primaire (guild_id, name), mais une écriture directe en base pourrait
    // les réintroduire : on ne laisse pas cette possibilité faire tomber le lot.
    const nomsDejaAjoutes = new Set();

    // Discord plafonne les commandes CHAT_INPUT par guild. Au-delà, il rejette le
    // lot ENTIER — la guild resterait alors figée sur son jeu précédent, sans
    // qu'aucune mise à jour ne passe plus jamais, et en silence pour l'admin.
    // Les commandes de fichiers sont donc servies en premier et prennent leur
    // place d'office : ce sont elles qui font fonctionner le bot. Les
    // personnalisées se partagent le reste dans leur ordre de création, ce qui
    // garantit qu'un redémarrage écarte exactement les mêmes que le précédent :
    // un arbitrage qui changerait d'un boot à l'autre serait indiagnosticable.
    // Les plus anciennes gagnent — elles sont déjà en usage, alors qu'une
    // commande récente jamais déployée ne manque encore à personne.
    let placesRestantes = GUILD_CHAT_INPUT_COMMANDS_MAX - countChatInputCommands(fileCommands);

    for (const row of customRows) {
        const validation = validateChatInputName(row.name);
        if (!validation.valid) {
            rejets.push({ name: row.name, reason: validation.reason });
            continue;
        }
        if (nomsDeQuasar.has(row.name)) {
            rejets.push({ name: row.name, reason: 'nom déjà utilisé par une commande de Quasar' });
            continue;
        }
        if (nomsDejaAjoutes.has(row.name)) {
            rejets.push({ name: row.name, reason: 'doublon : une commande personnalisée de ce nom est déjà dans le lot' });
            continue;
        }
        // Testé après les autres motifs : une commande écartée n'est pas déployée,
        // elle n'a donc aucune raison de consommer une place.
        if (placesRestantes <= 0) {
            rejets.push({
                name: row.name,
                reason: `plafond de ${GUILD_CHAT_INPUT_COMMANDS_MAX} commandes par serveur atteint : supprime des commandes personnalisées pour que celle-ci soit déployée`,
            });
            continue;
        }

        nomsDejaAjoutes.add(row.name);
        placesRestantes--;
        body.push({
            name: row.name,
            description: buildCustomCommandDescription(row),
            type: CHAT_INPUT_TYPE,
        });
    }

    return { body, rejets };
}

/** Nomme les premiers rejets puis résume le reste, pour ne pas noyer le démarrage. */
function journaliserRejets(rejets, guildName) {
    for (const rejet of rejets.slice(0, MAX_REJETS_DETAILLES)) {
        console.warn(`[Quasar] Commande personnalisée « ${rejet.name} » non déployée sur ${guildName} : ${rejet.reason}`);
    }
    const restants = rejets.length - MAX_REJETS_DETAILLES;
    if (restants > 0) {
        console.warn(`[Quasar] … et ${restants} autre(s) commande(s) personnalisée(s) non déployée(s) sur ${guildName}.`);
    }
}

/**
 * Alerte si une commande de fichier approche du plafond de caractères qui lui
 * est propre. Ces commandes ne sont jamais écartées — elles sont le bot — mais
 * l'une d'elles dépassant 8000 ferait refuser le lot ENTIER par Discord, et donc
 * un serveur sans aucune commande. C'est un défaut de développement, pas une
 * donnée d'administrateur : il doit se voir au démarrage, pas en production.
 */
function auditFileCommandSizes(fileCommands) {
    const seuil = CHAT_INPUT_COMMAND_CHARACTERS_MAX * SEUIL_ALERTE_TAILLE_COMMANDE;

    for (const commande of fileCommands) {
        const cout = commandCharacterCost(commande);
        if (cout < seuil) continue;

        const verdict = cout > CHAT_INPUT_COMMAND_CHARACTERS_MAX
            ? 'Discord refusera le lot entier'
            : 'proche du plafond';
        console.warn(`[Quasar] ⚠ La commande /${commande.name} pèse ${cout}/${CHAT_INPUT_COMMAND_CHARACTERS_MAX} caractères (${verdict}) : raccourcis ses descriptions, ses options ou ses choix.`);
    }
}

async function deployCommands(client) {
    let fileCommands;
    try {
        fileCommands = loadFileCommands();
    } catch (error) {
        console.error('[Quasar] Erreur chargement des commandes de fichiers:', error);
        return;
    }

    const customParGuild = loadCustomCommandsByGuild();
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    auditFileCommandSizes(fileCommands);

    const placesParServeur = GUILD_CHAT_INPUT_COMMANDS_MAX - countChatInputCommands(fileCommands);
    console.log(`[Quasar] Déploiement des commandes slash : ${fileCommands.length} commande(s) de Quasar, ${placesParServeur} place(s) disponible(s) par serveur pour les commandes personnalisées (plafond Discord : ${GUILD_CHAT_INPUT_COMMANDS_MAX} par serveur).`);

    // Déployer par guild (instantané) plutôt que global (jusqu'à 1h de délai).
    // Chaque guild a son propre corps : les commandes personnalisées sont
    // propres à un guild_id, il n'y a pas de lot commun à partager.
    for (const guild of client.guilds.cache.values()) {
        const customRows = customParGuild.get(guild.id) || [];
        const { body, rejets } = buildGuildCommands(fileCommands, customRows);

        journaliserRejets(rejets, guild.name);

        try {
            await rest.put(
                Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guild.id),
                { body }
            );
            const nbCustom = body.length - fileCommands.length;
            console.log(`[Quasar] Commandes déployées sur ${guild.name} : ${fileCommands.length} de Quasar + ${nbCustom} personnalisée(s)${rejets.length ? `, ${rejets.length} écartée(s)` : ''}`);
        } catch (error) {
            // Échec isolé : les autres serveurs doivent quand même être servis.
            console.error(`[Quasar] Erreur déploiement des commandes sur ${guild.name}:`, error);
        }
    }

    console.log('[Quasar] Commandes slash déployées ✓');
}

module.exports = { deployCommands };
