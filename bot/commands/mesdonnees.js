const {
    SlashCommandBuilder, EmbedBuilder,
    ButtonBuilder, ButtonStyle, ActionRowBuilder,
} = require('discord.js');
const { getDb } = require('../../api/services/database');
const { buildErrorEmbed } = require('../utils/errors');

// Couleur d'accent, alignée sur /signaler pour l'unité visuelle des commandes
// « transparence / droits » ouvertes à tous.
const ACCENT_COLOR = 0xDE3163;

// Délai légal de réponse : un mois (art. 12.3 RGPD). On l'exprime en 30 jours,
// cohérent avec `due_at = requested_at + 1 mois` de la table erasure_requests.
const ERASURE_DELAY_DAYS = 30;

// Interlocuteurs pour l'exercice des droits. L'équipe du serveur est la
// responsable de traitement (elle décide) ; Venacity, sous-traitant qui héberge
// l'instance, se contente de router la demande et d'exécuter la décision.
const VENACITY_CONTACT = 'contact@vena.city';
// Site légal public de Venacity (où sont publiés le contrat de sous-traitance et
// la politique de confidentialité). Domaine réel de l'instance ; le chemin exact
// de la politique est référencé en toutes lettres plutôt qu'en lien profond, pour
// ne pas pointer vers une URL qui ne serait pas encore publiée (cf. sous-lot G).
const VENACITY_LEGAL_SITE = 'strata.vena.city';

// Cette commande est ouverte à TOUS les membres, pas seulement aux administrateurs :
// l'information des personnes concernées (art. 14 RGPD) et l'exercice de leurs droits
// n'ont de sens que si chacun, y compris un membre ordinaire, peut savoir ce que
// Quasar traite le concernant. C'est le même parti pris que /signaler.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('mes-donnees')
        .setDescription('Voir les données que Quasar traite vous concernant et exercer vos droits'),

    async execute(interaction) {
        // Hors serveur (message privé) : sans guild, impossible de savoir de quel
        // traitement on parle. On le dit clairement plutôt que de renvoyer un vide.
        if (!interaction.guild) {
            return interaction.reply({
                embeds: [buildErrorEmbed({
                    title: 'À utiliser sur un serveur',
                    cause: 'Quasar traite des données par serveur : en message privé, il n\'y a pas de serveur auquel les rattacher.',
                    action: 'Lancez /mes-donnees depuis un salon du serveur qui vous concerne.',
                })],
                ephemeral: true,
            });
        }

        const guildId = interaction.guild.id;
        const userId = interaction.user.id;
        const db = getDb();

        // ── Comptes réels lus en base ─────────────────────────────────────────
        // Dégradation gracieuse : si une table venait à manquer (premier boot),
        // on renvoie 0 plutôt que de faire échouer toute la commande.
        const sanctions = safeGet(db, `
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS actives
            FROM sanctions
            WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { total: 0, actives: 0 };

        const ticketsCount = (safeGet(db, `
            SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { n: 0 }).n;

        const prefsCount = (safeGet(db, `
            SELECT COUNT(*) AS n FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { n: 0 }).n;

        // ── Construction de l'embed (ton accessible, non juridique) ───────────
        const embed = new EmbedBuilder()
            .setTitle('🔒 Les données que Quasar traite te concernant')
            .setColor(ACCENT_COLOR)
            .setDescription(
                `Voici les catégories de données que Quasar traite à votre sujet **sur le serveur ${interaction.guild.name}**. ` +
                'Ces informations ne sont visibles que par vous.'
            );

        // 1. Identifiants Discord — cette catégorie s'applique toujours : dès que
        //    tu es concerné par quoi que ce soit, c'est via ton identifiant Discord.
        embed.addFields({
            name: '🪪 Votre identifiant Discord',
            value:
                'Quasar vous reconnaît par votre identifiant technique Discord, uniquement là où vous êtes concerné·e ' +
                '(une sanction, un ticket, une préférence). Il ne stocke ni votre nom réel, ni votre e-mail, ni votre mot de passe.',
        });

        // 2. Sanctions — on donne le nombre, jamais le détail (potentiellement
        //    sensible) : pour en connaître la teneur, on renvoie vers l'admin.
        embed.addFields({
            name: '⚖️ Sanctions de modération te concernant',
            value: sanctions.total > 0
                ? `**${sanctions.total}** sanction(s) enregistrée(s) te concernant ici` +
                  (sanctions.actives > 0 ? `, dont **${sanctions.actives}** encore active(s).` : ' (aucune active actuellement).') +
                  '\nPour en connaître le détail, adressez-vous à l\'équipe d\'administration du serveur.'
                : 'Aucune sanction enregistrée te concernant sur ce serveur.',
        });

        // 3. Tickets ouverts à ton nom — on rappelle que le contenu des échanges
        //    n'est jamais conservé par Quasar (seules les métadonnées le sont).
        embed.addFields({
            name: '🎫 Tickets que vous avez ouverts',
            value: ticketsCount > 0
                ? `**${ticketsCount}** ticket(s) ouvert(s) à votre nom sur ce serveur. ` +
                  'Le contenu des conversations n\'est jamais conservé par Quasar, seulement le fait qu\'un ticket a existé.'
                : 'Aucun ticket ouvert à votre nom sur ce serveur.',
        });

        // 4. Préférences de salons vocaux temporaires — n'existent que si tu as
        //    déjà personnalisé un salon ; on n'affiche la catégorie que si c'est le cas.
        if (prefsCount > 0) {
            embed.addFields({
                name: '🔊 Préférences de salons vocaux temporaires',
                value:
                    'Vos préférences de salon vocal temporaire (nom du salon, limite de membres) sont mémorisées ' +
                    'pour te les réappliquer automatiquement la prochaine fois.',
            });
        }

        // 5. Exercice des droits — fidèle au partage des rôles : l'admin décide,
        //    Venacity route et exécute.
        embed.addFields({
            name: '✅ Comment exercer vos droits',
            value:
                'Vous pouvez demander à accéder à ces données, à les corriger ou à les supprimer.\n' +
                '• **En premier lieu, l\'équipe d\'administration de ce serveur** : elle est responsable de vos données ici, ' +
                'c\'est elle qui prend les décisions.\n' +
                `• **Venacity** (${VENACITY_CONTACT}) héberge Quasar en tant que sous-traitant : elle transmet votre demande ` +
                'à l\'équipe du serveur et exécute sa décision, sans se substituer à elle.\n' +
                `Plus de détails dans la politique de confidentialité publique de Venacity (${VENACITY_LEGAL_SITE}).`,
        });

        embed.setFooter({
            text: 'Vous pouvez aussi déposer une demande de suppression directement ci-dessous.',
        });

        // Bouton de dépôt d'une demande de suppression, routé à l'admin responsable.
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('mesdonnees_erase')
                .setLabel('Demander la suppression de mes données')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
        );

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    },
};

/**
 * Dépose une demande de suppression (droit à l'effacement, art. 17) déclenchée par
 * le bouton de /mes-donnees. Appelé depuis le routeur d'interactions de bot/index.js.
 *
 * La demande est enregistrée dans `erasure_requests` (source='command') puis routée
 * à l'équipe d'administration du serveur, qui dispose d'un mois pour se prononcer.
 * Idempotence : si une demande 'pending' de la même personne existe déjà sur ce
 * serveur, on ne la duplique pas — on informe qu'elle est déjà en cours.
 */
async function handleMesDonneesButton(interaction) {
    // On ne traite que le bouton de suppression ; le routeur nous envoie tout le
    // préfixe `mesdonnees_`, on ignore proprement ce qui ne nous concerne pas.
    if (interaction.customId !== 'mesdonnees_erase') return;

    // Un clic hors serveur ne devrait pas arriver (le message est éphémère et lié à
    // un serveur), mais on se protège : sans guild, aucune demande rattachable.
    if (!interaction.guild) {
        return interaction.reply({
            embeds: [buildErrorEmbed({
                title: 'À utiliser sur un serveur',
                cause: 'Une demande de suppression se rattache à un serveur précis, indisponible en message privé.',
                action: 'Relancez /mes-donnees depuis le serveur concerné.',
            })],
            ephemeral: true,
        });
    }

    const guildId = interaction.guild.id;
    const subjectId = interaction.user.id;
    const db = getDb();

    // La clé étrangère erasure_requests.guild_id → guilds(guild_id) est active
    // (PRAGMA foreign_keys = ON). On garantit la présence de la ligne du serveur,
    // comme le fait le handler `ready`, pour qu'un serveur tout juste rejoint ne
    // fasse pas échouer l'insertion.
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)')
        .run(guildId, interaction.guild.name);

    // Idempotence raisonnable : une seule demande en cours par personne et par serveur.
    const existing = db.prepare(`
        SELECT id, requested_at FROM erasure_requests
        WHERE guild_id = ? AND subject_id = ? AND status = 'pending'
        ORDER BY requested_at DESC LIMIT 1
    `).get(guildId, subjectId);

    if (existing) {
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('📨 Demande déjà en cours')
                    .setColor(ACCENT_COLOR)
                    .setDescription(
                        'Une demande de suppression te concernant est **déjà en attente de traitement** sur ce serveur. ' +
                        'Inutile d\'en déposer une nouvelle : l\'équipe d\'administration du serveur en a été informée ' +
                        'et dispose d\'un mois pour y répondre.\n\n' +
                        `Pour un suivi ou une précision, vous pouvez contacter l\'équipe du serveur ou Venacity (${VENACITY_CONTACT}).`
                    ),
            ],
            ephemeral: true,
        });
    }

    // Horodatage en secondes (unixepoch), cohérent avec le reste du lot 2.
    const now = Math.floor(Date.now() / 1000);
    const dueAt = now + ERASURE_DELAY_DAYS * 24 * 60 * 60;

    db.prepare(`
        INSERT INTO erasure_requests
            (guild_id, subject_id, category, details, requested_at, due_at, status, source)
        VALUES (?, ?, 'mixed', ?, ?, ?, 'pending', 'command')
    `).run(guildId, subjectId, 'Demande déposée via /mes-donnees', now, dueAt);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setTitle('✅ Demande de suppression transmise')
                .setColor(ACCENT_COLOR)
                .setDescription(
                    'Votre demande de suppression a été **transmise à l\'équipe d\'administration de ce serveur**, ' +
                    'qui est responsable de vos données et décide des suites à donner. ' +
                    'Elle dispose d\'**un mois** pour y répondre.\n\n' +
                    `Venacity (${VENACITY_CONTACT}), qui héberge Quasar, a acheminé votre demande et exécutera la décision de l\'équipe. ` +
                    'Certaines données peuvent devoir être conservées (par exemple une sanction encore active) ; ' +
                    'le cas échéant, l\'équipe du serveur te le fera savoir.'
                )
                .setFooter({ text: 'Vous pouvez fermer ce message : votre demande est enregistrée.' }),
        ],
        ephemeral: true,
    });
}

/**
 * Lit une seule ligne sans jamais faire échouer la commande : une table absente au
 * tout premier boot renvoie une exception, qu'on absorbe en renvoyant null.
 */
function safeGet(db, sql, params) {
    try {
        return db.prepare(sql).get(...params);
    } catch (err) {
        console.error('[Quasar] /mes-donnees — lecture ignorée :', err.message);
        return null;
    }
}

// Handler du bouton, branché depuis le routeur d'interactions (préfixe `mesdonnees_`),
// exactement comme handleReportModal l'est pour /signaler.
module.exports.handleMesDonneesButton = handleMesDonneesButton;
