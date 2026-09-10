// ═══════════════════════════════════════════════════════════════
//  Rendu Discord des structures neutres
//
//  Trois traductions, et elles seules :
//    embed neutre  -> EmbedBuilder
//    ctx.choose    -> ActionRowBuilder de ButtonBuilder
//    ctx.prompt    -> ModalBuilder de TextInputBuilder
//
//  Rien ici n'appelle l'API : ces fonctions construisent, `context.js` envoie.
//  La séparation permet de tester le rendu sans client ni jeton.
// ═══════════════════════════════════════════════════════════════

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { estEmbed } = require('../embed');

// Discord plafonne à 5 boutons par rangée et 5 rangées par message, soit 25
// choix. Au-delà, l'API refuse le message entier : mieux vaut lever ici, avec
// un message qui dit quoi faire.
const BOUTONS_PAR_RANGEE = 5;
const RANGEES_MAX = 5;

// Un modal Discord accepte au maximum 5 champs. Même raison.
const CHAMPS_PROMPT_MAX = 5;

const STYLES_BOUTON = Object.freeze({
    primaire: ButtonStyle.Primary,
    secondaire: ButtonStyle.Secondary,
    succes: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
    lien: ButtonStyle.Link,
});

const STYLES_SAISIE = Object.freeze({
    ligne: TextInputStyle.Short,
    paragraphe: TextInputStyle.Paragraph,
});

/**
 * Couleur neutre -> entier discord.js.
 * Accepte l'entier historique du dépôt (0xc8a86e) et la chaîne « #rrggbb »,
 * qui est la forme stockée en base pour les embeds du dashboard.
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

/** `horodatage` neutre -> valeur acceptée par setTimestamp (true = maintenant). */
function horodatageVersDate(horodatage) {
    if (horodatage === true) return new Date();
    if (horodatage instanceof Date) return horodatage;
    if (typeof horodatage === 'number' || typeof horodatage === 'string') return new Date(horodatage);
    return null;
}

/**
 * Embed neutre -> EmbedBuilder.
 *
 * Chaque champ n'est posé que s'il est renseigné : `setTitle(undefined)` est
 * accepté par le builder mais produit `title: null` dans le JSON, ce qui n'est
 * pas la même chose qu'une absence de titre pour l'API.
 */
function rendreEmbed(neutre) {
    const builder = new EmbedBuilder();

    if (neutre.titre) builder.setTitle(neutre.titre);
    if (neutre.description) builder.setDescription(neutre.description);

    const couleur = couleurVersEntier(neutre.couleur);
    if (couleur !== undefined) builder.setColor(couleur);

    if (Array.isArray(neutre.champs) && neutre.champs.length > 0) {
        builder.addFields(neutre.champs.map(champ => ({
            name: champ.nom,
            value: champ.valeur,
            inline: Boolean(champ.enLigne),
        })));
    }

    if (neutre.pied) {
        builder.setFooter({
            text: typeof neutre.pied === 'string' ? neutre.pied : neutre.pied.texte,
            iconURL: typeof neutre.pied === 'string' ? undefined : neutre.pied.icone,
        });
    }
    if (neutre.auteur) {
        builder.setAuthor({
            name: typeof neutre.auteur === 'string' ? neutre.auteur : neutre.auteur.nom,
            iconURL: typeof neutre.auteur === 'string' ? undefined : neutre.auteur.icone,
            url: typeof neutre.auteur === 'string' ? undefined : neutre.auteur.url,
        });
    }
    if (neutre.image) builder.setImage(neutre.image);
    if (neutre.vignette) builder.setThumbnail(neutre.vignette);

    const date = horodatageVersDate(neutre.horodatage);
    if (date) builder.setTimestamp(date);

    return builder;
}

/**
 * Contenu neutre -> corps de message discord.js.
 *
 * Accepte une chaîne, un embed neutre, un tableau d'embeds neutres, ou un objet
 * déjà formé `{ contenu, embeds }` — les trois formes qui circulent dans le
 * code métier. Le résultat est fusionnable dans n'importe quel payload
 * (`reply`, `followUp`, `send`, `editReply`).
 */
function rendreContenu(contenuOuEmbed) {
    if (contenuOuEmbed === null || contenuOuEmbed === undefined) return {};
    if (typeof contenuOuEmbed === 'string') return { content: contenuOuEmbed };
    if (Array.isArray(contenuOuEmbed)) return { embeds: contenuOuEmbed.map(rendreEmbed) };
    if (estEmbed(contenuOuEmbed)) return { embeds: [rendreEmbed(contenuOuEmbed)] };

    const payload = {};
    if (contenuOuEmbed.contenu) payload.content = contenuOuEmbed.contenu;
    if (contenuOuEmbed.embeds) {
        payload.embeds = contenuOuEmbed.embeds.map(e => (estEmbed(e) ? rendreEmbed(e) : e));
    }
    return payload;
}

/**
 * Choix neutres -> rangées de boutons.
 *
 * `prefixe` est le préfixe de `customId`. Il porte l'identité de l'appel :
 * `context.js` y met un identifiant unique pour un panneau éphémère (afin de ne
 * collecter QUE ses propres clics), et le code métier y met un identifiant
 * stable pour un panneau persistant, qui doit rester reconnaissable après un
 * redémarrage.
 *
 * @param {Array<{cle: string, libelle: string, emoji?: string, style?: string, url?: string, desactive?: boolean}>} choix
 * @param {string} prefixe
 * @returns {ActionRowBuilder[]}
 */
function rendreChoix(choix, prefixe) {
    if (!Array.isArray(choix) || choix.length === 0) return [];
    if (choix.length > BOUTONS_PAR_RANGEE * RANGEES_MAX) {
        throw new Error(
            `ctx.choose : ${choix.length} choix demandés, Discord en accepte ${BOUTONS_PAR_RANGEE * RANGEES_MAX} au maximum. `
            + 'Découpez le panneau en plusieurs messages.'
        );
    }

    const rangees = [];
    for (let debut = 0; debut < choix.length; debut += BOUTONS_PAR_RANGEE) {
        const rangee = new ActionRowBuilder();
        for (const option of choix.slice(debut, debut + BOUTONS_PAR_RANGEE)) {
            const style = STYLES_BOUTON[option.style] || ButtonStyle.Secondary;
            const bouton = new ButtonBuilder().setStyle(style);

            // Un bouton de style « lien » ne porte pas de customId mais une URL,
            // et Discord refuse le message si on lui donne les deux.
            if (style === ButtonStyle.Link) bouton.setURL(option.url);
            else bouton.setCustomId(`${prefixe}:${option.cle}`);

            // Libellé texte toujours posé quand il existe : une icône seule est
            // illisible pour qui ne connaît pas le panneau (convention VNCT).
            if (option.libelle) bouton.setLabel(option.libelle);
            if (option.emoji) bouton.setEmoji(option.emoji);
            if (option.desactive) bouton.setDisabled(true);

            rangee.addComponents(bouton);
        }
        rangees.push(rangee);
    }
    return rangees;
}

/**
 * Questions neutres -> ModalBuilder.
 *
 * @param {Array<{cle: string, libelle: string, style?: 'ligne'|'paragraphe', max?: number, min?: number, requis?: boolean, valeur?: string, exemple?: string}>} questions
 * @param {{titre?: string}} [options]
 * @param {string} identifiant  customId du modal, utilisé pour filtrer la soumission
 */
function rendrePrompt(questions, options = {}, identifiant) {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('ctx.prompt : au moins une question est nécessaire.');
    }
    if (questions.length > CHAMPS_PROMPT_MAX) {
        throw new Error(
            `ctx.prompt : ${questions.length} champs demandés, Discord en accepte ${CHAMPS_PROMPT_MAX} au maximum.`
        );
    }

    const modal = new ModalBuilder()
        .setCustomId(identifiant)
        .setTitle(options.titre || 'Quasar');

    for (const question of questions) {
        const saisie = new TextInputBuilder()
            .setCustomId(question.cle)
            .setLabel(question.libelle)
            .setStyle(STYLES_SAISIE[question.style] || TextInputStyle.Short)
            // `requis` par défaut à false : un champ facultatif oublié est une
            // gêne, un champ obligatoire imposé par erreur bloque le parcours.
            .setRequired(Boolean(question.requis));

        if (question.max) saisie.setMaxLength(question.max);
        if (question.min) saisie.setMinLength(question.min);
        if (question.valeur) saisie.setValue(question.valeur);
        if (question.exemple) saisie.setPlaceholder(question.exemple);

        modal.addComponents(new ActionRowBuilder().addComponents(saisie));
    }

    return modal;
}

module.exports = {
    rendreEmbed,
    rendreContenu,
    rendreChoix,
    rendrePrompt,
    couleurVersEntier,
    STYLES_BOUTON,
    STYLES_SAISIE,
    BOUTONS_PAR_RANGEE,
    RANGEES_MAX,
    CHAMPS_PROMPT_MAX,
};
