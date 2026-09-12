// ═══════════════════════════════════════════════════════════════
//  Contexte d'exécution neutre — Discord
//
//  Traduit une interaction discord.js en l'objet décrit par la DA §5.4. C'est
//  la seule chose qu'une commande ou un panneau migré reçoit : si une
//  information n'est pas ici, elle n'existe pas pour le code métier.
//
//  Trois règles à connaître avant d'écrire une commande :
//
//   • Une interaction Discord doit être acquittée dans les 3 secondes, et une
//     seule fois. `repondre()` choisit donc lui-même entre reply, editReply et
//     followUp selon l'état réel de l'interaction — le code métier n'a pas à
//     s'en préoccuper, et ne doit surtout pas appeler `interaction.reply` en
//     parallèle.
//
//   • `ctx.prompt()` REBASCULE le contexte sur la soumission du formulaire.
//     C'est indispensable : la soumission d'un modal est une NOUVELLE
//     interaction, qui exige à son tour un acquittement. Après un `prompt()`
//     qui n'a pas rendu `null`, `ctx.repondre()` répond donc au formulaire, et
//     ne pas répondre du tout laisserait « L'interaction a échoué » à l'écran.
//
//   • Après un `ctx.choose()` éphémère, `ctx.repondre()` poste un message
//     SUPPLÉMENTAIRE, il ne réécrit pas le panneau. Pour réécrire le panneau
//     lui-même — le griser, afficher le choix retenu — il y a
//     `ctx.modifierPanneau()`.
//
//   • Un `choose()` déclare ce qui l'enchaîne, par `suite: 'message' | 'saisie'`.
//     Le code métier décrit son INTENTION, jamais la plomberie : « acquitter le
//     clic » ne veut rien dire sur Fluxer, où un `choose` est une réaction emoji
//     sans accusé de réception. Chaque adaptateur en fait ce qu'il peut — côté
//     Discord, `'saisie'` laisse le clic vierge pour qu'un formulaire puisse
//     s'ouvrir dessus ; côté Fluxer, l'option est inerte.
// ═══════════════════════════════════════════════════════════════

const { InteractionResponse } = require('discord.js');
const { rendreContenu, rendreChoix, rendrePrompt, rendreSelecteurMembre, corpsPanneau } = require('./render');
const { aPermission, BITS } = require('./permissions');
const { versNomCanonique } = require('./channels');
const { dateDuSnowflake } = require('./snowflake');

// Base du CDN Discord, pour reconstruire une URL d'avatar à partir du seul hash
// rendu par l'API REST (les objets discord.js, eux, savent le faire seuls).
const CDN = 'https://cdn.discordapp.com';
const TAILLE_AVATAR_DEFAUT = 128;

// Délais par défaut, en secondes. Alignés sur ce que Discord tolère : un modal
// reste ouvert 15 minutes, mais attendre aussi longtemps retiendrait un
// collecteur en mémoire pour une personne qui a fermé la fenêtre depuis
// longtemps.
const DELAI_PROMPT_DEFAUT = 300;
const DELAI_CHOOSE_DEFAUT = 120;

// `autorise: 'staff'` (vocabulaire de la DA §6.2) désigne l'encadrement du
// serveur. On le traduit par « Gérer le serveur » : c'est la permission qui
// sépare déjà l'équipe des membres dans le reste de Quasar, et elle est
// disponible à l'identique sur les deux plateformes.
const PERMISSION_STAFF = 'MANAGE_GUILD';

const MODES_AUTORISE = Object.freeze(['auteur', 'tous', 'staff']);

// Périmètres de `ctx.choisirMembre`. Côté Discord, 'salonVocal' restreint le
// sélecteur aux personnes présentes dans le salon ; côté Fluxer, il validera la
// mention saisie contre la même liste.
const PERIMETRES_MEMBRE = Object.freeze(['serveur', 'salonVocal']);

// Ce qui enchaîne un `ctx.choose`. Formulé en intention et non en mécanique :
//   'message' — l'appelant va poster une réponse ou modifier le panneau ;
//   'saisie'  — l'appelant va ouvrir un formulaire (`ctx.prompt`).
// Les deux seules valeurs acceptées : une troisième, mal orthographiée, ferait
// silencieusement retomber sur le défaut et casserait le parcours « panneau
// puis formulaire » sans le moindre message.
const SUITES_CHOOSE = Object.freeze(['message', 'saisie']);

let compteurInteractions = 0;

// ⚠️ Il n'y a PLUS d'échappatoire `brut` sur les entités normalisées. Elle a
// existé le temps des lots 1 à 5, pour que du code à demi migré retrouve
// l'objet discord.js d'origine ; elle est retirée à la consolidation, et
// `test/platform-etancheite.test.js` interdit désormais `.brut` dans tout
// `bot/`. Une information qui manque au code métier s'AJOUTE au normaliseur,
// pour les deux plateformes — c'est tout l'objet de cette couche.

// ─── Normalisation des entités ───────────────────────────────────────────────
//
// Les normaliseurs tolèrent DEUX formes : l'objet discord.js (camelCase, issu
// de la passerelle et du cache) et la réponse REST brute (snake_case, issue des
// écritures de `api.js`). Sans cette tolérance, `api.envoyerMessage` rendrait un
// message dont `canalId` serait `undefined` — donc inutilisable pour stocker un
// panneau en base, ce qui est précisément son usage.

function normaliserUtilisateur(user) {
    if (!user) return null;
    return {
        id: user.id,
        nom: user.globalName ?? user.global_name ?? user.username ?? null,
        etiquette: user.tag ?? user.username ?? null,
        mention: `<@${user.id}>`,
        estBot: Boolean(user.bot),
    };
}

/**
 * Étiquette lisible d'un compte.
 *
 * Depuis la bascule de Discord vers les pseudonymes uniques, un discriminateur
 * à « 0 » signifie qu'il n'y en a plus : afficher « leeva#0 » serait un
 * artefact. `tag` fait déjà ce calcul côté discord.js ; la réponse REST brute,
 * non.
 */
function etiquetteUtilisateur(user) {
    if (!user) return null;
    if (typeof user.tag === 'string' && user.tag) return user.tag;
    const discriminateur = user.discriminator;
    if (discriminateur && discriminateur !== '0') return `${user.username}#${discriminateur}`;
    return user.username ?? null;
}

/**
 * Fabrique d'URL d'avatar, à la taille demandée.
 *
 * Une fonction et non une chaîne : l'embed d'accueil veut 128, le journal 64,
 * et figer une taille obligerait le code métier à réécrire l'URL — donc à
 * connaître le CDN d'une plateforme.
 *
 * Trois sources, dans l'ordre : l'objet discord.js (qui sait construire l'URL),
 * le hash d'avatar de la réponse REST, et à défaut l'avatar par défaut.
 *
 * @param {object} membre  membre ou utilisateur, l'un ou l'autre
 * @returns {(taille?: number) => string|null}
 */
function fabriqueAvatar(membre) {
    const user = membre?.user ?? membre;
    const id = user?.id ?? membre?.id;

    return (taille = TAILLE_AVATAR_DEFAUT) => {
        // `displayAvatarURL` d'un membre rend l'avatar PROPRE AU SERVEUR quand il
        // en a un, ce qui est ce qu'attend un journal de modération.
        if (typeof membre?.displayAvatarURL === 'function') return membre.displayAvatarURL({ size: taille });
        if (typeof user?.displayAvatarURL === 'function') return user.displayAvatarURL({ size: taille });
        if (!id) return null;

        // Réponse REST : on n'a que des hashs.
        const hashMembre = typeof membre?.avatar === 'string' ? membre.avatar : null;
        const guildeId = membre?.guild_id ?? membre?.guildId ?? null;
        if (hashMembre && guildeId) {
            return `${CDN}/guilds/${guildeId}/users/${id}/avatars/${hashMembre}.png?size=${taille}`;
        }
        const hashUtilisateur = typeof user?.avatar === 'string' ? user.avatar : null;
        if (hashUtilisateur) return `${CDN}/avatars/${id}/${hashUtilisateur}.png?size=${taille}`;

        // Avatar par défaut : indexé par le discriminateur pour les anciens
        // comptes, par les bits hauts de l'identifiant pour les nouveaux.
        const discriminateur = user?.discriminator;
        const index = discriminateur && discriminateur !== '0'
            ? Number(discriminateur) % 5
            : Number((BigInt(id) >> 22n) % 6n);
        return `${CDN}/embed/avatars/${index}.png`;
    };
}

/**
 * Couleur d'un rôle, en hexadécimal « #rrggbb ».
 *
 * Trois sources possibles selon la provenance : `hexColor` (objet discord.js),
 * `color` entier (objet discord.js comme réponse REST brute), ou rien. Un rôle
 * sans couleur vaut 0 côté Discord, ce qui se rend « #000000 » — c'est déjà ce
 * que produit `hexColor`, et c'est la valeur qu'affichaient les embeds de
 * roleCreate / roleDelete avant migration.
 */
function couleurRole(role) {
    if (typeof role.hexColor === 'string' && /^#?[0-9a-f]{6}$/i.test(role.hexColor)) {
        return `#${role.hexColor.replace(/^#/, '').toLowerCase()}`;
    }
    const entier = Number.isFinite(role.color) ? role.color : 0;
    return `#${(entier & 0xFFFFFF).toString(16).padStart(6, '0')}`;
}

/**
 * role : { id, nom, mention, position, gere, couleur, guildeId }
 *
 * `couleur` et `guildeId` sont portés par le RÔLE, et non passés en second
 * argument d'événement : c'est aussi la forme de `GUILD_ROLE_CREATE` côté
 * Fluxer, dont le payload porte `guild_id` à côté du rôle. Sans `guildeId`, un
 * handler `roleCree` ne sait pas dans quel serveur écrire son journal — le
 * payload neutre ne porte que le rôle.
 */
function normaliserRole(role) {
    if (!role) return null;
    return {
        id: role.id,
        nom: role.name,
        mention: `<@&${role.id}>`,
        position: role.position,
        gere: Boolean(role.managed),
        couleur: couleurRole(role),
        guildeId: role.guildId ?? role.guild_id ?? role.guild?.id ?? null,
    };
}

function normaliserCanal(canal) {
    if (!canal) return null;
    return {
        id: canal.id,
        nom: canal.name,
        // Nom canonique quand Quasar connaît ce type, `null` sinon (forum, fil,
        // annonce). `typeNatif` reste lisible pour les journaux de structure,
        // qui AFFICHENT « Type 15 » plutôt que de taire un salon dont le type
        // n'a pas de nom canonique. Rien ne doit en DÉCIDER : une branche sur
        // cette valeur serait un `ChannelType` déguisé.
        type: versNomCanonique(canal.type),
        typeNatif: canal.type,
        guildeId: canal.guildId ?? canal.guild_id ?? canal.guild?.id ?? null,
        parentId: canal.parentId ?? canal.parent_id ?? null,
        mention: `<#${canal.id}>`,
    };
}

function normaliserMembre(membre) {
    if (!membre) return null;
    const roles = Array.isArray(membre.roles)
        ? membre.roles
        : [...(membre.roles?.cache?.keys?.() || [])];

    return {
        id: membre.id ?? membre.user?.id,
        nom: membre.displayName ?? membre.nick ?? membre.user?.username ?? null,
        pseudo: membre.nickname ?? membre.nick ?? null,
        mention: `<@${membre.id ?? membre.user?.id}>`,
        roles,
        estBot: Boolean(membre.user?.bot),
        rejointLe: membre.joinedTimestamp ?? (membre.joined_at ? Date.parse(membre.joined_at) : null),
        estAdmin: aPermission(membre.permissions, 'ADMINISTRATOR'),
        aPermission: (nom) => aPermission(membre.permissions, nom),

        // Fin de l'exclusion temporaire, ou null. C'est la seule façon de
        // répondre à « ce membre est-il exclu ? » sans lire discord.js.
        timeoutJusqua: membre.communicationDisabledUntilTimestamp
            ?? (membre.communication_disabled_until ? Date.parse(membre.communication_disabled_until) : null),

        // Date de création du COMPTE, à ne pas confondre avec `rejointLe`.
        // Déduite du snowflake quand l'objet ne la porte pas : la convention
        // appartient à la plateforme, pas à l'anti-raid qui s'en sert.
        compteCreeLe: membre.user?.createdTimestamp ?? dateDuSnowflake(membre.id ?? membre.user?.id),

        etiquette: etiquetteUtilisateur(membre.user ?? membre),
        // Pseudonyme BRUT, distinct de `nom` qui rend le nom affiché : le
        // gabarit d'accueil expose {username} et {user} séparément.
        nomUtilisateur: membre.user?.username ?? null,
        avatar: fabriqueAvatar(membre),

        // Salon vocal où le membre se trouve, ou null. Croisé avec la base par
        // les commandes vocales : sans lui, on piloterait son salon sans y être.
        canalVocalId: membre.voice?.channelId ?? membre.voice_state?.channel_id ?? null,
    };
}

/**
 * guilde : { id, nom, proprietaireId }
 *
 * `proprietaireId` n'est pas un ornement : c'est le seul moyen, sur la voie
 * neutre, de savoir qu'une cible est le propriétaire du serveur — quelqu'un que
 * Discord place au-dessus de tout et qu'aucune sanction ne doit viser. Sans
 * lui, `unreachableTarget` ne protégeait le propriétaire que si l'appelant le
 * déclarait de lui-même, et la sanction partait pour être refusée après coup
 * par la plateforme, traduite en un vague « permission manquante ».
 */
function normaliserGuilde(guilde) {
    if (!guilde) return null;
    return {
        id: guilde.id,
        nom: guilde.name,
        proprietaireId: guilde.ownerId ?? guilde.owner_id ?? null,
        // Une panne côté plateforme rend un serveur temporairement
        // indisponible, et l'événement de départ est émis à l'identique. Sans
        // ce drapeau, la purge des données se déclencherait sur une panne : on
        // détruirait les données de serveurs parfaitement actifs.
        disponible: guilde.available !== false && guilde.unavailable !== true,
        // Effectif du serveur. `null` et non 0 quand l'information manque : une
        // alerte de vague comparerait sinon un seuil à un effectif inventé.
        membreCount: guilde.memberCount ?? guilde.member_count ?? null,
        // Rôle @everyone. Il porte l'identifiant du serveur côté Discord, mais
        // c'est une connaissance de PLATEFORME : un verrouillage de salon qui
        // écrirait `guilde.id` en dur cesserait d'être portable.
        roleParDefautId: guilde.roles?.everyone?.id ?? guilde.id ?? null,
    };
}

// ─── Lecture des options ─────────────────────────────────────────────────────

/** Retrouve la déclaration d'une option, sous-commande comprise. */
function trouverOption(descripteur, sousCommande, nom) {
    const source = sousCommande?.options || descripteur?.options || [];
    return source.find(option => option.nom === nom);
}

/**
 * Lecteur d'options typé par le DESCRIPTEUR, pas par ce que Discord renvoie.
 *
 * C'est ce qui rend `ctx.options.get()` identique d'une plateforme à l'autre :
 * Fluxer n'a que des jetons de texte, et c'est la déclaration qui dit comment
 * les interpréter. Un nom d'option absent du descripteur lève plutôt que de
 * rendre `undefined` : une faute de frappe sur `get('membre')` produirait sinon
 * une commande qui « ne fait rien », sans le moindre indice.
 */
function creerLecteurOptions(interaction, descripteur, sousCommande) {
    return {
        get(nom) {
            const declaration = trouverOption(descripteur, sousCommande, nom);
            if (!declaration) {
                const contexte = sousCommande ? `${descripteur.nom} ${sousCommande.nom}` : descripteur.nom;
                throw new Error(`Option « ${nom} » non déclarée par la commande /${contexte}.`);
            }
            switch (declaration.type) {
                case 'texte':
                case 'choix':
                    return interaction.options.getString(nom);
                case 'entier':
                    return interaction.options.getInteger(nom);
                case 'booleen':
                    return interaction.options.getBoolean(nom);
                case 'utilisateur':
                    return normaliserUtilisateur(interaction.options.getUser(nom));
                case 'canal':
                    return normaliserCanal(interaction.options.getChannel(nom));
                case 'role':
                    return normaliserRole(interaction.options.getRole(nom));
                default:
                    throw new Error(`Type d'option « ${declaration.type} » non rendu par l'adaptateur Discord.`);
            }
        },
        /** Nom de la sous-commande invoquée, ou null. */
        sousCommande: sousCommande?.nom ?? null,
    };
}

// ─── Contrôle d'accès d'un panneau ───────────────────────────────────────────

/**
 * Valide la règle `autorise` AVANT de rendre le panneau.
 *
 * Elle était évaluée dans le filtre du collecteur, appelé par un écouteur
 * `async` de discord.js : une valeur invalide y devenait un rejet flottant que
 * le `try/catch` de `choose` ne pouvait pas attraper, et le panneau restait
 * muet jusqu'à son expiration. Levée ici, l'erreur désigne l'appel fautif.
 */
function validerAutorise(autorise) {
    if (autorise === undefined || typeof autorise === 'function') return;
    if (typeof autorise !== 'string' || (!MODES_AUTORISE.includes(autorise) && !(autorise in BITS))) {
        throw new Error(
            `ctx.choose : « autorise: ${JSON.stringify(autorise)} » n'est ni un mode connu `
            + `(${MODES_AUTORISE.join(', ')}), ni un nom canonique de permission, ni un prédicat.`
        );
    }
}

/**
 * Valide la déclaration d'enchaînement d'un `choose`.
 *
 * Même sévérité que partout ailleurs dans le registre : une valeur inconnue
 * retomberait sur le défaut, et le parcours « panneau puis formulaire »
 * échouerait plus tard sur un « L'interaction a échoué » sans rapport visible
 * avec la faute de frappe qui l'a causé.
 */
function validerSuite(suite) {
    if (suite === undefined || SUITES_CHOOSE.includes(suite)) return;
    throw new Error(
        `ctx.choose : « suite: ${JSON.stringify(suite)} » inconnue. `
        + `Valeurs acceptées : ${SUITES_CHOOSE.map(v => `'${v}'`).join(', ')}. `
        + '\'message\' (défaut) si une réponse enchaîne, \'saisie\' si un formulaire enchaîne.'
    );
}

/**
 * Pose un panneau persistant dans un salon donné.
 *
 * Écrite une fois, exposée sur TOUS les contextes — commande, panneau,
 * événement. Un panneau ne naît pas toujours d'une interaction : celui d'un
 * salon vocal temporaire est posé par `etatVocalModifie` à la création du
 * salon, et `/ticket setup salon:#support` doit poser le sien dans `#support`,
 * pas dans le salon d'où la commande est lancée — ce que `ctx.choose` ne sait
 * pas faire, puisqu'il répond à l'interaction en cours.
 *
 * Le `customId` produit est EXACTEMENT celui de
 * `ctx.choose({ persistant: true, panneau })` : `panneau:cle`. Le routage par
 * `surPanneau` ne fait donc aucune différence selon l'origine, et le handler
 * reste déclaré une seule fois — dans `panneaux` d'un descripteur de commande,
 * ou dans `bot/panneaux/` pour un module qui n'a pas de commande.
 *
 * @param {object} adaptateur
 * @param {string} canalId
 * @param {string|object} contenuOuEmbed  chaîne, embed neutre, ou corps composé
 *   `{ contenu, embeds, fichiers }`. Le corps composé n'est pas une commodité :
 *   les mentions d'un embed NE NOTIFIENT PAS, et l'ouverture d'un ticket doit
 *   pouvoir mettre `content` et `embeds` dans le même message que ses boutons.
 * @param {Array<{cle, libelle, emoji?, style?, desactive?, nouvelleRangee?}>|Array<Array>} choix
 * @param {{panneau: string}} options
 * @returns {Promise<{canalId: string, messageId: string|null}>}
 */
async function poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, { panneau } = {}) {
    exigerNomPanneau('poserPanneau', panneau);
    if (!canalId) throw new Error('poserPanneau : le salon de destination est obligatoire.');

    const message = await adaptateur.api.envoyerMessage(
        canalId,
        corpsPanneau(contenuOuEmbed, choix, panneau),
    );
    return { canalId, messageId: message?.id ?? null };
}

/**
 * Un nom de panneau ne peut pas contenir le séparateur que l'adaptateur place
 * entre le panneau et la clé du choix : `ticket:ouvrir` ne serait plus
 * déchiffrable si le panneau s'appelait `a:b`. Écrit une fois, appliqué partout
 * où un nom de panneau entre dans la couche.
 */
function exigerNomPanneau(appelant, panneau) {
    if (typeof panneau !== 'string' || !panneau || panneau.includes(':')) {
        throw new Error(
            `${appelant} : nom de panneau invalide « ${panneau} ». Attendu une chaîne non vide `
            + 'et sans « : », qui sépare le panneau de la clé du choix.'
        );
    }
    return panneau;
}

/**
 * Valide le périmètre d'un `choisirMembre`. Même sévérité, même raison : une
 * valeur inconnue retomberait sur le défaut et ouvrirait le sélecteur à tout le
 * serveur là où on voulait le restreindre au salon vocal.
 */
function validerPerimetreMembre(perimetre) {
    if (perimetre === undefined || PERIMETRES_MEMBRE.includes(perimetre)) return;
    throw new Error(
        `ctx.choisirMembre : « parmi: ${JSON.stringify(perimetre)} » inconnu. `
        + `Valeurs acceptées : ${PERIMETRES_MEMBRE.map(v => `'${v}'`).join(', ')}.`
    );
}

/**
 * Applique la règle `autorise` à un clic.
 * @param {string} auteurId identifiant de la personne qui a lancé la commande
 */
function autoriseClic(clic, autorise, auteurId) {
    if (typeof autorise === 'function') return Boolean(autorise(normaliserMembre(clic.member)));
    if (autorise === 'tous') return true;

    const permissions = clic.memberPermissions || clic.member?.permissions;
    if (autorise === 'staff') return aPermission(permissions, PERMISSION_STAFF);
    if (typeof autorise === 'string' && autorise !== 'auteur') return aPermission(permissions, autorise);

    // Défaut : seule la personne qui a lancé la commande peut cliquer. Sans
    // cette règle, n'importe qui pourrait répondre à sa place sur un panneau
    // posté dans un salon public.
    return clic.user.id === auteurId;
}

// ─── Noyau commun ────────────────────────────────────────────────────────────

/**
 * Cœur du contexte, partagé par les commandes et les panneaux persistants.
 *
 * @param {object} interaction interaction discord.js (commande ou composant)
 * @param {object} liaison
 * @param {object}  liaison.adaptateur
 * @param {string}  liaison.etiquette  nom de commande ou préfixe de panneau,
 *   sert de valeur par défaut aux identifiants de composants
 */
function creerNoyauContexte(interaction, { adaptateur, etiquette }) {
    // L'interaction sur laquelle répondre. Elle change après un `prompt()` et
    // après un `choose()` : voir l'avertissement en tête de fichier.
    let courante = interaction;

    // 'normal'    — `repondre` acquitte l'interaction courante ;
    // 'apresClic' — un clic vient d'être acquitté par `deferUpdate` ; `repondre`
    //               doit donc poster un message SUPPLÉMENTAIRE. Un `editReply`
    //               réécrirait le panneau, ce qui n'est presque jamais
    //               l'intention et fait disparaître les boutons.
    let mode = 'normal';

    async function envoyer(contenuOuEmbed, { ephemere = false } = {}) {
        const payload = rendreContenu(contenuOuEmbed);
        // `ephemeral` (et non `flags`) : c'est la forme utilisée partout dans le
        // dépôt sur discord.js 14, et mélanger les deux dans un même processus
        // rend les diagnostics illisibles.
        if (ephemere) payload.ephemeral = true;

        if (mode === 'apresClic' || courante.replied) return courante.followUp(payload);
        // Une réponse différée est déjà acquittée : `ephemeral` y est décidé au
        // moment du defer, et Discord refuse de le changer après coup — le
        // laisser dans le corps ferait échouer l'édition.
        if (courante.deferred) {
            const { ephemeral, ...corps } = payload;
            return courante.editReply(corps);
        }
        return courante.reply(payload);
    }

    const ctx = {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,

        guildeId: interaction.guild?.id ?? null,
        canalId: interaction.channel?.id ?? interaction.channelId ?? null,
        guilde: normaliserGuilde(interaction.guild),

        // Propriétaire du serveur, remonté au premier niveau du contexte.
        // `resoudrePorteeNeutre` (bot/utils/errors.js) lit `valeur.proprietaireId`
        // pour construire une portée d'écriture : c'est par ici que la garde
        // « on ne sanctionne pas le propriétaire » devient effective sur la voie
        // neutre, sans que la commande ait à le déclarer elle-même.
        proprietaireId: interaction.guild?.ownerId ?? null,

        auteur: normaliserUtilisateur(interaction.user),
        membre: normaliserMembre(interaction.member),

        // Identité du bot, LUE À CHAQUE ACCÈS sur l'adaptateur et non capturée
        // ici : `moi` est nul tant que la connexion n'est pas faite, et un
        // contexte construit avant la connexion figerait ce nul pour toujours.
        // C'est ce qui alimente la garde « le bot ne se sanctionne pas
        // lui-même » et le pré-contrôle de permission de `applyPunishments`.
        get moi() { return adaptateur.moi; },

        // Horodatage de RÉCEPTION de l'interaction, pour mesurer une latence sans
        // rien savoir de la plateforme (utilisé par /ping).
        creeLe: interaction.createdTimestamp,
        latencePasserelle: Number.isFinite(interaction.client?.ws?.ping)
            ? Math.round(interaction.client.ws.ping)
            : null,

        api: adaptateur.api,
        get db() {
            // Chargement différé : la chaîne base de données ne doit être
            // ouverte que si le handler s'en sert.
            return require('../../../api/services/database').getDb();
        },

        // ─── Réponses ────────────────────────────────────────────────────────

        /**
         * @param {string|object} contenuOuEmbed
         * @param {{ephemere?: boolean, sensible?: boolean}} [options]
         *   `sensible` ne change rien sur Discord (l'éphémère y est réellement
         *   privé) ; il pilote la stratégie de repli côté Fluxer, où il impose
         *   le message privé plutôt que l'auto-suppression. On le passe donc dès
         *   maintenant, pour que le handler soit correct sur les deux
         *   plateformes le jour de sa bascule.
         */
        repondre(contenuOuEmbed, options = {}) {
            return envoyer(contenuOuEmbed, options);
        },

        /**
         * Message privé à l'auteur. Passe par le client REST normalisé pour que
         * le chemin soit exactement le même sur les deux plateformes.
         *
         * Lève si la personne refuse les messages privés (code 50007) :
         * `bot/utils/errors.js` traduit déjà ce code, et avaler l'échec ici
         * laisserait croire que l'envoi a eu lieu — inacceptable pour un export
         * RGPD ou un signalement.
         */
        async repondreEnPrive(contenuOuEmbed) {
            const canalId = await adaptateur.api.ouvrirMessagePrive(interaction.user.id);
            return adaptateur.api.envoyerMessage(canalId, contenuOuEmbed);
        },

        /**
         * Acquitte l'interaction SANS répondre, et laisse jusqu'à quinze
         * minutes pour le faire.
         *
         * Une interaction doit être acquittée en trois secondes. Une commande
         * qui lit cent messages puis les supprime en lot dépasse régulièrement
         * ce délai : sans acquittement différé elle reste muette alors que le
         * travail se fait. Après `differer()`, `repondre()` remplit la réponse
         * différée au lieu d'en créer une.
         *
         * ⚠️ `prompt()` devient IMPOSSIBLE après un `differer()` : Discord
         * n'ouvre un formulaire que sur une interaction vierge. Même famille que
         * `choose({ suite: 'saisie' })` — si un formulaire enchaîne, ne différez
         * pas.
         */
        differer({ ephemere = false } = {}) {
            return courante.deferReply(ephemere ? { ephemeral: true } : {});
        },

        /** Message supplémentaire après une première réponse. */
        suivre(contenuOuEmbed, { ephemere = false } = {}) {
            const payload = rendreContenu(contenuOuEmbed);
            if (ephemere) payload.ephemeral = true;
            return courante.followUp(payload);
        },

        /**
         * Pose un panneau persistant DANS UN SALON DONNÉ.
         *
         * À ne pas confondre avec `choose({ persistant: true })`, qui répond à
         * l'interaction en cours : ici c'est `canalId` qui décide, et c'est ce
         * qu'il faut pour `/ticket setup salon:#support`. Même signature, même
         * `customId`, même routage que depuis un événement — le contexte
         * d'origine ne change rien.
         *
         * @see poserPanneau, en tête de ce fichier
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, options);
        },

        /**
         * Réécrit le message du panneau lui-même — pour le griser, afficher le
         * choix retenu, reposer ses boutons désactivés, ou les retirer. À ne pas
         * confondre avec `repondre`, qui poste une suite.
         *
         * ⚠️ Deux mécaniques, choisies sur l'ÉTAT de l'interaction et non sur un
         * drapeau de l'appelant :
         *
         *   • rien n'est encore acquitté — le cas d'un clic de panneau, qui
         *     arrive vierge : `update()`. C'est la seule forme qui réécrive le
         *     message ET acquitte le clic en un seul appel, sans laisser le
         *     moindre message éphémère derrière elle ;
         *   • l'interaction est déjà différée ou répondue : `editReply()`, qui
         *     complète la réponse en cours.
         *
         * Appeler `editReply` sur un clic vierge échoue (« interaction has not
         * been replied to »), et c'est ce qui obligeait le panneau d'arbitrage à
         * contourner par `differer()` + `api.modifierMessage` — au prix de
         * quatre messages éphémères que l'original n'avait pas.
         *
         * @param {string|object} contenuOuEmbed
         * @param {Array} [choix]  choix neutres à (re)poser. Omis, le panneau
         *   garde ses boutons ; les enlever demande `{ composants: [] }` dans un
         *   corps composé. Les retirer implicitement casserait un panneau
         *   persistant.
         * @param {{panneau?: string}} [options] nom du panneau, à défaut celui
         *   du contexte courant.
         */
        modifierPanneau(contenuOuEmbed, choix = null, options = {}) {
            const corps = choix
                ? corpsPanneau(contenuOuEmbed, choix, exigerNomPanneau('modifierPanneau', options.panneau || etiquette))
                : contenuOuEmbed;
            const payload = rendreContenu(corps);

            if (typeof courante.update === 'function' && !courante.deferred && !courante.replied) {
                return courante.update(payload);
            }
            return courante.editReply(payload);
        },

        /**
         * Erreur d'USAGE : ce n'est pas un bug, rien n'est journalisé et aucun
         * code d'incident n'est affiché. Même rendu que `userError()`, dont
         * cette méthode est le passage neutre.
         */
        erreurUtilisateur({ titre, cause, action, ephemere = true }) {
            const { userError } = require('../../utils/errors');
            return userError(courante, { title: titre, cause, action, ephemeral: ephemere });
        },

        // ─── Primitives de substitution (DA §6) ──────────────────────────────

        /**
         * Collecte une saisie. Un modal côté Discord, un dialogue séquentiel
         * côté Fluxer. Retour identique : un objet { cle: valeur }, ou `null`
         * en cas d'annulation ou d'expiration.
         *
         * ⚠️ `showModal` exige une interaction NON acquittée : ne rien répondre
         * avant d'appeler `prompt()`. Et répondre APRÈS, toujours — la
         * soumission du formulaire est une nouvelle interaction à acquitter.
         * Après un `choose()`, il faut donc lui avoir déclaré `{ suite: 'saisie' }`.
         */
        async prompt(questions, options = {}) {
            if (courante.deferred || courante.replied) {
                throw new Error(
                    'ctx.prompt : l\'interaction est déjà acquittée, aucun formulaire ne peut plus être ouvert. '
                    + 'Appelez prompt() avant toute réponse et sans ctx.differer() préalable — '
                    + 'et si un ctx.choose() le précède, déclarez-lui { suite: \'saisie\' }.'
                );
            }

            const identifiant = `qprompt:${interaction.id}:${compteurInteractions++}`;
            await courante.showModal(rendrePrompt(questions, options, identifiant));

            let soumission;
            try {
                soumission = await courante.awaitModalSubmit({
                    time: (options.delai ?? DELAI_PROMPT_DEFAUT) * 1000,
                    filter: (i) => i.customId === identifiant && i.user.id === interaction.user.id,
                });
            } catch {
                // Expiration, ou fenêtre fermée : les deux se présentent de la
                // même façon à discord.js. Ce n'est pas une panne.
                return null;
            }

            courante = soumission;
            mode = 'normal';

            const reponses = {};
            for (const question of questions) {
                // `getTextInputValue` lève si le champ manque — ce qui arrive si
                // le modal a été construit par une version antérieure du code et
                // soumis après un redéploiement. Un champ absent vaut chaîne
                // vide : le code métier applique déjà ses propres validations.
                try {
                    reponses[question.cle] = soumission.fields.getTextInputValue(question.cle);
                } catch {
                    reponses[question.cle] = '';
                }
            }
            return reponses;
        },

        /**
         * Propose des actions. Des boutons côté Discord, des réactions côté
         * Fluxer.
         *
         * @param {string|object} message  contenu ou embed neutre du panneau
         * @param {Array<{cle: string, libelle: string, emoji?: string, style?: string}>} choix
         * @param {object} [options]
         * @param {boolean} [options.persistant]  panneau durable (tickets, reaction roles)
         * @param {string}  [options.panneau]    nom du panneau persistant — le
         *        même que la clé déclarée dans `panneaux` du descripteur.
         *        Vocabulaire complet : voir bot/platform/commands.js.
         * @param {string|Function} [options.autorise] 'auteur' (défaut), 'tous',
         *        'staff', un nom canonique de permission, ou un prédicat (membre) => boolean
         * @param {number}  [options.delai]      secondes, panneau éphémère seulement
         * @param {boolean} [options.ephemere]
         * @param {boolean} [options.sensible]  même sens que sur `repondre` : le
         *        panneau porte des données personnelles. Sans effet sur Discord,
         *        où l'éphémère est réellement privé ; côté Fluxer il imposera le
         *        message privé, jamais l'auto-suppression — un panneau
         *        d'effacement RGPD ne peut pas reposer sur un délai.
         * @param {'message'|'saisie'} [options.suite]  ce qui enchaîne. Voir ci-dessous.
         * @returns {Promise<string|null|{persistant: true, canalId: string, messageId: string}>}
         *   la clé choisie ; `null` à expiration ; les coordonnées du message
         *   pour un panneau persistant, à stocker en base par l'appelant.
         *
         * ⚠️ Ce qui se passe APRÈS le clic dépend de `suite`, qui déclare
         * l'INTENTION de l'appelant et non la plomberie d'une plateforme :
         *
         *   suite: 'message' (défaut) — un message ou une réécriture du panneau
         *     enchaîne. Côté Discord, le clic est acquitté sans rien afficher :
         *     `ctx.repondre()` poste ensuite un message supplémentaire et
         *     `ctx.modifierPanneau()` réécrit le panneau. `ctx.prompt()` est
         *     alors IMPOSSIBLE — Discord n'ouvre un formulaire que sur une
         *     interaction vierge — et prompt() le dira explicitement.
         *
         *   suite: 'saisie' — un formulaire enchaîne. Côté Discord, le clic
         *     n'est pas acquitté et le contexte bascule dessus tel quel : c'est
         *     ce qui rend possible « panneau de ticket puis formulaire ». En
         *     contrepartie, il FAUT appeler prompt() ou repondre() dans les
         *     3 secondes, sinon Discord affiche « L'interaction a échoué ».
         *     Côté Fluxer, où un choose est une réaction emoji sans accusé de
         *     réception, l'option est inerte : le dialogue séquentiel s'ouvre
         *     de la même façon dans les deux cas.
         */
        async choose(message, choix, options = {}) {
            validerAutorise(options.autorise);
            validerSuite(options.suite);

            const persistant = Boolean(options.persistant);
            // Préfixe du customId. Pour un panneau persistant c'est le NOM du
            // panneau tel quel, afin qu'un clic reçu après un redémarrage
            // retrouve son handler ; pour un panneau éphémère, un identifiant
            // jetable propre à cet appel, pour ne collecter que ses clics.
            const prefixeCustomId = persistant
                ? (options.panneau || etiquette)
                : `qchoose:${interaction.id}:${compteurInteractions++}`;

            const payload = { ...rendreContenu(message), components: rendreChoix(choix, prefixeCustomId) };
            if (options.ephemere) payload.ephemeral = true;

            // `reply` rend un InteractionResponse, `followUp` et `editReply` un
            // Message : c'est `resoudreMessage` qui les ramène à une forme unique.
            let reponse;
            if (mode === 'apresClic' || courante.replied) {
                reponse = await courante.followUp(payload);
            } else if (courante.deferred) {
                const { ephemeral, ...corps } = payload;
                reponse = await courante.editReply(corps);
            } else {
                reponse = await courante.reply(payload);
            }

            const msg = await resoudreMessage(reponse, courante);

            // Un panneau persistant ne collecte rien : ses clics sont routés par
            // `adaptateur.surPanneau`, qui survit aux redémarrages. On rend ses
            // coordonnées pour que l'appelant les stocke en base.
            if (persistant) {
                return { persistant: true, canalId: msg?.channelId ?? ctx.canalId, messageId: msg?.id ?? null };
            }

            if (!msg) return null;

            let clic;
            try {
                clic = await msg.awaitMessageComponent({
                    time: (options.delai ?? DELAI_CHOOSE_DEFAUT) * 1000,
                    filter: (i) => i.customId.startsWith(`${prefixeCustomId}:`)
                        && autoriseClic(i, options.autorise, interaction.user.id),
                });
            } catch {
                return null;
            }

            if (options.suite === 'saisie') {
                // Clic laissé vierge : c'est la seule façon d'ouvrir un modal
                // dessus. Rien n'est acquitté, l'appelant doit répondre.
                courante = clic;
                mode = 'normal';
            } else {
                await clic.deferUpdate();
                courante = clic;
                mode = 'apresClic';
            }
            return clic.customId.slice(prefixeCustomId.length + 1);
        },

        /**
         * Demande de DÉSIGNER QUELQU'UN. Troisième primitive d'interface, aux
         * côtés de `prompt` (saisir) et `choose` (agir) — DA §6.
         *
         * `choose` ne la remplace pas : une liste de membres n'est pas un jeu de
         * choix fixes, et `prompt` obligerait à taper un identifiant. Autoriser
         * une personne dans son salon vocal ou l'en expulser passe par là.
         *
         * @param {string|object} message  contenu ou embed neutre
         * @param {object} [options]
         * @param {'serveur'|'salonVocal'} [options.parmi]  défaut 'serveur'
         * @param {string}  [options.canalId]  salon vocal, requis si parmi='salonVocal'
         * @param {string|Function} [options.autorise]  même règle que `choose`
         * @param {number}  [options.delai]    secondes
         * @param {boolean} [options.ephemere]
         * @returns {Promise<{id: string, nom: string, mention: string}|null>}
         *   `null` à expiration ou si personne n'est sélectionnable.
         *
         * Côté Fluxer, où il n'existe aucun sélecteur : le bot demandera « qui ?
         * mentionnez la personne », résoudra la mention ou l'identifiant, et
         * validera la réponse contre le même `parmi`. Le code métier ne verra
         * pas la différence — il décrit qui choisir, pas comment.
         */
        async choisirMembre(message, options = {}) {
            validerAutorise(options.autorise);
            validerPerimetreMembre(options.parmi);

            const perimetre = options.parmi || 'serveur';
            const identifiant = `qmembre:${interaction.id}:${compteurInteractions++}`;

            // Périmètre « salon vocal » : la liste est lue AVANT l'envoi, pour
            // pouvoir dire « il n'y a personne » plutôt que d'afficher un menu
            // vide que Discord refuserait.
            let membres = [];
            if (perimetre === 'salonVocal') {
                const canalId = options.canalId ?? ctx.canalId;
                membres = (await adaptateur.api.listerMembresVocal(canalId)) || [];
                membres = membres.filter(m => m.id !== interaction.user.id && !m.estBot);
                if (membres.length === 0) return null;
            }

            const payload = {
                ...rendreContenu(message),
                components: [rendreSelecteurMembre(identifiant, {
                    perimetre, membres, exemple: options.exemple,
                })],
            };
            if (options.ephemere) payload.ephemeral = true;

            let reponse;
            if (mode === 'apresClic' || courante.replied) {
                reponse = await courante.followUp(payload);
            } else if (courante.deferred) {
                const { ephemeral, ...corps } = payload;
                reponse = await courante.editReply(corps);
            } else {
                reponse = await courante.reply(payload);
            }

            const msg = await resoudreMessage(reponse, courante);
            if (!msg) return null;

            let choix;
            try {
                choix = await msg.awaitMessageComponent({
                    time: (options.delai ?? DELAI_CHOOSE_DEFAUT) * 1000,
                    filter: (i) => i.customId === identifiant
                        && autoriseClic(i, options.autorise, interaction.user.id),
                });
            } catch {
                return null;
            }

            await choix.deferUpdate();
            courante = choix;
            mode = 'apresClic';

            // Sélecteur natif : `members` porte l'objet complet. Menu de choix :
            // seule la valeur revient, on la retrouve dans la liste déjà lue.
            const id = choix.values?.[0] ?? null;
            if (!id) return null;
            const natif = choix.members?.get?.(id) ?? choix.users?.get?.(id);
            if (natif) {
                const normalise = natif.user ? normaliserMembre(natif) : normaliserUtilisateur(natif);
                return { id: normalise.id, nom: normalise.nom, mention: normalise.mention };
            }
            const connu = membres.find(m => m.id === id);
            return { id, nom: connu?.nom ?? id, mention: `<@${id}>` };
        },
    };

    return ctx;
}

/**
 * Ramène l'envoi à un `Message` réel, quelle que soit la méthode utilisée.
 *
 * `reply` rend un `InteractionResponse`, `followUp` et `editReply` un `Message`.
 * L'`InteractionResponse` sait collecter un composant, mais son `id` est celui
 * de l'INTERACTION, pas du message : le stocker pour un panneau persistant
 * donnerait un identifiant qui ne correspond à rien, et le panneau serait mort
 * au redémarrage suivant. D'où le `fetch()`.
 *
 * @returns {Promise<import('discord.js').Message|null>} null si le message a
 *   été supprimé entre-temps, ou s'il est devenu inaccessible.
 */
async function resoudreMessage(reponse, interaction) {
    try {
        if (reponse instanceof InteractionResponse) return await reponse.fetch();
        if (reponse?.id && reponse?.channelId) return reponse;
        return await interaction.fetchReply();
    } catch {
        return null;
    }
}

// ─── Contextes concrets ──────────────────────────────────────────────────────

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{adaptateur: object, descripteur: object, sousCommande?: object}} liaison
 */
function creerContexteCommande(interaction, { adaptateur, descripteur, sousCommande = null }) {
    const ctx = creerNoyauContexte(interaction, { adaptateur, etiquette: `qpanel:${descripteur.nom}` });
    ctx.options = creerLecteurOptions(interaction, descripteur, sousCommande);
    ctx.commande = descripteur.nom;

    // ─── Commandes personnalisées, serveur par serveur ───────────────────────
    //
    // `/cmd create|edit|delete` enregistre et retire des commandes auprès de la
    // plateforme. Sans ces deux méthodes, la seule issue depuis une commande
    // était de monter son PROPRE client REST discord.js sur les variables
    // d'environnement — un second client, une seconde authentification, et un
    // fichier de commande qui redevient Discord-only.
    //
    // Le serveur n'est pas un paramètre : une commande agit sur le sien, et le
    // laisser choisir ouvrirait un déploiement sur n'importe quel serveur depuis
    // n'importe quelle interaction.
    //
    // Inertes — et rendant `true` — là où `capacites.interactions` est faux :
    // côté Fluxer, une commande personnalisée sera résolue en base par le
    // parseur, il n'y a rien à enregistrer. « Rien à faire » est un succès.

    /** @param {{nom: string, description: string}} commande */
    ctx.deployerCommandeServeur = (commande) =>
        adaptateur.deployerCommandeServeur(ctx.guildeId, commande);

    /** @param {string} nom */
    ctx.retirerCommandeServeur = (nom) =>
        adaptateur.retirerCommandeServeur(ctx.guildeId, nom);

    return ctx;
}

/**
 * Contexte d'un clic sur un panneau persistant.
 *
 * L'interaction arrive NON acquittée, volontairement : c'est ce qui permet à un
 * handler de panneau d'ouvrir directement un formulaire (`ctx.prompt`), sans
 * quoi le parcours « panneau de ticket → formulaire » serait impossible. La
 * contrepartie est la règle habituelle de Discord : il faut répondre dans les
 * 3 secondes.
 *
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @param {{adaptateur: object, panneau: string, cle: string}} liaison
 */
function creerContextePanneau(interaction, { adaptateur, panneau, cle }) {
    const ctx = creerNoyauContexte(interaction, { adaptateur, etiquette: panneau });
    ctx.panneau = {
        // Le NOM du panneau, celui déclaré dans `panneaux` et passé à
        // `ctx.choose({ panneau })` : le même mot aux trois endroits.
        nom: panneau,
        cle,
        messageId: interaction.message?.id ?? null,
    };
    return ctx;
}

/** Contexte réduit servi aux handlers d'autocomplétion. */
function creerContexteCompletion(interaction, { adaptateur, descripteur }) {
    return {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,
        guildeId: interaction.guild?.id ?? null,
        canalId: interaction.channel?.id ?? interaction.channelId ?? null,
        auteur: normaliserUtilisateur(interaction.user),
        api: adaptateur.api,
        get db() { return require('../../../api/services/database').getDb(); },
        /** Valeur saisie jusqu'ici, et nom de l'option en cours de saisie. */
        saisie: interaction.options.getFocused(true),
        /** @param {Array<{nom: string, valeur: string}>} propositions (25 maximum) */
        repondre(propositions) {
            return interaction.respond(
                propositions.slice(0, 25).map(p => ({ name: p.nom, value: p.valeur }))
            );
        },
        descripteur,
    };
}

module.exports = {
    creerContexteCommande,
    exigerNomPanneau,
    creerContextePanneau,
    creerContexteCompletion,
    creerNoyauContexte,
    poserPanneau,
    validerAutorise,
    validerSuite,
    validerPerimetreMembre,
    autoriseClic,
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    couleurRole,
    etiquetteUtilisateur,
    fabriqueAvatar,
    normaliserCanal,
    normaliserGuilde,
    DELAI_PROMPT_DEFAUT,
    DELAI_CHOOSE_DEFAUT,
    PERMISSION_STAFF,
    MODES_AUTORISE,
    SUITES_CHOOSE,
    PERIMETRES_MEMBRE,
};
