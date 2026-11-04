// ═══════════════════════════════════════════════════════════════
//  Rendu Fluxer des structures neutres
//
//  Trois traductions, les mêmes que côté Discord, avec des cibles très
//  différentes :
//
//    embed neutre  -> objet JSON « rich embed input » de l'API Fluxer
//    ctx.choose    -> une réaction emoji par choix + une LÉGENDE en ligne
//    ctx.prompt    -> une suite de questions posées une par une
//
//  Rien ici n'appelle l'API : ces fonctions construisent, `context.js` envoie.
//  La séparation permet de tester tout le rendu sans jeton et sans réseau.
//
//  ⚠️ Fluxer n'a AUCUNE interaction — ni bouton, ni menu, ni formulaire
//  (`fluxer_gateway/src/utils/event_atoms.erl` ne dispatche pas d'événement
//  d'interaction, et il n'existe aucune route de composant dans l'API HTTP).
//  Là où `discord/render.js` produit des composants, ce fichier produit du
//  TEXTE et des emojis. C'est la seule différence structurante du lot 6.
// ═══════════════════════════════════════════════════════════════

const { estEmbed, ressembleAEmbedDiscord } = require('../embed');

// Clés reconnues d'un corps de message composé. Identiques à celles de
// l'adaptateur Discord : c'est le vocabulaire NEUTRE, il ne dépend pas de la
// plateforme. `composants` en fait partie et est accepté ici — voir plus bas.
const CLES_CORPS = Object.freeze(['contenu', 'embeds', 'fichiers', 'composants', 'mentionsAutorisees']);

// Un message Fluxer porte au plus `max_reactions_per_message` groupes de
// réaction distincts, « which defaults to 30 » (messages.mdx, § Reaction
// object). C'est le plafond d'un panneau `ctx.choose`.
//
// ⚠️ Discord, lui, plafonne à 25 (5 boutons × 5 rangées). Un panneau de 26 à 30
// choix passerait donc ici et serait refusé là-bas : le plafond PORTABLE reste
// 25, et c'est celui qu'un descripteur doit viser.
const REACTIONS_MAX = 30;

// Aucun équivalent des rangées de boutons : les deux constantes n'existent que
// pour que la surface du module soit la même des deux côtés, ce qu'un test de
// miroir vérifie. Elles valent le plafond Discord, qui est la contrainte
// portable, et ne servent à rien dans le rendu Fluxer.
const BOUTONS_PAR_RANGEE = 5;
const RANGEES_MAX = 5;

// Un dialogue séquentiel n'a pas de plafond de plateforme : c'est une suite de
// messages. On garde néanmoins celui d'un formulaire Discord, pour qu'un
// `ctx.prompt` écrit pour Fluxer reste posable sur Discord — et parce qu'au-delà
// de cinq questions posées une par une, personne ne va au bout.
const CHAMPS_PROMPT_MAX = 5;

// Les styles de bouton n'ont aucun rendu ici : une réaction emoji n'a pas de
// couleur. La table est conservée pour valider ce qu'un descripteur déclare —
// un `style: 'primaire '` fautif doit se voir sur les deux plateformes, pas
// seulement sur celle qui rend des boutons.
const STYLES_BOUTON = Object.freeze({
    primaire: 'primaire',
    secondaire: 'secondaire',
    succes: 'succes',
    danger: 'danger',
    lien: 'lien',
});

// Idem pour les styles de saisie : le dialogue séquentiel accepte une ligne
// comme un paragraphe, la distinction ne change que la consigne affichée.
const STYLES_SAISIE = Object.freeze({
    ligne: 'ligne',
    paragraphe: 'paragraphe',
});

// Mot que la personne tape pour interrompre un dialogue (DA §6.1). En minuscule
// et sans accent à la comparaison : « Annuler » et « annuler » doivent marcher.
const MOT_ANNULATION = 'annuler';

/**
 * Couleur neutre -> entier.
 * Accepte l'entier historique du dépôt (0xc8a86e) et la chaîne « #rrggbb »,
 * forme stockée en base pour les embeds du dashboard. Strictement identique à
 * la fonction Discord : la couleur neutre ne dépend pas de la plateforme.
 */
function couleurVersEntier(couleur) {
    if (couleur === undefined || couleur === null) return undefined;
    if (typeof couleur === 'number') return couleur;
    if (typeof couleur === 'string') {
        const entier = Number.parseInt(couleur.replace(/^#/, ''), 16);
        return Number.isNaN(entier) ? undefined : entier;
    }
    return undefined;
}

/** `horodatage` neutre -> ISO 8601, la forme qu'attend l'API Fluxer. */
function horodatageVersIso(horodatage) {
    if (horodatage === true) return new Date().toISOString();
    if (horodatage instanceof Date) return horodatage.toISOString();
    if (typeof horodatage === 'number' || typeof horodatage === 'string') {
        const date = new Date(horodatage);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return null;
}

/**
 * Embed neutre -> « rich embed input » de l'API Fluxer.
 *
 * Source de la forme : `http-api/messages.mdx`, § « Rich embed input objects ».
 * Le JSON est celui de Discord à un détail près : Fluxer stocke toujours
 * `type: "rich"` lui-même et n'accepte pas le champ en entrée, donc on ne
 * l'envoie pas.
 *
 * Chaque champ n'est posé que s'il est renseigné. Ce n'est pas de la cosmétique :
 * « A nested object that omits its own required field is discarded. An author
 * without name, a media object without url, and a footer without text are read
 * as if the field had not been sent. » Un `{ text: undefined }` serait donc jeté
 * en silence, pas signalé.
 */
function rendreEmbed(neutre) {
    // Garde d'entrée, pour la même raison que côté Discord : `rendreEmbed` est
    // appelée en boucle sur `corps.embeds`, où un EmbedBuilder recopié par
    // habitude passerait sans bruit et ressortirait vide.
    if (!estEmbed(neutre)) {
        throw new TypeError(
            ressembleAEmbedDiscord(neutre)
                ? 'Embed au format Discord passé à rendreEmbed(). Construisez-le avec `embed({ … })` '
                    + 'de bot/platform/embed.js.'
                : `Embed neutre attendu, reçu ${neutre === null ? 'null' : typeof neutre}.`
        );
    }

    const rendu = {};

    if (neutre.titre) rendu.title = neutre.titre;
    if (neutre.description) rendu.description = neutre.description;

    const couleur = couleurVersEntier(neutre.couleur);
    // Masque 24 bits : la palette du dépôt tient dedans (0xc8a86e), et Fluxer
    // écrit ses couleurs de rôle « in the range 0 through 16777215 »
    // (permissions.mdx). L'entrée d'embed ne publie pas de borne, mais envoyer
    // une valeur hors plage exposerait au rejet du message ENTIER.
    // À VÉRIFIER EN RECETTE : une couleur > 0xFFFFFF est-elle rejetée, tronquée
    // ou acceptée par l'API ? Le masque la rend inoffensive dans les trois cas.
    if (couleur !== undefined) rendu.color = couleur & 0xFFFFFF;

    if (Array.isArray(neutre.champs) && neutre.champs.length > 0) {
        rendu.fields = neutre.champs.map(champ => ({
            name: champ.nom,
            value: champ.valeur,
            inline: Boolean(champ.enLigne),
        }));
    }

    if (neutre.pied) {
        const texte = typeof neutre.pied === 'string' ? neutre.pied : neutre.pied.texte;
        if (texte) {
            rendu.footer = { text: texte };
            const icone = typeof neutre.pied === 'string' ? undefined : neutre.pied.icone;
            if (icone) rendu.footer.icon_url = icone;
        }
    }
    if (neutre.auteur) {
        const nom = typeof neutre.auteur === 'string' ? neutre.auteur : neutre.auteur.nom;
        if (nom) {
            rendu.author = { name: nom };
            if (typeof neutre.auteur === 'object') {
                if (neutre.auteur.icone) rendu.author.icon_url = neutre.auteur.icone;
                if (neutre.auteur.url) rendu.author.url = neutre.auteur.url;
            }
        }
    }
    // `image` et `thumbnail` sont des OBJETS côté Fluxer comme côté Discord :
    // « Embed media input object | url | string ». Une chaîne nue serait rejetée.
    if (neutre.image) rendu.image = { url: neutre.image };
    if (neutre.vignette) rendu.thumbnail = { url: neutre.vignette };
    // Rendu sur le TITRE, exactement comme Discord : l'embed n'a qu'un `url`.
    if (neutre.lien) rendu.url = neutre.lien;

    const iso = horodatageVersIso(neutre.horodatage);
    if (iso) rendu.timestamp = iso;

    return rendu;
}

/**
 * Pièce jointe neutre -> forme intermédiaire de l'adaptateur.
 * `{ nom, donnees, description? }` où `donnees` est un Buffer, une chaîne ou un
 * flux. C'est `api.js` qui décide ensuite comment la poster — voir
 * `requeteMessage`, dont le multipart Fluxer n'est PAS celui de Discord.
 */
function rendreFichier(fichier) {
    if (!fichier || !fichier.nom) {
        throw new Error('Pièce jointe invalide : { nom, donnees } est le minimum attendu.');
    }
    return { attachment: fichier.donnees, name: fichier.nom, description: fichier.description };
}

/**
 * Contenu neutre -> corps de message intermédiaire.
 *
 * Formes acceptées, identiques à celles de l'adaptateur Discord :
 *   - une chaîne ;
 *   - un embed neutre, ou un tableau d'embeds neutres ;
 *   - un corps composé `{ contenu, embeds, fichiers, composants, mentionsAutorisees }`.
 *
 * Les clés produites sont celles de l'adaptateur Discord (`content`, `embeds`,
 * `files`, `allowedMentions`) et non celles de l'API : c'est `api.corpsMessage`
 * qui fait la conversion finale, en un seul endroit, avec une table qui LÈVE sur
 * une clé sans correspondance.
 *
 * ⚠️ Un embed au format Discord est REFUSÉ avec une exception qui le dit, pour
 * la même raison que côté Discord : le tolérer produirait un embed à moitié
 * rendu, et l'erreur apparaîtrait très loin de sa cause.
 */
function rendreContenu(contenuOuEmbed) {
    if (contenuOuEmbed === null || contenuOuEmbed === undefined) return {};
    if (typeof contenuOuEmbed === 'string') return { content: contenuOuEmbed };
    if (Array.isArray(contenuOuEmbed)) return { embeds: contenuOuEmbed.map(rendreEmbed) };
    if (estEmbed(contenuOuEmbed)) return { embeds: [rendreEmbed(contenuOuEmbed)] };

    if (typeof contenuOuEmbed === 'object' && CLES_CORPS.some(cle => cle in contenuOuEmbed)) {
        const payload = {};
        if (contenuOuEmbed.contenu !== undefined) payload.content = contenuOuEmbed.contenu;
        if (contenuOuEmbed.embeds) payload.embeds = contenuOuEmbed.embeds.map(rendreEmbed);
        if (contenuOuEmbed.fichiers) payload.files = contenuOuEmbed.fichiers.map(rendreFichier);
        // `composants` est accepté et IGNORÉ. Fluxer n'a pas de composants : les
        // rendre sous une forme quelconque ne produirait rien d'utilisable, et
        // les REFUSER casserait un code métier parfaitement portable qui pose
        // un panneau par `ctx.choose` — la primitive neutre, elle, marche des
        // deux côtés. Le silence est ici le bon comportement, et il est déclaré.
        if (contenuOuEmbed.mentionsAutorisees) payload.allowedMentions = contenuOuEmbed.mentionsAutorisees;
        return payload;
    }

    if (ressembleAEmbedDiscord(contenuOuEmbed)) {
        throw new TypeError(
            'Embed au format Discord passé à la couche neutre. Construisez-le avec '
            + '`embed({ titre, description, couleur, champs, … })` de bot/platform/embed.js : '
            + 'un EmbedBuilder ou un APIEmbed ne serait rendu qu\'à moitié.'
        );
    }

    throw new TypeError(
        `Contenu non reconnu par la couche neutre (${Object.keys(contenuOuEmbed).join(', ') || 'objet vide'}). `
        + `Attendu : une chaîne, un embed neutre, ou un corps { ${CLES_CORPS.join(', ')} }.`
    );
}

/**
 * Ajoute la légende des choix au contenu du panneau.
 *
 * Sur un embed, elle est APPENDUE à la description : la DA §6.2 impose que le
 * libellé soit lisible « en regard de son emoji », et un embed dont la
 * description s'arrête avant les choix laisse une rangée d'emojis muets.
 * Sur un contenu texte, elle est ajoutée après une ligne vide.
 *
 * Trois formes d'entrée, les mêmes que `rendreContenu` :
 *   - une chaîne ;
 *   - un embed neutre ;
 *   - un CORPS COMPOSÉ `{ contenu, embeds, fichiers, mentionsAutorisees }`.
 *
 * La troisième existe pour qu'un panneau puisse porter ses mentions et ses
 * pièces jointes dans LE MÊME message : sans elle, l'ouverture d'un ticket poste
 * les mentions à part, et le salon reçoit deux messages là où il en attendait
 * un. La légende va alors sur le PREMIER embed, et à défaut d'embed sur le
 * contenu texte — c'est là qu'on la lit.
 *
 * Rien n'est modifié en place : l'appelant peut réutiliser son embed (un panneau
 * reposté à chaque redémarrage, par exemple) sans le voir grossir d'une légende
 * à chaque passage.
 */
function composerPanneau(contenuOuEmbed, legende) {
    if (!legende) return contenuOuEmbed;
    if (typeof contenuOuEmbed === 'string') return `${contenuOuEmbed}\n\n${legende}`;
    if (!contenuOuEmbed || typeof contenuOuEmbed !== 'object') return contenuOuEmbed;

    // Tableau d'embeds : la légende va sur le premier, celui qu'on voit.
    if (Array.isArray(contenuOuEmbed)) {
        return contenuOuEmbed.map((e, i) => (i === 0 ? avecLegende(e, legende) : e));
    }

    // Corps composé. On le reconnaît à ses clés propres et NON à l'absence de
    // celles d'un embed : `{ contenu: '…' }` est un corps, `{ description: '…' }`
    // est un embed, et les confondre ferait disparaître la légende.
    if (estCorpsCompose(contenuOuEmbed)) {
        const corps = { ...contenuOuEmbed };
        if (Array.isArray(corps.embeds) && corps.embeds.length > 0) {
            corps.embeds = corps.embeds.map((e, i) => (i === 0 ? avecLegende(e, legende) : e));
        } else {
            corps.contenu = corps.contenu ? `${corps.contenu}\n\n${legende}` : legende;
        }
        return corps;
    }

    return avecLegende(contenuOuEmbed, legende);
}

/** Clés qui n'appartiennent qu'à un corps composé, jamais à un embed neutre. */
const CLES_CORPS_COMPOSE = Object.freeze(['contenu', 'embeds', 'fichiers', 'composants', 'mentionsAutorisees']);

function estCorpsCompose(valeur) {
    return CLES_CORPS_COMPOSE.some(cle => cle in valeur);
}

/** Embed neutre + légende, en recopie. */
function avecLegende(embedNeutre, legende) {
    if (!embedNeutre || typeof embedNeutre !== 'object') return embedNeutre;
    const description = embedNeutre.description
        ? `${embedNeutre.description}\n\n${legende}`
        : legende;
    return { ...embedNeutre, description };
}

/**
 * Corps d'un panneau persistant : contenu + légende des choix, prêt pour
 * `api.envoyerMessage` ou `api.modifierMessage`.
 *
 * Écrit une seule fois parce qu'il sert aux DEUX sens — poser un panneau
 * (`ctx.poserPanneau`) et le réécrire (`api.modifierPanneau`). Deux
 * constructions séparées finiraient par diverger, et un panneau réécrit sans sa
 * légende est une rangée d'emojis dont plus personne ne sait ce qu'ils font.
 *
 * Le pendant exact de `corpsPanneau` côté Discord, à la cible près : là-bas il
 * produit des `composants`, ici une LÉGENDE dans le texte. Les RÉACTIONS, elles,
 * ne font pas partie du corps d'un message Fluxer — elles sont apposées après
 * l'envoi, par `ctx.poserPanneau` et `api.modifierPanneau`.
 *
 * @param {string|object} contenuOuEmbed  chaîne, embed neutre, ou corps composé
 * @param {Array} choix
 * @param {string} [panneau]
 * @returns {string|object} corps NEUTRE, légende incluse
 */
function corpsPanneau(contenuOuEmbed, choix, panneau) {
    if (contenuOuEmbed && typeof contenuOuEmbed === 'object'
        && !Array.isArray(contenuOuEmbed) && contenuOuEmbed.composants !== undefined) {
        throw new Error(
            'Panneau : « composants » n\'a pas à être fourni — ce sont les choix qui les décident. '
            + 'Passez-les dans l\'argument `choix`.'
        );
    }
    const { legende } = rendreChoix(choix, panneau);
    return composerPanneau(contenuOuEmbed, legende);
}

/**
 * Découpe une liste de choix en rangées.
 *
 * ⚠️ SANS OBJET ICI, et volontairement présent quand même.
 *
 * Le découpage est une donnée de MISE EN PAGE : « ces trois boutons vont
 * ensemble » se dit de la même façon partout. Fluxer, lui, n'a pas de rangées —
 * un choix y est une réaction, et les emojis s'alignent comme le client les
 * affiche. Mais un descripteur unique sert les DEUX plateformes : refuser ici
 * une mise en page valide là-bas rendrait ce descripteur non portable, et
 * l'accepter sans la VALIDER laisserait passer un mélange que Discord refuse —
 * qui ne se découvrirait qu'à la bascule.
 *
 * Les trois écritures, identiques à celles de `discord/render.js` :
 *   • un tableau PLAT — rempli par rangées de cinq, le défaut ;
 *   • un tableau de RANGÉES, `[[a, b, c], [d, e]]` ;
 *   • un tableau plat dont un choix porte `nouvelleRangee: true`.
 *
 * @param {Array} choix
 * @returns {Array<Array>} les rangées, vides écartées
 */
function decouperRangees(choix) {
    const rangeesExplicites = choix.filter(entree => Array.isArray(entree));
    if (rangeesExplicites.length > 0) {
        if (rangeesExplicites.length !== choix.length) {
            throw new Error(
                'ctx.choose : mélange de choix et de rangées. Passez un tableau PLAT de choix, '
                + 'ou un tableau de rangées — jamais les deux dans la même liste.'
            );
        }
        return choix.filter(rangee => rangee.length > 0);
    }

    if (!choix.some(option => option?.nouvelleRangee)) {
        const rangees = [];
        for (let debut = 0; debut < choix.length; debut += BOUTONS_PAR_RANGEE) {
            rangees.push(choix.slice(debut, debut + BOUTONS_PAR_RANGEE));
        }
        return rangees;
    }

    const rangees = [[]];
    for (const option of choix) {
        if (option?.nouvelleRangee && rangees[rangees.length - 1].length > 0) rangees.push([]);
        rangees[rangees.length - 1].push(option);
    }
    return rangees.filter(rangee => rangee.length > 0);
}

/**
 * Ramène une déclaration de choix à une liste plate, quelle que soit sa mise en
 * page.
 *
 * L'ORDRE déclaré est conservé de bout en bout : c'est lui qui décide de l'ordre
 * dans lequel les réactions sont apposées, donc de l'ordre que les gens voient.
 * Les rangées, elles, disparaissent — elles n'ont pas de rendu ici.
 */
function aplatirChoix(choix) {
    if (!Array.isArray(choix)) return [];
    return decouperRangees(choix)
        .flat()
        .filter(entree => entree && typeof entree === 'object');
}

/**
 * Choix neutres -> réactions à apposer, et légende à afficher.
 *
 * C'est le cœur du rendu Fluxer de `ctx.choose` (DA §6.2). Un choix devient une
 * réaction emoji, et son LIBELLÉ est rendu en ligne dans l'embed en regard de
 * son emoji : sans cette légende, un panneau n'est qu'une rangée d'emojis dont
 * personne ne sait ce qu'ils font — il n'y a pas de survol sur une réaction.
 *
 * @param {Array<{cle: string, libelle: string, emoji?: string, style?: string, desactive?: boolean}>} choix
 * @param {string} [prefixe]  nom du panneau. Inutilisé ici : une réaction n'a
 *   pas de `customId` où le loger, c'est la ligne `interaction_panels` qui
 *   relie le message à son panneau. Le paramètre est conservé pour que la
 *   signature soit la même des deux côtés.
 * @returns {{reactions: Array<{cle, emoji, libelle}>, legende: string}}
 */
function rendreChoix(choix, prefixe = null) {
    const plat = aplatirChoix(choix);
    if (plat.length === 0) return { reactions: [], legende: '' };
    if (plat.length > REACTIONS_MAX) {
        throw new Error(
            `ctx.choose : ${plat.length} choix demandés, un message Fluxer porte au plus `
            + `${REACTIONS_MAX} groupes de réaction. Découpez le panneau en plusieurs messages.`
        );
    }

    const vues = new Set();
    const reactions = plat
        // Un choix désactivé n'a pas de réaction : il reste en légende, barré,
        // pour que le panneau garde sa forme sans être actionnable.
        .filter(option => !option.desactive)
        .map((option) => {
            if (!option.emoji) {
                throw new Error(
                    `ctx.choose : le choix « ${option.cle} » n'a pas d'emoji. Sur Fluxer un choix EST `
                    + 'une réaction : sans emoji, il n\'y a rien à cliquer. Déclarez `emoji` sur chaque '
                    + 'choix — c\'est sans effet côté Discord, où le libellé suffit.'
                );
            }
            if (vues.has(option.emoji)) {
                throw new Error(
                    `ctx.choose : l'emoji ${option.emoji} est utilisé par deux choix. Une réaction ne `
                    + 'peut désigner qu\'un seul choix — le second serait inatteignable.'
                );
            }
            vues.add(option.emoji);
            return { cle: option.cle, emoji: option.emoji, libelle: option.libelle };
        });

    const legende = plat
        .map(option => (option.desactive
            ? `${option.emoji || '•'} ~~${option.libelle || option.cle}~~`
            : `${option.emoji} **${option.libelle || option.cle}**`))
        .join('\n');

    return { reactions, legende };
}

/**
 * Questions neutres -> étapes d'un dialogue séquentiel.
 *
 * Le rendu Discord est une fenêtre unique ; ici c'est une suite de messages, une
 * question à la fois, chacune attendant sa réponse (DA §6.1). La consigne de
 * chaque étape est construite maintenant pour que `context.js` n'ait plus qu'à
 * l'envoyer, et pour qu'elle soit testable sans réseau.
 *
 * @param {Array<{cle, libelle, style?, max?, min?, requis?, valeur?, exemple?}>} questions
 * @param {{titre?: string, delai?: number}} [options]
 * @param {string} [identifiant]  inutilisé (aucun formulaire à corréler) ;
 *   conservé pour que la signature soit la même des deux côtés.
 * @returns {{titre: string, etapes: Array<object>}}
 */
function rendrePrompt(questions, options = {}, identifiant = null) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('ctx.prompt : au moins une question est nécessaire.');
    }
    if (questions.length > CHAMPS_PROMPT_MAX) {
        throw new Error(
            `ctx.prompt : ${questions.length} champs demandés, ${CHAMPS_PROMPT_MAX} au maximum — `
            + 'c\'est le plafond d\'un formulaire Discord, et la limite au-delà de laquelle un '
            + 'dialogue séquentiel n\'est plus mené à son terme.'
        );
    }

    const titre = options.titre || 'Quasar';
    const etapes = questions.map((question, index) => {
        const contraintes = [];
        // `requis` par défaut à false, comme côté Discord : un champ facultatif
        // oublié est une gêne, un champ obligatoire imposé par erreur bloque.
        if (question.requis) contraintes.push('obligatoire');
        else contraintes.push('facultatif, répondez `-` pour passer');
        if (question.min) contraintes.push(`${question.min} caractères minimum`);
        if (question.max) contraintes.push(`${question.max} caractères maximum`);

        const lignes = [`**${titre} — ${index + 1}/${questions.length}**`, '', question.libelle];
        if (question.exemple) lignes.push(`_Exemple : ${question.exemple}_`);
        if (question.valeur) lignes.push(`_Valeur actuelle : ${question.valeur}_`);
        lignes.push('', `> ${contraintes.join(' · ')}`);
        lignes.push(`> Répondez dans ce salon, ou tapez \`${MOT_ANNULATION}\` pour abandonner.`);

        return {
            cle: question.cle,
            requis: Boolean(question.requis),
            min: question.min,
            max: question.max,
            style: STYLES_SAISIE[question.style] || STYLES_SAISIE.ligne,
            question: lignes.join('\n'),
        };
    });

    return { titre, etapes };
}

/**
 * Sélecteur de membre -> consigne de saisie.
 *
 * Il n'y a aucun sélecteur natif sur Fluxer : le bot DEMANDE, la personne
 * mentionne. Le périmètre change la consigne et, quand il vaut 'salonVocal', la
 * liste des personnes éligibles est affichée — sans elle, il faudrait deviner
 * qui est dans le salon.
 *
 * @param {string} [identifiant]  inutilisé, conservé pour la symétrie de signature
 * @param {{perimetre: string, membres?: Array<{id, nom}>, exemple?: string}} options
 * @returns {string}
 */
function rendreSelecteurMembre(identifiant = null, { perimetre, membres = [], exemple } = {}) {
    const consigne = exemple || 'Mentionnez la personne, ou collez son identifiant.';
    if (perimetre === 'salonVocal') {
        // 25 est le plafond d'un menu Discord ; on le reprend pour que le
        // message reste lisible et que le comportement soit le même des deux
        // côtés au-delà.
        const liste = membres.slice(0, 25).map(m => `• ${m.nom ?? m.id} — \`${m.id}\``).join('\n');
        return [
            consigne,
            '',
            'Personnes présentes dans le salon vocal :',
            liste || '_(personne)_',
            '',
            `> Tapez \`${MOT_ANNULATION}\` pour abandonner.`,
        ].join('\n');
    }
    return `${consigne}\n\n> Tapez \`${MOT_ANNULATION}\` pour abandonner.`;
}

module.exports = {
    decouperRangees,
    aplatirChoix,
    corpsPanneau,
    composerPanneau,
    estCorpsCompose,
    avecLegende,
    CLES_CORPS_COMPOSE,
    rendreEmbed,
    rendreSelecteurMembre,
    rendreContenu,
    rendreFichier,
    CLES_CORPS,
    rendreChoix,
    rendrePrompt,
    couleurVersEntier,
    horodatageVersIso,
    STYLES_BOUTON,
    STYLES_SAISIE,
    BOUTONS_PAR_RANGEE,
    RANGEES_MAX,
    REACTIONS_MAX,
    CHAMPS_PROMPT_MAX,
    MOT_ANNULATION,
};
