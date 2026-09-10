// ═══════════════════════════════════════════════════════════════
//  Contexte d'exécution neutre — Discord
//
//  Traduit une interaction discord.js en l'objet décrit par la DA §5.4. C'est
//  la seule chose qu'une commande migrée reçoit : si une information n'est pas
//  ici, elle n'existe pas pour le code métier.
//
//  Deux règles à connaître avant d'écrire une commande :
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
// ═══════════════════════════════════════════════════════════════

const { InteractionResponse } = require('discord.js');
const { rendreContenu, rendreChoix, rendrePrompt } = require('./render');
const { aPermission, BITS } = require('./permissions');

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

let compteurInteractions = 0;

/** Attache une référence native sans la rendre visible d'un log ou d'un JSON. */
function avecBrut(objet, brut) {
    // ⚠️ Échappatoire de transition. `brut` porte l'objet discord.js d'origine
    // pour le code pas encore migré ; il vaut `undefined` sur Fluxer. Une
    // commande migrée ne doit JAMAIS s'en servir — c'est exactement ce que ce
    // chantier retire. À supprimer à la fin des lots 1 à 5.
    Object.defineProperty(objet, 'brut', { value: brut, enumerable: false });
    return objet;
}

// ─── Normalisation des entités ───────────────────────────────────────────────

function normaliserUtilisateur(user) {
    if (!user) return null;
    return avecBrut({
        id: user.id,
        nom: user.globalName || user.username,
        etiquette: user.tag,
        mention: `<@${user.id}>`,
        estBot: Boolean(user.bot),
    }, user);
}

function normaliserRole(role) {
    if (!role) return null;
    return avecBrut({
        id: role.id,
        nom: role.name,
        mention: `<@&${role.id}>`,
        position: role.position,
        gere: Boolean(role.managed),
    }, role);
}

function normaliserCanal(canal) {
    if (!canal) return null;
    return avecBrut({
        id: canal.id,
        nom: canal.name,
        type: canal.type,
        guildeId: canal.guildId ?? canal.guild?.id ?? null,
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
        nom: membre.displayName ?? membre.user?.username,
        pseudo: membre.nickname ?? null,
        mention: `<@${membre.id ?? membre.user?.id}>`,
        roles,
        estBot: Boolean(membre.user?.bot),
        rejointLe: membre.joinedTimestamp ?? null,
        estAdmin: aPermission(membre.permissions, 'ADMINISTRATOR'),
        aPermission: (nom) => aPermission(membre.permissions, nom),
    }, membre);
}

function normaliserGuilde(guilde) {
    if (!guilde) return null;
    return avecBrut({ id: guilde.id, nom: guilde.name }, guilde);
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

// ─── Contexte de commande ────────────────────────────────────────────────────

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{adaptateur: object, descripteur: object, sousCommande?: object}} liaison
 */
function creerContexteCommande(interaction, { adaptateur, descripteur, sousCommande = null }) {
    // L'interaction sur laquelle répondre. Elle change après un `prompt()` :
    // voir l'avertissement en tête de fichier.
    let courante = interaction;

    const capacites = adaptateur.capacites;

    async function envoyer(contenuOuEmbed, { ephemere = false } = {}) {
        const payload = rendreContenu(contenuOuEmbed);
        // `ephemeral` (et non `flags`) : c'est la forme utilisée partout dans le
        // dépôt sur discord.js 14, et mélanger les deux dans un même processus
        // rend les diagnostics illisibles.
        if (ephemere) payload.ephemeral = true;

        // Une réponse différée est déjà acquittée : `ephemeral` y est décidé au
        // moment du defer, et Discord refuse de le changer après coup — le
        // laisser dans le corps ferait échouer l'édition.
        if (courante.deferred && !courante.replied) {
            const { ephemeral, ...corps } = payload;
            return courante.editReply(corps);
        }
        if (courante.replied) return courante.followUp(payload);
        return courante.reply(payload);
    }

    const ctx = {
        plateforme: adaptateur.nom,
        capacites,

        guildeId: interaction.guild?.id ?? null,
        canalId: interaction.channel?.id ?? interaction.channelId ?? null,
        guilde: normaliserGuilde(interaction.guild),

        auteur: normaliserUtilisateur(interaction.user),
        membre: normaliserMembre(interaction.member),

        options: creerLecteurOptions(interaction, descripteur, sousCommande),

        // Horodatage de RÉCEPTION de la commande, pour mesurer une latence sans
        // rien savoir de la plateforme (utilisé par /ping).
        creeLe: interaction.createdTimestamp,
        latencePasserelle: Number.isFinite(interaction.client?.ws?.ping)
            ? Math.round(interaction.client.ws.ping)
            : null,

        api: adaptateur.api,
        get db() {
            // Chargement différé : la chaîne base de données ne doit être
            // ouverte que si une commande s'en sert.
            return require('../../../api/services/database').getDb();
        },

        // ─── Réponses ────────────────────────────────────────────────────────

        /**
         * @param {string|object} contenuOuEmbed
         * @param {{ephemere?: boolean, sensible?: boolean}} [options]
         *   `sensible` ne change rien sur Discord (l'éphémère y est réellement
         *   privé) ; il pilote la stratégie de repli côté Fluxer, où il impose
         *   le message privé plutôt que l'auto-suppression. On le passe donc dès
         *   maintenant, pour que la commande soit correcte sur les deux
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
         */
        async prompt(questions, options = {}) {
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
         * @param {string}  [options.identifiant] préfixe de customId d'un panneau persistant
         * @param {string|Function} [options.autorise] 'auteur' (défaut), 'tous',
         *        'staff', un nom canonique de permission, ou un prédicat (membre) => boolean
         * @param {number}  [options.delai]        secondes, panneau éphémère seulement
         * @param {boolean} [options.ephemere]
         * @returns {Promise<string|null|{persistant: true, canalId: string, messageId: string}>}
         *   la clé choisie ; `null` à expiration ; les coordonnées du message
         *   pour un panneau persistant, à stocker en base par l'appelant.
         */
        async choose(message, choix, options = {}) {
            const persistant = Boolean(options.persistant);
            const prefixe = persistant
                ? (options.identifiant || `qpanel:${descripteur.nom}`)
                : `qchoose:${interaction.id}:${compteurInteractions++}`;

            const payload = { ...rendreContenu(message), components: rendreChoix(choix, prefixe) };
            if (options.ephemere) payload.ephemeral = true;

            // `reply` rend un InteractionResponse, `followUp` et `editReply` un
            // Message : c'est `resoudreMessage` qui les ramène à une forme unique.
            let reponse;
            if (courante.deferred && !courante.replied) {
                const { ephemeral, ...corps } = payload;
                reponse = await courante.editReply(corps);
            } else if (courante.replied) {
                reponse = await courante.followUp(payload);
            } else {
                reponse = await courante.reply(payload);
            }

            const msg = await resoudreMessage(reponse, courante);

            // Un panneau persistant ne collecte rien : ses clics sont routés par
            // les handlers d'interactions, qui survivent aux redémarrages. On
            // rend ses coordonnées pour que l'appelant les stocke en base.
            if (persistant) {
                return { persistant: true, canalId: msg?.channelId ?? ctx.canalId, messageId: msg?.id ?? null };
            }

            if (!msg) return null;

            try {
                const clic = await msg.awaitMessageComponent({
                    time: (options.delai ?? DELAI_CHOOSE_DEFAUT) * 1000,
                    filter: (i) => i.customId.startsWith(`${prefixe}:`)
                        && autoriseClic(i, options.autorise, interaction.user.id),
                });
                // Acquitter le clic sans rien afficher : c'est l'appelant qui
                // décide de la suite, et le contexte bascule sur ce clic pour
                // que ses réponses aboutissent.
                await clic.deferUpdate();
                courante = clic;
                return clic.customId.slice(prefixe.length + 1);
            } catch {
                return null;
            }
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

/**
 * Applique la règle `autorise` de `ctx.choose` à un clic.
 *
 * @param {string} auteurId identifiant de la personne qui a lancé la commande
 */
function autoriseClic(clic, autorise, auteurId) {
    if (typeof autorise === 'function') return Boolean(autorise(normaliserMembre(clic.member)));
    if (autorise === 'tous') return true;

    const permissions = clic.memberPermissions || clic.member?.permissions;
    // 'staff' est le vocabulaire de la DA ; il désigne l'encadrement du serveur,
    // traduit par « Gérer le serveur » (cf. PERMISSION_STAFF).
    if (autorise === 'staff') return aPermission(permissions, PERMISSION_STAFF);
    if (typeof autorise === 'string' && autorise !== 'auteur') {
        if (!(autorise in BITS)) {
            throw new Error(
                `ctx.choose : « autorise: ${autorise} » n'est ni un mode connu (auteur, tous, staff) `
                + 'ni un nom canonique de permission.'
            );
        }
        return aPermission(permissions, autorise);
    }

    // Défaut : seule la personne qui a lancé la commande peut cliquer. Sans
    // cette règle, n'importe qui pourrait répondre à sa place sur un panneau
    // posté dans un salon public.
    return clic.user.id === auteurId;
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
    creerContexteCompletion,
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    normaliserCanal,
    normaliserGuilde,
    DELAI_PROMPT_DEFAUT,
    DELAI_CHOOSE_DEFAUT,
    PERMISSION_STAFF,
};
