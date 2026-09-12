// ⚠️ NON MIGRÉ AU LOT 3.
//
// Mêmes manques que guildMemberAdd.js, dont ce handler est le symétrique :
// l'avatar du membre, `user.tag` et `membreCount` sont absents du payload neutre
// de `membreParti`, et `{username}` n'a pas d'équivalent exact dans `membre.nom`.
// Pas d'anti-raid ici, en revanche : ce fichier se débloquera dès que le contrat
// portera ces trois champs. Signatures proposées dans le compte-rendu du lot 3.
const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { resolveVariables, buildEmbed } = require('../utils/welcomeMessage');
const { sendLog } = require('../utils/logger');

module.exports = {
    name: 'guildMemberRemove',
    once: false,
    async execute(member) {
        const db = getDb();
        const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(member.guild.id);

        // Log membre quitte
        const logEmbed = new EmbedBuilder()
            .setTitle('📤 Membre parti')
            .setColor(0xe74c3c)
            .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
            .addFields(
                { name: 'Membre', value: `${member.user.tag}`, inline: true },
                { name: 'Membres', value: `${member.guild.memberCount}`, inline: true }
            )
            .setTimestamp();
        await sendLog(member.guild, 'member_leave', logEmbed);

        if (!config || !config.leave_enabled || !config.leave_channel) return;

        const channel = member.guild.channels.cache.get(config.leave_channel);
        if (!channel) return;

        const embed = buildEmbed(config.leave_embed, member);
        const content = config.leave_message ? resolveVariables(config.leave_message, member) : null;

        try {
            if (embed) {
                await channel.send({ content: content || undefined, embeds: [embed] });
            } else if (content) {
                await channel.send({ content });
            }
        } catch (e) {
            console.error('[Quasar] Erreur message leave:', e.message);
        }
    }
};
