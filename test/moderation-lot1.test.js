// Lot 1 du chantier multiplateforme : la modération au contrat neutre.
//
// Ce que ce fichier doit tenir, dans cet ordre d'importance :
//
//  1. LE JSON DÉPLOYÉ NE BOUGE PAS. Les neuf commandes migrées tournent sur une
//     instance en production. Les références ci-dessous ont été relevées sur les
//     `SlashCommandBuilder` d'origine AVANT migration (`git show dev:<fichier>`,
//     puis `data.toJSON()`), et sont écrites en dur : les recalculer depuis le
//     code testé ne prouverait rien. Une différence, même cosmétique, se paie en
//     re-déploiement silencieux à chaque démarrage.
//  2. LES EMBEDS NE BOUGENT PAS non plus — mêmes titres, mêmes couleurs, mêmes
//     champs, même ordre, même répartition en ligne / pleine largeur.
//  3. Les utilitaires de modération passent par le contrat neutre, et
//     `sendModLog` reste bi-format tant que `punishments.js` l'appelle avec une
//     `Guild`.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données :
// les commandes chargées ici l'ouvrent.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../api/services/database');
const { construireSlashCommand, chargerCommandes } = require('../bot/platform/discord/commands');
const { rendreEmbed } = require('../bot/platform/discord/render');
const { estEmbed } = require('../bot/platform/embed');
const { CODES_NEUTRES } = require('../bot/platform/erreurs');
const { marquerErreur } = require('../bot/platform/discord/erreurs');
const { DISABLED_COMMAND_FILES } = require('../bot/utils/disabledCommands');
const { sendModLog } = require('../bot/utils/modlog');

const GUILDE = '120000000000000001';
const SALON = '120000000000000002';
const SALON_LOG = '120000000000000003';
const MODO = '120000000000000004';
const CIBLE = '120000000000000005';
const BOT = '120000000000000006';
const PROPRIETAIRE = '120000000000000007';

// ── Amorçage ─────────────────────────────────────────────────────────────────

const db = getDb();
db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Serveur de test');
db.prepare(`
    INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
    ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
`).run(GUILDE, JSON.stringify({ logChannel: SALON_LOG }));

// ── Outils ───────────────────────────────────────────────────────────────────

/** Corps réellement envoyé : `toJSON()` laisse des `undefined` que le fil n'emporte pas. */
const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

/** Embed neutre -> corps Discord, débarrassé de l'horodatage (variable par nature). */
function embedEnvoye(neutre) {
    assert.ok(estEmbed(neutre), 'un embed neutre était attendu');
    const { timestamp, ...reste } = corpsEnvoye(rendreEmbed(neutre));
    return reste;
}

const erreurApi = (code) => marquerErreur(Object.assign(new Error('erreur simulée'), { code }));

/** Utilisateur normalisé, tel que `ctx.options.get()` le rend. */
function utilisateur(id, { etiquette = 'jean#0', estBot = false } = {}) {
    return { id, nom: 'jean', etiquette, mention: `<@${id}>`, estBot };
}

/**
 * Contexte d'exécution réduit à ce que les commandes de ce lot consomment.
 *
 * `options.get` LÈVE sur un nom non déclaré par le descripteur, exactement comme
 * le lecteur réel (platform/discord/context.js) : c'est ce qui prouve qu'une
 * commande ne lit que des options qu'elle a déclarées, et qu'un renommage ne
 * passe pas inaperçu.
 */
function faireContexte(descripteur, valeurs = {}, { api = {} } = {}) {
    const reponses = [];
    const suites = [];
    const erreurs = [];
    const appels = [];
    const declarees = new Set((descripteur.options || []).map(o => o.nom));

    const tracer = (nom, resultat) => (...args) => {
        appels.push([nom, ...args]);
        return typeof resultat === 'function' ? resultat(...args) : resultat;
    };

    const ctx = {
        plateforme: 'discord',
        capacites: { interactions: true, ephemere: true, timeout: true, bulkDelete: true },
        guildeId: GUILDE,
        canalId: SALON,
        guilde: { id: GUILDE, nom: 'Serveur de test', proprietaireId: PROPRIETAIRE },
        proprietaireId: PROPRIETAIRE,
        auteur: utilisateur(MODO, { etiquette: 'leeva' }),
        moi: { id: BOT, nom: 'Quasar' },
        commande: descripteur.nom,
        db,
        reponses,
        suites,
        erreurs,
        appels,
        options: {
            get(nom) {
                if (!declarees.has(nom)) throw new Error(`Option « ${nom} » non déclarée par /${descripteur.nom}.`);
                return valeurs[nom] ?? null;
            },
            sousCommande: null,
        },
        api: {
            async obtenirMembre() { return { id: CIBLE, roles: [] }; },
            async verifierMembreSanctionnable() { return null; },
            async obtenirCanal(id) { return { id, parentId: null }; },
            async envoyerMessage(...a) { return tracer('envoyerMessage')(...a); },
            async exclureMembre(...a) { return tracer('exclureMembre')(...a); },
            async bannirMembre(...a) { return tracer('bannirMembre')(...a); },
            async appliquerTimeout(...a) { return tracer('appliquerTimeout')(...a); },
            ...api,
        },
        async repondre(contenu, options = {}) { reponses.push({ contenu, options }); },
        async suivre(contenu) { suites.push(contenu); },
        erreurUtilisateur(spec) { erreurs.push(spec); },
    };

    // Les stubs surchargés doivent être tracés eux aussi.
    for (const [nom, methode] of Object.entries(ctx.api)) {
        if (typeof methode !== 'function') continue;
        const original = methode;
        ctx.api[nom] = async (...args) => { appels.push([nom, ...args]); return original(...args); };
    }

    return ctx;
}

/** Dernier embed passé à `ctx.repondre`. */
const dernierEmbed = (ctx) => embedEnvoye(ctx.reponses.at(-1).contenu);

// ═══════════════════════════════════════════════════════════════
//  1. Non-régression du JSON déployé
// ═══════════════════════════════════════════════════════════════

// Relevé sur les builders d'origine, avant migration.
const REFERENCES = {
    warn: {
        options: [
            { name: 'membre', description: 'Le membre à avertir', required: true, type: 6 },
            { type: 3, name: 'raison', description: 'Raison de l\'avertissement', required: false },
        ],
        name: 'warn',
        description: 'Avertir un membre',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    warns: {
        options: [
            { name: 'membre', description: 'Le membre à vérifier', required: true, type: 6 },
        ],
        name: 'warns',
        description: 'Voir les avertissements d\'un membre',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    unwarn: {
        options: [
            { type: 4, name: 'id', description: 'ID de la sanction à retirer', required: true },
        ],
        name: 'unwarn',
        description: 'Retirer un avertissement',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    sanctions: {
        options: [
            { name: 'membre', description: 'Le membre à vérifier', required: true, type: 6 },
        ],
        name: 'sanctions',
        description: 'Voir l\'historique complet des sanctions d\'un membre',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    kick: {
        options: [
            { name: 'membre', description: 'Le membre à expulser', required: true, type: 6 },
            { type: 3, name: 'raison', description: 'Raison du kick', required: false },
        ],
        name: 'kick',
        description: 'Expulser un membre',
        default_member_permissions: '2',
        type: 1,
    },
    ban: {
        options: [
            { name: 'membre', description: 'Le membre à bannir', required: true, type: 6 },
            { type: 3, name: 'raison', description: 'Raison du ban', required: false },
            {
                max_value: 7, min_value: 0, type: 4, name: 'supprimer',
                description: 'Supprimer les messages des X derniers jours (0-7)', required: false,
            },
        ],
        name: 'ban',
        description: 'Bannir un membre',
        default_member_permissions: '4',
        type: 1,
    },
    mute: {
        options: [
            { name: 'membre', description: 'Le membre à mute', required: true, type: 6 },
            { type: 3, name: 'durée', description: 'Durée (ex: 10m, 1h, 1d)', required: true },
            { type: 3, name: 'raison', description: 'Raison du mute', required: false },
        ],
        name: 'mute',
        description: 'Mute (timeout) un membre',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    log: {
        options: [
            {
                channel_types: [0], name: 'channel', description: 'Le channel de logs',
                required: true, type: 7,
            },
        ],
        name: 'log',
        description: 'Définir le channel de logs de modération',
        default_member_permissions: '8',
        type: 1,
    },
    unlog: {
        options: [],
        name: 'unlog',
        description: 'Retirer le channel de logs de modération',
        default_member_permissions: '8',
        type: 1,
    },
};

for (const [nom, reference] of Object.entries(REFERENCES)) {
    test(`/${nom} — le descripteur produit le JSON de son builder d'origine`, () => {
        const descripteur = require(`../bot/commands/${nom}`);
        assert.deepEqual(corpsEnvoye(construireSlashCommand(descripteur)), reference);
    });
}

test('chaque commande migrée déclare les permissions dont le BOT a besoin', () => {
    // Sans ce champ, la commande sort du balayage `PermissionFlagsBits` et le
    // garde-fou du lien d'invitation devient un faux témoin. Un tableau vide est
    // une réponse valable, et c'est celle des commandes qui ne font qu'écrire en
    // base et répondre.
    const attendu = {
        warn: [], warns: [], unwarn: [], sanctions: [],
        kick: ['KICK_MEMBERS'], ban: ['BAN_MEMBERS'], mute: ['MODERATE_MEMBERS'],
        log: [], unlog: [],
    };
    for (const [nom, permissions] of Object.entries(attendu)) {
        assert.deepEqual(require(`../bot/commands/${nom}`).permissionsBot, permissions, `/${nom}`);
    }
});

test('les commandes de modération migrées sont bien reconnues comme neutres', () => {
    const entrees = chargerCommandes({
        dossier: path.join(__dirname, '..', 'bot', 'commands'),
        exclus: DISABLED_COMMAND_FILES,
    });
    const parNom = new Map(entrees.map(e => [e.nom, e]));

    for (const nom of Object.keys(REFERENCES)) {
        assert.equal(parNom.get(nom)?.neutre, true, `/${nom} doit être un descripteur neutre`);
    }
    // Les trois que le contrat ne permet pas encore de migrer (voir le
    // compte-rendu du lot 1) restent au format historique, et le chargeur doit
    // continuer de les accepter.
    for (const nom of ['unban', 'unmute', 'clear']) {
        assert.equal(parNom.get(nom)?.neutre, false, `/${nom} n'est pas encore migrable`);
    }
});

test('plus aucune commande de modération migrée n\'importe discord.js', () => {
    const fs = require('node:fs');
    const racine = path.join(__dirname, '..', 'bot');
    const fichiers = [
        ...Object.keys(REFERENCES).map(n => path.join(racine, 'commands', `${n}.js`)),
        path.join(racine, 'utils', 'warnEscalation.js'),
        path.join(racine, 'utils', 'modlog.js'),
    ];
    for (const fichier of fichiers) {
        const source = fs.readFileSync(fichier, 'utf8');
        assert.equal(/require\(['"]discord\.js['"]\)/.test(source), false,
            `${path.relative(racine, fichier)} importe encore discord.js`);
    }
});

// ═══════════════════════════════════════════════════════════════
//  2. Non-régression des embeds
// ═══════════════════════════════════════════════════════════════
//
// ⚠️ Une seule différence assumée par rapport à l'original, et elle est
// inhérente au rendu neutre : `rendreEmbed` pose `inline: Boolean(champ.enLigne)`
// sur TOUS les champs, donc `"inline": false` là où le builder d'origine ne
// posait aucune clé. L'affichage est identique (Discord considère l'absence
// comme `false`) ; seul le corps JSON diffère. Les références ci-dessous le
// portent explicitement, pour que la différence soit déclarée et non subie.

test('/warn — embed, escalade et journal passent par le contrat neutre', async () => {
    const descripteur = require('../bot/commands/warn');
    const ctx = faireContexte(descripteur, {
        membre: utilisateur(CIBLE),
        raison: 'Spam répété',
    });

    await descripteur.executer(ctx);

    const embedWarn = dernierEmbed(ctx);
    const idSanction = embedWarn.fields.at(-1).value;

    assert.deepEqual(embedWarn, {
        title: '⚠️ Avertissement',
        color: 0xf1c40f,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Modérateur', value: `<@${MODO}>`, inline: true },
            { name: 'Raison', value: 'Spam répété', inline: false },
            // Le libellé porte la fenêtre de rétention du serveur — 12 mois par
            // défaut. Sans elle, un modérateur qui voit « 2 warns » alors que le
            // membre en a cinq dans l'historique croit à un bug.
            { name: 'Warns actifs (12 mois)', value: '1', inline: true },
            { name: 'ID sanction', value: idSanction, inline: true },
        ],
    });

    // L'avertissement est bien écrit dans l'historique, avec le modérateur réel.
    const ligne = db.prepare('SELECT * FROM sanctions WHERE id = ?').get(Number(idSanction.slice(1)));
    assert.equal(ligne.type, 'warn');
    assert.equal(ligne.user_id, CIBLE);
    assert.equal(ligne.moderator_id, MODO);

    // Le journal de modération part par le client REST normalisé, pas par un
    // salon discord.js sorti d'un cache.
    const log = ctx.appels.find(([nom]) => nom === 'envoyerMessage');
    assert.ok(log, 'aucun journal de modération envoyé');
    assert.equal(log[1], SALON_LOG);
    assert.deepEqual(embedEnvoye(log[2]), embedWarn);
});

test('/warn — les trois refus d\'usage restent des erreurs d\'usage', async () => {
    const descripteur = require('../bot/commands/warn');

    const parti = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: { async obtenirMembre() { return null; } },
    });
    await descripteur.executer(parti);
    assert.equal(parti.erreurs[0].titre, 'Membre introuvable');

    const soiMeme = faireContexte(descripteur, { membre: utilisateur(MODO) });
    await descripteur.executer(soiMeme);
    assert.equal(soiMeme.erreurs[0].titre, 'Vous ne pouvez pas vous avertir vous-même');

    const bot = faireContexte(descripteur, { membre: utilisateur(CIBLE, { estBot: true }) });
    await descripteur.executer(bot);
    assert.equal(bot.erreurs[0].titre, 'Les bots ne peuvent pas être avertis');

    // Aucun des trois n'a rien écrit en base.
    for (const ctx of [parti, soiMeme, bot]) assert.equal(ctx.reponses.length, 0);
});

test('/kick — pré-contrôle neutre, exclusion par le client REST, journal', async () => {
    const descripteur = require('../bot/commands/kick');
    const ctx = faireContexte(descripteur, { membre: utilisateur(CIBLE), raison: 'Insultes' });

    await descripteur.executer(ctx);

    assert.deepEqual(dernierEmbed(ctx), {
        title: '🔴 Expulsion',
        color: 0xe74c3c,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Modérateur', value: `<@${MODO}>`, inline: true },
            { name: 'Raison', value: 'Insultes', inline: false },
        ],
    });
    assert.deepEqual(
        ctx.appels.find(([nom]) => nom === 'exclureMembre'),
        ['exclureMembre', GUILDE, CIBLE, 'Insultes'],
    );

    // `verifierMembreSanctionnable` remplace `member.kickable`, et rend le MÊME
    // message : hiérarchie et permission y sont volontairement confondues.
    const refuse = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: { async verifierMembreSanctionnable() { return 'hierarchie'; } },
    });
    await descripteur.executer(refuse);
    assert.equal(refuse.erreurs[0].titre, 'Je ne peux pas expulser ce membre');
    assert.equal(refuse.appels.some(([nom]) => nom === 'exclureMembre'), false);
});

test('/ban — la durée de purge part en secondes, et un membre parti reste bannissable', async () => {
    const descripteur = require('../bot/commands/ban');
    const ctx = faireContexte(descripteur, {
        membre: utilisateur(CIBLE), raison: 'Raid', supprimer: 2,
    });

    await descripteur.executer(ctx);

    assert.deepEqual(dernierEmbed(ctx), {
        title: '🔨 Bannissement',
        color: 0xe74c3c,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Modérateur', value: `<@${MODO}>`, inline: true },
            { name: 'Raison', value: 'Raid', inline: false },
            { name: 'Messages supprimés', value: '2 jour(s)', inline: true },
        ],
    });
    assert.deepEqual(
        ctx.appels.find(([nom]) => nom === 'bannirMembre'),
        ['bannirMembre', GUILDE, CIBLE, 'Raid', { supprimerMessagesSecondes: 2 * 86400 }],
    );

    // Personne déjà partie : le pré-contrôle de hiérarchie ne s'applique pas,
    // c'est même le cas le plus fréquent en anti-raid.
    const absent = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: {
            async obtenirMembre() { return null; },
            async verifierMembreSanctionnable() { throw new Error('ne doit pas être appelé'); },
        },
    });
    await descripteur.executer(absent);
    assert.equal(absent.erreurs.length, 0);
    assert.ok(absent.appels.some(([nom]) => nom === 'bannirMembre'));
});

test('/mute — appliquerTimeout reçoit une ÉCHÉANCE, pas une durée', async () => {
    const descripteur = require('../bot/commands/mute');
    const avant = Date.now();
    const ctx = faireContexte(descripteur, {
        membre: utilisateur(CIBLE), durée: '10m', raison: 'Flood',
    });

    await descripteur.executer(ctx);

    const [, guildeId, membreId, echeance, raison] = ctx.appels.find(([nom]) => nom === 'appliquerTimeout');
    assert.equal(guildeId, GUILDE);
    assert.equal(membreId, CIBLE);
    assert.equal(raison, 'Flood');
    // Une échéance, donc un instant futur — et pas 600000, qui serait la durée.
    assert.ok(echeance >= avant + 10 * 60 * 1000, `échéance attendue dans le futur, reçu ${echeance}`);
    assert.ok(echeance <= Date.now() + 10 * 60 * 1000);

    assert.deepEqual(dernierEmbed(ctx), {
        title: '🔇 Mute',
        color: 0xe67e22,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Modérateur', value: `<@${MODO}>`, inline: true },
            { name: 'Durée', value: '10m', inline: true },
            { name: 'Raison', value: 'Flood', inline: false },
        ],
    });
});

test('/mute — durée invalide, bot visé et refus de la plateforme disent la même chose qu\'avant', async () => {
    const descripteur = require('../bot/commands/mute');

    const tropLongue = faireContexte(descripteur, { membre: utilisateur(CIBLE), durée: '30d' });
    await descripteur.executer(tropLongue);
    assert.equal(tropLongue.erreurs[0].titre, 'Durée invalide');

    const surUnBot = faireContexte(descripteur, {
        membre: utilisateur(CIBLE, { estBot: true }), durée: '10m',
    });
    await descripteur.executer(surUnBot);
    assert.equal(surUnBot.erreurs[0].titre, 'Les bots ne peuvent pas être exclus temporairement');

    // Un refus de la plateforme et un refus du pré-contrôle rendent le même
    // message : c'est ce que voyait la personne qui modère avant migration.
    const enEchec = faireContexte(descripteur, { membre: utilisateur(CIBLE), durée: '10m' }, {
        api: { async appliquerTimeout() { throw erreurApi(50013); } },
    });
    await descripteur.executer(enEchec);
    assert.equal(enEchec.erreurs[0].titre, 'Je ne peux pas exclure ce membre');

    const horsHierarchie = faireContexte(descripteur, { membre: utilisateur(CIBLE), durée: '10m' }, {
        api: { async verifierMembreSanctionnable() { return 'hierarchie'; } },
    });
    await descripteur.executer(horsHierarchie);
    assert.equal(horsHierarchie.erreurs[0].titre, 'Je ne peux pas exclure ce membre');
    assert.equal(horsHierarchie.appels.some(([nom]) => nom === 'appliquerTimeout'), false);
});

test('/log et /unlog écrivent et retirent le salon de journalisation', async () => {
    const AUTRE_SALON = '120000000000000009';
    const log = require('../bot/commands/log');
    const ctxLog = faireContexte(log, {
        channel: { id: AUTRE_SALON, nom: 'logs', mention: `<#${AUTRE_SALON}>`, type: 'texte' },
    });
    await log.executer(ctxLog);

    assert.deepEqual(dernierEmbed(ctxLog), {
        title: '📝 Logs de modération',
        color: 0xc8a86e,
        description: `Les logs seront envoyés dans <#${AUTRE_SALON}>.`,
    });
    const apres = JSON.parse(db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = \'moderation\'').get(GUILDE).config);
    assert.equal(apres.logChannel, AUTRE_SALON);

    const unlog = require('../bot/commands/unlog');
    const ctxUnlog = faireContexte(unlog, {});
    await unlog.executer(ctxUnlog);
    assert.deepEqual(dernierEmbed(ctxUnlog), {
        title: '📝 Logs de modération',
        color: 0xe74c3c,
        description: 'Les logs de modération ont été désactivés.',
    });
    const vide = JSON.parse(db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module_name = \'moderation\'').get(GUILDE).config);
    assert.equal(vide.logChannel, undefined);

    // Remis en place pour les tests suivants : l'ordre d'exécution d'un fichier
    // de test est celui de la lecture, et sendModLog en a besoin.
    db.prepare('UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = \'moderation\'')
        .run(JSON.stringify({ logChannel: SALON_LOG }), GUILDE);
});

test('/warns et /sanctions rendent l\'historique sans toucher à la plateforme', async () => {
    db.prepare(`INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, created_at)
                VALUES (?, ?, ?, 'mute', 'Test historique', '2026-01-02 03:04:05')`)
        .run(GUILDE, CIBLE, MODO);

    const warns = require('../bot/commands/warns');
    const ctxWarns = faireContexte(warns, { membre: utilisateur(CIBLE) });
    await ctxWarns.options.get('membre'); // l'option est bien déclarée
    await warns.executer(ctxWarns);
    const embedWarns = dernierEmbed(ctxWarns);
    assert.equal(embedWarns.title, '📋 Avertissements de jean#0');
    assert.equal(embedWarns.color, 0xf1c40f);
    assert.ok(embedWarns.description.includes('Spam répété'));
    assert.match(embedWarns.footer.text, /actif\(s\) \/ \d+ total$/);

    const sanctions = require('../bot/commands/sanctions');
    const ctxSanctions = faireContexte(sanctions, { membre: utilisateur(CIBLE) });
    await sanctions.executer(ctxSanctions);
    const embedSanctions = dernierEmbed(ctxSanctions);
    assert.equal(embedSanctions.title, '📋 Sanctions de jean#0');
    assert.equal(embedSanctions.color, 0xc8a86e);
    assert.ok(embedSanctions.description.includes('🔇'), 'le mute doit apparaître dans l\'historique');

    // Aucune sanction du tout : réponse texte éphémère, comme avant.
    const vierge = faireContexte(sanctions, { membre: utilisateur('120000000000000099') });
    await sanctions.executer(vierge);
    assert.deepEqual(vierge.reponses.at(-1), {
        contenu: '✅ <@120000000000000099> n\'a aucune sanction.',
        options: { ephemere: true },
    });
});

test('/unwarn retire un avertissement, et refuse deux fois le même', async () => {
    const id = db.prepare(`INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason)
                           VALUES (?, ?, ?, 'warn', 'À retirer')`)
        .run(GUILDE, CIBLE, MODO).lastInsertRowid;

    const descripteur = require('../bot/commands/unwarn');
    const ctx = faireContexte(descripteur, { id: Number(id) });
    await descripteur.executer(ctx);

    assert.deepEqual(dernierEmbed(ctx), {
        title: '✅ Avertissement retiré',
        color: 0x2ecc71,
        fields: [
            { name: 'Sanction', value: `#${id}`, inline: true },
            { name: 'Membre', value: `<@${CIBLE}>`, inline: true },
            { name: 'Retiré par', value: `<@${MODO}>`, inline: true },
        ],
    });
    assert.equal(db.prepare('SELECT active FROM sanctions WHERE id = ?').get(id).active, 0);

    const deuxieme = faireContexte(descripteur, { id: Number(id) });
    await descripteur.executer(deuxieme);
    assert.equal(deuxieme.erreurs[0].titre, 'Avertissement déjà retiré');

    const inconnu = faireContexte(descripteur, { id: 999999 });
    await descripteur.executer(inconnu);
    assert.equal(inconnu.erreurs[0].titre, 'Avertissement introuvable');
});

// ═══════════════════════════════════════════════════════════════
//  3. sendModLog, bi-format
// ═══════════════════════════════════════════════════════════════

/** Guilde discord.js réduite, avec capture de ce qui part dans le salon de logs. */
function faireGuilde({ salonPresent = true } = {}) {
    const envois = [];
    const canal = { send: async (payload) => { envois.push(payload); return { id: 'msg1' }; } };
    return {
        envois,
        guild: {
            id: GUILDE,
            channels: { cache: new Map(salonPresent ? [[SALON_LOG, canal]] : []) },
        },
    };
}

test('sendModLog — voie historique : capture de référence inchangée', async () => {
    const { guild, envois } = faireGuilde();
    const construit = new EmbedBuilder().setTitle('🔨 Bannissement').setColor(0xe74c3c);

    await sendModLog(guild, construit, 'mod_ban');

    assert.equal(envois.length, 1);
    // Le builder traverse TEL QUEL : c'est ce dont dépend `sendAutomodLog` de
    // punishments.js, seul appelant non migré de cette fonction.
    assert.equal(envois[0].embeds[0], construit);
});

test('sendModLog — voie neutre : le journal part par le client REST normalisé', async () => {
    const { embed } = require('../bot/platform/embed');
    const envois = [];
    const portee = {
        guildeId: GUILDE,
        api: { async envoyerMessage(canalId, contenu) { envois.push([canalId, contenu]); } },
    };
    const neutre = embed({ titre: '🔴 Expulsion', couleur: 0xe74c3c });

    await sendModLog(portee, neutre, 'mod_kick');

    assert.deepEqual(envois, [[SALON_LOG, neutre]]);
});

test('sendModLog — un type de log désactivé bloque les DEUX voies', async () => {
    db.prepare('UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = \'moderation\'')
        .run(JSON.stringify({ logChannel: SALON_LOG, enabledLogs: { mod_warn: false } }), GUILDE);

    const { guild, envois } = faireGuilde();
    await sendModLog(guild, new EmbedBuilder(), 'mod_warn');
    assert.deepEqual(envois, []);

    const neutres = [];
    await sendModLog(
        { guildeId: GUILDE, api: { async envoyerMessage(...a) { neutres.push(a); } } },
        require('../bot/platform/embed').embed({ titre: 'x' }),
        'mod_warn',
    );
    assert.deepEqual(neutres, []);

    db.prepare('UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = \'moderation\'')
        .run(JSON.stringify({ logChannel: SALON_LOG }), GUILDE);
});

test('sendModLog — sans type de log, rien n\'est envoyé nulle part', async () => {
    const { guild, envois } = faireGuilde();
    const erreurs = [];
    const original = console.error;
    console.error = (...a) => erreurs.push(a.join(' '));
    try {
        await sendModLog(guild, new EmbedBuilder(), undefined);
    } finally {
        console.error = original;
    }
    assert.deepEqual(envois, []);
    assert.match(erreurs.join('\n'), /sans type de log/);
});

// ═══════════════════════════════════════════════════════════════
//  4. Codes d'erreur neutres dans punishments.js
// ═══════════════════════════════════════════════════════════════

test('describeError raisonne sur le code NEUTRE, pas sur le numéro Discord', () => {
    // `describeError` n'est pas exporté : on l'observe par le résultat que
    // `applyPunishments` rend quand l'action échoue. C'est d'ailleurs le seul
    // endroit où sa phrase est réellement lue.
    const { applyPunishments } = require('../bot/utils/punishments');

    const portee = (lever) => ({
        guildeId: GUILDE,
        moi: { id: BOT },
        api: {
            async envoyerMessage() {},
            async exclureMembre() { throw lever; },
            async obtenirMembre() { return { id: BOT, aPermission: () => true }; },
        },
    });

    const cas = [
        [erreurApi(50013), 'Permission manquante côté bot.'],
        [erreurApi(50001), 'Permission manquante côté bot.'],
        [erreurApi(10007), 'La cible n\'existe plus : membre parti, message ou salon supprimé.'],
        [erreurApi(10004), 'Je ne suis plus sur ce serveur.'],
        // Sans équivalent neutre : le numéro Discord reste le seul moyen de la nommer.
        [erreurApi(30035), 'Limite de bannissements atteinte pour ce serveur.'],
    ];

    return Promise.all(cas.map(async ([err, attendu]) => {
        const [resultat] = await applyPunishments([{ action: 'kick' }], {
            portee: portee(err),
            member: { id: CIBLE },
            reason: 'test',
            source: 'automod',
            moderatorId: BOT,
        });
        assert.equal(resultat.ok, false);
        assert.equal(resultat.error, attendu, `code ${err.code}`);
    }));
});

test('describeError garde les phrases d\'origine pour une erreur NON marquée', async () => {
    // TRANSITION : antiraid, automod et honeypot passent encore une `Guild`
    // discord.js, donc lèvent des erreurs brutes, jamais marquées par `api.*`.
    // Sans le repli sur le numéro, leurs échecs ressortiraient en anglais.
    const { applyPunishments } = require('../bot/utils/punishments');
    const brute = Object.assign(new Error('Missing Permissions'), { code: 50013 });

    const [resultat] = await applyPunishments([{ action: 'kick' }], {
        guild: {
            id: GUILDE,
            ownerId: PROPRIETAIRE,
            client: { user: { id: BOT } },
            channels: { cache: new Map() },
            members: { me: { permissions: { has: () => true } } },
        },
        member: { id: CIBLE, kickable: true, kick: async () => { throw brute; } },
        reason: 'test',
        source: 'automod',
        moderatorId: BOT,
    });
    assert.equal(resultat.error, 'Permission manquante côté bot.');
});

test('le balayeur de bannissements temporaires lit les codes neutres', async () => {
    const { sweepExpiredBans } = require('../bot/utils/punishments');
    const expire = Math.floor(Date.now() / 1000) - 60;

    /** @returns {number} lignes d'échéance restantes */
    async function balayer(lever) {
        db.prepare('DELETE FROM temp_bans').run();
        db.prepare('INSERT INTO temp_bans (guild_id, user_id, expires_at, reason, source) VALUES (?, ?, ?, ?, ?)')
            .run(GUILDE, CIBLE, expire, 'test', 'automod');
        await sweepExpiredBans({
            guildeId: GUILDE,
            moi: { id: BOT },
            api: {
                async envoyerMessage() {},
                async debannirMembre() { if (lever) throw lever; },
            },
        });
        return db.prepare('SELECT COUNT(*) AS n FROM temp_bans').get().n;
    }

    // Déjà levé à la main : c'est un succès, l'échéance disparaît.
    assert.equal(await balayer(erreurApi(10026)), 0);
    // Bot retiré du serveur : échéance OUBLIÉE, sans quoi on retenterait sans fin.
    assert.equal(await balayer(erreurApi(10004)), 0);
    // Permission manquante : l'échéance est GARDÉE pour le tour suivant. La
    // confondre avec un abandon transformerait un ban temporaire en ban définitif.
    assert.equal(await balayer(erreurApi(50013)), 1);
    // Nominal.
    assert.equal(await balayer(null), 0);
    db.prepare('DELETE FROM temp_bans').run();
});

// ═══════════════════════════════════════════════════════════════
//  5. Escalade des avertissements, au contrat neutre
// ═══════════════════════════════════════════════════════════════

test('runWarnEscalation applique le palier par la PORTÉE, jamais par une guilde', async () => {
    const { runWarnEscalation } = require('../bot/utils/warnEscalation');
    db.prepare('DELETE FROM warn_escalation WHERE guild_id = ?').run(GUILDE);
    db.prepare('INSERT INTO warn_escalation (guild_id, threshold, punishments, enabled) VALUES (?, 2, ?, 1)')
        .run(GUILDE, 'kick');

    const appels = [];
    const portee = {
        plateforme: 'discord',
        capacites: {},
        guildeId: GUILDE,
        moi: { id: BOT },
        api: {
            async envoyerMessage(...a) { appels.push(['envoyerMessage', ...a]); },
            async obtenirCanal(id) { appels.push(['obtenirCanal', id]); return { id, parentId: null }; },
            async exclureMembre(...a) { appels.push(['exclureMembre', ...a]); },
            async obtenirMembre() { return { id: BOT, aPermission: () => true }; },
        },
        async repondre() {},
    };

    const issue = await runWarnEscalation({
        portee,
        member: { id: CIBLE, roles: [] },
        userId: CIBLE,
        warnCount: 2,
        moderatorId: BOT,
        canalId: SALON,
    });

    assert.equal(issue.tier.threshold, 2);
    assert.deepEqual(issue.results, [{ action: 'kick', ok: true }]);
    // L'exclusion est partie par le client REST normalisé : si `guild` avait
    // été transmis, `applyPunishments` serait reparti en voie discord.js sans
    // le moindre avertissement.
    assert.ok(appels.some(([nom]) => nom === 'exclureMembre'));
    // Le salon n'est résolu que pour évaluer la portée du palier, et seulement
    // une fois un palier retenu.
    assert.ok(appels.some(([nom, id]) => nom === 'obtenirCanal' && id === SALON));
});

test('runWarnEscalation — un palier en alerte seule poste un embed NEUTRE', async () => {
    const { runWarnEscalation } = require('../bot/utils/warnEscalation');
    db.prepare('DELETE FROM warn_escalation WHERE guild_id = ?').run(GUILDE);
    db.prepare('INSERT INTO warn_escalation (guild_id, threshold, punishments, enabled) VALUES (?, 3, ?, 1)')
        .run(GUILDE, '');

    const envois = [];
    const issue = await runWarnEscalation({
        portee: {
            guildeId: GUILDE,
            moi: { id: BOT },
            api: {
                async envoyerMessage(canalId, contenu) { envois.push([canalId, contenu]); },
                async obtenirCanal(id) { return { id, parentId: null }; },
            },
        },
        member: { id: CIBLE, roles: [] },
        userId: CIBLE,
        warnCount: 3,
        moderatorId: BOT,
        canalId: SALON,
    });

    assert.equal(issue.alertOnly, true);
    assert.equal(envois.length, 1);
    assert.deepEqual(embedEnvoye(envois[0][1]), {
        title: '⚠️ Palier d\'avertissements atteint',
        color: 0xf1c40f,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (${CIBLE})`, inline: true },
            { name: 'Déclencheur', value: 'Escalade des avertissements', inline: true },
            { name: 'Palier', value: '3 avertissement(s)', inline: true },
            { name: 'Avertissements actifs', value: '3', inline: true },
            { name: 'Sanction', value: 'Aucune : ce palier est réglé en alerte seule.', inline: false },
        ],
    });

    db.prepare('DELETE FROM warn_escalation WHERE guild_id = ?').run(GUILDE);
});

test('runWarnEscalation — sans portée exploitable, aucune sanction n\'est tentée', async () => {
    const { runWarnEscalation } = require('../bot/utils/warnEscalation');
    // Une guilde discord.js n'est plus une entrée valable : l'accepter aurait
    // rouvert la voie historique en silence.
    assert.equal(await runWarnEscalation({ portee: { id: GUILDE }, warnCount: 5 }), null);
    assert.equal(await runWarnEscalation({ warnCount: 5 }), null);
});

// ═══════════════════════════════════════════════════════════════
//  6. Le code neutre reste neutre
// ═══════════════════════════════════════════════════════════════

test('les codes d\'erreur neutres attendus par ce lot existent bien au contrat', () => {
    // Si l'un d'eux disparaissait du vocabulaire, `describeError` et le balayeur
    // retomberaient silencieusement sur « Erreur inconnue ».
    for (const nom of ['permission', 'introuvable', 'deja_fait', 'guilde_inconnue', 'inconnu']) {
        assert.equal(CODES_NEUTRES[nom], nom);
    }
});
