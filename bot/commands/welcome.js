// Jeu de réglages de /welcome. Tout le corps de la commande — descripteur,
// sous-commandes, écritures en base, réponses — vit dans la fabrique, partagée
// avec /leave (cf. bot/utils/configCommand.js).
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
    defaultTestMsg: (membre, guilde) => `👋 Bienvenue ${membre.mention} sur **${guilde.nom}** !`
});
