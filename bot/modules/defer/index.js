// ═══════════════════════════════════════════════════════════════
//  Salon d'arbitrage (« defer »)
//
//  Toute règle de modération automatique peut, au lieu de sanctionner, poser le
//  cas dans un salon où l'équipe tranche. C'est la soupape du chantier : une
//  règle trop large ne bannit personne tant qu'une personne n'a pas validé.
//
//  Deux contraintes commandent toute la conception de ce module :
//
//   • LE BOT REDÉMARRE. Aucun état n'est gardé en mémoire : l'identifiant du cas
//     voyage dans la clé du choix, et tout le reste est relu en base. Un bouton
//     cliqué trois semaines et deux redéploiements plus tard fonctionne.
//   • DEUX PERSONNES CLIQUENT EN MÊME TEMPS. La résolution passe par un UPDATE
//     conditionné à `status = 'pending'` : c'est la base qui départage, et la
//     seconde personne reçoit un refus explicite au lieu d'une double sanction.
//
//  ─── Le panneau n'appartient à aucune commande ─────────────────────────────
//
//  L'arbitrage se configure au dashboard : il n'y a pas de `/defer` sur laquelle
//  accrocher une clé `panneaux`. Le handler des clics vit donc dans
//  `bot/panneaux/defer.js`, par `definirPanneau` — la seconde porte du registre.
//  Ce fichier ne fait que POSER le panneau et lire la base.
// ═══════════════════════════════════════════════════════════════

const { embed } = require('../../platform/embed');
const { getDb } = require('../../../api/services/database');
const { SOURCE_LABELS } = require('../../utils/punishments');
const { resoudrePorteeNeutre } = require('../../utils/errors');

const COLOR_PENDING = 0xf1c40f;
const COLOR_APPLIED = 0xe74c3c;
const COLOR_IGNORED = 0x95a5a6;

// Nom du panneau persistant de ce module. Le même mot à la déclaration
// (`bot/panneaux/defer.js`), à la pose (`poserPanneau`) et au routage.
const PANNEAU = 'defer';

// Verbes portés par la clé du choix : `apply:42`, `ignore:42`.
const VERBE_APPLIQUER = 'apply';
const VERBE_IGNORER = 'ignore';

/** Configuration du salon d'arbitrage d'un serveur, ou null. */
function getDeferConfig(guildId) {
    try {
        return getDb().prepare('SELECT * FROM defer_config WHERE guild_id = ?').get(guildId) || null;
    } catch (err) {
        console.error('[Quasar Arbitrage] Lecture de la configuration en échec :', err.message);
        return null;
    }
}

function getCase(caseId) {
    try {
        return getDb().prepare('SELECT * FROM defer_cases WHERE id = ?').get(caseId) || null;
    } catch (err) {
        console.error('[Quasar Arbitrage] Lecture du cas en échec :', err.message);
        return null;
    }
}

/**
 * Tente de s'attribuer un cas encore en attente. C'est le point de sérialisation
 * du module : l'UPDATE ne touche la ligne que si elle est toujours `pending`, donc
 * un seul appel concurrent peut réussir.
 *
 * @returns {boolean} true si l'appelant vient de résoudre le cas.
 */
function claimCase(caseId, status, resolvedBy) {
    try {
        const result = getDb().prepare(`
            UPDATE defer_cases
            SET status = ?, resolved_by = ?, resolved_at = unixepoch()
            WHERE id = ? AND status = 'pending'
        `).run(status, resolvedBy, caseId);
        return result.changes === 1;
    } catch (err) {
        console.error('[Quasar Arbitrage] Résolution du cas en échec :', err.message);
        return false;
    }
}

/** `apply:42` → { verb: 'apply', caseId: 42 } ; null si le format ne colle pas. */
function analyserCle(cle) {
    const trouve = /^(apply|ignore):(\d+)$/.exec(cle || '');
    if (!trouve) return null;
    return { verb: trouve[1], caseId: Number(trouve[2]) };
}

function buildCaseEmbed(row, { evidence } = {}) {
    const champs = [
        { nom: 'Membre', valeur: `<@${row.target_user_id}> (${row.target_user_id})`, enLigne: true },
        { nom: 'Déclencheur', valeur: SOURCE_LABELS[row.source] || 'Modération automatique', enLigne: true },
        { nom: 'Motif', valeur: (row.reason || 'Aucun motif précisé').slice(0, 1024) },
        {
            nom: 'Sanctions proposées',
            valeur: row.proposed_punishments
                ? `\`${String(row.proposed_punishments).slice(0, 1000)}\``
                : 'Aucune — signalement seul.',
        },
    ];

    // La preuve est affichée mais jamais conservée en base : elle vit dans ce
    // message, comme le reste du salon, et disparaît avec lui.
    if (evidence) {
        champs.push({ nom: 'Élément déclencheur', valeur: String(evidence).slice(0, 1024) });
    }

    return embed({
        titre: `⚖️ Cas d'arbitrage #${row.id}`,
        couleur: COLOR_PENDING,
        description: 'Une règle de modération automatique propose une sanction. Rien n\'a encore été appliqué.',
        champs,
        horodatage: row.created_at ? row.created_at * 1000 : Date.now(),
    });
}

/** Les deux actions offertes à l'équipe, au format neutre des choix. */
function buildCaseChoix(caseId) {
    return [
        {
            cle: `${VERBE_APPLIQUER}:${caseId}`,
            libelle: 'Appliquer les sanctions',
            emoji: '⚖️',
            style: 'danger',
        },
        {
            cle: `${VERBE_IGNORER}:${caseId}`,
            libelle: 'Ignorer le cas',
            emoji: '🕊️',
            style: 'secondaire',
        },
    ];
}

/**
 * Embed d'un cas déjà tranché. Un salon d'arbitrage où l'on ne sait plus ce qui a
 * été traité, par qui et quand ne sert à rien : le message d'origine est réécrit,
 * jamais laissé tel quel avec ses boutons morts.
 */
function buildResolvedEmbed(row, { resolvedBy, outcomeLines }) {
    const applied = row.status === 'approved';
    const champs = [
        { nom: 'Membre', valeur: `<@${row.target_user_id}> (${row.target_user_id})`, enLigne: true },
        { nom: 'Déclencheur', valeur: SOURCE_LABELS[row.source] || 'Modération automatique', enLigne: true },
        { nom: 'Motif', valeur: (row.reason || 'Aucun motif précisé').slice(0, 1024) },
        {
            nom: 'Sanctions proposées',
            valeur: row.proposed_punishments
                ? `\`${String(row.proposed_punishments).slice(0, 1000)}\``
                : 'Aucune — signalement seul.',
        },
        {
            nom: 'Arbitrage',
            valeur: `${applied ? 'Appliqué' : 'Ignoré'} par <@${resolvedBy}> — <t:${row.resolved_at || Math.floor(Date.now() / 1000)}:f>`,
        },
    ];

    if (outcomeLines?.length) {
        champs.push({ nom: 'Résultat', valeur: outcomeLines.join('\n').slice(0, 1024) });
    }

    return embed({
        titre: `⚖️ Cas d'arbitrage #${row.id} — ${applied ? 'sanctions appliquées' : 'cas ignoré'}`,
        couleur: applied ? COLOR_APPLIED : COLOR_IGNORED,
        champs,
        horodatage: true,
    });
}

/**
 * Portée d'écriture du module, quelle que soit la forme reçue.
 *
 * `applyPunishments` transmet sa cible telle quelle : un `ctx` neutre depuis
 * l'escalade d'avertissements et le panneau d'arbitrage, une `Guild` discord.js
 * depuis l'anti-raid et le salon piège, qui ne sont pas encore migrés.
 *
 * @returns {null|{guildeId, api, moiId, poserPanneau}}
 */
function resoudrePortee(cible) {
    const portee = resoudrePorteeNeutre(cible);
    if (portee) {
        return {
            ...portee,
            // `poserPanneau` est exposé par tous les contextes neutres —
            // commande, panneau, événement. Une portée littérale
            // `{ guildeId, api }` n'en a pas : elle ne peut pas poser de boutons,
            // et on le dira plutôt que de poster un cas inarbitrable.
            poserPanneau: typeof cible.poserPanneau === 'function'
                ? cible.poserPanneau.bind(cible)
                : null,
        };
    }

    // TRANSITION : format historique, à retirer au lot de consolidation.
    // Une `Guild` discord.js, reçue de l'anti-raid et du salon piège. On en
    // dérive une portée neutre plutôt que de dupliquer tout l'envoi : le corps
    // de `sendDeferCase` reste alors unique, et les deux voies produisent le
    // même message et le même `customId`. Requires différés, comme le fait déjà
    // `versEmbedDiscord` dans bot/utils/errors.js.
    if (!cible || typeof cible !== 'object' || !cible.id || !cible.client) return null;
    const { creerApi } = require('../../platform/discord/api');
    const { poserPanneau } = require('../../platform/discord/context');
    const api = creerApi(cible.client);
    return {
        guildeId: cible.id,
        api,
        moiId: cible.client?.user?.id ?? null,
        poserPanneau: (canalId, contenu, choix, options) => poserPanneau({ api }, canalId, contenu, choix, options),
    };
}

/**
 * Pose un cas dans le salon d'arbitrage. Ne lève jamais.
 *
 * @param {object} cible  portée neutre (`ctx`) ou `Guild` discord.js
 * @param {object} caseData
 * @param {string} caseData.targetUserId
 * @param {string} caseData.source — 'automod' | 'escalation' | 'antiraid' | 'honeypot'
 * @param {string} caseData.reason
 * @param {string} caseData.proposedPunishments — chaîne de punitions composables
 * @param {string} [caseData.evidence] — extrait affiché, jamais stocké
 * @returns {Promise<{ ok: boolean, caseId?: number, error?: string }>}
 */
async function sendDeferCase(cible, caseData = {}) {
    if (!cible) return { ok: false, error: 'serveur indisponible' };
    if (!caseData.targetUserId) return { ok: false, error: 'membre visé inconnu' };

    const portee = resoudrePortee(cible);
    if (!portee || !portee.guildeId) return { ok: false, error: 'serveur indisponible' };
    if (!portee.poserPanneau) {
        return { ok: false, error: 'cette portée ne sait pas poser de panneau d\'arbitrage' };
    }

    const config = getDeferConfig(portee.guildeId);
    if (!config || !config.enabled || !config.channel_id) {
        return { ok: false, error: 'aucun salon d\'arbitrage actif sur ce serveur' };
    }

    const canalId = String(config.channel_id);
    const canal = await portee.api.obtenirCanal(canalId).catch(() => null);
    if (!canal) return { ok: false, error: 'le salon d\'arbitrage configuré n\'existe plus' };

    // Tant que l'identité du bot n'est pas connue, on ne sait rien de ses droits
    // et on n'invente pas de refus — c'est la règle du pré-contrôle de sanction.
    if (portee.moiId) {
        const permissions = await portee.api.permissionsSurCanal(canalId, portee.moiId).catch(() => null);
        if (!permissions?.aPermission('VIEW_CHANNEL') || !permissions?.aPermission('SEND_MESSAGES')) {
            return { ok: false, error: 'je n\'ai pas le droit d\'écrire dans le salon d\'arbitrage' };
        }
    }

    let row;
    try {
        const db = getDb();
        const inserted = db.prepare(`
            INSERT INTO defer_cases
                (guild_id, channel_id, target_user_id, source, reason, proposed_punishments, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `).run(
            portee.guildeId,
            canalId,
            String(caseData.targetUserId),
            caseData.source || 'automod',
            caseData.reason || null,
            caseData.proposedPunishments || null
        );
        row = getCase(inserted.lastInsertRowid);
    } catch (err) {
        console.error('[Quasar Arbitrage] Création du cas en échec :', err.message);
        return { ok: false, error: 'le cas n\'a pas pu être enregistré' };
    }
    if (!row) return { ok: false, error: 'le cas n\'a pas pu être enregistré' };

    let pose;
    try {
        pose = await portee.poserPanneau(
            canalId,
            buildCaseEmbed(row, { evidence: caseData.evidence }),
            buildCaseChoix(row.id),
            { panneau: PANNEAU },
        );
    } catch (err) {
        // Message impossible à poster : le cas serait invisible et resterait
        // « en attente » pour toujours. On le retire plutôt que de laisser une
        // file d'attente fantôme grossir en base.
        try { getDb().prepare('DELETE FROM defer_cases WHERE id = ?').run(row.id); } catch {}
        console.error('[Quasar Arbitrage] Envoi du cas en échec :', err.message);
        return { ok: false, error: 'le message d\'arbitrage n\'a pas pu être posté' };
    }

    try {
        getDb().prepare('UPDATE defer_cases SET message_id = ? WHERE id = ?').run(pose.messageId, row.id);
    } catch (err) {
        // Sans identifiant de message, le cas reste arbitrable (les boutons
        // portent son identifiant) : seule la reprise depuis la base perdrait le
        // lien. Ce n'est pas un motif d'échec.
        console.error('[Quasar Arbitrage] Message du cas non mémorisé :', err.message);
    }

    return { ok: true, caseId: row.id };
}

module.exports = {
    PANNEAU,
    VERBE_APPLIQUER,
    VERBE_IGNORER,
    analyserCle,
    getDeferConfig,
    getCase,
    claimCase,
    sendDeferCase,
    buildCaseEmbed,
    buildCaseChoix,
    buildResolvedEmbed,
};
