// Lot 1 du chantier multiplateforme : la modération au contrat neutre.
//
// Ce que ce fichier doit tenir, dans cet ordre d'importance :
//
//  1. LE JSON DÉPLOYÉ NE BOUGE PAS. Les douze commandes migrées tournent sur une
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
    const differe = [];
    const declarees = new Set((descripteur.options || []).map(o => o.nom));

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
        differe,
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
            async envoyerMessage() {},
            async exclureMembre() {},
            async bannirMembre() {},
            async appliquerTimeout() {},
            async debannirMembre() {},
            async obtenirBannissement() { return { utilisateur: utilisateur(CIBLE), raison: 'Raid' }; },
            async listerMessages() { return []; },
            async supprimerMessagesEnLot(canalId, ids) { return { supprimes: ids.length, ignores: 0 }; },
            ...api,
        },
        // `differer` enregistre l'ordre d'appel : c'est ce qui prouve que /clear
        // acquitte AVANT de travailler, et pas après.
        async differer(options = {}) { differe.push(options); appels.push(['differer', options]); },
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
    unban: {
        options: [
            { type: 3, name: 'id', description: 'L\'ID de l\'utilisateur à débannir', required: true },
        ],
        name: 'unban',
        description: 'Débannir un utilisateur',
        default_member_permissions: '4',
        type: 1,
    },
    unmute: {
        options: [
            { name: 'membre', description: 'Le membre à unmute', required: true, type: 6 },
        ],
        name: 'unmute',
        description: 'Unmute un membre',
        default_member_permissions: '1099511627776',
        type: 1,
    },
    clear: {
        options: [
            {
                max_value: 100, min_value: 1, type: 4, name: 'nombre',
                description: 'Nombre de messages à supprimer (1-100)', required: true,
            },
            {
                name: 'membre', description: 'Supprimer uniquement les messages de ce membre',
                required: false, type: 6,
            },
        ],
        name: 'clear',
        description: 'Supprimer des messages',
        default_member_permissions: '8192',
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
        kick: ['KICK_MEMBERS'], ban: ['BAN_MEMBERS'], unban: ['BAN_MEMBERS'],
        mute: ['MODERATE_MEMBERS'], unmute: ['MODERATE_MEMBERS'],
        // Lire l'historique est aussi nécessaire que supprimer : sans
        // READ_MESSAGE_HISTORY, il n'y a rien à passer à la suppression en lot.
        clear: ['MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY'],
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
});

test('les trois événements de modération sont des descripteurs neutres', () => {
    const { estDescripteurEvenement } = require('../bot/platform/events');
    const attendu = {
        messageDelete: 'messageSupprime',
        messageUpdate: 'messageModifie',
        guildMemberUpdate: 'membreModifie',
    };
    for (const [fichier, nomNeutre] of Object.entries(attendu)) {
        const mod = require(`../bot/events/${fichier}`);
        assert.equal(estDescripteurEvenement(mod), true, `${fichier} n'est pas un descripteur neutre`);
        assert.equal(mod.nom, nomNeutre);
    }
});

test('plus aucune commande de modération migrée n\'importe discord.js', () => {
    const fs = require('node:fs');
    const racine = path.join(__dirname, '..', 'bot');
    const fichiers = [
        ...Object.keys(REFERENCES).map(n => path.join(racine, 'commands', `${n}.js`)),
        ...['messageDelete', 'messageUpdate', 'guildMemberUpdate']
            .map(n => path.join(racine, 'events', `${n}.js`)),
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

test('/unban — le bannissement est LU avant d\'être levé, et son absence est une erreur d\'usage', async () => {
    const descripteur = require('../bot/commands/unban');

    const ctx = faireContexte(descripteur, { id: CIBLE });
    await descripteur.executer(ctx);

    assert.deepEqual(dernierEmbed(ctx), {
        title: '✅ Débannissement',
        color: 0x2ecc71,
        fields: [
            { name: 'Utilisateur', value: `jean#0 (${CIBLE})`, inline: true },
            { name: 'Débanni par', value: `<@${MODO}>`, inline: true },
        ],
    });
    // La lecture précède la levée : sans elle, l'embed ne pourrait pas nommer la
    // personne, et on ne saurait pas qu'on a visé le bon identifiant.
    const ordre = ctx.appels.map(([nom]) => nom);
    assert.ok(ordre.indexOf('obtenirBannissement') < ordre.indexOf('debannirMembre'));
    assert.deepEqual(ctx.appels.find(([nom]) => nom === 'debannirMembre'), ['debannirMembre', GUILDE, CIBLE]);

    // Aucun bannissement : `obtenirBannissement` rend null, et rien n'est levé.
    const libre = faireContexte(descripteur, { id: CIBLE }, {
        api: { async obtenirBannissement() { return null; } },
    });
    await descripteur.executer(libre);
    assert.equal(libre.erreurs[0].titre, 'Cette personne n\'est pas bannie');
    assert.equal(libre.appels.some(([nom]) => nom === 'debannirMembre'), false);

    // Course : quelqu'un lève le bannissement entre la lecture et la levée. Ce
    // n'est pas un incident, c'est le même message.
    const course = faireContexte(descripteur, { id: CIBLE }, {
        api: { async debannirMembre() { throw erreurApi(10026); } },
    });
    await descripteur.executer(course);
    assert.equal(course.erreurs[0].titre, 'Cette personne n\'est pas bannie');
});

test('/unmute — le garde « pas exclu » lit timeoutJusqua, la levée passe une échéance nulle', async () => {
    const descripteur = require('../bot/commands/unmute');

    const ctx = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: { async obtenirMembre() { return { id: CIBLE, roles: [], timeoutJusqua: Date.now() + 60000 }; } },
    });
    await descripteur.executer(ctx);

    assert.deepEqual(ctx.appels.find(([nom]) => nom === 'appliquerTimeout'),
        ['appliquerTimeout', GUILDE, CIBLE, null]);
    assert.deepEqual(dernierEmbed(ctx), {
        title: '🔊 Unmute',
        color: 0x2ecc71,
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Unmute par', value: `<@${MODO}>`, inline: true },
        ],
    });

    // Aucune exclusion en cours : annoncer une levée laisserait croire à une
    // action qui n'a pas eu lieu.
    const libre = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: { async obtenirMembre() { return { id: CIBLE, roles: [], timeoutJusqua: null }; } },
    });
    await descripteur.executer(libre);
    assert.equal(libre.erreurs[0].titre, 'Ce membre n\'est pas exclu');
    assert.equal(libre.appels.some(([nom]) => nom === 'appliquerTimeout'), false);

    const parti = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: { async obtenirMembre() { return null; } },
    });
    await descripteur.executer(parti);
    assert.equal(parti.erreurs[0].titre, 'Membre introuvable');

    const refuse = faireContexte(descripteur, { membre: utilisateur(CIBLE) }, {
        api: {
            async obtenirMembre() { return { id: CIBLE, roles: [], timeoutJusqua: Date.now() + 60000 }; },
            async appliquerTimeout() { throw erreurApi(50013); },
        },
    });
    await descripteur.executer(refuse);
    assert.equal(refuse.erreurs[0].titre, 'Je ne peux pas lever cette exclusion');
});

test('/clear — l\'interaction est acquittée AVANT le travail, et en éphémère', async () => {
    const descripteur = require('../bot/commands/clear');
    const ctx = faireContexte(descripteur, { nombre: 5 }, {
        api: {
            async listerMessages(canalId, options) {
                return Array.from({ length: options.limite }, (_, i) => ({ id: `M${i}`, auteur: utilisateur(CIBLE) }));
            },
        },
    });

    await descripteur.executer(ctx);

    // C'est tout l'objet de `ctx.differer` : lire cent messages puis les
    // supprimer dépasse les trois secondes que la plateforme laisse pour
    // répondre. Sans lui, la purge aurait lieu et la commande paraîtrait cassée.
    assert.deepEqual(ctx.differe, [{ ephemere: true }]);
    assert.equal(ctx.appels[0][0], 'differer', 'l\'acquittement doit précéder tout appel');

    assert.deepEqual(ctx.appels.find(([nom]) => nom === 'listerMessages'),
        ['listerMessages', SALON, { limite: 5 }]);
    assert.deepEqual(ctx.reponses.at(-1), {
        contenu: '🗑️ **5** message(s) supprimé(s).',
        options: {},
    });
});

test('/clear — la purge ciblée relit 100 messages, filtre, puis tronque au nombre demandé', async () => {
    const descripteur = require('../bot/commands/clear');
    const ctx = faireContexte(descripteur, { nombre: 2, membre: utilisateur(CIBLE) }, {
        api: {
            async listerMessages() {
                return [
                    { id: 'M1', auteur: utilisateur(CIBLE) },
                    { id: 'M2', auteur: utilisateur(MODO) },
                    { id: 'M3', auteur: utilisateur(CIBLE) },
                    { id: 'M4', auteur: utilisateur(CIBLE) },
                ];
            },
        },
    });

    await descripteur.executer(ctx);

    assert.deepEqual(ctx.appels.find(([nom]) => nom === 'listerMessages'),
        ['listerMessages', SALON, { limite: 100 }]);
    // Les messages des autres sont écartés, et on s'arrête au nombre demandé.
    assert.deepEqual(ctx.appels.find(([nom]) => nom === 'supprimerMessagesEnLot'),
        ['supprimerMessagesEnLot', SALON, ['M1', 'M3']]);
    assert.equal(ctx.reponses.at(-1).contenu, `🗑️ **2** message(s) de <@${CIBLE}> supprimé(s).`);

    // Personne n'a rien écrit : erreur d'usage, aucune suppression tentée.
    const vide = faireContexte(descripteur, { nombre: 5, membre: utilisateur(CIBLE) }, {
        api: { async listerMessages() { return [{ id: 'M1', auteur: utilisateur(MODO) }]; } },
    });
    await descripteur.executer(vide);
    assert.equal(vide.erreurs[0].titre, 'Aucun message à supprimer');
    assert.equal(vide.appels.some(([nom]) => nom === 'supprimerMessagesEnLot'), false);
});

test('/clear — un échec réel reste un incident, avec son code', async () => {
    const descripteur = require('../bot/commands/clear');
    const ctx = faireContexte(descripteur, { nombre: 5 }, {
        api: { async listerMessages() { throw erreurApi(50013); } },
    });

    const journal = [];
    const original = console.error;
    console.error = (...a) => journal.push(a.join(' '));
    try {
        await descripteur.executer(ctx);
    } finally {
        console.error = original;
    }
    assert.match(journal.join('\n'), /\/clear/);
});

// ═══════════════════════════════════════════════════════════════
//  3. Événements de journalisation
// ═══════════════════════════════════════════════════════════════

/** Active les types de log non-modération, désactivés par défaut. */
function avecLogsActives(types, faire) {
    const config = { logChannel: SALON_LOG, enabledLogs: Object.fromEntries(types.map(t => [t, true])) };
    const ecrire = (c) => db.prepare('UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = \'moderation\'')
        .run(JSON.stringify(c), GUILDE);
    ecrire(config);
    return Promise.resolve(faire()).finally(() => ecrire({ logChannel: SALON_LOG }));
}

/** Contexte d'événement : volontairement plus pauvre que celui d'une commande. */
function faireContexteEvenement() {
    const envois = [];
    return {
        envois,
        ctx: {
            plateforme: 'discord',
            capacites: { interactions: true },
            moi: { id: BOT },
            api: { async envoyerMessage(canalId, contenu) { envois.push([canalId, contenu]); } },
            db,
        },
    };
}

test('messageSupprime — l\'embed liste les pièces jointes, seule trace qu\'il en reste', async () => {
    const { normaliserMessage } = require('../bot/platform/discord/events');
    const handler = require('../bot/events/messageDelete');
    const { ctx, envois } = faireContexteEvenement();

    // Payload construit par le NORMALISEUR réel, et non à la main : c'est la
    // forme exacte que le handler recevra en production.
    const message = normaliserMessage({
        id: 'M1',
        channelId: SALON,
        guildId: GUILDE,
        content: 'Message effacé',
        author: { id: CIBLE, username: 'jean', tag: 'jean#0' },
        attachments: [{ id: 'A1', filename: 'preuve.png', url: 'https://cdn/preuve.png', size: 42 }],
    });

    await avecLogsActives(['msg_delete'], () => handler.executer(ctx, message));

    assert.equal(envois.length, 1);
    assert.equal(envois[0][0], SALON_LOG);
    assert.deepEqual(embedEnvoye(envois[0][1]), {
        title: '🗑️ Message supprimé',
        color: 0xe74c3c,
        fields: [
            { name: 'Auteur', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Channel', value: `<#${SALON}>`, inline: true },
            { name: 'Contenu', value: 'Message effacé', inline: false },
            { name: '📎 Pièces jointes', value: 'preuve.png', inline: false },
        ],
    });
});

test('messageSupprime — bot, message partiel et hors serveur restent ignorés', async () => {
    const { normaliserMessage } = require('../bot/platform/discord/events');
    const handler = require('../bot/events/messageDelete');

    const cas = [
        normaliserMessage({ id: 'M1', channelId: SALON, guildId: GUILDE, author: { id: BOT, bot: true } }),
        normaliserMessage({ id: 'M2', channelId: SALON, guildId: GUILDE, partial: true }),
        normaliserMessage({ id: 'M3', channelId: SALON }), // message privé : pas de serveur
    ];

    await avecLogsActives(['msg_delete'], async () => {
        for (const message of cas) {
            const { ctx, envois } = faireContexteEvenement();
            await handler.executer(ctx, message);
            assert.deepEqual(envois, [], `message ${message.id} journalisé à tort`);
        }
    });
});

test('messageModifie — l\'embed porte le lien du message, et une simple prévisualisation est ignorée', async () => {
    const { normaliserMessage } = require('../bot/platform/discord/events');
    const handler = require('../bot/events/messageUpdate');
    const { ctx, envois } = faireContexteEvenement();

    const base = { id: 'M1', channelId: SALON, guildId: GUILDE, author: { id: CIBLE, username: 'jean', tag: 'jean#0' } };
    const avant = normaliserMessage({ ...base, content: 'avant' });
    const apres = normaliserMessage({ ...base, content: 'après' });

    await avecLogsActives(['msg_edit'], () => handler.executer(ctx, avant, apres));

    assert.deepEqual(embedEnvoye(envois[0][1]), {
        title: '✏️ Message modifié',
        color: 0x3498db,
        // Sans le lien, on lit un avant/après sans pouvoir aller voir le fil.
        url: `https://discord.com/channels/${GUILDE}/${SALON}/M1`,
        fields: [
            { name: 'Auteur', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Channel', value: `<#${SALON}>`, inline: true },
            { name: 'Avant', value: 'avant', inline: false },
            { name: 'Après', value: 'après', inline: false },
        ],
    });

    // Contenu identique : c'est l'aperçu d'un lien qui se déplie, pas une édition.
    const apercu = faireContexteEvenement();
    await avecLogsActives(['msg_edit'], () => handler.executer(apercu.ctx, avant, normaliserMessage({ ...base, content: 'avant' })));
    assert.deepEqual(apercu.envois, []);
});

test('membreModifie — le serveur vient du troisième argument, et les rôles des identifiants', async () => {
    const { EVENEMENTS } = require('../bot/platform/discord/events');
    const handler = require('../bot/events/guildMemberUpdate');
    const [, normaliser] = EVENEMENTS.membreModifie;

    const membre = (nickname, roles) => ({
        id: CIBLE,
        nickname,
        roles: { cache: new Map(roles.map(r => [r, { id: r }])) },
        user: { id: CIBLE, username: 'jean', tag: 'jean#0', bot: false },
        guild: { id: GUILDE, name: 'Serveur de test', ownerId: PROPRIETAIRE },
        displayAvatarURL: ({ size }) => `https://cdn/avatar.png?size=${size}`,
        permissions: { has: () => false },
    });

    const { ctx, envois } = faireContexteEvenement();
    // Pseudo ET rôles changent d'un coup : les deux journaux doivent partir.
    const payload = normaliser(membre('Jean', ['R1', 'R2']), membre('Jeanne', ['R2', 'R3']));

    await avecLogsActives(['member_nick', 'member_roles'], () => handler.executer(ctx, ...payload));

    assert.equal(envois.length, 3, 'pseudo, rôle ajouté et rôle retiré');
    // Le serveur ne figure pas dans le membre normalisé : sans le troisième
    // argument du payload, aucun de ces trois journaux ne saurait où aller.
    for (const [canalId] of envois) assert.equal(canalId, SALON_LOG);

    assert.deepEqual(embedEnvoye(envois[0][1]), {
        title: '✏️ Changement de pseudo',
        color: 0x3498db,
        thumbnail: { url: 'https://cdn/avatar.png?size=64' },
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Avant', value: 'Jean', inline: true },
            { name: 'Après', value: 'Jeanne', inline: true },
        ],
    });
    assert.deepEqual(embedEnvoye(envois[1][1]), {
        title: '🎭 Rôle(s) ajouté(s)',
        color: 0x2ecc71,
        thumbnail: { url: 'https://cdn/avatar.png?size=64' },
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Rôle(s)', value: '<@&R3>', inline: true },
        ],
    });
    assert.deepEqual(embedEnvoye(envois[2][1]), {
        title: '🎭 Rôle(s) retiré(s)',
        color: 0xe74c3c,
        thumbnail: { url: 'https://cdn/avatar.png?size=64' },
        fields: [
            { name: 'Membre', value: `<@${CIBLE}> (jean#0)`, inline: true },
            { name: 'Rôle(s)', value: '<@&R1>', inline: true },
        ],
    });

    // Un bot n'est jamais journalisé, et un changement sans effet ne produit rien.
    const bot = faireContexteEvenement();
    const membreBot = membre('X', ['R1']);
    membreBot.user.bot = true;
    await avecLogsActives(['member_nick', 'member_roles'],
        () => handler.executer(bot.ctx, ...normaliser(membreBot, membreBot)));
    assert.deepEqual(bot.envois, []);

    const inchange = faireContexteEvenement();
    await avecLogsActives(['member_nick', 'member_roles'],
        () => handler.executer(inchange.ctx, ...normaliser(membre('Jean', ['R1']), membre('Jean', ['R1']))));
    assert.deepEqual(inchange.envois, []);
});

// ═══════════════════════════════════════════════════════════════
//  4. sendModLog, entièrement neutre
// ═══════════════════════════════════════════════════════════════

/**
 * Portée d'écriture réduite, avec capture de ce qui part dans le salon de logs.
 *
 * La voie `Guild` discord.js a été retirée au lot 7 : son dernier appelant, le
 * mode panique, reçoit désormais une portée de `api/routes/antiraid.js`. Un
 * objet qui n'est pas une portée ne produit plus rien — c'est ce que vérifie le
 * dernier test de cette section.
 */
function fairePorteeLog() {
    const envois = [];
    return {
        envois,
        portee: {
            guildeId: GUILDE,
            api: { async envoyerMessage(canalId, contenu) { envois.push([canalId, contenu]); return { id: 'msg1' }; } },
        },
    };
}

test('sendModLog — un objet qui n\'est pas une portée n\'envoie rien', async () => {
    // Ce que passait la voie historique : une `Guild` discord.js. Elle n'est plus
    // reconnue, et le silence vaut mieux qu'une exception dans un journal.
    const envois = [];
    const guild = {
        id: GUILDE,
        channels: { cache: new Map([[SALON_LOG, { send: async (p) => { envois.push(p); } }]]) },
    };

    await sendModLog(guild, new EmbedBuilder().setTitle('🔨 Bannissement'), 'mod_ban');

    assert.deepEqual(envois, []);
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

test('sendModLog — un type de log désactivé bloque l\'envoi', async () => {
    db.prepare('UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = \'moderation\'')
        .run(JSON.stringify({ logChannel: SALON_LOG, enabledLogs: { mod_warn: false } }), GUILDE);

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
    const { portee, envois } = fairePorteeLog();
    const erreurs = [];
    const original = console.error;
    console.error = (...a) => erreurs.push(a.join(' '));
    try {
        await sendModLog(portee, require('../bot/platform/embed').embed({ titre: 'x' }), undefined);
    } finally {
        console.error = original;
    }
    assert.deepEqual(envois, []);
    assert.match(erreurs.join('\n'), /sans type de log/);
});

// ═══════════════════════════════════════════════════════════════
//  5. Codes d'erreur neutres et pré-contrôles dans punishments.js
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

test('une portée non neutre ne sanctionne rien, et le dit', async () => {
    // La voie `guild:` de `applyPunishments` a été retirée à la consolidation :
    // anti-raid, AutoMod et salon piège passent tous une portée. Une `Guild`
    // discord.js n'en est pas une — elle n'a pas d'`api` — et l'appel doit
    // échouer en le disant, jamais partir à l'aveugle sur un serveur deviné.
    const { applyPunishments } = require('../bot/utils/punishments');

    const [resultat] = await applyPunishments([{ action: 'kick' }], {
        portee: {
            id: GUILDE,
            ownerId: PROPRIETAIRE,
            client: { user: { id: BOT } },
            channels: { cache: new Map() },
            members: { me: { permissions: { has: () => true } } },
        },
        member: { id: CIBLE },
        reason: 'test',
        source: 'automod',
        moderatorId: BOT,
    });
    assert.deepEqual(resultat, { action: 'kick', ok: false, error: 'Serveur indisponible.' });
});

test('describeError traduit un code NEUTRE, et retombe sur le message sinon', () => {
    // La table des numéros Discord en repli est tombée avec la voie historique :
    // toutes les écritures passent désormais par `api.*`, donc toutes leurs
    // erreurs portent un `codeNeutre`. Seul 30035 garde son numéro — la limite
    // de bannissements d'un serveur n'a pas d'équivalent neutre.
    const { describeError } = require('../bot/utils/punishments');
    assert.equal(describeError(Object.assign(new Error('x'), { codeNeutre: 'permission' })),
        'Permission manquante côté bot.');
    assert.equal(describeError(Object.assign(new Error('x'), { codeNeutre: 'introuvable' })),
        'La cible n\'existe plus : membre parti, message ou salon supprimé.');
    assert.equal(describeError(Object.assign(new Error('x'), { code: 30035 })),
        'Limite de bannissements atteinte pour ce serveur.');
    // Erreur non marquée : son message, jamais un « Erreur inconnue » muet.
    assert.equal(describeError(new Error('Panne réseau')), 'Panne réseau');
});

test('la voie neutre refuse une sanction AVANT de la tenter, comme la voie historique', async () => {
    // Sans ce pré-contrôle, la sanction partait, la plateforme la refusait, et
    // `describeError` rendait « Permission manquante côté bot. » — ce qui envoie
    // vérifier les permissions alors que le problème est la hiérarchie des rôles
    // une fois sur deux.
    const { applyPunishments } = require('../bot/utils/punishments');

    const portee = (refus) => ({
        guildeId: GUILDE,
        moi: { id: BOT },
        api: {
            async envoyerMessage() {},
            async verifierMembreSanctionnable() { return refus; },
            async obtenirMembre() { return { id: BOT, aPermission: () => true }; },
            async appliquerTimeout() { throw new Error('ne doit pas être tenté'); },
            async exclureMembre() { throw new Error('ne doit pas être tenté'); },
            async bannirMembre() { throw new Error('ne doit pas être tenté'); },
        },
    });

    const attendu = {
        timeout: 'Hiérarchie des rôles ou permission « Exclure temporairement » manquante.',
        kick: 'Hiérarchie des rôles ou permission « Expulser des membres » manquante.',
        ban: 'Hiérarchie des rôles ou permission « Bannir des membres » manquante.',
    };

    for (const [action, message] of Object.entries(attendu)) {
        for (const refus of ['hierarchie', 'permission']) {
            const [resultat] = await applyPunishments([{ action, durationMs: 60000 }], {
                portee: portee(refus),
                member: { id: CIBLE },
                reason: 'test',
                source: 'automod',
                moderatorId: BOT,
            });
            assert.equal(resultat.ok, false, `${action} / ${refus}`);
            // Une seule phrase pour les deux causes : c'est ce que la voie
            // historique annonce, et le changer changerait ce que lit une
            // personne qui modère.
            assert.equal(resultat.error, message, `${action} / ${refus}`);
        }
    }
});

test('le pré-contrôle neutre n\'invente jamais un refus', async () => {
    const { applyPunishments } = require('../bot/utils/punishments');
    const tentees = [];

    // Trois façons de ne pas savoir, aucune n'est un refus :
    //   • réponse indéterminable (membre illisible, identité du bot hors cache) ;
    //   • appel en panne ;
    //   • portée qui n'expose pas la méthode — une portée n'est reconnue qu'à son
    //     `api.envoyerMessage`, et l'appel lèverait alors de façon SYNCHRONE,
    //     hors de portée d'un `.catch()`, pour ressortir en
    //     « verifierMembreSanctionnable is not a function ».
    const verificateurs = [
        async () => null,
        async () => { throw new Error('API injoignable'); },
        undefined,
    ];

    for (const verifier of verificateurs) {
        const api = {
            async envoyerMessage() {},
            async exclureMembre(...a) { tentees.push(a); },
        };
        if (verifier) api.verifierMembreSanctionnable = verifier;

        const [resultat] = await applyPunishments([{ action: 'kick' }], {
            portee: { guildeId: GUILDE, moi: { id: BOT }, api },
            member: { id: CIBLE },
            reason: 'test',
            source: 'automod',
            moderatorId: BOT,
        });
        assert.equal(resultat.ok, true, `verificateur ${String(verifier)}`);
    }
    assert.equal(tentees.length, verificateurs.length, 'chaque sanction devait être tentée');
});

test('un membre déjà parti reste bannissable : pas de contrôle de hiérarchie sur personne', async () => {
    // Cas le plus fréquent en anti-raid. `verifierMembreSanctionnable` ne doit
    // même pas être appelé : il n'y a plus de membre à situer dans la hiérarchie.
    const { applyPunishments } = require('../bot/utils/punishments');
    const bannis = [];

    const [resultat] = await applyPunishments([{ action: 'ban' }], {
        portee: {
            guildeId: GUILDE,
            moi: { id: BOT },
            api: {
                async envoyerMessage() {},
                async verifierMembreSanctionnable() { throw new Error('ne doit pas être appelé'); },
                async obtenirMembre() { return { id: BOT, aPermission: () => true }; },
                async bannirMembre(...a) { bannis.push(a); },
            },
        },
        member: null,
        userId: CIBLE,
        reason: 'test',
        source: 'antiraid',
        moderatorId: BOT,
    });

    assert.equal(resultat.ok, true);
    assert.equal(bannis.length, 1);
});

test('les pré-contrôles rendent les MÊMES phrases qu\'avant migration', async () => {
    // `moderatable` / `kickable` / `bannable` étaient la source de vérité de la
    // voie historique, retirée à la consolidation. Le pré-contrôle neutre
    // (`api.verifierMembreSanctionnable`) doit rendre les phrases à l'identique :
    // ce sont elles que lit une personne qui modère, et elles nomment la
    // correction à faire.
    const { applyPunishments } = require('../bot/utils/punishments');
    const portee = {
        guildeId: GUILDE,
        moi: { id: BOT },
        api: {
            async verifierMembreSanctionnable() { return 'hierarchie'; },
            async envoyerMessage() { return { id: '1' }; },
            async obtenirMembre(g, m) { return { id: m, aPermission: () => true }; },
        },
    };

    const [expulsion] = await applyPunishments([{ action: 'kick' }], {
        portee,
        member: { id: CIBLE },
        reason: 'test',
        source: 'automod',
        moderatorId: BOT,
    });
    assert.equal(expulsion.error, 'Hiérarchie des rôles ou permission « Expulser des membres » manquante.');

    const [exclusion] = await applyPunishments([{ action: 'timeout', durationMs: 60000 }], {
        portee,
        member: { id: CIBLE },
        reason: 'test',
        source: 'automod',
        moderatorId: BOT,
    });
    assert.equal(exclusion.error, 'Hiérarchie des rôles ou permission « Exclure temporairement » manquante.');
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
//  6. Escalade des avertissements, au contrat neutre
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
//  7. Le code neutre reste neutre
// ═══════════════════════════════════════════════════════════════

test('les codes d\'erreur neutres attendus par ce lot existent bien au contrat', () => {
    // Si l'un d'eux disparaissait du vocabulaire, `describeError` et le balayeur
    // retomberaient silencieusement sur « Erreur inconnue ».
    for (const nom of ['permission', 'introuvable', 'deja_fait', 'guilde_inconnue', 'inconnu']) {
        assert.equal(CODES_NEUTRES[nom], nom);
    }
});
