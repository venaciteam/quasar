const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOperatorName } = require('../utils/reportRouting');

const ACCENT_COLOR = 0xDE3163;

// Regroupement volontairement simple : un membre qui tape /help cherche ce qu'il
// peut faire, pas l'inventaire exhaustif. Les commandes réservées à la modération
// ne sont montrées qu'à ceux qui peuvent les utiliser.
const PUBLIC_COMMANDS = [
    ['/help', 'Afficher cette aide'],
    ['/signaler bug', 'Signaler un dysfonctionnement de Quasar'],
    ['/signaler abus', 'Signaler un usage abusif du bot sur ce serveur'],
    ['/ping', 'Vérifier que le bot répond'],
];

const VOICE_COMMANDS = [
    ['/voice', 'Gérer ton salon vocal temporaire'],
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Afficher l\'aide de Quasar et savoir comment signaler un problème'),

    async execute(interaction) {
        const member = interaction.member;
        const perms = member?.permissions;

        const canModerate = perms?.has?.('ModerateMembers') || perms?.has?.('BanMembers');
        const canManage = perms?.has?.('ManageGuild');

        const embed = new EmbedBuilder()
            .setTitle('🌌 Quasar — Aide')
            .setColor(ACCENT_COLOR)
            .setDescription(
                'Quasar gère la modération, les tickets, les rôles et les salons vocaux temporaires ' +
                'de ce serveur.'
            )
            .addFields({ name: '📌 Pour tout le monde', value: formatList(PUBLIC_COMMANDS) });

        embed.addFields({ name: '🔊 Vocal', value: formatList(VOICE_COMMANDS) });

        if (canModerate) {
            embed.addFields({ name: '🛡️ Modération', value: formatList(MODERATION_COMMANDS) });
        }
        if (canManage) {
            embed.addFields({ name: '⚙️ Configuration', value: formatList(ADMIN_COMMANDS) });
        }

        // Mis en avant délibérément : c'est le seul canal dont dispose un membre
        // ordinaire, qui n'a pas accès au dashboard.
        const operator = getOperatorName();
        embed.addFields({
            name: '🚨 Un problème avec le bot ?',
            value:
                '`/signaler bug` — Quasar dysfonctionne (commande en erreur, comportement anormal).\n' +
                '`/signaler abus` — le bot est utilisé de façon abusive sur ce serveur.\n\n' +
                (operator
                    ? `Cette instance est hébergée par **${operator}**.`
                    : 'Cette instance est hébergée par la personne ou l\'organisation qui l\'a installée.'),
        });

        embed.setFooter({ text: 'Quasar — logiciel libre sous licence AGPL-3.0' });

        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
};
