const fs = require('fs');
const path = require('path');
const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { CUSTOM_CMD_ACCESS_MODES, effectiveAccessMode } = require('../../api/services/database');
const { hasMentions, silentMentions } = require('../../api/services/mentions');
const { DISABLED_COMMAND_FILES } = require('../utils/disabledCommands');
const { validateChatInputName, buildCustomCommandDescription } = require('../utils/slashCommandSpec');

// Une commande custom rejoue désormais les mentions de l'embed qu'elle affiche,
// exactement comme `/embed send` et les rappels programmés : une mention
// configurée sur un embed est appliquée partout où cet embed est envoyé, sans
// exception cachée. Ce qui protège de l'abus n'est plus le fait d'ignorer les
// mentions, mais le contrôle d'accès de la commande (access_mode) : tout le
// monde, les administrateurs, ou un rôle précis.
const ACCES_CHOIX = [
    { nom: 'Tout le monde', valeur: 'everyone' },
    { nom: 'Administrateurs uniquement', valeur: 'admins' },
    { nom: 'Un rôle précis', valeur: 'role' },
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
 * Le nom se lit sur le descripteur (`mod.nom`). Le repli sur `mod.data.name`, et
 * le pont `data` que `definirCommande` posait pour lui, ont été retirés à la
 * consolidation : les 26 commandes actives sont des descripteurs neutres, et le
 * chargeur refuse désormais tout autre format.
 *
 * Un fichier illisible n'interrompt pas le calcul : perdre une entrée de la
 * liste ne coûte au pire qu'une commande personnalisée inerte, alors qu'une
 * exception ici bloquerait tout renommage.
 */
function reservedCommandNames() {
    if (_reservedNames) return _reservedNames;

    // Le nom d'une commande, tel que son descripteur le déclare.
    const nomDe = (valeur) => ((typeof valeur?.nom === 'string' && valeur.nom) ? valeur.nom : null);

    const noms = new Set();
    for (const fichier of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !DISABLED_COMMAND_FILES.includes(f))) {
        try {
            const mod = require(path.join(__dirname, fichier));
            const direct = nomDe(mod);
            if (direct) {
                noms.add(direct);
                continue;
            }
            for (const valeur of Object.values(mod || {})) {
                const nom = nomDe(valeur);
                if (nom) noms.add(nom);
            }
        } catch (e) {
            console.warn(`[Quasar] Noms réservés : fichier ${fichier} illisible (${e.message}), ignoré.`);
        }
    }

    _reservedNames = noms;
    return noms;
}

/**
 * Valide un nom de commande personnalisée à la CRÉATION, avant toute écriture.
 *
 * Existait déjà pour le renommage, pas pour la création : `/cmd create` ne
 * faisait qu'une normalisation, là où `/cmd edit` passait par
 * `validateChatInputName()` et `reservedCommandNames()`. Un nom que Discord
 * refuse était donc accepté et stocké, pour ne se manifester qu'au
 * redéploiement du lot de commandes — c'est-à-dire loin de la personne qui
 * l'avait saisi, et sur un lot ENTIER qui échoue à cause d'une seule entrée.
 * Un nom déjà porté par une commande de Quasar produisait, lui, une commande
 * qui ne répondait jamais et disparaissait au redémarrage suivant.
 *
 * Les textes sont volontairement repris mot pour mot de
 * `validateCustomCommandRename` : deux formulations différentes pour la même
 * règle finiraient par décrire deux règles différentes.
 *
 * @returns {{name:string}|{error:{title:string, cause:string, action:string}}}
 */
function validateCustomCommandCreate(db, guildId, rawName) {
    const nom = normalizeCustomCommandName(rawName);

    if (!nom) {
        return { error: {
            title: 'Nom de commande vide',
            cause: 'Le nom de la commande est vide.',
            action: 'Saisissez un nom entre 1 et 32 caractères, en minuscules et sans espace.',
        } };
    }

    const validation = validateChatInputName(nom);
    if (!validation.valid) {
        return { error: {
            title: 'Nom de commande refusé par Discord',
            cause: `Discord refuse ce nom de commande : ${validation.reason}.`,
            action: 'Choisissez un nom de 1 à 32 caractères, en minuscules, sans espace ni apostrophe (les tirets et underscores sont acceptés).',
        } };
    }

    if (reservedCommandNames().has(nom)) {
        return { error: {
            title: 'Nom déjà pris par Quasar',
            cause: `/${nom} est déjà une commande de Quasar.`,
            action: 'Choisissez un autre nom : une commande personnalisée portant ce nom ne répondrait jamais, et elle disparaîtrait au prochain redémarrage du bot.',
        } };
    }

    const collision = db.prepare('SELECT name FROM custom_commands WHERE guild_id = ? AND name = ?').get(guildId, nom);
    if (collision) {
        return { error: {
            title: 'Cette commande existe déjà',
            cause: `Une commande personnalisée **/${nom}** est déjà enregistrée sur ce serveur.`,
            action: 'Modifiez-la avec `/cmd edit`, ou choisissez un autre nom.',
        } };
    }

    return { name: nom };
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

module.exports = definirCommande({
    nom: 'cmd',
    description: 'Gérer les commandes personnalisées',
    permission: 'MANAGE_GUILD',
    // Rien à demander au bot : enregistrer une commande d'application relève du
    // scope `applications.commands` accordé à l'invitation, pas d'une permission
    // de serveur. Déclaré vide plutôt qu'omis — l'omission ne se distinguerait
    // pas d'un oubli de migration.
    permissionsBot: [],

    sousCommandes: [
        {
            nom: 'create',
            description: 'Créer une commande personnalisée',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de la commande (sans /)' },
                { nom: 'reponse', type: 'texte', requis: false, description: 'Texte de la réponse' },
                { nom: 'embed', type: 'texte', requis: false, description: 'Nom d\'un embed sauvegardé (prioritaire sur le texte)' },
                { nom: 'acces', type: 'choix', requis: false, description: 'Qui peut utiliser la commande (par défaut : tout le monde)', choix: ACCES_CHOIX },
                { nom: 'role', type: 'role', requis: false, description: 'Rôle autorisé (uniquement si accès = un rôle précis)' },
            ],
        },
        {
            nom: 'edit',
            description: 'Modifier une commande existante',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de la commande' },
                { nom: 'nouveau_nom', type: 'texte', requis: false, description: 'Renommer la commande (sans /)' },
                { nom: 'reponse', type: 'texte', requis: false, description: 'Nouveau texte' },
                { nom: 'embed', type: 'texte', requis: false, description: 'Nouvel embed (nom)' },
                { nom: 'acces', type: 'choix', requis: false, description: 'Qui peut utiliser la commande', choix: ACCES_CHOIX },
                { nom: 'role', type: 'role', requis: false, description: 'Rôle autorisé (uniquement si accès = un rôle précis)' },
            ],
        },
        {
            nom: 'delete',
            description: 'Supprimer une commande personnalisée',
            options: [
                { nom: 'nom', type: 'texte', requis: true, description: 'Nom de la commande' },
            ],
        },
        {
            nom: 'list',
            description: 'Lister toutes les commandes personnalisées',
        },
    ],

    // Un seul `executer` pour les quatre sous-commandes : `create` et `edit`
    // partagent l'essentiel de leur corps, et les séparer en quatre fonctions
    // dupliquerait le contrôle d'accès et la résolution d'embed.
    async executer(ctx) {
        const sub = ctx.options.sousCommande;
        const db = ctx.db;

        if (sub === 'create' || sub === 'edit') {
            const nom = normalizeCustomCommandName(ctx.options.get('nom'));
            const reponse = ctx.options.get('reponse');
            const embedNom = ctx.options.get('embed');
            // Option propre à `/cmd edit` : à la création, il n'y a rien à renommer.
            const nouveauNom = sub === 'edit' ? ctx.options.get('nouveau_nom') : null;

            // Un `/cmd edit` qui ne fait que renommer est légitime : il ne touche
            // ni au texte ni à l'embed, la commande garde son contenu.
            if (!reponse && !embedNom && !nouveauNom) {
                return ctx.erreurUtilisateur({
                    titre: 'Commande sans contenu',
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
                ).get(ctx.guildeId, embedNom);
                if (!embedRow) {
                    return ctx.erreurUtilisateur({
                        titre: 'Embed introuvable',
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
            const accesOpt = ctx.options.get('acces');
            const roleOpt = ctx.options.get('role');
            let accesMode = accesOpt || (roleOpt ? 'role' : null);

            if (accesMode && !CUSTOM_CMD_ACCESS_MODES.includes(accesMode)) {
                return ctx.erreurUtilisateur({
                    titre: 'Mode d\'accès inconnu',
                    cause: `« ${accesMode} » n'est pas un mode d'accès valide.`,
                    action: 'Choisissez « Tout le monde », « Administrateurs uniquement » ou « Un rôle précis ».',
                });
            }
            if (accesMode === 'role' && !roleOpt) {
                return ctx.erreurUtilisateur({
                    titre: 'Rôle manquant',
                    cause: 'Vous avez choisi de réserver la commande à un rôle, mais aucun rôle n\'a été indiqué.',
                    action: 'Relancez la commande en renseignant aussi l\'option `role`.',
                });
            }
            const accesRoleId = accesMode === 'role' ? roleOpt.id : null;

            // Rappel à l'admin : ping libre + accès libre = n'importe qui peut
            // déclencher la mention. On le signale sans l'empêcher, c'est un
            // choix légitime pour un embed qui ne ping qu'un petit rôle.
            const avertPing = (mode) => (embedPing && mode === 'everyone')
                ? '\n\n⚠️ Cet embed a des mentions configurées : elles seront envoyées à **chaque** utilisation, et la commande est ouverte à tout le monde. Restreignez son accès avec l\'option `acces` si ce n\'est pas voulu.'
                : '';

            if (sub === 'create') {
                // Forme du nom, collision avec une commande de Quasar, collision
                // avec une commande existante : les trois d'un coup, et avec les
                // mêmes textes que le renommage.
                const nomValide = validateCustomCommandCreate(db, ctx.guildeId, nom);
                if (nomValide.error) return ctx.erreurUtilisateur(versErreurNeutre(nomValide.error));

                // À la création, l'absence d'option `acces` vaut « tout le
                // monde » : c'est le défaut de la colonne et le comportement
                // historique des commandes personnalisées.
                const modeCree = accesMode || 'everyone';

                db.prepare('INSERT INTO custom_commands (guild_id, name, response, embed_id, access_mode, access_role_id) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(ctx.guildeId, nom, reponse || null, embedId, modeCree, accesRoleId);

                // Déployer la commande slash, par l'adaptateur actif — jamais
                // par un client REST monté ici.
                await enregistrementNeutre(ctx).deployer(ctx.guildeId, nom, reponse);

                await ctx.repondre(embed({
                    titre: '✅ Commande créée',
                    couleur: 0xc86e8e,
                    description: `La commande \`/${nom}\` est disponible sur le serveur.${avertPing(modeCree)}`,
                    champs: [
                        embedNom
                            ? { nom: 'Réponse', valeur: `Embed: **${embedNom}**` }
                            : { nom: 'Réponse', valeur: reponse },
                        { nom: 'Accès', valeur: decrireAcces(modeCree, accesRoleId) },
                    ],
                    horodatage: true,
                }), { ephemere: true });

            } else {
                // ─── Renommage : tout valider AVANT la moindre écriture ───────
                let renommage = null;
                if (nouveauNom) {
                    const verdict = validateCustomCommandRename(db, ctx.guildeId, nom, nouveauNom);
                    if (verdict.error) return ctx.erreurUtilisateur({
                        titre: 'Renommage impossible',
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

                const ecriture = updateCustomCommand(db, ctx.guildeId, nom, { fields, newName: renommage });
                if (ecriture.error) return ctx.erreurUtilisateur({
                    titre: renommage ? 'Renommage impossible' : 'Modification impossible',
                    cause: ecriture.error.cause,
                    action: ecriture.error.action,
                });

                const nomFinal = ecriture.name;

                // État réellement en base après coup : le mode qu'on vient
                // d'écrire, ou celui déjà configuré si l'option n'a pas été
                // fournie. La réponse sert aussi à construire la description
                // envoyée à Discord en cas de renommage.
                const apres = db.prepare('SELECT response, access_mode, access_role_id FROM custom_commands WHERE guild_id = ? AND name = ?')
                    .get(ctx.guildeId, nomFinal);

                // Base d'abord, Discord ensuite (cf. le bloc « ordre des
                // opérations » en bas de fichier).
                let avertissement = null;
                if (renommage) {
                    ({ warning: avertissement } = await syncCustomCommandRename(
                        ctx.guildeId, nom, nomFinal, apres?.response, enregistrementNeutre(ctx),
                    ));
                }

                const entete = renommage
                    ? `✅ Commande \`/${nom}\` renommée en \`/${nomFinal}\`.`
                    : `✅ Commande \`/${nomFinal}\` mise à jour.`;

                await ctx.repondre({
                    contenu: `${entete}\nAccès : ${decrireAcces(apres?.access_mode, apres?.access_role_id)}${avertPing(apres?.access_mode)}`
                        + (avertissement ? `\n\n⚠️ ${avertissement}` : ''),
                    mentionsAutorisees: silentMentions(), // le récap ne doit pinger personne
                }, { ephemere: true });
            }

        } else if (sub === 'delete') {
            const nom = ctx.options.get('nom').toLowerCase();
            const result = db.prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?').run(ctx.guildeId, nom);

            if (result.changes === 0) return ctx.erreurUtilisateur({
                    titre: 'Commande introuvable',
                    cause: `Aucune commande personnalisée **/${nom}** n'existe sur ce serveur.`,
                    action: 'Consultez la liste avec `/cmd list`.',
                });

            // Retirer la commande slash de la guild, par l'adaptateur actif.
            await enregistrementNeutre(ctx).retirer(ctx.guildeId, nom);

            await ctx.repondre(`🗑️ Commande \`/${nom}\` supprimée.`, { ephemere: true });

        } else if (sub === 'list') {
            const cmds = db.prepare('SELECT name, response, embed_id, access_mode, access_role_id FROM custom_commands WHERE guild_id = ?').all(ctx.guildeId);

            if (cmds.length === 0) return ctx.repondre('Aucune commande personnalisée.', { ephemere: true });

            const lines = cmds.map(c => {
                const reponse = c.embed_id ? '*(embed)*' : (c.response?.substring(0, 50) + (c.response?.length > 50 ? '…' : ''));
                return `⚡ \`/${c.name}\` — ${reponse}\n　${decrireAcces(c.access_mode, c.access_role_id)}`;
            });

            await ctx.repondre(embed({
                titre: '⚡ Commandes personnalisées',
                couleur: 0x6e8ec8,
                description: lines.join('\n'),
                horodatage: true,
            }), { ephemere: true });
        }
    },
});

/**
 * Erreur de validation partagée avec le dashboard -> forme attendue par le
 * contexte neutre. Les validateurs rendent `{ title, cause, action }`, la
 * formulation anglaise de la route API : les renommer là-bas casserait
 * api/routes/customcmds.js, hors périmètre du lot 3.
 */
function versErreurNeutre({ title, cause, action }) {
    return { titre: title, cause, action };
}

// ═══════════════════════════════════════════════════════════════
//  Enregistrement d'une commande personnalisée auprès de la plateforme
//
//  DEUX APPELANTS, UNE SEULE VOIE : l'adaptateur actif. La commande
//  (`/cmd create|edit|delete`) le tient par son contexte, la route du dashboard
//  (`api/routes/customcmds.js`) le reçoit de `createApi`. Les deux fabriques
//  ci-dessous rendent la même paire `{ deployer, retirer }`, si bien que
//  `syncCustomCommandRename` n'a pas à savoir d'où elle vient.
//
//  Jusqu'au lot 7, la route montait son PROPRE client REST discord.js sur les
//  variables d'environnement, faute de recevoir l'adaptateur : c'étaient les
//  trois derniers `require('discord.js')` de bot/commands/ hors famille
//  musique. Ils sont tombés avec la nouvelle signature de `createApi`.
//
//  L'appel est INERTE là où `capacites.interactions` est faux : sur Fluxer, une
//  commande personnalisée est une ligne de `custom_commands` que le parseur
//  consulte, il n'y a rien à enregistrer auprès de la plateforme.
// ═══════════════════════════════════════════════════════════════

/**
 * Voie d'enregistrement portée par le contexte neutre d'une commande.
 *
 * La description est construite par `buildCustomCommandDescription()`, la même
 * fonction qu'utilise le redéploiement au démarrage : sans ça, une commande
 * changerait de libellé au premier reboot suivant sa création.
 *
 * @param {object} ctx contexte de commande
 * @returns {{deployer: Function, retirer: Function}} même signature que
 *   `enregistrementAdaptateur`, pour être interchangeables.
 */
function enregistrementNeutre(ctx) {
    return {
        deployer: (guildId, name, response) => ctx.deployerCommandeServeur({
            nom: name,
            description: buildCustomCommandDescription({ name, response }),
        }),
        retirer: (guildId, name) => ctx.retirerCommandeServeur(name),
    };
}

/**
 * Même paire, construite à partir de l'ADAPTATEUR lui-même.
 *
 * C'est ce que consomme `api/routes/customcmds.js` : une route n'a pas de
 * contexte de commande, mais elle reçoit l'adaptateur depuis `createApi`. Les
 * deux méthodes portent ici le serveur en premier argument — l'adaptateur, lui,
 * n'en désigne aucun.
 *
 * @param {object|null} adaptateur
 * @returns {{deployer: Function, retirer: Function}} inerte si l'adaptateur est
 *   absent : le bot n'est pas connecté, il n'y a rien à enregistrer et rien à
 *   annuler côté base. `false` remonte alors comme un refus de la plateforme,
 *   qui se corrige au prochain démarrage (cf. syncCustomCommandRename).
 */
function enregistrementAdaptateur(adaptateur) {
    if (!adaptateur || typeof adaptateur.deployerCommandeServeur !== 'function') {
        return { deployer: async () => false, retirer: async () => false };
    }
    return {
        deployer: (guildId, name, response) => adaptateur.deployerCommandeServeur(guildId, {
            nom: name,
            description: buildCustomCommandDescription({ name, response }),
        }),
        retirer: (guildId, name) => adaptateur.retirerCommandeServeur(guildId, name),
    };
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
 * @param {{deployer: Function, retirer: Function}} enregistrement voie
 *   d'enregistrement : `enregistrementNeutre(ctx)` depuis la commande,
 *   `enregistrementAdaptateur(adaptateur)` depuis la route du dashboard. Les
 *   deux ont la même signature, et cette fonction n'a donc pas à savoir
 *   laquelle elle emprunte. OBLIGATOIRE : il n'y a plus de voie par défaut
 *   montée sur les variables d'environnement.
 * @returns {Promise<{warning:string|null}>} avertissement à afficher, ou null.
 */
async function syncCustomCommandRename(guildId, oldName, newName, response, enregistrement) {
    const { deployer, retirer } = enregistrement;

    const posee = await deployer(guildId, newName, response);
    // Tentée quoi qu'il arrive : l'ancienne entrée ne correspond plus à aucune
    // ligne en base, la laisser sur le serveur ne ferait qu'égarer les membres.
    const retiree = await retirer(guildId, oldName);

    if (posee && retiree) return { warning: null };
    return {
        warning: `La commande a bien été renommée en /${newName}, mais Discord n'a pas pu être mis à jour tout de suite. `
            + 'L\'affichage des commandes du serveur se corrigera au prochain redémarrage du bot.',
    };
}

// Noyau partagé avec la route du dashboard (api/routes/customcmds.js), qui écrit
// dans la même table et déploie sur le même Discord. Le descripteur neutre reste
// l'export principal : le chargeur de commandes le reconnaît à `nom` +
// `executer`, et ignore les fonctions qu'on lui attache ici.
Object.assign(module.exports, {
    normalizeCustomCommandName,
    reservedCommandNames,
    enregistrementNeutre,
    enregistrementAdaptateur,
    validateCustomCommandCreate,
    validateCustomCommandRename,
    updateCustomCommand,
    syncCustomCommandRename,
});
