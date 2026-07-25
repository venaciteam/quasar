const {
    SlashCommandBuilder, EmbedBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js');
const {
    getBugRelayUrl, getAbuseRelayUrl, getAbuseContact,
    getOperatorName, sendReport,
} = require('../utils/reportRouting');

const ACCENT_COLOR = 0xDE3163;

// Cette commande est ouverte à TOUS les membres, pas seulement aux administrateurs.
// Le dashboard n'est accessible qu'aux admins : sans elle, un membre ordinaire —
// justement celui qui subit un éventuel abus — n'a aucun moyen de signaler quoi que
// ce soit. Discord impose aux développeurs de fournir un canal de signalement portant
// sur l'application « or its use » : un canal réservé aux admins ne le fournit pas.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('signaler')
        .setDescription('Signaler un bug de Quasar ou un usage abusif du bot')
        .addSubcommand(sub =>
            sub.setName('bug')
                .setDescription('Quasar fonctionne mal : commande en erreur, dashboard cassé…')
        )
        .addSubcommand(sub =>
            sub.setName('abus')
                .setDescription('Le bot est utilisé de façon abusive sur ce serveur')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'bug') {
            const modal = new ModalBuilder()
                .setCustomId('signaler_bug')
                .setTitle('Signaler un bug de Quasar');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('description')
                        .setLabel('Que s\'est-il passé ?')
                        .setPlaceholder('Décris le problème et ce que tu faisais au moment où il est arrivé.')
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(1500)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('contact')
                        .setLabel('Te recontacter (facultatif)')
                        .setPlaceholder('Pseudo Discord, e-mail… laisse vide si tu préfères.')
                        .setStyle(TextInputStyle.Short)
                        .setMaxLength(200)
                        .setRequired(false)
                )
            );

            return interaction.showModal(modal);
        }

        // ── Abus d'usage ───────────────────────────────────────────────────
        const relay = getAbuseRelayUrl();

        if (!relay) {
            // Aucun relais configuré : cette instance ne collecte pas les signalements
            // d'abus. On ne fait pas semblant — on oriente vers les interlocuteurs
            // qui peuvent réellement agir.
            const operator = getOperatorName();
            const contact = getAbuseContact();

            const embed = new EmbedBuilder()
                .setTitle('🚨 Signaler un usage abusif')
                .setColor(ACCENT_COLOR)
                .setDescription(
                    'Cette instance de Quasar ne reçoit pas les signalements d\'abus : ' +
                    'ils doivent aller aux personnes qui peuvent agir.'
                )
                .addFields(
                    {
                        name: '1. L\'équipe de ce serveur',
                        value: 'Pour un problème de modération ou de comportement, les administrateurs ' +
                               'du serveur sont responsables de ce qui s\'y passe.',
                    },
                    {
                        name: `2. ${operator ? operator : 'La personne ou l\'organisation qui héberge cette instance'}`,
                        value: contact
                            ? contact
                            : 'Si le problème vient de l\'équipe du serveur elle-même, adresse-toi à ' +
                              'qui héberge ce bot. Aucun contact n\'a été renseigné sur cette instance.',
                    },
                    {
                        name: '3. Discord',
                        value: 'Pour une violation des conditions d\'utilisation de Discord : ' +
                               '[formulaire de signalement Discord](https://support.discord.com/hc/fr/requests/new).',
                    }
                )
                .setFooter({ text: 'Pour un dysfonctionnement technique du bot, utilise plutôt /signaler bug.' });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId('signaler_abus')
            .setTitle('Signaler un usage abusif');

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('description')
                    .setLabel('Que se passe-t-il ?')
                    .setPlaceholder('Décris l\'usage abusif du bot sur ce serveur, aussi précisément que possible.')
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(1500)
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('contact')
                    .setLabel('Te recontacter (facultatif)')
                    .setPlaceholder('Pseudo Discord, e-mail… laisse vide si tu préfères.')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(200)
                    .setRequired(false)
            )
        );

        return interaction.showModal(modal);
    },
};

/**
 * Traite l'envoi des deux formulaires. Appelé depuis le routeur d'interactions.
 */
async function handleReportModal(interaction) {
    const isAbuse = interaction.customId === 'signaler_abus';
    const description = interaction.fields.getTextInputValue('description');
    const contact = interaction.fields.getTextInputValue('contact') || null;

    await interaction.deferReply({ ephemeral: true });

    const relayUrl = isAbuse ? getAbuseRelayUrl() : getBugRelayUrl();
    if (!relayUrl) {
        return interaction.editReply({
            content: '❌ Aucune destination de signalement n\'est configurée sur cette instance.',
        });
    }

    let version = '';
    try { version = require('../../package.json').version; } catch { /* sans importance */ }

    const result = await sendReport({
        relayUrl,
        kind: isAbuse ? 'abuse' : 'bug',
        description,
        contact,
        guildId: interaction.guild?.id,
        serviceVersion: version,
    });

    if (!result.ok) {
        console.error(`[Quasar] Signalement non transmis (${result.error})`);
        return interaction.editReply({
            content:
                '❌ Le signalement n\'a pas pu être transmis. Réessaie dans quelques minutes — ' +
                'et si le problème persiste, préviens directement l\'équipe du serveur.',
        });
    }

    return interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setTitle('✅ Signalement transmis')
                .setColor(ACCENT_COLOR)
                .setDescription(
                    isAbuse
                        ? 'Ton signalement a été transmis à l\'équipe qui héberge cette instance de Quasar. ' +
                          'Elle en prendra connaissance et décidera des suites.'
                        : 'Merci — ton signalement a été transmis à l\'équipe qui développe Quasar.'
                )
                .setFooter({
                    text: contact
                        ? 'Le contact que tu as indiqué a été joint au signalement.'
                        : 'Aucun moyen de te recontacter n\'a été transmis.',
                })
                .setTimestamp()
        ],
    });
}

module.exports.handleReportModal = handleReportModal;
