const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { getQueue, createQueue } = require('../modules/music/queue');
const { playNext, setupPlayer, clearDisconnect } = require('../modules/music/player');
const { resolve } = require('../modules/music/resolver');
const { checkMusicChannel } = require('../utils/musicChannel');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Jouer une musique (YouTube, Spotify, Deezer, Apple Music, ou recherche texte)')
        .addStringOption(opt => opt.setName('musique').setDescription('Lien ou titre à rechercher').setRequired(true)),

    async execute(interaction) {
        const input = interaction.options.getString('musique');
        const member = interaction.member;
        const voiceChannel = member.voice?.channel;

        if (!await checkMusicChannel(interaction)) return;

        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Vous devez être dans un salon vocal.', ephemeral: true });
        }

        await interaction.deferReply();

        // Résoudre le titre
        const result = await resolve(input, `<@${interaction.user.id}>`);
        if (result.error) {
            return interaction.editReply({ content: `❌ ${result.error}` });
        }

        const { tracks, playlist } = result;
        let queue = getQueue(interaction.guild.id);

        // Rejoindre le vocal si pas déjà dedans
        if (!queue || !queue.connection) {
            queue = createQueue(interaction.guild.id, voiceChannel, interaction.channel);

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
                selfDeaf: true
            });

            queue.connection = connection;
            setupPlayer(queue);

            // Gérer la déconnexion forcée (bot kick du vocal)
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
                    await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
                } catch {
                    connection.destroy();
                    const { deleteQueue } = require('../modules/music/queue');
                    deleteQueue(interaction.guild.id);
                }
            });
        }

        clearDisconnect(queue);

        // Ajouter les tracks
        queue.tracks.push(...tracks);

        if (playlist) {
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('📋 Playlist ajoutée')
                    .setColor(0x6e8ec8)
                    .setDescription(`**${playlist}** — ${tracks.length} piste(s) ajoutée(s) à la queue.`)
                    .setTimestamp()]
            });
        } else {
            const track = tracks[0];
            const isPlaying = queue.current !== null;
            const displayUrl = track.songlinkUrl || track.url;

            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(isPlaying ? '📋 Ajouté à la queue' : '🎵 Lecture')
                    .setColor(0xc86e8e)
                    .setDescription(`**[${track.title}](${displayUrl})**`)
                    .addFields(
                        { name: 'Durée', value: track.duration || 'Inconnue', inline: true },
                        { name: 'Position', value: isPlaying ? `#${queue.tracks.length}` : 'En cours', inline: true }
                    )
                    .setThumbnail(track.thumbnail || null)
                    .setTimestamp()]
            });
        }

        // Démarrer la lecture si rien ne joue
        if (!queue.current) {
            playNext(interaction.guild.id);
        }
    }
};
