const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getDb, CUSTOM_CMD_ACCESS_MODES, effectiveAccessMode } = require('../../api/services/database');
const { hasMentions, silentMentions } = require('../../api/services/mentions');
const { userError } = require('../utils/errors');
const { DISABLED_COMMAND_FILES } = require('../utils/disabledCommands');
const { validateChatInputName, buildCustomCommandDescription } = require('../utils/slashCommandSpec');

// Une commande custom rejoue désormais les mentions de l'embed qu'elle affiche,
// exactement comme `/embed send` et les rappels programmés : une mention
// configurée sur un embed est appliquée partout où cet embed est envoyé, sans
// exception cachée. Ce qui protège de l'abus n'est plus le fait d'ignorer les
// mentions, mais le contrôle d'accès de la commande (access_mode) : tout le
// monde, les administrateurs, ou un rôle précis.
const ACCES_CHOIX = [
    { name: 'Tout le monde', value: 'everyone' },
    { name: 'Administrateurs uniquement', value: 'admins' },
    { name: 'Un rôle précis', value: 'role' },
];

// Libellé lisible d'un mode d'accès lu en base, pour les récapitulatifs et
// `/cmd list`. Passe par effectiveAccessMode pour annoncer le mode que le bot
// applique réellement, pas la valeur brute de la colonne.
function decrireAcces(storedMode, roleId) {
    const mode = effectiveAccessMode(storedMode);
    if (mode === 'admins') return '🛡️ Administrateurs';
    // Les administrateurs passent quel que soit le mode (voir bot/index.js) :
    // annoncer « Rôle X » seul serait faux, et laisserait croire à un blocage
    // quand un admin sans le rôle lance malgré tout la commande.
    if (mode === 'role') return roleId ? `🎭 Rôle <@&${roleId}> (ou administrateur)` : '🎭 Rôle supprimé (administrateurs uniquement)';
    return '🌍 Tout le monde';
}

// ═══════════════════════════════════════════════════════════════
//  Noyau partagé des commandes personnalisées
//
//  `/cmd` et la route du dashboard (api/routes/customcmds.js) écrivent dans la
//  même table et déploient sur le même Discord. Tout ce qui décide « ce nom
//  est-il acceptable » et « comment on renomme sans rien perdre » vit donc ici,
//  en un seul exemplaire : deux copies finiraient par diverger, et un nom refusé
//  d'un côté mais accepté de l'autre est exactement le genre d'incohérence qui
//  fait tomber le lot entier au redéploiement (cf. bot/utils/deploy-commands.js).
// ═══════════════════════════════════════════════════════════════

// Normalisation d'un nom saisi. STRICTEMENT identique à celle appliquée à la
// création par `/cmd create` et par la route POST du dashboard : espaces de
// bordure retirés, minuscules, suites d'espaces internes remplacées par un
// tiret. Le `trim()` compte : sans lui, « aide » saisi avec un espace parasite
// donnait `-aide-`, un nom valide pour Discord — donc accepté en silence.
function normalizeCustomCommandName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

// Colonnes de `custom_commands` qu'une modification est autorisée à écrire.
// Liste blanche : `updateCustomCommand()` compose son UPDATE à partir des clés
// reçues, et rien d'autre que ces colonnes ne doit pouvoir s'y retrouver.
// `name` en est volontairement absent — un renommage passe par `newName`, qui
// contrôle les collisions.
const UPDATABLE_COLUMNS = ['response', 'embed_id', 'access_mode', 'access_role_id'];

// Noms déjà pris par les commandes de Quasar. Calculé une fois : les fichiers de
// bot/commands/ ne changent pas en cours d'exécution.
let _reservedNames = null;

/**
 * Noms des commandes livrées par Quasar (fichiers de bot/commands/).
 *
 * Lu depuis les fichiers, jamais codé en dur : une liste recopiée oublierait la
 * prochaine commande ajoutée, et une commande personnalisée homonyme serait
 * inerte (bot/index.js résout d'abord ses propres commandes) puis écartée au
 * redémarrage par deploy-commands.js. Mêmes règles de lecture que
 * `loadFileCommands()` : fichiers désactivés ignorés — ils ne sont pas déployés,
 * ils ne réservent donc pas leur nom — et prise en charge des fichiers à
 * exports multiples (ex : musiccontrols.js).
 *
 * Un fichier illisible n'interrompt pas le calcul : perdre une entrée de la
 * liste ne coûte au pire qu'une commande personnalisée inerte, alors qu'une
 * exception ici bloquerait tout renommage.
 */
function reservedCommandNames() {
    if (_reservedNames) return _reservedNames;

    const noms = new Set();
    for (const fichier of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !DISABLED_COMMAND_FILES.includes(f))) {
        try {
            const mod = require(path.join(__dirname, fichier));
            if (mod?.data?.name) {
                noms.add(mod.data.name);
                continue;
            }
            for (const valeur of Object.values(mod || {})) {
                if (valeur?.data?.name) noms.add(valeur.data.name);
            }
        } catch (e) {
            console.warn(`[Quasar] Noms réservés : fichier ${fichier} illisible (${e.message}), ignoré.`);
        }
    }

    _reservedNames = noms;
    return noms;
}

/**
 * Valide un nouveau nom de commande personnalisée, AVANT toute écriture.
 *
 * @returns {{name:string, unchanged:boolean}|{error:{cause:string, action:string}}}
 *          `unchanged` = le nom normalisé est déjà celui de la commande : ce
 *          n'est pas une erreur, il n'y a simplement rien à renommer.
 */
function validateCustomCommandRename(db, guildId, currentName, rawNewName) {
    const nom = normalizeCustomCommandName(rawNewName);

    if (!nom) {
        return { error: {
            cause: 'Le nouveau nom de la commande est vide.',
            action: 'Saisissez un nom entre 1 et 32 caractères, en minuscules et sans espace.',
        } };
    }

    // Renommer vers le nom actuel n'est pas une erreur — et on sort AVANT les
    // contrôles suivants : la commande se trouverait elle-même en « collision »,
    // et une ligne héritée au nom aujourd'hui non conforme deviendrait
    // impossible à modifier alors que l'utilisateur ne la renomme même pas.
    if (nom === currentName) return { name: nom, unchanged: true };

    const validation = validateChatInputName(nom);
    if (!validation.valid) {
        // La raison est rédigée dans slashCommandSpec pour être affichée telle
        // quelle : on ne la reformule pas, sinon les deux textes divergeraient.
        return { error: {
            cause: `Discord refuse ce nom de commande : ${validation.reason}.`,
            action: 'Choisissez un nom de 1 à 32 caractères, en minuscules, sans espace ni apostrophe (les tirets et underscores sont acceptés).',
        } };
    }

    if (reservedCommandNames().has(nom)) {
        return { error: {
            cause: `/${nom} est déjà une commande de Quasar.`,
            action: 'Choisissez un autre nom : une commande personnalisée portant ce nom ne répondrait jamais, et elle disparaîtrait au prochain redémarrage du bot.',
        } };
    }

    const collision = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(guildId, nom);
    if (collision) {
        return { error: {
            cause: `Une commande personnalisée /${nom} existe déjà sur ce serveur.`,
            action: 'Choisissez un autre nom, ou supprimez d\'abord la commande existante.',
        } };
    }

    return { name: nom, unchanged: false };
}

/**
 * Erreur métier transportée à travers la transaction (voir updateCustomCommand).
 * `code` permet à l'appelant de choisir sa réponse (404 / 400 côté API) sans
 * avoir à reconnaître le message à la ficelle.
 */
function erreurMetier(code, cause, action) {
    const e = new Error(cause);
    e.metier = { code, cause, action };
    return e;
}

/**
 * Écrit une modification de commande personnalisée : contenu/accès et/ou
 * nouveau nom, en UNE SEULE transaction.
 *
 * Le nom fait partie de la clé primaire (guild_id, name). Le renommage est donc
 * un UPDATE de cette colonne, et non un DELETE + INSERT : la ligne n'est jamais
 * détruite, donc `response`, `embed_id`, `access_mode`, `access_role_id` et les
 * colonnes héritées (`allowed_roles`, `allowed_channels`) sont conservées sans
 * avoir à les réécrire — une future colonne le sera aussi, gratuitement.
 *
 * La transaction sert à deux choses :
 *   1. lier le changement de contenu et le changement de nom — le dashboard
 *      envoie les deux en une requête, il serait absurde qu'un échec laisse la
 *      commande renommée mais avec l'ancien texte ;
 *   2. revérifier la collision au moment exact de l'écriture, pour qu'une
 *      création concurrente ne puisse jamais aboutir à un doublon ni à une
 *      ligne écrasée. En cas d'échec, SQLite annule tout : ni doublon, ni
 *      ligne perdue.
 *
 * @param {{fields?: object, newName?: string|null}} changes
 * @returns {{ok:true, name:string}|{error:{code:string, cause:string, action:string}}}
 *          codes d'erreur : 'INTROUVABLE' (la ligne n'existe plus) et
 *          'COLLISION' (le nom visé a été pris entre-temps).
 */
function updateCustomCommand(db, guildId, currentName, { fields = {}, newName = null } = {}) {
    const colonnes = Object.keys(fields);
    for (const colonne of colonnes) {
        // Garde-fou de programmation, pas de validation d'entrée utilisateur :
        // les clés viennent du code appelant, jamais du corps d'une requête.
        if (!UPDATABLE_COLUMNS.includes(colonne)) throw new Error(`Colonne non modifiable : ${colonne}`);
    }

    const renomme = !!newName && newName !== currentName;

    const appliquer = db.transaction(() => {
        const existe = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(guildId, currentName);
        if (!existe) {
            throw erreurMetier(
                'INTROUVABLE',
                `Aucune commande personnalisée /${currentName} n'existe sur ce serveur.`,
                'Vérifiez la liste des commandes : elle a peut-être été supprimée ou renommée entre-temps.'
            );
        }

        if (colonnes.length > 0) {
            db.prepare(`UPDATE custom_commands SET ${colonnes.map(c => `${c} = ?`).join(', ')} WHERE guild_id = ? AND name = ?`)
                .run(...colonnes.map(c => fields[c]), guildId, currentName);
        }

        if (renomme) {
            const collision = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(guildId, newName);
            if (collision) {
                throw erreurMetier(
                    'COLLISION',
                    `Une commande personnalisée /${newName} existe déjà sur ce serveur.`,
                    'Choisissez un autre nom, ou supprimez d\'abord la commande existante.'
                );
            }
            db.prepare('UPDATE custom_commands SET name = ? WHERE guild_id = ? AND name = ?')
                .run(newName, guildId, currentName);
        }
    });

    try {
        appliquer();
    } catch (e) {
        if (e.metier) return { error: e.metier };
        throw e;
    }

    return { ok: true, name: renomme ? newName : currentName };
}

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
            .addStringOption(opt => opt.setName('acces').setDescription('Qui peut utiliser la commande (par défaut : tout le monde)').setRequired(false).addChoices(...ACCES_CHOIX))
            .addRoleOption(opt => opt.setName('role').setDescription('Rôle autorisé (uniquement si accès = un rôle précis)').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('edit')
            .setDescription('Modifier une commande existante')
            .addStringOption(opt => opt.setName('nom').setDescription('Nom de la commande').setRequired(true))
            .addStringOption(opt => opt.setName('nouveau_nom').setDescription('Renommer la commande (sans /)').setRequired(false))
            .addStringOption(opt => opt.setName('reponse').setDescription('Nouveau texte').setRequired(false))
            .addStringOption(opt => opt.setName('embed').setDescription('Nouvel embed (nom)').setRequired(false))
            .addStringOption(opt => opt.setName('acces').setDescription('Qui peut utiliser la commande').setRequired(false).addChoices(...ACCES_CHOIX))
            .addRoleOption(opt => opt.setName('role').setDescription('Rôle autorisé (uniquement si accès = un rôle précis)').setRequired(false))
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
            const nom = normalizeCustomCommandName(interaction.options.getString('nom'));
            const reponse = interaction.options.getString('reponse');
            const embedNom = interaction.options.getString('embed');
            // Option propre à `/cmd edit` : à la création, il n'y a rien à renommer.
            const nouveauNom = sub === 'edit' ? interaction.options.getString('nouveau_nom') : null;

            // Un `/cmd edit` qui ne fait que renommer est légitime : il ne touche
            // ni au texte ni à l'embed, la commande garde son contenu.
            if (!reponse && !embedNom && !nouveauNom) {
                return userError(interaction, {
                    title: 'Commande sans contenu',
                    cause: 'Une commande personnalisée doit répondre quelque chose : un texte, ou un embed enregistré.',
                    action: sub === 'edit'
                        ? 'Renseignez `reponse`, `embed`, ou `nouveau_nom` si vous voulez seulement la renommer.'
                        : 'Renseignez le champ `reponse`, ou indiquez un embed existant avec `embed`.',
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
                        action: 'Créez-le d\'abord avec `/embed create`, ou consultez les embeds existants avec `/embed list`.',
                    });
                }
                embedId = embedRow.id;
                embedPing = hasMentions(embedRow);
            }

            // ─── Contrôle d'accès ───────────────────────────────────────────
            // Un rôle fourni sans `acces` explicite ne peut vouloir dire qu'une
            // chose : réserver la commande à ce rôle. On l'interprète ainsi
            // plutôt que d'ignorer silencieusement l'option.
            const accesOpt = interaction.options.getString('acces');
            const roleOpt = interaction.options.getRole('role');
            let accesMode = accesOpt || (roleOpt ? 'role' : null);

            if (accesMode && !CUSTOM_CMD_ACCESS_MODES.includes(accesMode)) {
                return userError(interaction, {
                    title: 'Mode d\'accès inconnu',
                    cause: `« ${accesMode} » n'est pas un mode d'accès valide.`,
                    action: 'Choisissez « Tout le monde », « Administrateurs uniquement » ou « Un rôle précis ».',
                });
            }
            if (accesMode === 'role' && !roleOpt) {
                return userError(interaction, {
                    title: 'Rôle manquant',
                    cause: 'Vous avez choisi de réserver la commande à un rôle, mais aucun rôle n\'a été indiqué.',
                    action: 'Relancez la commande en renseignant aussi l\'option `role`.',
                });
            }
            const accesRoleId = accesMode === 'role' ? roleOpt.id : null;

            // Rappel à l'admin : ping libre + accès libre = n'importe qui peut
            // déclencher la mention. On le signale sans l'empêcher, c'est un
            // choix légitime pour un embed qui ne ping qu'un petit rôle.
            const avertPing = (mode) => (embedPing && mode === 'everyone')
                ? '\n\n⚠️ Cet embed a des mentions configurées : elles seront envoyées à **chaque** utilisation, et la commande est ouverte à tout le monde. Restreins son accès avec l\'option `acces` si ce n\'est pas voulu.'
                : '';

            if (sub === 'create') {
                const existing = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(interaction.guild.id, nom);
                if (existing) {
                    return userError(interaction, {
                        title: 'Cette commande existe déjà',
                        cause: `Une commande personnalisée **/${nom}** est déjà enregistrée sur ce serveur.`,
                        action: 'Modifiez-la avec `/cmd edit`, ou choisissez un autre nom.',
                    });
                }

                // À la création, l'absence d'option `acces` vaut « tout le
                // monde » : c'est le défaut de la colonne et le comportement
                // historique des commandes personnalisées.
                const modeCree = accesMode || 'everyone';

                db.prepare('INSERT INTO custom_commands (guild_id, name, response, embed_id, access_mode, access_role_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(interaction.guild.id, nom, reponse || null, embedId, modeCree, accesRoleId);

                // Déployer la commande slash
                await deployCustomCommand(interaction.guild.id, nom, reponse);

                await interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle('✅ Commande créée')
                        .setColor(0xc86e8e)
                        .setDescription(`La commande \`/${nom}\` est disponible sur le serveur.${avertPing(modeCree)}`)
                        .addFields(
                            embedNom
                                ? { name: 'Réponse', value: `Embed: **${embedNom}**` }
                                : { name: 'Réponse', value: reponse },
                            { name: 'Accès', value: decrireAcces(modeCree, accesRoleId) }
                        )
                        .setTimestamp()],
                    ephemeral: true
                });

            } else {
                // ─── Renommage : tout valider AVANT la moindre écriture ───────
                let renommage = null;
                if (nouveauNom) {
                    const verdict = validateCustomCommandRename(db, interaction.guild.id, nom, nouveauNom);
                    if (verdict.error) return userError(interaction, {
                        title: 'Renommage impossible',
                        cause: verdict.error.cause,
                        action: verdict.error.action,
                    });
                    // `unchanged` : le nouveau nom est déjà le nom actuel, il n'y
                    // a rien à renommer — ce n'est pas une erreur pour autant.
                    if (!verdict.unchanged) renommage = verdict.name;
                }

                // Contenu : on ne l'écrit que si l'utilisateur en a fourni un.
                // Un `/cmd edit nom nouveau_nom:...` seul ne doit pas vider la
                // réponse ni délier l'embed de la commande.
                const fields = {};
                if (reponse || embedNom) {
                    fields.response = reponse || null;
                    fields.embed_id = embedId;
                }
                // À l'édition, ne pas toucher à l'accès si l'option n'est pas
                // fournie : modifier le texte d'une commande ne doit pas rouvrir
                // en grand une commande volontairement restreinte — et un simple
                // renommage encore moins.
                if (accesMode) {
                    fields.access_mode = accesMode;
                    fields.access_role_id = accesRoleId;
                }

                const ecriture = updateCustomCommand(db, interaction.guild.id, nom, { fields, newName: renommage });
                if (ecriture.error) return userError(interaction, {
                    title: renommage ? 'Renommage impossible' : 'Modification impossible',
                    cause: ecriture.error.cause,
                    action: ecriture.error.action,
                });

                const nomFinal = ecriture.name;

                // État réellement en base après coup : le mode qu'on vient
                // d'écrire, ou celui déjà configuré si l'option n'a pas été
                // fournie. La réponse sert aussi à construire la description
                // envoyée à Discord en cas de renommage.
                const apres = db.prepare('SELECT response, access_mode, access_role_id FROM custom_commands WHERE guild_id = ? AND name = ?')
                    .get(interaction.guild.id, nomFinal);

                // Base d'abord, Discord ensuite (cf. le bloc « ordre des
                // opérations » en bas de fichier).
                let avertissement = null;
                if (renommage) {
                    ({ warning: avertissement } = await syncCustomCommandRename(
                        interaction.guild.id, nom, nomFinal, apres?.response
                    ));
                }

                const entete = renommage
                    ? `✅ Commande \`/${nom}\` renommée en \`/${nomFinal}\`.`
                    : `✅ Commande \`/${nomFinal}\` mise à jour.`;

                await interaction.reply({
                    content: `${entete}\nAccès : ${decrireAcces(apres?.access_mode, apres?.access_role_id)}${avertPing(apres?.access_mode)}`
                        + (avertissement ? `\n\n⚠️ ${avertissement}` : ''),
                    allowedMentions: silentMentions(), // le récap ne doit pinger personne
                    ephemeral: true
                });
            }

        } else if (sub === 'delete') {
            const nom = interaction.options.getString('nom').toLowerCase();
            const result = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?').run(interaction.guild.id, nom);

            if (result.changes === 0) return userError(interaction, {
                    title: 'Commande introuvable',
                    cause: `Aucune commande personnalisée **/${nom}** n'existe sur ce serveur.`,
                    action: 'Consultez la liste avec `/cmd list`.',
                });

            // Retirer la commande slash de la guild
            await removeCustomCommand(interaction.guild.id, nom);

            await interaction.reply({ content: `🗑️ Commande \`/${nom}\` supprimée.`, ephemeral: true });

        } else if (sub === 'list') {
            const cmds = db.prepare('SELECT name, response, embed_id, access_mode, access_role_id FROM custom_commands WHERE guild_id = ?').all(interaction.guild.id);

            if (cmds.length === 0) return interaction.reply({ content: 'Aucune commande personnalisée.', ephemeral: true });

            const lines = cmds.map(c => {
                const reponse = c.embed_id ? '*(embed)*' : (c.response?.substring(0, 50) + (c.response?.length > 50 ? '…' : ''));
                return `⚡ \`/${c.name}\` — ${reponse}\n　${decrireAcces(c.access_mode, c.access_role_id)}`;
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

/** Client REST Discord, construit à la demande (le token n'est lu qu'à l'appel). */
function restClient() {
    const { REST } = require('discord.js');
    return new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
}

/**
 * Enregistre une commande personnalisée auprès de Discord.
 *
 * La description est construite par `buildCustomCommandDescription()`, la même
 * fonction qu'utilise le redéploiement au démarrage : sans ça, une commande
 * changerait de libellé au premier reboot suivant sa création.
 *
 * @param {string|null} response texte de réponse de la commande (null = embed).
 * @returns {Promise<boolean>} false si Discord a refusé — l'appelant décide quoi
 *          en dire, il n'y a rien à annuler côté base (cf. syncCustomCommandRename).
 */
async function deployCustomCommand(guildId, name, response) {
    const { Routes } = require('discord.js');

    try {
        await restClient().post(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), {
            body: { name, description: buildCustomCommandDescription({ name, response }), type: 1 }
        });
        return true;
    } catch (e) {
        console.error('[Quasar] Erreur déploiement commande custom:', e.message);
        return false;
    }
}

/**
 * Désenregistre une commande personnalisée auprès de Discord.
 * @returns {Promise<boolean>} true si la commande n'est plus enregistrée (y
 *          compris quand elle n'y était déjà pas).
 */
async function removeCustomCommand(guildId, name) {
    const { Routes } = require('discord.js');

    try {
        const rest = restClient();
        const cmds = await rest.get(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId));
        const cmd = cmds.find(c => c.name === name);
        if (cmd) {
            await rest.delete(Routes.applicationGuildCommand(process.env.DISCORD_CLIENT_ID, guildId, cmd.id));
        }
        return true;
    } catch (e) {
        console.error('[Quasar] Erreur suppression commande custom:', e.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  Renommage : ordre des opérations base ↔ Discord
//
//  1. La BASE d'abord, Discord ensuite. La base est la source de vérité : c'est
//     elle que lit le bot pour répondre, et c'est elle que le PUT de
//     deploy-commands.js rejoue intégralement au prochain démarrage. Une écriture
//     Discord réussie sur une base non modifiée serait la pire des combinaisons :
//     l'ancienne commande aurait disparu du serveur, la nouvelle serait inerte,
//     et l'utilisateur aurait reçu une erreur lui disant que rien n'a été fait.
//     Dans l'ordre retenu, un échec de validation ou de transaction ne touche
//     jamais Discord : on refuse, et rien n'a bougé nulle part.
//
//  2. Côté Discord : on ENREGISTRE le nouveau nom, PUIS on retire l'ancien. Si
//     l'appel échoue (réseau, limite de débit, permissions), la dégradation est
//     bornée : au pire le serveur porte les deux entrées un moment, l'ancienne
//     étant simplement sans effet puisque la base ne la connaît plus. L'ordre
//     inverse ouvrirait une fenêtre où le serveur n'a plus aucune des deux.
//
//  3. Un échec Discord ne fait PAS échouer le renommage : il est déjà commité,
//     et le prochain démarrage du bot resynchronise tout depuis la base. On
//     renvoie donc un avertissement, pas une erreur — dire « échec » pousserait
//     l'utilisateur à retenter un renommage déjà effectué, qui échouerait alors
//     sur « commande introuvable ».
// ═══════════════════════════════════════════════════════════════

/**
 * @returns {Promise<{warning:string|null}>} avertissement à afficher, ou null.
 */
async function syncCustomCommandRename(guildId, oldName, newName, response) {
    const posee = await deployCustomCommand(guildId, newName, response);
    // Tentée quoi qu'il arrive : l'ancienne entrée ne correspond plus à aucune
    // ligne en base, la laisser sur le serveur ne ferait qu'égarer les membres.
    const retiree = await removeCustomCommand(guildId, oldName);

    if (posee && retiree) return { warning: null };
    return {
        warning: `La commande a bien été renommée en /${newName}, mais Discord n'a pas pu être mis à jour tout de suite. `
            + 'L\'affichage des commandes du serveur se corrigera au prochain redémarrage du bot.',
    };
}

// Noyau partagé avec la route du dashboard (api/routes/customcmds.js), qui écrit
// dans la même table et déploie sur le même Discord. `data` et `execute` restent
// exportés tels quels : les chargeurs de commandes (bot/index.js,
// deploy-commands.js) testent `mod.data` et ignorent le reste.
Object.assign(module.exports, {
    normalizeCustomCommandName,
    reservedCommandNames,
    validateCustomCommandRename,
    updateCustomCommand,
    deployCustomCommand,
    removeCustomCommand,
    syncCustomCommandRename,
});
