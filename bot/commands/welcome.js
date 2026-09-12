// ⚠️ NON MIGRÉ AU LOT 3. Ce fichier n'est qu'un jeu de réglages : tout le corps
// de /welcome vit dans la fabrique, et c'est elle qui bute sur le contrat —
// `{username}`, `{membercount}` et l'avatar du membre n'y existent pas. Le
// détail, et les signatures proposées, sont en tête de bot/utils/configCommand.js.
const { createConfigCommand } = require('../utils/configCommand');

module.exports = createConfigCommand({
    name: 'welcome',
    description: 'Configurer les messages de bienvenue',
    emoji: '👋',
    color: 0xc86e8e,
    defaultColor: '#c86e8e',
    channelCol: 'welcome_channel',
    messageCol: 'welcome_message',
    embedCol: 'welcome_embed',
    enabledCol: 'welcome_enabled',
    defaultEmbedTitle: 'Bienvenue sur {server} !',
    defaultEmbedDesc: '{user} arrive — membre numéro **{membercount}**.',
    defaultTestMsg: (member) => `👋 Bienvenue ${member} sur **${member.guild.name}** !`
});
