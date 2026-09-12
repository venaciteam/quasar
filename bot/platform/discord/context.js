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
const { rendreContenu, rendreChoix, rendrePrompt } = require('./render');
const { aPermission, BITS } = require('./permissions');
const { versNomCanonique } = require('./channels');

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

// Ce qui enchaîne un `ctx.choose`. Formulé en intention et non en mécanique :
//   'message' — l'appelant va poster une réponse ou modifier le panneau ;
//   'saisie'  — l'appelant va ouvrir un formulaire (`ctx.prompt`).
// Les deux seules valeurs acceptées : une troisième, mal orthographiée, ferait
// silencieusement retomber sur le défaut et casserait le parcours « panneau
// puis formulaire » sans le moindre message.
const SUITES_CHOOSE = Object.freeze(['message', 'saisie']);

let compteurInteractions = 0;

/** Attache une référence native sans la rendre visible d'un log ou d'un JSON. */
function avecBrut(objet, brut) {
    // ⚠️ Échappatoire de transition. `brut` porte l'objet discord.js d'origine
    // pour le code pas encore migré ; il vaut `undefined` sur Fluxer. Une
    // commande migrée ne doit JAMAIS s'en servir — c'est exactement ce que ce
    // chantier retire, et un test l'interdit hors de bot/platform/.
    // À supprimer à la fin des lots 1 à 5.
    Object.defineProperty(objet, 'brut', { value: brut, enumerable: false });
    return objet;
}

// ─── Normalisation des entités ───────────────────────────────────────────────
//
// Les normaliseurs tolèrent DEUX formes : l'objet discord.js (camelCase, issu
// de la passerelle et du cache) et la réponse REST brute (snake_case, issue des
// écritures de `api.js`). Sans cette tolérance, `api.envoyerMessage` rendrait un
// message dont `canalId` serait `undefined` — donc inutilisable pour stocker un
// panneau en base, ce qui est précisément son usage.

function normaliserUtilisateur(user) {
    if (!user) return null;
    return avecBrut({
        id: user.id,
        nom: user.globalName ?? user.global_name ?? user.username ?? null,
        etiquette: user.tag ?? user.username ?? null,
        mention: `<@${user.id}>`,
        estBot: Boolean(user.bot),
    }, user);
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
    return avecBrut({
        id: role.id,
        nom: role.name,
        mention: `<@&${role.id}>`,
        position: role.position,
        gere: Boolean(role.managed),
        couleur: couleurRole(role),
        guildeId: role.guildId ?? role.guild_id ?? role.guild?.id ?? null,
    }, role);
}

function normaliserCanal(canal) {
    if (!canal) return null;
    return avecBrut({
        id: canal.id,
        nom: canal.name,
        // Nom canonique quand Quasar connaît ce type, `null` sinon (forum, fil,
        // annonce). Le type natif reste lisible par `typeNatif` pour le code de
        // transition qui filtre encore sur `ChannelType`.
        type: versNomCanonique(canal.type),
        typeNatif: canal.type,
        guildeId: canal.guildId ?? canal.guild_id ?? canal.guild?.id ?? null,
        parentId: canal.parentId ?? canal.parent_id ?? null,
        mention: `<#${canal.id}>`,
    }, canal);
}

function normaliserMembre(membre) {
    if (!membre) return null;
    const roles = Array.isArray(membre.roles)
        ? membre.roles
        : [...(membre.roles?.cache?.keys?.() || [])];

    return avecBrut({
        id: membre.id ?? membre.user?.id,
        nom: membre.displayName ?? membre.nick ?? membre.user?.username ?? null,
        pseudo: membre.nickname ?? membre.nick ?? null,
        mention: `<@${membre.id ?? membre.user?.id}>`,
        roles,
        estBot: Boolean(membre.user?.bot),
        rejointLe: membre.joinedTimestamp ?? (membre.joined_at ? Date.parse(membre.joined_at) : null),
        estAdmin: aPermission(membre.permissions, 'ADMINISTRATOR'),
        aPermission: (nom) => aPermission(membre.permissions, nom),
    }, membre);
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
    return avecBrut({
        id: guilde.id,
        nom: guilde.name,
        proprietaireId: guilde.ownerId ?? guilde.owner_id ?? null,
        // Une panne côté plateforme rend un serveur temporairement
        // indisponible, et l'événement de départ est émis à l'identique. Sans
        // ce drapeau, la purge des données se déclencherait sur une panne : on
        // détruirait les données de serveurs parfaitement actifs.
        disponible: guilde.available !== false && guilde.unavailable !== true,
    }, guilde);
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

        /** Message supplémentaire après une première réponse. */
        suivre(contenuOuEmbed, { ephemere = false } = {}) {
            const payload = rendreContenu(contenuOuEmbed);
            if (ephemere) payload.ephemeral = true;
            return courante.followUp(payload);
        },

        /**
         * Réécrit le message du panneau lui-même — pour le griser, afficher le
         * choix retenu, ou retirer ses boutons. À ne pas confondre avec
         * `repondre`, qui poste une suite.
         */
        modifierPanneau(contenuOuEmbed) {
            const payload = rendreContenu(contenuOuEmbed);
            // Un panneau sans `composants` déclarés garde ses boutons : les
            // retirer implicitement casserait un panneau persistant. Pour les
            // enlever, passer `{ composants: [] }`.
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
                    + 'Appelez prompt() avant toute réponse — et si un ctx.choose() le précède, '
                    + 'déclarez-lui { suite: \'saisie\' }.'
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
        // TRANSITION : `bot/utils/errors.js` lit encore `panneau.prefixe` pour
        // nommer la source d'un incident. Alias conservé le temps que ce fichier
        // passe à `nom` — le retirer maintenant ferait retomber la ligne de
        // journal sur « inconnu », sans que rien ne le signale.
        prefixe: panneau,
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
    creerContextePanneau,
    creerContexteCompletion,
    creerNoyauContexte,
    validerAutorise,
    validerSuite,
    autoriseClic,
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    couleurRole,
    normaliserCanal,
    normaliserGuilde,
    DELAI_PROMPT_DEFAUT,
    DELAI_CHOOSE_DEFAUT,
    PERMISSION_STAFF,
    MODES_AUTORISE,
    SUITES_CHOOSE,
};
