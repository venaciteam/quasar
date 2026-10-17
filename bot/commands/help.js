const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { getOperatorName } = require('../utils/reportRouting');

const ACCENT_COLOR = 0xDE3163;

// Regroupement volontairement simple : un membre qui tape /help cherche ce qu'il
// peut faire, pas l'inventaire exhaustif. Les commandes réservées à la modération
// ne sont montrées qu'à ceux qui peuvent les utiliser.
//
// ⚠️ Ces quatre listes sont tenues À LA MAIN, et la DA (§5.3) prévoit à terme de
// les dériver du registre de commandes. Ce n'est PAS fait ici : la sortie de
// /help doit rester identique à la ligne près. Ce qu'il manque pour la dériver
// est consigné dans le compte-rendu du lot 3.
const PUBLIC_COMMANDS = [
    ['/help', 'Afficher cette aide'],
    ['/signaler bug', 'Signaler un dysfonctionnement de Quasar'],
    ['/signaler abus', 'Signaler un usage abusif du bot sur ce serveur'],
    ['/ping', 'Vérifier que le bot répond'],
];

const VOICE_COMMANDS = [
    ['/voice', 'Gérer votre salon vocal temporaire'],
];

const MODERATION_COMMANDS = [
    ['/warn @membre [raison]', 'Avertir un membre'],
    ['/warns @membre', 'Voir les avertissements d\'un membre'],
    ['/unwarn [id]', 'Retirer un avertissement'],
    ['/sanctions @membre', 'Historique complet des sanctions'],
    ['/mute @membre [durée]', 'Exclure temporairement (timeout)'],
    ['/unmute @membre', 'Lever le timeout'],
    ['/kick @membre [raison]', 'Expulser un membre'],
    ['/ban @membre [raison]', 'Bannir un membre'],
    ['/unban [id]', 'Débannir un membre'],
    ['/clear [nombre]', 'Supprimer des messages'],
];

const ADMIN_COMMANDS = [
    ['/log #salon', 'Définir le salon de logs'],
    ['/ticket setup', 'Configurer le système de tickets'],
    ['/welcome', 'Messages de bienvenue'],
    ['/leave', 'Messages de départ'],
    ['/autorole', 'Rôles automatiques à l\'arrivée'],
    ['/reactionrole', 'Panels de rôles par réaction'],
    ['/voicerole', 'Rôles liés au vocal'],
    ['/tempvoice setup', 'Salons vocaux temporaires'],
    ['/embed', 'Créer et envoyer des embeds'],
    ['/customcmd', 'Commandes personnalisées'],
];

function formatList(entries) {
    return entries.map(([cmd, desc]) => `\`${cmd}\`\n↳ ${desc}`).join('\n');
}

module.exports = definirCommande({
    nom: 'help',
    description: 'Afficher l\'aide de Quasar et savoir comment signaler un problème',
    // Ouverture DÉCLARÉE : /help s'adresse à tout le monde, et c'est le seul
    // point d'entrée d'un membre ordinaire vers `/signaler`.
    accesParDefaut: true,
    // Répondre suffit : SEND_MESSAGES et EMBED_LINKS font partie du socle sans
    // lequel le bot est muet de toute façon.
    permissionsBot: [],

    async executer(ctx) {
        // `aPermission` lit les permissions CALCULÉES du membre, comme le faisait
        // `member.permissions.has()`. En message privé il n'y a pas de membre :
        // les deux sections réservées disparaissent, exactement comme avant.
        const canModerate = Boolean(ctx.membre?.aPermission('MODERATE_MEMBERS') || ctx.membre?.aPermission('BAN_MEMBERS'));
        const canManage = Boolean(ctx.membre?.aPermission('MANAGE_GUILD'));

        const champs = [
            { nom: '📌 Pour tout le monde', valeur: formatList(PUBLIC_COMMANDS) },
            { nom: '🔊 Vocal', valeur: formatList(VOICE_COMMANDS) },
        ];

        if (canModerate) {
            champs.push({ nom: '🛡️ Modération', valeur: formatList(MODERATION_COMMANDS) });
        }
        if (canManage) {
            champs.push({ nom: '⚙️ Configuration', valeur: formatList(ADMIN_COMMANDS) });
        }

        // Mis en avant délibérément : c'est le seul canal dont dispose un membre
        // ordinaire, qui n'a pas accès au dashboard.
        const operator = getOperatorName();
        champs.push({
            nom: '🚨 Un problème avec le bot ?',
            valeur:
                '`/signaler bug` — Quasar dysfonctionne (commande en erreur, comportement anormal).\n' +
                '`/signaler abus` — le bot est utilisé de façon abusive sur ce serveur.\n\n' +
                (operator
                    ? `Cette instance est hébergée par **${operator}**.`
                    : 'Cette instance est hébergée par la personne ou l\'organisation qui l\'a installée.'),
        });

        return ctx.repondre(embed({
            titre: '🌌 Quasar — Aide',
            couleur: ACCENT_COLOR,
            description:
                'Quasar gère la modération, les tickets, les rôles et les salons vocaux temporaires ' +
                'de ce serveur.',
            champs,
            pied: { texte: 'Quasar — logiciel libre sous licence AGPL-3.0' },
        }), { ephemere: true });
    },
});
