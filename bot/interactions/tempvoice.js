// ═══════════════════════════════════════════════════════════════
//  Panneau d'un salon vocal temporaire — logique pure
//
//  Ce fichier bâtissait tout son parcours sur discord.js : boutons, menus de
//  sélection et formulaires y étaient construits à la main, et `bot/index.js`
//  routait les clics par le préfixe `tv_`. Il ne reste ici que la LOGIQUE ; le
//  routage passe par la clé `panneaux` du descripteur de /tempvoice, et les
//  composants par les primitives du contrat (`prompt`, `choisirMembre`).
//
//  Il n'est pas fusionné dans bot/commands/tempvoice.js à dessein : cette
//  commande configure le SERVEUR (quels salons d'accueil, activés ou non),
//  tandis que ce panneau pilote UN salon, pour son propriétaire. Deux durées de
//  vie, deux publics ; les mêler produirait un fichier de trois cents lignes
//  dont la moitié ne concernerait jamais qui lit l'autre.
//
//  Le salon visé n'est plus porté par l'identifiant du composant
//  (`tv_lock_<id>`) mais par `ctx.canalId` : le panneau est posté DANS le salon
//  vocal temporaire, et un clic arrive donc forcément depuis lui. Un
//  identifiant de moins à faire circuler, et un de moins à pouvoir falsifier.
// ═══════════════════════════════════════════════════════════════

// Nom du panneau. Le contrat veut LE MÊME MOT à trois endroits — déclaration
// dans `panneaux` de /tempvoice, pose par `etatVocalModifie`, routage par la
// couche. Il est donc écrit une seule fois, ici, et importé par les deux
// autres : trois littéraux séparés finiraient par diverger d'une lettre, et un
// panneau posé que personne ne route ne produit aucune erreur.
const PANNEAU = 'tempvoice';

// Boutons du panneau, dans l'ordre, avec les libellés, emojis et styles
// d'origine. Ils vivent ici et non dans l'événement qui les pose : c'est ce
// fichier qui sait ce que chaque clé déclenche, et une clé ajoutée d'un côté
// sans handler de l'autre se verrait immédiatement.
//
// ⚠️ Le DÉCOUPAGE EN RANGÉES change : `rendreChoix` remplit cinq boutons par
// rangée, là où le panneau historique était écrit en 4 + 3. Mêmes boutons,
// mêmes libellés, mêmes emojis, mêmes styles, même ordre — seul le retour à la
// ligne se déplace. Le contrat n'a pas de marqueur de rangée ; c'est consigné
// au compte-rendu du lot avec la signature proposée.
const BOUTONS_PANNEAU = Object.freeze([
    { cle: 'rename', libelle: 'Renommer', emoji: '✏️', style: 'primaire' },
    { cle: 'limit', libelle: 'Limite', emoji: '👥', style: 'primaire' },
    { cle: 'lock', libelle: 'Verrouiller', emoji: '🔒', style: 'secondaire' },
    { cle: 'unlock', libelle: 'Déverrouiller', emoji: '🔓', style: 'secondaire' },
    { cle: 'permit', libelle: 'Autoriser', emoji: '✅', style: 'succes' },
    { cle: 'kick', libelle: 'Expulser', emoji: '👋', style: 'danger' },
    { cle: 'reset', libelle: 'Reset préfs', emoji: '🗑️', style: 'danger' },
]);

// Délai d'attente d'une sélection, en secondes. Le panneau historique n'en
// avait aucun — son menu était un composant persistant, routé par bot/index.js
// à n'importe quel moment. Cinq minutes est le compromis : assez long pour
// n'être jamais atteint dans un usage normal, assez court pour ne pas retenir
// un collecteur en mémoire pour quelqu'un qui a fermé la fenêtre. Le jeton
// d'interaction de Discord expire de toute façon au bout de quinze minutes.
const DELAI_SELECTION = 300;

/** Refus commun : la personne n'est pas propriétaire du salon. */
const REFUS_PROPRIETAIRE = Object.freeze({
    titre: 'Vous n\'êtes pas propriétaire de ce salon',
    cause: 'Seule la personne qui a créé ce salon vocal temporaire peut en modifier les réglages.',
    action: 'Demandez-lui de faire la modification, ou créez votre propre salon en rejoignant le salon d\'accueil.',
});

/** Refus commun : le salon a disparu entre l'affichage du panneau et le clic. */
const REFUS_SALON_DISPARU = Object.freeze({
    titre: 'Ce salon n\'existe plus',
    cause: 'Le salon vocal a été supprimé, probablement parce qu\'il s\'est vidé.',
    action: 'Rejoignez le salon d\'accueil pour en créer un nouveau.',
});

/** Mémorise une préférence de salon pour la catégorie courante. */
function memoriserPreference(ctx, categorieId, colonne, valeur) {
    // La colonne est choisie ici, jamais reçue d'ailleurs : les deux seules
    // valeurs possibles sont écrites en toutes lettres au point d'appel.
    ctx.db.prepare(`
        INSERT INTO tempvoice_preferences (guild_id, user_id, category_id, ${colonne}, updated_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(guild_id, user_id, category_id) DO UPDATE SET ${colonne} = excluded.${colonne}, updated_at = unixepoch()
    `).run(ctx.guildeId, ctx.auteur.id, categorieId, valeur);
}

/**
 * Handler des clics du panneau de salon vocal temporaire.
 *
 * Déclaré dans `panneaux` du descripteur de /tempvoice, appelé par la couche.
 * L'interaction arrive NON acquittée : `ctx.prompt` peut donc s'ouvrir
 * directement, et il faut répondre dans les trois secondes.
 *
 * @param {object} ctx  contexte de panneau (repondre, prompt, choisirMembre, api, db)
 * @param {string} cle  clé du choix cliqué : rename, limit, lock, unlock, permit, kick, reset
 */
async function handlerPanneauTempVoice(ctx, cle) {
    const actif = ctx.db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ? AND owner_id = ?')
        .get(ctx.canalId, ctx.auteur.id);
    if (!actif) return ctx.erreurUtilisateur({ ...REFUS_PROPRIETAIRE });

    const canal = await ctx.api.obtenirCanal(ctx.canalId);
    if (!canal) return ctx.erreurUtilisateur({ ...REFUS_SALON_DISPARU });

    if (cle === 'rename') {
        const reponses = await ctx.prompt([{
            cle: 'name',
            libelle: 'Nouveau nom',
            style: 'ligne',
            max: 100,
            requis: true,
            exemple: 'Mon salon cool',
        }], { titre: 'Renommer le salon' });
        // Fenêtre fermée ou expirée : rien à faire, et surtout rien à répondre.
        if (!reponses) return undefined;

        const name = reponses.name;
        await ctx.api.modifierCanal(ctx.canalId, { nom: name });
        memoriserPreference(ctx, actif.category_id, 'channel_name', name);
        return ctx.repondre(`✅ Salon renommé en **${name}**`, { ephemere: true });
    }

    if (cle === 'limit') {
        const reponses = await ctx.prompt([{
            cle: 'limit',
            libelle: 'Nombre de places (0 = illimité)',
            style: 'ligne',
            max: 2,
            requis: true,
            exemple: '5',
        }], { titre: 'Limite de places' });
        if (!reponses) return undefined;

        const limit = parseInt(reponses.limit, 10);
        if (isNaN(limit) || limit < 0 || limit > 99) {
            return ctx.erreurUtilisateur({
                titre: 'Nombre de places invalide',
                cause: 'La limite doit être un nombre entre 0 et 99. Discord n\'accepte rien d\'autre.',
                action: 'Saisissez un nombre entre 1 et 99, ou 0 pour ne mettre aucune limite.',
            });
        }

        await ctx.api.modifierCanal(ctx.canalId, { limiteUtilisateurs: limit });
        memoriserPreference(ctx, actif.category_id, 'user_limit', limit);
        return ctx.repondre(limit === 0 ? '✅ Limite retirée (illimité)' : `✅ Limite fixée à **${limit}** places`, { ephemere: true });
    }

    if (cle === 'lock') {
        // ⚠️ Overwrite UNITAIRE : `modifierCanal({ permissions })` remplacerait
        // le jeu ENTIER du salon, et le propriétaire perdrait à chaque
        // verrouillage les droits que la création lui a donnés — avec les
        // autorisations accordées par « Autoriser ». `definirOverwrite` ne
        // réécrit que l'entrée de @everyone, comme le faisait
        // `permissionOverwrites.edit`.
        await ctx.api.definirOverwrite(ctx.canalId, ctx.guilde.roleParDefautId, { CONNECT: false }, { type: 'role' });
        const name = canal.nom.replace(/ 🔒$/, '');
        await ctx.api.modifierCanal(ctx.canalId, { nom: `${name} 🔒` });
        return ctx.repondre('🔒 Salon verrouillé — plus personne ne peut rejoindre.', { ephemere: true });
    }

    if (cle === 'unlock') {
        // `null` rend la permission à l'héritage, sur les DEUX masques : c'est
        // le `Connect: null` d'avant migration, et surtout pas un `false`, qui
        // graverait le refus au lieu de le lever.
        await ctx.api.definirOverwrite(ctx.canalId, ctx.guilde.roleParDefautId, { CONNECT: null }, { type: 'role' });
        if (canal.nom.endsWith(' 🔒')) {
            await ctx.api.modifierCanal(ctx.canalId, { nom: canal.nom.replace(/ 🔒$/, '') });
        }
        return ctx.repondre('🔓 Salon déverrouillé.', { ephemere: true });
    }

    if (cle === 'permit') {
        // `parmi: 'serveur'` et non `'salonVocal'` : on autorise quelqu'un à
        // REJOINDRE, donc quelqu'un qui n'est pas encore là. C'est aussi le
        // sélecteur natif d'avant migration, à l'identique.
        const cible = await ctx.choisirMembre('✅ Qui voulez-vous autoriser ?', {
            parmi: 'serveur',
            exemple: 'Choisir un utilisateur à autoriser',
            delai: DELAI_SELECTION,
            ephemere: true,
        });
        if (!cible) return undefined;

        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);
        if (!membre) {
            return ctx.modifierPanneau({
                contenu: '❌ **Membre introuvable** — cette personne a quitté le serveur entre-temps.',
                composants: [],
            });
        }

        await ctx.api.definirOverwrite(ctx.canalId, cible.id, { CONNECT: true, VIEW_CHANNEL: true }, { type: 'membre' });
        return ctx.modifierPanneau({
            contenu: `✅ ${cible.mention} peut maintenant rejoindre votre salon.`,
            composants: [],
        });
    }

    if (cle === 'kick') {
        // Lister les membres du vocal (sauf l'owner)
        const restants = await ctx.api.listerMembresVocal(ctx.canalId);
        const autres = (restants || []).filter(m => m.id !== ctx.auteur.id);
        if (autres.length === 0) {
            return ctx.erreurUtilisateur({
                titre: 'Personne d\'autre dans le salon',
                cause: 'Vous êtes seul·e ici : il n\'y a personne à qui transférer la propriété.',
                action: 'Attendez que quelqu\'un rejoigne, puis réessayez.',
            });
        }

        const cible = await ctx.choisirMembre('👋 Qui voulez-vous expulser ?', {
            parmi: 'serveur',
            exemple: 'Choisir un utilisateur à expulser',
            delai: DELAI_SELECTION,
            ephemere: true,
        });
        if (!cible) return undefined;

        const membre = await ctx.api.obtenirMembre(ctx.guildeId, cible.id);
        if (!membre || membre.canalVocalId !== ctx.canalId) {
            return ctx.modifierPanneau({
                contenu: '❌ **Cette personne n\'est pas dans votre salon** — elle l\'a quitté, ou n\'y est jamais entrée.',
                composants: [],
            });
        }

        await ctx.api.modifierMembre(ctx.guildeId, cible.id, { canalVocalId: null }, 'Expulsé par le propriétaire du vocal');
        return ctx.modifierPanneau({ contenu: `✅ ${cible.mention} a été expulsé.`, composants: [] });
    }

    if (cle === 'reset') {
        ctx.db.prepare('DELETE FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
            .run(ctx.guildeId, ctx.auteur.id, actif.category_id);
        return ctx.repondre('✅ Vos préférences pour cette catégorie ont été réinitialisées.', { ephemere: true });
    }

    return undefined;
}

/**
 * TRANSITION — panneaux `tv_*` posés AVANT la migration.
 *
 * `bot/index.js` requiert cette fonction et la branche sur le préfixe
 * historique `tv_`. Ce fichier ne lui est pas accessible : la ligne doit donc
 * continuer d'exister, et elle sera retirée au lot de consolidation avec le
 * routage qui l'appelle.
 *
 * Elle ne fait plus le travail — le panneau neutre s'en charge — mais elle ne
 * reste pas muette pour autant : un bouton qui ne répond rien laisse
 * « L'interaction a échoué » à l'écran, sans rien dire de la cause.
 *
 * La fenêtre concernée est courte : un panneau TempVoice vit dans le salon
 * temporaire, et disparaît avec lui dès qu'il se vide. Seuls les salons encore
 * occupés au moment du déploiement portent un panneau de l'ancienne forme.
 *
 * @param {import('discord.js').Interaction} interaction  interaction BRUTE,
 *   c'est la voie historique — aucun contexte neutre n'existe pour elle.
 */
async function handleTempVoiceInteraction(interaction) {
    const { userError } = require('../utils/errors');
    return userError(interaction, {
        title: 'Ce panneau a été remplacé',
        cause: 'Il a été posé par une version antérieure de Quasar, et ses boutons ne sont plus reconnus.',
        action: 'Utilisez les commandes `/voice`, ou quittez le salon et recréez-en un depuis le salon d\'accueil pour obtenir un panneau à jour.',
    });
}

module.exports = {
    PANNEAU,
    BOUTONS_PANNEAU,
    handlerPanneauTempVoice,
    handleTempVoiceInteraction,
    DELAI_SELECTION,
};
