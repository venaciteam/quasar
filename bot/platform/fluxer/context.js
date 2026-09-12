// ═══════════════════════════════════════════════════════════════
//  Contexte d'exécution neutre — Fluxer
//
//  Traduit un message de commande, une réaction de panneau ou un événement en
//  l'objet décrit par la DA §5.4. C'est la seule chose qu'une commande ou un
//  panneau migré reçoit : si une information n'est pas ici, elle n'existe pas
//  pour le code métier.
//
//  Quatre règles à connaître avant d'écrire une commande, et elles ne sont PAS
//  celles de Discord :
//
//   • Il n'y a rien à acquitter. Une commande Fluxer est un message ordinaire :
//     pas de fenêtre de trois secondes, pas de `reply` unique, pas de `deferred`.
//     `repondre()` poste un message, autant de fois qu'on l'appelle, et
//     `differer()` ne fait qu'allumer l'indicateur de saisie.
//
//   • `ctx.prompt()` NE REBASCULE RIEN. Le dialogue séquentiel se déroule dans
//     le salon (ou en privé si le contenu est sensible), question par question ;
//     après lui, `ctx.repondre()` répond toujours au même endroit. Un
//     `prompt()` peut donc suivre n'importe quoi — y compris un `differer()`,
//     ce que Discord interdit.
//
//   • `ctx.choose()` pose des RÉACTIONS, et une réaction n'a pas d'accusé de
//     réception. `suite: 'saisie'` est donc inerte, et documenté comme tel.
//     `modifierPanneau()` réécrit le message du panneau — il existe vraiment,
//     contrairement à une réponse d'interaction.
//
//   • Il n'y a pas d'éphémère. `{ ephemere: true }` applique la stratégie de la
//     DA §6.3 : message privé si `sensible`, sinon auto-suppression après
//     quinze secondes. L'auto-suppression n'est PAS une garantie de
//     confidentialité, et aucun contenu personnel ne doit en dépendre.
// ═══════════════════════════════════════════════════════════════

const {
    rendreChoix, rendrePrompt, rendreSelecteurMembre, corpsPanneau, composerPanneau,
    MOT_ANNULATION,
} = require('./render');
const { aPermission, BITS, masqueMembre, masqueSurCanal } = require('./permissions');
const { versNomCanonique } = require('./channels');
const { dateDuSnowflake } = require('./snowflake');

// Base du proxy média de Fluxer, pour reconstruire une URL d'avatar à partir du
// seul hash que rend l'API.
//
// À VÉRIFIER EN RECETTE : la valeur canonique se lit dans `endpoints.media` du
// document de découverte d'instance (`GET /v1/instance`, cf. media-proxy/
// overview.md § Base URLs) et n'est PAS publiée en dur dans la documentation.
// Celle-ci est déduite du domaine public de l'instance de référence. Surchargeable
// par FLUXER_MEDIA_BASE pour une instance auto-hébergée, sans quoi tous les
// avatars d'un embed d'accueil pointeraient dans le vide.
const BASE_MEDIA_DEFAUT = 'https://media.fluxer.app';
const TAILLE_AVATAR_DEFAUT = 128;

/**
 * Base du proxy média, lue À CHAQUE APPEL et non capturée au chargement : une
 * instance auto-hébergée la renseigne par FLUXER_MEDIA_BASE, et les tests la
 * changent d'un cas à l'autre.
 */
function baseMedia(env = process.env) {
    return env.FLUXER_MEDIA_BASE || BASE_MEDIA_DEFAUT;
}

// Délais par défaut, en secondes. Alignés sur ceux de l'adaptateur Discord pour
// qu'un descripteur qui n'en déclare pas se comporte pareil des deux côtés.
const DELAI_PROMPT_DEFAUT = 300;
const DELAI_CHOOSE_DEFAUT = 120;

// Durée avant auto-suppression d'une réponse « éphémère » non sensible (DA §6.3).
const DELAI_AUTO_SUPPRESSION_MS = 15000;

// `autorise: 'staff'` (DA §6.2) désigne l'encadrement du serveur. Même
// traduction que côté Discord : « Gérer le serveur », qui sépare déjà l'équipe
// des membres dans le reste de Quasar et existe à l'identique sur Fluxer
// (MANAGE_GUILD, 1<<5, permissions.mdx).
const PERMISSION_STAFF = 'MANAGE_GUILD';

const MODES_AUTORISE = Object.freeze(['auteur', 'tous', 'staff']);

// Périmètres de `ctx.choisirMembre`. 'salonVocal' valide la mention saisie
// contre la liste des occupants, là où Discord restreint un sélecteur.
const PERIMETRES_MEMBRE = Object.freeze(['serveur', 'salonVocal']);

// Ce qui enchaîne un `ctx.choose`, vocabulaire du contrat. Les deux valeurs sont
// acceptées et validées ici comme côté Discord — une troisième, mal
// orthographiée, doit être refusée sur les DEUX plateformes, sinon un
// descripteur fautif ne se révélerait qu'au jour de la bascule.
const SUITES_CHOOSE = Object.freeze(['message', 'saisie']);

let compteurDialogues = 0;

// ⚠️ Il n'y a PAS d'échappatoire « brut » sur les entités normalisées, pas plus
// que côté Discord depuis la consolidation. Une information qui manque au code
// métier s'AJOUTE au normaliseur, pour les deux plateformes — c'est tout l'objet
// de cette couche, et la seule chose qui garantisse qu'un handler écrit une fois
// se comporte pareil des deux côtés.

// ─── Normalisation des entités ───────────────────────────────────────────────
//
// Les payloads Fluxer sont en snake_case, de bout en bout : passerelle comme
// REST. Il n'y a donc pas la double forme que tolèrent les normaliseurs Discord
// (objet discord.js camelCase / réponse REST snake_case) — mais on garde la
// tolérance camelCase pour que les doublures de test écrites contre l'un
// fonctionnent contre l'autre, et surtout pour que les CLÉS DE SORTIE soient
// rigoureusement les mêmes des deux côtés. C'est cette identité de sortie qui
// fait que `bot/events/` et `bot/commands/` n'ont pas une ligne de différence.

function normaliserUtilisateur(user) {
    if (!user) return null;
    return {
        id: user.id,
        // `global_name` est le nom affiché, `username` le pseudonyme unique —
        // même partage qu'en API Discord (users.mdx, « Partial user object »).
        nom: user.globalName ?? user.global_name ?? user.username ?? null,
        etiquette: etiquetteUtilisateur(user),
        mention: `<@${user.id}>`,
        // « bot? | boolean | omitted when false » : l'absence vaut faux.
        estBot: Boolean(user.bot),
    };
}

/**
 * Étiquette lisible d'un compte.
 *
 * ⚠️ Fluxer a GARDÉ les discriminateurs : « discriminator | string | four decimal
 * digits with leading zeroes » (users.mdx). Il n'y a pas eu de bascule vers des
 * pseudonymes uniques comme chez Discord, donc pas de « 0 » à masquer — mais
 * « 0000 » existe et signifie « compte technique » : un webhook, ou un compte
 * supprimé. Afficher « webhook#0000 » serait un artefact, on rend alors le
 * pseudonyme seul.
 */
function etiquetteUtilisateur(user) {
    if (!user) return null;
    if (typeof user.tag === 'string' && user.tag) return user.tag;
    const discriminateur = user.discriminator;
    if (discriminateur && discriminateur !== '0' && discriminateur !== '0000') {
        return `${user.username}#${discriminateur}`;
    }
    return user.username ?? null;
}

/**
 * Fabrique d'URL d'avatar, à la taille demandée.
 *
 * Une fonction et non une chaîne, exactement comme côté Discord : l'embed
 * d'accueil veut 128, le journal 64, et figer une taille obligerait le code
 * métier à réécrire l'URL — donc à connaître le proxy média d'une plateforme.
 *
 * Deux routes, lues dans `media-proxy/routes.mdx` :
 *   /avatars/{user_id}/{hash}.{ext}
 *   /guilds/{guild_id}/users/{user_id}/avatars/{hash}.{ext}
 * et le paramètre `size` « snaps to the ladder » — 128 par défaut
 * (media-proxy/transformations.md § Asset size selection).
 *
 * ⚠️ Rend `null` quand le compte n'a AUCUN avatar. Fluxer sert ses avatars par
 * défaut depuis `endpoints.static_cdn`, dont la documentation ne publie pas le
 * chemin ; inventer une URL produirait une image cassée dans chaque embed
 * d'accueil, là où `null` laisse le rendu s'en passer proprement.
 * À VÉRIFIER EN RECETTE : chemin exact de l'avatar par défaut sur le CDN statique.
 */
function fabriqueAvatar(membre, { base = baseMedia() } = {}) {
    const user = membre?.user ?? membre;
    const id = user?.id ?? membre?.id;

    return (taille = TAILLE_AVATAR_DEFAUT) => {
        if (!id) return null;
        // L'avatar PROPRE AU SERVEUR prime, comme `displayAvatarURL` d'un membre
        // discord.js : c'est ce qu'attend un journal de modération.
        const hashMembre = typeof membre?.avatar === 'string' ? membre.avatar : null;
        const guildeId = membre?.guild_id ?? membre?.guildId ?? null;
        if (hashMembre && guildeId) {
            return `${base}/guilds/${guildeId}/users/${id}/avatars/${hashMembre}.png?size=${taille}`;
        }
        const hashUtilisateur = typeof user?.avatar === 'string' ? user.avatar : null;
        if (hashUtilisateur) return `${base}/avatars/${id}/${hashUtilisateur}.png?size=${taille}`;
        return null;
    };
}

/**
 * Couleur d'un rôle, en hexadécimal « #rrggbb ».
 *
 * « color | integer | The colour of the role as an RGB integer, which every
 * operation on this resource writes in the range 0 through 16777215 »
 * (permissions.mdx). Un rôle sans couleur vaut 0, rendu « #000000 » — la même
 * valeur que produisait `hexColor` côté Discord, donc le même affichage dans les
 * embeds de roleCreate / roleDelete.
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
 * ⚠️ `gere` vaut TOUJOURS false : Fluxer n'a pas de rôle géré par une
 * intégration, son objet rôle (permissions.mdx, « Guild role object ») ne
 * déclare aucun champ `managed`. Le champ est conservé parce que le contrat le
 * porte et que `checkAssignableRole` le lit ; il est simplement toujours
 * « non géré », ce qui est exact sur cette plateforme.
 *
 * `guildeId` est porté PAR LE RÔLE, comme côté Discord : c'est aussi la forme de
 * `GUILD_ROLE_CREATE`, dont le payload porte `guild_id` à côté du rôle.
 */
/**
 * Le rôle est-il @everyone ?
 *
 * Il porte le même snowflake que son serveur : « The everyone role has the same
 * snowflake as its guild and is named @everyone » (permissions.mdx). Sans
 * identifiant de serveur connu on répond « non » — un « je ne sais pas » qui
 * deviendrait « oui » ferait disparaître un rôle ordinaire des sélecteurs.
 */
function estRoleParDefaut(role, guildeId = null) {
    const serveur = role.guildId ?? role.guild_id ?? role.guild?.id ?? guildeId ?? null;
    return Boolean(serveur) && String(role.id) === String(serveur);
}

function normaliserRole(role, { guildeId = null } = {}) {
    if (!role) return null;
    return {
        id: role.id,
        nom: role.name,
        mention: `<@&${role.id}>`,
        position: role.position,
        gere: Boolean(role.managed),
        couleur: couleurRole(role),
        guildeId: role.guildId ?? role.guild_id ?? role.guild?.id ?? guildeId ?? null,
        // « The everyone role has the same snowflake as its guild »
        // (http-api/permissions.mdx). Même règle que côté Discord.
        parDefaut: estRoleParDefaut(role, guildeId),
    };
}

function normaliserCanal(canal) {
    if (!canal) return null;
    return {
        id: canal.id,
        nom: canal.name,
        // Nom canonique quand Quasar connaît ce type, `null` sinon (message
        // privé, groupe, salon-lien, notes personnelles). Le type natif reste
        // lisible par `typeNatif`.
        type: versNomCanonique(canal.type),
        typeNatif: canal.type,
        guildeId: canal.guildId ?? canal.guild_id ?? canal.guild?.id ?? null,
        parentId: canal.parentId ?? canal.parent_id ?? null,
        // « position? | integer | The sort position, present only for a guild
        // channel », et « A channel that stores no position reports 0 »
        // (http-api/channels.mdx).
        position: canal.rawPosition ?? canal.position ?? null,
        mention: `<#${canal.id}>`,
    };
}

/**
 * membre : les quinze champs du contrat, à l'identique de l'adaptateur Discord.
 *
 * ⚠️ LE point de divergence du lot 6 : un membre Fluxer ne porte AUCUN champ
 * `permissions` (guild-members.mdx, « Guild member object »). Là où discord.js
 * livre un masque déjà calculé, il faut le calculer nous-mêmes à partir des
 * rôles du serveur — d'où `etat`, l'état local du client. Sans lui, `estAdmin`
 * serait toujours faux et `accesParDefaut: false` n'ouvrirait la commande à
 * personne.
 *
 * `etat` absent (normalisation d'une réponse REST isolée, doublure de test) rend
 * un masque vide, donc `estAdmin: false` : c'est exactement ce que fait
 * l'adaptateur Discord sur une réponse REST brute, et c'est le bon défaut — un
 * « je ne sais pas » ne doit jamais devenir un droit accordé.
 *
 * @param {object} membre  membre Fluxer (`user`, `roles`, `nick`, …)
 * @param {object} [options]
 * @param {object} [options.etat]      état local du client
 * @param {string} [options.guildeId]  quand le membre ne porte pas `guild_id`
 * @param {object} [options.utilisateur] compte, quand il est hors du membre
 *   (MESSAGE_CREATE retire `user` du membre : il est dans `author`)
 */
function normaliserMembre(membre, { etat = null, guildeId = null, utilisateur = null, baseMedia } = {}) {
    if (!membre) return null;

    const user = utilisateur ?? membre.user ?? null;
    const id = membre.id ?? user?.id ?? null;
    const guilde = membre.guild_id ?? membre.guildId ?? guildeId ?? null;

    // « roles | array[snowflake] | The IDs of the roles assigned […] The everyone
    // role is never present. » Toujours un tableau d'identifiants, jamais un
    // gestionnaire : c'est plus simple que côté Discord.
    const roles = Array.isArray(membre.roles) ? membre.roles.map(String) : [];

    const proprietaireId = guilde
        ? (etat?.guilde(guilde)?.proprietes?.owner_id ?? null)
        : null;
    const masque = (etat && guilde && id)
        ? masqueMembre({
            membreId: id,
            rolesMembre: roles,
            roles: etat.roles(guilde),
            guildeId: guilde,
            proprietaireId,
        })
        : 0n;

    // Le membre porté par le payload n'a pas toujours son `user` : on complète
    // depuis l'objet fusionné pour que l'avatar de serveur reste trouvable.
    const pourAvatar = user ? { ...membre, user, guild_id: guilde } : { ...membre, guild_id: guilde };

    return {
        id,
        nom: membre.displayName ?? membre.nick ?? user?.global_name ?? user?.username ?? null,
        pseudo: membre.nickname ?? membre.nick ?? null,
        mention: `<@${id}>`,
        roles,
        estBot: Boolean(user?.bot),
        rejointLe: membre.joinedTimestamp ?? (membre.joined_at ? Date.parse(membre.joined_at) : null),
        estAdmin: aPermission(masque, 'ADMINISTRATOR'),
        aPermission: (nom) => aPermission(masque, nom),

        // Fin de l'exclusion temporaire, ou null. « A client compares
        // communication_disabled_until against the current time, because a
        // non-null value can name a moment that has already passed. » — c'est à
        // l'appelant de comparer, et c'est déjà ce que fait le code métier.
        timeoutJusqua: membre.communicationDisabledUntilTimestamp
            ?? (membre.communication_disabled_until ? Date.parse(membre.communication_disabled_until) : null),

        // Date de création du COMPTE, à ne pas confondre avec `rejointLe`.
        // Déduite du snowflake : Fluxer partage l'époque de Discord
        // (snowflakes.md), et la convention appartient à la plateforme, pas à
        // l'anti-raid qui s'en sert.
        compteCreeLe: user?.createdTimestamp ?? dateDuSnowflake(id),

        etiquette: etiquetteUtilisateur(user ?? membre),
        // Pseudonyme BRUT, distinct de `nom` : le gabarit d'accueil expose
        // {username} et {user} séparément.
        nomUtilisateur: user?.username ?? null,
        avatar: fabriqueAvatar(pourAvatar, baseMedia ? { base: baseMedia } : undefined),

        // Salon vocal où le membre se trouve, ou null. Lu dans l'état local :
        // le membre Fluxer ne porte pas son état vocal, c'est VOICE_STATE_UPDATE
        // qui le publie séparément.
        canalVocalId: membre.voice?.channelId
            ?? membre.voice_state?.channel_id
            ?? ((etat && guilde && id) ? (etat.etatVocal(guilde, id)?.channel_id ?? null) : null),
    };
}

/**
 * guilde : { id, nom, proprietaireId, disponible, membreCount, roleParDefautId }
 *
 * `proprietaireId` n'est pas un ornement : c'est le seul moyen de savoir qu'une
 * cible est le propriétaire du serveur, quelqu'un que Fluxer place au-dessus de
 * tout — « The guild owner manages every role », « The guild owner receives the
 * complete 64-bit mask » — et qu'aucune sanction ne doit viser.
 *
 * `roleParDefautId` est l'identifiant du serveur : « The everyone role has the
 * same snowflake as its guild » (permissions.mdx). C'est une connaissance de
 * PLATEFORME, et c'est pour cela qu'elle est ici et pas dans un verrouillage de
 * salon qui écrirait `guilde.id` en dur.
 */
function normaliserGuilde(guilde) {
    if (!guilde) return null;
    // L'état local range la guilde sous `proprietes` ; une réponse REST est
    // plate. Les deux formes passent.
    const source = guilde.proprietes ? { id: guilde.id, ...guilde.proprietes } : guilde;
    return {
        id: source.id ?? guilde.id,
        nom: source.name ?? null,
        proprietaireId: source.ownerId ?? source.owner_id ?? null,
        // Un serveur temporairement indisponible émet le même événement de
        // départ qu'un vrai départ. Sans ce drapeau, la purge des données se
        // déclencherait sur une panne.
        disponible: guilde.disponible !== false && source.available !== false && source.unavailable !== true,
        // `null` et non 0 quand l'information manque : une alerte de vague
        // comparerait sinon un seuil à un effectif inventé.
        membreCount: source.memberCount ?? source.member_count ?? null,
        roleParDefautId: source.id ?? guilde.id ?? null,
    };
}

// ─── Lecture des options ─────────────────────────────────────────────────────

/** Retrouve la déclaration d'une option, sous-commande comprise. */
function trouverOption(descripteur, sousCommande, nom) {
    const source = sousCommande?.options || descripteur?.options || [];
    return source.find(option => option.nom === nom);
}

/**
 * Lecteur d'options, alimenté par le PARSEUR et typé par le DESCRIPTEUR.
 *
 * Côté Discord, la plateforme a déjà typé les valeurs et le lecteur ne fait que
 * choisir la bonne méthode. Ici, le parseur (`commands.js`) a fait tout le
 * travail de conversion : le lecteur ne fait plus que servir, et refuser un nom
 * d'option non déclaré. Le refus compte autant des deux côtés — une faute de
 * frappe sur `get('membre')` produirait sinon une commande qui « ne fait rien »,
 * sans le moindre indice.
 */
function creerLecteurOptions(valeurs, descripteur, sousCommande) {
    return {
        get(nom) {
            const declaration = trouverOption(descripteur, sousCommande, nom);
            if (!declaration) {
                const contexte = sousCommande ? `${descripteur.nom} ${sousCommande.nom}` : descripteur.nom;
                throw new Error(`Option « ${nom} » non déclarée par la commande /${contexte}.`);
            }
            const valeur = valeurs?.[nom];
            return valeur === undefined ? null : valeur;
        },
        /** Nom de la sous-commande invoquée, ou null. */
        sousCommande: sousCommande?.nom ?? null,
    };
}

// ─── Contrôle d'accès d'un panneau ───────────────────────────────────────────

/**
 * Valide la règle `autorise` AVANT de rendre le panneau.
 *
 * Même sévérité et même message que côté Discord : une valeur invalide doit
 * échouer à l'appel, pas au fond d'un collecteur où plus personne ne la voit.
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
 * L'option est INERTE sur Fluxer — une réaction emoji n'a pas d'accusé de
 * réception — mais elle est validée quand même. Un `suite: 'saise'` accepté ici
 * en silence ne se révélerait que le jour du portage vers Discord, très loin du
 * fichier fautif.
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
 * Valide le périmètre d'un `choisirMembre`. Même sévérité, même raison : une
 * valeur inconnue retomberait sur le défaut et accepterait n'importe qui du
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
 * Applique la règle `autorise` à une réaction.
 *
 * Sémantique STRICTEMENT identique à celle de l'adaptateur Discord :
 *   - un prédicat reçoit le membre normalisé ;
 *   - 'tous' laisse passer ;
 *   - 'staff' exige MANAGE_GUILD ;
 *   - un nom canonique exige cette permission ;
 *   - le défaut ('auteur') n'autorise que la personne qui a lancé la commande.
 *
 * @param {object} clic  { membre (normalisé), utilisateurId }
 * @param {string} auteurId
 */
function autoriseClic(clic, autorise, auteurId) {
    if (typeof autorise === 'function') return Boolean(autorise(clic.membre));
    if (autorise === 'tous') return true;

    const membre = clic.membre;
    if (autorise === 'staff') return Boolean(membre?.aPermission?.(PERMISSION_STAFF));
    if (typeof autorise === 'string' && autorise !== 'auteur') {
        return Boolean(membre?.aPermission?.(autorise));
    }

    // Défaut : seule la personne qui a lancé la commande peut agir. Sans cette
    // règle, n'importe qui pourrait répondre à sa place sur un panneau posté
    // dans un salon public — et sur Fluxer le panneau EST public par nature.
    return String(clic.utilisateurId) === String(auteurId);
}

// ─── Pose d'un panneau ───────────────────────────────────────────────────────

/**
 * Pose un panneau persistant dans un salon donné.
 *
 * Écrite une fois, exposée sur TOUS les contextes — commande, panneau,
 * événement — exactement comme côté Discord : un panneau ne naît pas toujours
 * d'une commande, celui d'un salon vocal temporaire est posé par
 * `etatVocalModifie`.
 *
 * Le rendu, lui, n'a rien à voir : au lieu d'une rangée de boutons, le bot
 * poste l'embed AVEC sa légende en ligne, puis appose une réaction par choix.
 * L'ordre compte — les réactions sont posées dans l'ordre déclaré, et c'est cet
 * ordre que les gens verront.
 *
 * La ligne `interaction_panels` est écrite ICI et pas par l'appelant : sans
 * elle, la réaction d'un tiers après un redémarrage n'aurait aucun moyen d'être
 * reliée à son panneau. C'est la différence de fond avec Discord, où le
 * `customId` du bouton porte cette information dans le message lui-même.
 *
 * @returns {Promise<{canalId: string, messageId: string|null}>}
 */
async function poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, { panneau, guildeId = null } = {}) {
    exigerNomPanneau('poserPanneau', panneau);
    if (!canalId) throw new Error('poserPanneau : le salon de destination est obligatoire.');

    const { reactions } = rendreChoix(choix, panneau);
    const message = await adaptateur.api.envoyerMessage(canalId, corpsPanneau(contenuOuEmbed, choix, panneau));

    for (const reaction of reactions) {
        // Une réaction refusée (emoji personnalisé d'un autre serveur, droit
        // ADD_REACTIONS manquant) ne doit pas emporter le panneau : les autres
        // choix restent utilisables, et l'incident se voit dans le journal.
        try {
            await adaptateur.api.ajouterReaction(canalId, message.id, reaction.emoji);
        } catch (err) {
            console.error(
                `[Quasar] Panneau ${panneau} : réaction ${reaction.emoji} non posée `
                + `(${err?.codeNeutre || err?.code || err?.message}).`
            );
        }
    }

    adaptateur.enregistrerPanneauPersistant({
        guildeId: guildeId ?? message.guildeId ?? null,
        canalId,
        messageId: message.id,
        panneau,
        choix: reactions,
    });

    return { canalId, messageId: message?.id ?? null };
}

/**
 * Un nom de panneau ne peut pas contenir le séparateur que l'adaptateur place
 * entre le panneau et la clé du choix. La contrainte n'a pas d'objet TECHNIQUE
 * ici — une réaction ne porte pas de `customId` composé — mais elle est
 * appliquée quand même : un descripteur valide d'un côté doit l'être de l'autre,
 * et un nom refusé seulement sur Discord ne se découvrirait qu'à la bascule.
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

// ─── Noyau commun ────────────────────────────────────────────────────────────

/**
 * Cœur du contexte, partagé par les commandes, les panneaux et les dialogues.
 *
 * @param {object} source
 * @param {string}  source.guildeId
 * @param {string}  source.canalId
 * @param {object}  [source.auteur]     compte brut
 * @param {object}  [source.membre]     membre brut
 * @param {string}  [source.messageId]  message d'origine
 * @param {number}  [source.creeLe]
 * @param {object} liaison
 * @param {object}  liaison.adaptateur
 * @param {string}  liaison.etiquette
 */
function creerNoyauContexte(source, { adaptateur, etiquette }) {
    const etat = adaptateur.client?.etat ?? null;
    const auteur = normaliserUtilisateur(source.auteur);
    const membre = source.membre
        ? normaliserMembre(source.membre, { etat, guildeId: source.guildeId, utilisateur: source.auteur })
        : null;

    // Salon du dialogue courant. Un `prompt({ sensible: true })` le bascule en
    // message privé, et tout ce qui suit s'y déroule — sans quoi la moitié d'un
    // parcours RGPD repartirait dans le salon public.
    let canalDialogue = source.canalId;
    // Dernier panneau posé par ce contexte, cible de `modifierPanneau`.
    let dernierPanneau = null;

    /** Envoie un message dans le salon courant. */
    async function poster(contenuOuEmbed, canalId = source.canalId) {
        return adaptateur.api.envoyerMessage(canalId, contenuOuEmbed);
    }

    /**
     * Programme la disparition d'un message.
     *
     * `unref()` est indispensable : sans lui, quinze secondes de minuteur
     * retiennent le processus à l'arrêt, et un redéploiement attend. La
     * suppression est tolérante — si le message a déjà disparu (effacé à la
     * main, salon supprimé), il n'y a rien à signaler.
     */
    function programmerSuppression(canalId, messageId) {
        if (!messageId) return;
        const minuteur = setTimeout(() => {
            adaptateur.api.supprimerMessage(canalId, messageId).catch(() => {});
        }, DELAI_AUTO_SUPPRESSION_MS);
        minuteur.unref?.();
    }

    /**
     * Repli des réponses éphémères, DA §6.3, dans cet ordre :
     *   1. contenu SENSIBLE -> message privé + accusé neutre dans le salon ;
     *   2. sinon -> message dans le salon, auto-supprimé après 15 secondes.
     *
     * Aucun contenu sensible ne repose jamais sur l'auto-suppression : ce n'est
     * pas une garantie de confidentialité, le message est public pendant quinze
     * secondes et reste dans tous les clients qui l'ont chargé.
     */
    async function envoyer(contenuOuEmbed, { ephemere = false, sensible = false } = {}) {
        if (!ephemere) return poster(contenuOuEmbed);

        if (sensible) {
            const prive = await ctx.repondreEnPrive(contenuOuEmbed);
            // L'accusé, lui, est volontairement auto-supprimé : il ne porte rien.
            const accuse = await poster(
                `${auteur?.mention ?? ''} Je vous ai répondu en message privé.`.trim()
            ).catch(() => null);
            if (accuse?.id) programmerSuppression(source.canalId, accuse.id);
            return prive;
        }

        const message = await poster(contenuOuEmbed);
        programmerSuppression(source.canalId, message?.id);
        return message;
    }

    const ctx = {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,

        guildeId: source.guildeId ?? null,
        canalId: source.canalId ?? null,
        guilde: source.guildeId ? normaliserGuilde(etat?.guilde(source.guildeId)) : null,

        // Propriétaire du serveur, remonté au premier niveau du contexte :
        // `resoudrePorteeNeutre` (bot/utils/errors.js) le lit pour construire
        // une portée d'écriture, et c'est par là que la garde « on ne sanctionne
        // pas le propriétaire » devient effective sur la voie neutre.
        proprietaireId: source.guildeId
            ? (etat?.guilde(source.guildeId)?.proprietes?.owner_id ?? null)
            : null,

        auteur,
        membre,

        // Identité du bot, LUE À CHAQUE ACCÈS sur l'adaptateur et non capturée
        // ici : `moi` est nul tant que la connexion n'est pas faite, et un
        // contexte construit avant la connexion figerait ce nul pour toujours.
        get moi() { return adaptateur.moi; },

        // Horodatage de réception, pour mesurer une latence sans rien savoir de
        // la plateforme (utilisé par /ping).
        creeLe: source.creeLe ?? Date.now(),
        latencePasserelle: Number.isFinite(adaptateur.client?.passerelle?.latence)
            ? Math.round(adaptateur.client.passerelle.latence)
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
         *   `ephemere` n'a pas d'équivalent natif : voir la stratégie de repli
         *   ci-dessus. `sensible: true` impose le message privé et INTERDIT
         *   l'auto-suppression.
         */
        repondre(contenuOuEmbed, options = {}) {
            return envoyer(contenuOuEmbed, options);
        },

        /**
         * Message privé à l'auteur. Passe par le client REST normalisé pour que
         * le chemin soit exactement le même sur les deux plateformes.
         *
         * Lève si la personne refuse les messages privés
         * (`CANNOT_SEND_MESSAGES_TO_USER`) : avaler l'échec laisserait croire
         * que l'envoi a eu lieu — inacceptable pour un export RGPD ou un
         * signalement.
         */
        async repondreEnPrive(contenuOuEmbed) {
            const canalId = await adaptateur.api.ouvrirMessagePrive(auteur.id);
            return adaptateur.api.envoyerMessage(canalId, contenuOuEmbed);
        },

        /**
         * Indicateur « je travaille ».
         *
         * Il n'y a RIEN à acquitter sur Fluxer : un message n'expire pas au bout
         * de trois secondes. `differer()` allume donc l'indicateur de saisie
         * (`POST /channels/{id}/typing`), qui dure une dizaine de secondes et
         * dit exactement la même chose à la personne en face.
         *
         * ⚠️ NE LÈVE JAMAIS, même si le salon refuse l'indicateur : une commande
         * qui appelle `differer()` par précaution ne doit pas échouer à cause
         * d'un signal purement cosmétique. C'est la seule méthode du contexte
         * qui avale ses erreurs, et c'est délibéré.
         */
        async differer() {
            try {
                await adaptateur.api.indiquerSaisie(source.canalId);
            } catch { /* purement cosmétique */ }
            return null;
        },

        /** Message supplémentaire après une première réponse. */
        suivre(contenuOuEmbed, options = {}) {
            return envoyer(contenuOuEmbed, options);
        },

        /**
         * Pose un panneau persistant DANS UN SALON DONNÉ.
         * @see poserPanneau, en tête de ce fichier
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, {
                guildeId: source.guildeId, ...options,
            });
        },

        /**
         * Réécrit le message du panneau lui-même — pour le griser, afficher le
         * choix retenu, ou retirer ses réactions. À ne pas confondre avec
         * `repondre`, qui poste une suite.
         *
         * @param {string|object} contenuOuEmbed
         * @param {Array} [choix]  choix neutres à REPOSER. Omis, seul le message
         *   est réécrit et les réactions restent telles quelles — les retirer
         *   implicitement casserait un panneau persistant.
         * @param {{panneau?: string}} [options]
         *
         * ⚠️ Sans `choix`, les RÉACTIONS ne bougent pas : sur Fluxer elles ne
         * font pas partie du corps du message. `{ composants: [] }` (la forme
         * Discord) est donc sans effet ici. Pour griser un panneau, passez les
         * choix avec `desactive: true` : `api.modifierPanneau` retire alors
         * leurs réactions, ce qui les rend réellement inactionnables.
         */
        modifierPanneau(contenuOuEmbed, choix = null, options = {}) {
            const cible = dernierPanneau || (source.messageId
                ? { canalId: source.canalId, messageId: source.messageId }
                : null);
            if (!cible) {
                throw new Error(
                    'ctx.modifierPanneau : aucun panneau posé par ce contexte et aucun message d\'origine. '
                    + 'Appelez ctx.choose() ou ctx.poserPanneau() d\'abord.'
                );
            }
            // Avec des choix : on repose la légende ET les réactions, en
            // déléguant à `api.modifierPanneau` — écrit une seule fois, pour que
            // poser et reposer ne divergent jamais d'une réaction.
            if (choix) {
                return adaptateur.api.modifierPanneau(
                    cible.canalId, cible.messageId, contenuOuEmbed, choix,
                    { panneau: exigerNomPanneau('modifierPanneau', options.panneau || ctx.panneau?.nom || etiquette) },
                );
            }
            return adaptateur.api.modifierMessage(cible.canalId, cible.messageId, contenuOuEmbed);
        },

        /**
         * Erreur d'USAGE : ce n'est pas un bug, rien n'est journalisé et aucun
         * code d'incident n'est affiché. Même embed que `userError()`, dont
         * cette méthode est le passage neutre.
         *
         * On construit l'embed ici plutôt que d'appeler `userError(ctx, …)` :
         * `userError` délègue à `ctx.erreurUtilisateur` dès qu'il reçoit un
         * contexte neutre, et l'appeler d'ici boucherait l'appel sur lui-même.
         */
        erreurUtilisateur({ titre, cause, action, ephemere = true }) {
            const { construireEmbedErreur } = require('../../utils/errors');
            return envoyer(construireEmbedErreur({ title: titre, cause, action }), { ephemere });
        },

        // ─── Primitives de substitution (DA §6) ──────────────────────────────

        /**
         * Collecte une saisie — un DIALOGUE SÉQUENTIEL (DA §6.1).
         *
         * Le bot pose une question par champ et attend la réponse dans le salon,
         * ou en privé si `sensible`. La longueur est validée à chaque étape et
         * la question reposée en cas de dépassement, `annuler` interrompt,
         * l'expiration au bout de `delai` secondes rend `null`.
         *
         * Retour IDENTIQUE à Discord : un objet `{ cle: valeur }`, ou `null` en
         * cas d'annulation ou d'expiration. Le code métier ne voit aucune
         * différence — c'est tout l'intérêt de la primitive.
         *
         * ⚠️ Contrairement à Discord, `prompt()` peut suivre n'importe quoi : il
         * n'y a pas d'interaction à garder vierge. Un `choose()` ou un
         * `differer()` avant lui ne pose aucun problème.
         *
         * @param {Array<{cle, libelle, style?, max?, min?, requis?, valeur?, exemple?}>} questions
         * @param {{titre?: string, delai?: number, sensible?: boolean}} [options]
         */
        async prompt(questions, options = {}) {
            const { etapes } = rendrePrompt(questions, options, `qprompt:${compteurDialogues++}`);
            const delai = (options.delai ?? DELAI_PROMPT_DEFAUT) * 1000;
            const echeance = Date.now() + delai;

            // Un formulaire sensible ne se remplit pas en public. On bascule le
            // dialogue en privé, et on laisse un accusé neutre dans le salon.
            let canal = canalDialogue;
            if (options.sensible) {
                canal = await adaptateur.api.ouvrirMessagePrive(auteur.id);
                canalDialogue = canal;
                await poster(`${auteur?.mention ?? ''} Je vous écris en message privé.`.trim())
                    .then(m => programmerSuppression(source.canalId, m?.id))
                    .catch(() => {});
            }

            const reponses = {};
            for (const etape of etapes) {
                let valeur = null;

                // Boucle de validation : une réponse trop courte ou trop longue
                // repose la question au lieu d'abandonner la saisie déjà faite.
                for (;;) {
                    const restant = echeance - Date.now();
                    if (restant <= 0) return null;

                    await adaptateur.api.envoyerMessage(canal, etape.question);
                    const message = await adaptateur.attendreMessage({
                        canalId: canal,
                        auteurId: auteur.id,
                        delai: restant,
                    });
                    if (!message) return null;                       // expiration

                    const saisie = (message.content ?? '').trim();
                    if (saisie.toLowerCase() === MOT_ANNULATION) return null;

                    // `-` passe un champ facultatif. Le choix d'un caractère
                    // plutôt que d'un message vide est délibéré : Fluxer refuse
                    // un message sans contenu visible (CANNOT_SEND_EMPTY_MESSAGE),
                    // il n'existe donc aucune façon d'envoyer « rien ».
                    if (!etape.requis && saisie === '-') { valeur = ''; break; }

                    if (etape.requis && saisie.length === 0) {
                        await adaptateur.api.envoyerMessage(canal, '⚠️ Ce champ est obligatoire.');
                        continue;
                    }
                    if (etape.min && saisie.length < etape.min) {
                        await adaptateur.api.envoyerMessage(
                            canal, `⚠️ ${etape.min} caractères minimum (reçu : ${saisie.length}).`
                        );
                        continue;
                    }
                    if (etape.max && saisie.length > etape.max) {
                        await adaptateur.api.envoyerMessage(
                            canal, `⚠️ ${etape.max} caractères maximum (reçu : ${saisie.length}).`
                        );
                        continue;
                    }
                    valeur = saisie;
                    break;
                }

                reponses[etape.cle] = valeur;
            }
            return reponses;
        },

        /**
         * Propose des actions — des RÉACTIONS EMOJI (DA §6.2).
         *
         * L'embed est posté avec la légende des choix EN LIGNE, le bot appose
         * une réaction par choix dans l'ordre déclaré, et écoute
         * `MESSAGE_REACTION_ADD`.
         *
         * @param {string|object} message
         * @param {Array<{cle, libelle, emoji, style?, desactive?}>} choix
         *   ⚠️ `emoji` est OBLIGATOIRE ici : un choix EST une réaction. Un choix
         *   sans emoji lève, plutôt que d'être silencieusement inatteignable.
         * @param {object} [options] mêmes clés que côté Discord
         * @param {boolean} [options.persistant]  panneau durable
         * @param {string}  [options.panneau]     nom du panneau persistant
         * @param {string|Function} [options.autorise] 'auteur' (défaut), 'tous',
         *        'staff', un nom canonique de permission, ou un prédicat
         * @param {number}  [options.delai]       secondes, panneau éphémère seulement
         * @param {boolean} [options.ephemere]
         * @param {boolean} [options.sensible]
         * @param {'message'|'saisie'} [options.suite]  INERTE ici, voir ci-dessous
         * @returns {Promise<string|null|{persistant: true, canalId, messageId}>}
         *
         * ⚠️ `suite` n'a aucun effet sur Fluxer. Côté Discord elle décide si le
         * clic est acquitté, pour qu'un formulaire puisse s'ouvrir dessus ; ici,
         * une réaction n'a pas d'accusé de réception et `ctx.prompt()` s'ouvre
         * de la même façon dans les deux cas. L'option est validée mais ignorée,
         * comme la DA §6.2 le prévoit.
         *
         * ⚠️ Le bot IGNORE SES PROPRES RÉACTIONS. Il pose lui-même les emojis du
         * panneau : sans ce filtre, chaque panneau se déclencherait tout seul à
         * sa création. C'est le piège le plus prévisible du lot.
         */
        async choose(message, choix, options = {}) {
            validerAutorise(options.autorise);
            validerSuite(options.suite);

            const persistant = Boolean(options.persistant);
            const panneau = options.panneau || etiquette;
            const { reactions, legende } = rendreChoix(choix, panneau);

            // Un panneau persistant a un salon et une ligne en base : c'est
            // exactement `poserPanneau`, appliqué au salon courant. Pas de
            // seconde implémentation — les deux chemins doivent produire le même
            // message et la même ligne, sans quoi un panneau posé par `/ticket
            // setup` et un panneau posé par `ctx.choose` se routeraient
            // différemment.
            if (persistant) {
                return { persistant: true, ...(await poserPanneau(
                    adaptateur, source.canalId, message, choix, { panneau, guildeId: source.guildeId },
                )) };
            }

            // Panneau éphémère. `{ ephemere: true }` retombe sur la stratégie de
            // repli : sensible -> privé, sinon auto-suppression. Le panneau est
            // alors posé LÀ où il est lisible, et c'est ce salon qu'on écoute.
            let canal = source.canalId;
            if (options.ephemere && options.sensible) {
                canal = await adaptateur.api.ouvrirMessagePrive(auteur.id);
            }

            const poste = await adaptateur.api.envoyerMessage(canal, composerPanneau(message, legende));
            dernierPanneau = { canalId: canal, messageId: poste.id };

            for (const reaction of reactions) {
                try {
                    await adaptateur.api.ajouterReaction(canal, poste.id, reaction.emoji);
                } catch (err) {
                    console.error(
                        `[Quasar] choose : réaction ${reaction.emoji} non posée `
                        + `(${err?.codeNeutre || err?.code || err?.message}).`
                    );
                }
            }

            const cles = new Map(reactions.map(r => [r.emoji, r.cle]));
            const retenu = await adaptateur.attendreReaction({
                canalId: canal,
                messageId: poste.id,
                delai: (options.delai ?? DELAI_CHOOSE_DEFAUT) * 1000,
                accepte: (evenement) => {
                    const emoji = evenement.emojiCle;
                    if (!cles.has(emoji)) return false;
                    return autoriseClic(evenement, options.autorise, auteur.id);
                },
            });

            if (options.ephemere && !options.sensible) programmerSuppression(canal, poste.id);
            if (!retenu) return null;
            return cles.get(retenu.emojiCle) ?? null;
        },

        /**
         * Demande de DÉSIGNER QUELQU'UN (DA §6).
         *
         * Il n'existe aucun sélecteur sur Fluxer : le bot demande, la personne
         * mentionne ou colle un identifiant, et la réponse est validée contre le
         * même `parmi` que côté Discord. Le code métier ne voit pas la
         * différence — il décrit qui choisir, pas comment.
         *
         * @returns {Promise<{id, nom, mention}|null>} `null` à expiration, à
         *   l'annulation, ou si personne n'est sélectionnable.
         */
        async choisirMembre(message, options = {}) {
            validerAutorise(options.autorise);
            validerPerimetreMembre(options.parmi);

            const perimetre = options.parmi || 'serveur';
            const delai = (options.delai ?? DELAI_CHOOSE_DEFAUT) * 1000;
            const echeance = Date.now() + delai;

            // Périmètre « salon vocal » : la liste est lue AVANT l'envoi, pour
            // pouvoir dire « il n'y a personne » plutôt que d'ouvrir un dialogue
            // qu'aucune réponse ne pourrait satisfaire.
            let membres = [];
            if (perimetre === 'salonVocal') {
                const canalId = options.canalId ?? source.canalId;
                membres = (await adaptateur.api.listerMembresVocal(canalId)) || [];
                membres = membres.filter(m => m.id !== auteur.id && !m.estBot);
                if (membres.length === 0) return null;
            }

            const consigne = rendreSelecteurMembre(null, {
                perimetre, membres, exemple: options.exemple,
            });
            await envoyer(composerPanneau(message, consigne), {
                ephemere: options.ephemere, sensible: options.sensible,
            });

            for (;;) {
                const restant = echeance - Date.now();
                if (restant <= 0) return null;

                const reponse = await adaptateur.attendreMessage({
                    canalId: source.canalId,
                    // `autorise` décide QUI peut répondre. Le défaut ('auteur')
                    // est le comportement de Discord, où le sélecteur n'est
                    // cliquable que par la personne filtrée.
                    accepte: (evenement) => autoriseClic(evenement, options.autorise, auteur.id),
                    delai: restant,
                });
                if (!reponse) return null;

                const saisie = (reponse.content ?? '').trim();
                if (saisie.toLowerCase() === MOT_ANNULATION) return null;

                const id = extraireIdentifiantMembre(saisie);
                if (!id) {
                    await poster('⚠️ Je n\'ai pas reconnu de personne. Mentionnez-la, ou collez son identifiant.');
                    continue;
                }
                if (perimetre === 'salonVocal' && !membres.some(m => m.id === id)) {
                    await poster('⚠️ Cette personne n\'est pas dans le salon vocal.');
                    continue;
                }

                const connu = membres.find(m => m.id === id);
                if (connu) return { id: connu.id, nom: connu.nom ?? id, mention: `<@${id}>` };

                const membreServeur = source.guildeId
                    ? await adaptateur.api.obtenirMembre(source.guildeId, id)
                    : null;
                if (source.guildeId && !membreServeur) {
                    await poster('⚠️ Cette personne n\'est pas sur ce serveur.');
                    continue;
                }
                return {
                    id,
                    nom: membreServeur?.nom ?? id,
                    mention: `<@${id}>`,
                };
            }
        },
    };

    return ctx;
}

/**
 * Identifiant d'une personne, depuis une mention ou un identifiant brut.
 *
 * `<@id>` est la forme écrite par un client ; `<@!id>` est la forme héritée que
 * certains clients produisent encore pour une mention de membre avec pseudo. Les
 * deux sont acceptées, comme dans le parseur de commandes — une même saisie doit
 * se comporter pareil partout.
 */
function extraireIdentifiantMembre(texte) {
    const mention = /^<@!?(\d+)>$/.exec(String(texte).trim());
    if (mention) return mention[1];
    const brut = /^(\d{5,})$/.exec(String(texte).trim());
    return brut ? brut[1] : null;
}

// ─── Contextes concrets ──────────────────────────────────────────────────────

/**
 * Contexte d'une commande préfixée.
 *
 * @param {object} source  produit par le parseur (`commands.js`)
 * @param {{adaptateur, descripteur, sousCommande?, valeurs?}} liaison
 */
function creerContexteCommande(source, { adaptateur, descripteur, sousCommande = null, valeurs = {} }) {
    const ctx = creerNoyauContexte(source, { adaptateur, etiquette: `qpanel:${descripteur.nom}` });
    ctx.options = creerLecteurOptions(valeurs, descripteur, sousCommande);
    ctx.commande = descripteur.nom;

    // ─── Commandes personnalisées, serveur par serveur ───────────────────────
    //
    // Le serveur n'est PAS un paramètre : une commande agit sur le sien, et le
    // laisser choisir ouvrirait un enregistrement sur n'importe quel serveur
    // depuis n'importe quel message.
    //
    // Inertes ici, et rendant `true` : sur Fluxer une commande personnalisée est
    // une ligne de `custom_commands` que le parseur consulte quand aucune
    // commande déclarée ne correspond. Il n'y a rien à enregistrer auprès de la
    // plateforme — « rien à faire » est un succès, et `/cmd` n'a pas à tester
    // la plateforme pour le savoir.

    /** @param {{nom: string, description: string}} commande */
    ctx.deployerCommandeServeur = (commande) =>
        adaptateur.deployerCommandeServeur(ctx.guildeId, commande);

    /** @param {string} nom */
    ctx.retirerCommandeServeur = (nom) =>
        adaptateur.retirerCommandeServeur(ctx.guildeId, nom);

    return ctx;
}

/**
 * Contexte d'une réaction sur un panneau persistant.
 *
 * Le contexte est COMPLET — `repondre`, `prompt`, `choose`, `api`, `db` — parce
 * que c'est ce que le contrat promet : un handler de panneau doit pouvoir ouvrir
 * un formulaire directement. Sur Fluxer il n'y a aucune contrepartie à cette
 * promesse : pas de fenêtre de trois secondes, pas d'interaction à garder
 * vierge. C'est même la plateforme où le parcours « panneau puis formulaire »
 * est le plus simple.
 */
function creerContextePanneau(source, { adaptateur, panneau, cle }) {
    const ctx = creerNoyauContexte(source, { adaptateur, etiquette: panneau });
    ctx.panneau = {
        nom: panneau,
        cle,
        messageId: source.messageId ?? null,
    };
    return ctx;
}

/**
 * Contexte réduit servi aux handlers d'autocomplétion.
 *
 * ⚠️ INATTEIGNABLE sur Fluxer : l'autocomplétion est une interaction, et il n'y
 * en a pas. Le chargeur de commandes n'enregistre donc aucun handler `completer`
 * (cf. `commands.js`). La fabrique existe pour que la surface du module soit la
 * même des deux côtés — un test de miroir le vérifie — et pour que le jour où
 * Fluxer livre les interactions, il n'y ait qu'à la brancher.
 */
function creerContexteCompletion(source, { adaptateur, descripteur }) {
    return {
        plateforme: adaptateur.nom,
        capacites: adaptateur.capacites,
        guildeId: source.guildeId ?? null,
        canalId: source.canalId ?? null,
        auteur: normaliserUtilisateur(source.auteur),
        api: adaptateur.api,
        get db() { return require('../../../api/services/database').getDb(); },
        saisie: source.saisie ?? { name: null, value: '' },
        repondre() {
            throw new Error(
                'L\'autocomplétion n\'existe pas sur Fluxer : la plateforme ne dispatche aucune '
                + 'interaction. Le chargeur de commandes n\'enregistre pas les handlers « completer ».'
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
    // Réexportés depuis `render.js`, où vit désormais la composition d'un
    // panneau : les appelants historiques les trouvaient ici.
    corpsPanneau,
    composerPanneau,
    validerAutorise,
    validerSuite,
    validerPerimetreMembre,
    autoriseClic,
    extraireIdentifiantMembre,
    normaliserUtilisateur,
    normaliserMembre,
    normaliserRole,
    estRoleParDefaut,
    couleurRole,
    etiquetteUtilisateur,
    fabriqueAvatar,
    baseMedia,
    normaliserCanal,
    normaliserGuilde,
    masqueSurCanal,
    DELAI_PROMPT_DEFAUT,
    DELAI_CHOOSE_DEFAUT,
    DELAI_AUTO_SUPPRESSION_MS,
    BASE_MEDIA_DEFAUT,
    PERMISSION_STAFF,
    MODES_AUTORISE,
    SUITES_CHOOSE,
    PERIMETRES_MEMBRE,
};
