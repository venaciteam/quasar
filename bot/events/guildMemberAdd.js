const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../../api/services/database');
const { resolveVariables, buildEmbed } = require('../utils/welcomeMessage');
const { sendLog } = require('../utils/logger');
const { handleMemberJoin } = require('../modules/antiraid');

module.exports = {
    name: 'guildMemberAdd',
    once: false,
    async execute(member) {
        // ─── Anti-raid, AVANT tout le reste ───
        //
        // L'ordre est délibéré. Poser un autorôle de bienvenue à un compte qu'on
        // s'apprête à expulser est absurde : le rôle serait accordé puis emporté
        // par l'expulsion, avec deux appels d'API inutiles au moment précis où le
        // serveur est sous pression. Et souhaiter la bienvenue à une vague de
        // comptes de raid transformerait le salon d'accueil en amplificateur du
        // raid — c'est du reste ce qu'un raid cherche.
        //
        // `handleMemberJoin` ne lève JAMAIS et sort immédiatement quand le module
        // est désactivé (lecture d'un cache mémoire, aucune requête). Le message
        // de bienvenue, le log `member_join` et les autorôles restent donc
        // strictement inchangés sur un serveur qui n'a pas activé l'anti-raid.
        const verdict = await handleMemberJoin(member);
        // Seule sortie anticipée : la personne n'est plus sur le serveur. Il n'y
        // a plus personne à accueillir, ni à qui donner un rôle — et la sanction,
        // elle, a déjà été journalisée par le module.
        if (verdict.removed) return;

        const db = getDb();

        // ─── Log « membre rejoint » ───
        //
        // Inconditionnel, comme le log de départ dans `guildMemberRemove`. Son seul
        // gardien légitime est la case « 📥 Membre rejoint » du dashboard, que
        // `sendLog` consulte déjà via `isLogEnabled` — laquelle laisse ce type
        // désactivé par défaut. Il dépendait auparavant de `welcome_config` : un
        // serveur qui cochait la case sans configurer de message d'accueil ne
        // recevait jamais ce log, sans aucun moyen de comprendre pourquoi.
        const logEmbed = new EmbedBuilder()
            .setTitle('📥 Membre rejoint')
            .setColor(0x2ecc71)
            .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
            .addFields(
                { name: 'Membre', value: `${member} (${member.user.tag})`, inline: true },
                { name: 'Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Membres', value: `${member.guild.memberCount}`, inline: true }
            )
            .setTimestamp();
        await sendLog(member.guild, 'member_join', logEmbed);

        // ─── Message de bienvenue ───
        //
        // Seul comportement réellement piloté par `welcome_config`. Ce bloc `if`
        // remplace deux `return` qui court-circuitaient aussi le log et les
        // autorôles ci-dessous — y compris celui sur `!channel`, qui faisait
        // silencieusement disparaître les autorôles d'un serveur pourtant bien
        // configuré dès la suppression de son salon d'accueil.
        const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(member.guild.id);
        if (config && config.welcome_enabled && config.welcome_channel) {
            const channel = member.guild.channels.cache.get(config.welcome_channel);
            if (channel) {
                const embed = buildEmbed(config.welcome_embed, member);
                const content = config.welcome_message ? resolveVariables(config.welcome_message, member) : null;

                try {
                    if (embed) {
                        await channel.send({ content: content || undefined, embeds: [embed] });
                    } else if (content) {
                        await channel.send({ content });
                    }
                } catch (e) {
                    console.error('[Quasar] Erreur message welcome:', e.message);
                }
            }
        }

        // ─── Autoroles ───
        //
        // Configurés sur la page « Reaction Roles » du dashboard, qui n'a aucun
        // lien d'interface avec le message de bienvenue — et `/autorole add`
        // promet une attribution « à chaque nouveau membre », sans réserve. Les
        // faire dépendre de `welcome_config` revenait à ignorer un réglage que
        // l'interface affiche pourtant comme actif.
        const autoroles = db.prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').all(member.guild.id);
        for (const ar of autoroles) {
            try {
                await member.roles.add(ar.role_id);
            } catch (e) {
                console.error('[Quasar] Erreur autorole:', e.message);
            }
        }
    }
};
