// ═══════════════════════════════════════════════════════════════
//  Déclenchement d'une règle AutoMod — événement neutre `sanctionAutomatique`
//
//  Quand cet événement arrive, la plateforme A DÉJÀ AGI : le message a été
//  bloqué, l'alerte publiée, l'exclusion posée. Quasar ne fait donc ici que deux
//  choses, et surtout pas une troisième :
//    1. HISTORISER le déclenchement dans la table `sanctions`, pour qu'il
//       apparaisse dans l'historique de modération du dashboard au même titre
//       qu'une sanction manuelle ;
//    2. JOURNALISER dans le salon dédié de la règle (repli automatique sur le
//       modlog global assuré par sendAutomodLog).
//
//  Il n'APPLIQUE aucune punition. Rejouer une sanction par-dessus celle de la
//  plateforme donnerait deux exclusions pour un seul message, et un historique où
//  personne ne saurait dire qui a fait quoi.
//
//  ─── `capaciteRequise: 'automod'`, et pas un test de plateforme ───
//  Fluxer n'a aucun automod. Ce handler déclare donc la CAPACITÉ dont il dépend :
//  le chargeur d'événements ne le branche pas là où elle est absente, et pas une
//  ligne de ce fichier n'a besoin de nommer Discord. Le jour où une plateforme
//  livre une modération automatique native, elle bascule le booléen et hérite du
//  parcours complet.
//
//  ─── Un événement PAR ACTION exécutée ───
//  Une règle qui bloque ET exclut déclenche deux événements pour un seul message.
//  On enregistre donc une ligne par action réellement subie — un message bloqué et
//  une exclusion sont deux faits distincts — et AUCUNE ligne pour l'alerte, qui
//  n'est qu'une notification adressée à l'équipe, pas une sanction.
//
//  ─── Le type `automod` n'est pas un avertissement ───
//  Les blocages sont enregistrés sous le type `automod`, jamais `warn`.
//  L'escalade par avertissements compte les lignes `type = 'warn' AND active = 1` :
//  utiliser `warn` ici ferait sanctionner à nouveau, par un autre module, un
//  message que la plateforme avait déjà bloqué. C'est exactement la double
//  punition que l'architecture de ce module cherche à éviter.
// ═══════════════════════════════════════════════════════════════

const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { getDb } = require('../../api/services/database');
const { sendAutomodLog, formatDuration } = require('../utils/punishments');

// Correspondance action AutoMod → ce qu'on en dit et ce qu'on en garde.
//
// Indexée sur les clés STABLES du catalogue (`automodSync.ACTIONS`), et non plus
// sur les entiers de `AutoModerationActionType` : c'est ce qui permet à ce
// fichier de ne plus importer discord.js. La traduction entier → clé est faite
// par `ACTION_BY_DISCORD_TYPE`, chargé paresseusement ci-dessous.
//
// `sanctionType` à null signifie « on journalise, on n'historise pas » :
// l'alerte n'est subie par personne.
// `logType` réutilise les catégories existantes de bot/utils/logger.js — toutes
// les catégories `mod_*` sont actives par défaut, un serveur qui se met à jour
// voit donc ces logs sans rien avoir à cocher.
const ACTION_VIEW = {
    BLOCK_MESSAGE: {
        sanctionType: 'automod',
        logType: 'mod_clear',
        title: '🛡️ Message bloqué par AutoMod',
        color: 0x95a5a6,
    },
    SEND_ALERT_MESSAGE: {
        sanctionType: null,
        logType: 'mod_clear',
        title: '🛡️ Alerte AutoMod',
        color: 0x3498db,
    },
    TIMEOUT: {
        sanctionType: 'mute',
        logType: 'mod_mute',
        title: '🔇 Exclusion temporaire par AutoMod',
        color: 0xe67e22,
    },
    BLOCK_MEMBER_INTERACTION: {
        sanctionType: 'automod',
        logType: 'mod_mute',
        title: '🛡️ Interactions bloquées par AutoMod',
        color: 0xe67e22,
    },
};

/**
 * Écrit l'historique du déclenchement.
 *
 * Volontairement local plutôt qu'emprunté à punishments.js : `recordSanction`
 * n'y est pas exporté, et ce module n'applique aucune punition — il n'a donc rien
 * d'autre à partager avec lui que cette insertion de trois lignes.
 *
 * Un échec d'écriture (table absente au tout premier démarrage, serveur inconnu
 * de la table `guilds` vers laquelle pointe la clé étrangère) ne doit pas
 * empêcher la journalisation : le fait s'est produit, il doit rester visible.
 */
function recordTrigger({ guildId, userId, moderatorId, type, reason, duration }) {
    try {
        return getDb().prepare(`
            INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, duration)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(guildId, userId, moderatorId, type, reason, duration || null).lastInsertRowid;
    } catch (err) {
        console.error('[Quasar AutoMod] Historisation du déclenchement en échec :', err.message);
        return null;
    }
}

/** Ligne miroir de la règle déclenchée, ou null si Quasar ne la connaît pas. */
function findRuleRow(guildId, ruleId) {
    try {
        return getDb().prepare('SELECT * FROM automod_rules WHERE guild_id = ? AND discord_rule_id = ?')
            .get(guildId, ruleId) || null;
    } catch (err) {
        console.error('[Quasar AutoMod] Lecture de la règle déclenchée en échec :', err.message);
        return null;
    }
}

module.exports = definirEvenement({
    nom: 'sanctionAutomatique',
    // Sans cette ligne, le handler serait branché sur une plateforme dépourvue
    // d'automod — où l'événement n'arrive jamais, mais où `automodSync` finirait
    // par tirer discord.js dans un processus qui n'en veut pas.
    capaciteRequise: 'automod',

    /**
     * @param {object} ctx       contexte d'événement neutre
     * @param {object} sanction  { guildeId, membreId, regleId, action, contenu,
     *                             canalId, declencheurNatif, motCle, dureeSecondes }
     */
    async executer(ctx, sanction) {
        if (!sanction?.guildeId) return;

        // ⚠️ CHARGEMENT PARESSEUX, et sous la garde de `capaciteRequise`
        // ci-dessus. `automodSync` est l'exception assumée au principe « seul
        // bot/platform/discord/ dépend de discord.js » (voir son en-tête) :
        // l'importer en tête de CE fichier l'évaluerait au démarrage de
        // n'importe quelle plateforme, y compris celles qui n'ont pas d'automod.
        const { ACTION_BY_DISCORD_TYPE, TRIGGER_BY_DISCORD_TYPE } = require('../utils/automodSync');

        const view = ACTION_VIEW[ACTION_BY_DISCORD_TYPE.get(sanction.action)?.key];
        // Action inconnue de cette version : la plateforme peut en ajouter. On ne
        // devine pas ce qu'elle fait, et on ne l'enregistre pas comme une sanction.
        if (!view) {
            console.warn(`[Quasar AutoMod] Action Discord inconnue (type ${sanction.action}) — déclenchement non journalisé.`);
            return;
        }

        // La règle peut être totalement inconnue de Quasar : créée directement
        // dans les réglages de la plateforme, ou supprimée du miroir. Ce n'est pas
        // une erreur — la journalisation retombe simplement sur le modlog global.
        const row = findRuleRow(sanction.guildeId, sanction.regleId);
        const trigger = TRIGGER_BY_DISCORD_TYPE.get(sanction.declencheurNatif);

        const ruleName = row?.name || 'règle non enregistrée dans Quasar';
        const triggerLabel = trigger?.label || 'déclencheur inconnu';
        const reason = `AutoMod Discord — ${ruleName} (${triggerLabel})`;

        const durationSeconds = sanction.dureeSecondes ?? null;
        const duration = view.sanctionType === 'mute' && durationSeconds
            ? formatDuration(durationSeconds * 1000)
            : null;

        let sanctionId = null;
        if (view.sanctionType) {
            sanctionId = recordTrigger({
                guildId: sanction.guildeId,
                userId: sanction.membreId,
                // Identité du bot lue sur le contexte : c'est elle qui figure en
                // modérateur d'une sanction automatique.
                moderatorId: ctx.moi?.id || '0',
                type: view.sanctionType,
                reason,
                duration,
            });
        }

        const champs = [
            { nom: 'Membre', valeur: sanction.membreId ? `<@${sanction.membreId}> (${sanction.membreId})` : 'Inconnu', enLigne: true },
            { nom: 'Règle', valeur: ruleName.slice(0, 1024), enLigne: true },
            { nom: 'Filtre', valeur: triggerLabel, enLigne: true },
        ];

        if (sanction.canalId) champs.push({ nom: 'Salon', valeur: `<#${sanction.canalId}>`, enLigne: true });
        if (duration) champs.push({ nom: 'Durée', valeur: duration, enLigne: true });
        if (sanctionId) champs.push({ nom: 'Numéro de sanction', valeur: `#${sanctionId}`, enLigne: true });
        if (sanction.motCle) {
            champs.push({ nom: 'Terme détecté', valeur: `\`${sanction.motCle.slice(0, 200)}\`` });
        }
        // Le contenu incriminé n'est ajouté que s'il est effectivement transmis
        // (il dépend de l'intent « Contenu des messages »). Tronqué court : un
        // journal de modération n'a pas vocation à rediffuser intégralement ce que
        // la plateforme vient de bloquer.
        if (sanction.contenu) {
            champs.push({ nom: 'Contenu', valeur: `\`\`\`${sanction.contenu.slice(0, 500).replace(/```/g, "'''")}\`\`\`` });
        }

        // Portée d'écriture : le contexte d'un événement ne porte pas de serveur
        // (il n'en vise aucun en particulier), c'est le payload qui le nomme.
        const portee = { guildeId: sanction.guildeId, api: ctx.api, moi: ctx.moi };

        await sendAutomodLog(portee, embed({
            titre: view.title,
            couleur: view.color,
            champs,
            pied: { texte: 'Filtré par Discord — Quasar ne fait qu\'enregistrer.' },
            horodatage: true,
        }), view.logType, row?.log_channel).catch(err => {
            console.error('[Quasar AutoMod] Journalisation du déclenchement en échec :', err.message);
        });
    },
});
