/**
 * Un rôle n'est pas toujours attribuable par le bot : Discord refuse les rôles
 * gérés par une intégration, @everyone, et tout rôle situé au-dessus du plus
 * haut rôle du bot.
 *
 * Six entrées configurent des rôles à attribuer (les commandes /autorole,
 * /voicerole et /reactionrole, et leurs trois routes de dashboard), et elles ne
 * vérifiaient pas la même chose : /autorole add testait `managed`, les cinq
 * autres rien du tout. Un réglage impossible s'enregistrait donc sans broncher et
 * n'échouait qu'au moment de l'attribution — à l'arrivée d'un membre, à une
 * connexion en vocal ou à un clic sur un emoji — dans un `console.error` que
 * personne ne lit. C'est ce qui rend ce module nécessaire : la vérification est
 * écrite une fois, les six entrées l'appellent.
 */

/**
 * @returns {null|'missing'|'everyone'|'managed'|'hierarchy'} null si le rôle est
 *   attribuable, sinon le motif du refus.
 */
function checkAssignableRole(guild, role) {
    if (!role) return 'missing';
    if (role.id === guild.id) return 'everyone';
    if (role.managed) return 'managed';

    // `guild.members.me` peut manquer du cache. Dans le doute on laisse passer :
    // refuser un rôle parfaitement valide sur une absence de cache serait pire
    // que le laisser échouer plus tard, ce qui reste rattrapable.
    const me = guild.members.me;
    if (me && role.position >= me.roles.highest.position) return 'hierarchy';

    return null;
}

/**
 * Motif de refus détaillé, au format attendu par `userError` (embeds du bot).
 * L'API sert le même texte à plat via `describeForApi`.
 */
function describeRefusal(code, role) {
    switch (code) {
        case 'missing':
            return {
                title: 'Ce rôle est introuvable',
                cause: 'Il n\'existe pas (ou plus) sur ce serveur.',
                action: 'Choisissez un rôle existant dans la liste.',
            };
        case 'everyone':
            return {
                title: 'Ce rôle ne peut pas être attribué',
                cause: '@everyone est déjà attribué à tout le monde par Discord : l\'attribuer n\'aurait aucun effet.',
                action: 'Choisissez un rôle classique à la place.',
            };
        case 'managed':
            return {
                title: 'Ce rôle ne peut pas être attribué',
                cause: 'Il est géré automatiquement par une intégration (bot, abonnement Twitch, boost du serveur…). Discord interdit à un autre bot d\'y toucher.',
                action: 'Créez un rôle classique et utilisez celui-ci à la place.',
            };
        case 'hierarchy':
            return {
                title: 'Ce rôle est trop haut dans la hiérarchie',
                cause: `« ${role?.name} » est au-dessus du rôle le plus haut de Quasar. Discord interdit à un bot d'attribuer un rôle situé au-dessus du sien.`,
                action: 'Remontez le rôle « Quasar » dans Paramètres du serveur → Rôles, ou choisissez un rôle plus bas.',
            };
        default:
            return {
                title: 'Ce rôle ne peut pas être attribué',
                cause: 'Discord refuse que le bot attribue ce rôle.',
                action: 'Choisissez un autre rôle.',
            };
    }
}

/** Même motif, en une phrase, pour un `res.status(400).json({ error })`. */
function describeForApi(code, role) {
    const { cause, action } = describeRefusal(code, role);
    return `${cause} ${action}`;
}

module.exports = { checkAssignableRole, describeRefusal, describeForApi };
