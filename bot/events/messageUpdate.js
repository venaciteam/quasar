// ⚠️ NON MIGRÉ AU LOT 1 — il manque deux pièces au contrat neutre.
//
// L'embed pointe sur le message modifié (`setURL(newMessage.url)`), ce qui est
// tout l'intérêt du journal : sans le lien, on lit un avant/après sans pouvoir
// aller voir. Or ni `embed()` (bot/platform/embed.js) ni `normaliserMessage`
// (bot/platform/discord/events.js) ne portent cette information — le champ `url`
// est même classé parmi les marqueurs d'un embed au FORMAT DISCORD. Voir le
// compte-rendu du lot 1.
const { EmbedBuilder } = require('discord.js');
const { sendLog } = require('../utils/logger');

module.exports = {
    name: 'messageUpdate',
    once: false,
    async execute(oldMessage, newMessage) {
        if (!newMessage.guild || newMessage.author?.bot) return;
        if (oldMessage.partial || newMessage.partial) return;
        if (oldMessage.content === newMessage.content) return; // Embed preview, pas un edit

        const embed = new EmbedBuilder()
            .setTitle('✏️ Message modifié')
            .setColor(0x3498db)
            .addFields(
                { name: 'Auteur', value: `${newMessage.author} (${newMessage.author.tag})`, inline: true },
                { name: 'Channel', value: `<#${newMessage.channel.id}>`, inline: true },
                { name: 'Avant', value: (oldMessage.content || '*vide*').slice(0, 1024) },
                { name: 'Après', value: (newMessage.content || '*vide*').slice(0, 1024) }
            )
            .setURL(newMessage.url)
            .setTimestamp();

        await sendLog(newMessage.guild, 'msg_edit', embed);
    }
};
