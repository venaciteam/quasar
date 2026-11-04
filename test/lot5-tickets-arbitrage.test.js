// Lot 5 — tickets et salon d'arbitrage au contrat neutre.
//
// Ces deux parcours sont ceux qui bâtissent tout sur des boutons et des
// formulaires. La migration ne doit rien changer de ce qu'une personne voit :
// mêmes messages, mêmes embeds, mêmes boutons dans le même ordre avec les mêmes
// styles, mêmes champs de formulaire avec les mêmes limites, et surtout mêmes
// overwrites sur les salons de ticket. Les références sont relevées sur la
// v4.10.0, AVANT migration, et écrites en dur.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

const { construireSlashCommand } = require('../bot/platform/discord/commands');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const { normaliserOverwrites } = require('../bot/platform/discord/api');
const { embed, estEmbed } = require('../bot/platform/embed');
const { getDb } = require('../api/services/database');

const ticket = require('../bot/commands/ticket');
const panneauDefer = require('../bot/panneaux/defer');
const moduleDefer = require('../bot/modules/defer');
const { buildTranscriptFile, deliverTranscript } = require('../bot/utils/transcriptArchive');

const sousCommande = (nom) => ticket.sousCommandes.find(s => s.nom === nom);
const lignes = (ctx, type) => ctx.journal.filter(l => l[0] === type);
const premier = (ctx, type) => ctx.journal.find(l => l[0] === type);
const bits = (...noms) => noms.reduce((total, nom) => total | PermissionFlagsBits[nom], 0n).toString();

/** La clé étrangère `guild_id -> guilds(guild_id)` est active (PRAGMA foreign_keys). */
function assurerGuilde(guildeId) {
    getDb().prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(guildeId, 'Serveur');
    return guildeId;
}

/**
 * Contexte neutre réduit. Tout est journalisé ; rien ne part sur le réseau.
 * Les méthodes correspondent une pour une à celles du contrat.
 */
function faireCtx({
    guildeId = 'G1', canalId = 'C1', auteurId = 'U1', nomGuilde = 'Serveur',
    permissions = {}, permissionsCanal = {}, canaux = {}, messages = [],
    reponsesPrompt, options = {}, membres = {},
} = {}) {
    if (guildeId) assurerGuilde(guildeId);
    const journal = [];
    const api = {
        async obtenirCanal(id) { journal.push(['obtenirCanal', id]); return canaux[id] ?? null; },
        async creerCanal(guilde, spec) { journal.push(['creerCanal', guilde, spec]); return { id: 'TICKET1', nom: spec.nom }; },
        async envoyerMessage(canal, contenu) { journal.push(['envoyerMessage', canal, contenu]); return { id: 'MSG1' }; },
        async modifierMessage(canal, message, contenu) { journal.push(['modifierMessage', canal, message, contenu]); return { id: message }; },
        async modifierPanneau(canal, message, contenu, choix, opts) {
            journal.push(['api.modifierPanneau', canal, message, contenu, choix, opts]);
            return { id: message };
        },
        async definirOverwrite(canal, cible, deltas, opts) { journal.push(['definirOverwrite', canal, cible, deltas, opts]); },
        async supprimerOverwrite(canal, cible) { journal.push(['supprimerOverwrite', canal, cible]); },
        async permissionsSurCanal(canal) {
            journal.push(['permissionsSurCanal', canal]);
            const jeu = permissionsCanal[canal];
            return jeu ? { aPermission: (nom) => jeu.includes(nom) } : null;
        },
        async listerMessages(canal, opts) { journal.push(['listerMessages', canal, opts]); return messages; },
        async supprimerCanal(canal) { journal.push(['supprimerCanal', canal]); },
        async ouvrirMessagePrive(userId) { journal.push(['ouvrirMessagePrive', userId]); return `DM-${userId}`; },
        async obtenirMembre(guilde, membreId) { return membres[membreId] ?? null; },
    };

    return {
        journal, api,
        plateforme: 'discord',
        capacites: { interactions: true, ephemere: true },
        guildeId, canalId,
        guilde: guildeId ? { id: guildeId, nom: nomGuilde } : null,
        proprietaireId: 'OWNER',
        auteur: { id: auteurId, nom: 'Leeva', etiquette: 'leeva', mention: `<@${auteurId}>` },
        membre: { id: auteurId, aPermission: (nom) => Boolean(permissions[nom]) },
        moi: { id: 'BOT', nom: 'Quasar' },
        panneau: { nom: 'defer', cle: '', messageId: 'PANNEAU1' },
        db: getDb(),
        options: { get: (nom) => options[nom] ?? null },
        differer(opts = {}) { journal.push(['differer', opts]); return Promise.resolve(); },
        repondre(contenu, opts = {}) { journal.push(['repondre', contenu, opts]); return Promise.resolve(); },
        modifierPanneau(contenu, choix = null, opts = {}) {
            journal.push(['modifierPanneau', contenu, choix, opts]);
            return Promise.resolve();
        },
        erreurUtilisateur(spec) { journal.push(['erreurUtilisateur', spec]); return Promise.resolve(); },
        poserPanneau(canal, contenu, choix, opts) {
            journal.push(['poserPanneau', canal, contenu, choix, opts]);
            return Promise.resolve({ canalId: canal, messageId: 'PANEL1' });
        },
        prompt(questions, opts = {}) { journal.push(['prompt', questions, opts]); return Promise.resolve(reponsesPrompt ?? null); },
    };
}

// ── 1. JSON déployé ──────────────────────────────────────────────────────────

test('/ticket produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [
            {
                type: 1, name: 'setup', description: 'Configurer le système de tickets',
                options: [
                    { channel_types: [0], name: 'salon', description: 'Le salon où envoyer le message d\'ouverture de ticket', required: true, type: 7 },
                    { name: 'staff', description: 'Le rôle staff qui aura accès aux tickets', required: true, type: 8 },
                    { channel_types: [4], name: 'categorie', description: 'La catégorie où créer les tickets', required: false, type: 7 },
                    { type: 3, name: 'message', description: 'Message d\'accueil custom (affiché à l\'ouverture du ticket)', required: false },
                ],
            },
            {
                type: 1, name: 'close', description: 'Fermer le ticket actuel',
                options: [{ type: 3, name: 'raison', description: 'Raison de la fermeture', required: false }],
            },
            {
                type: 1, name: 'add', description: 'Ajouter un membre au ticket',
                options: [{ name: 'membre', description: 'Le membre à ajouter', required: true, type: 6 }],
            },
            {
                type: 1, name: 'remove', description: 'Retirer un membre du ticket',
                options: [{ name: 'membre', description: 'Le membre à retirer', required: true, type: 6 }],
            },
            { type: 1, name: 'config', description: 'Voir la configuration actuelle des tickets', options: [] },
        ],
        name: 'ticket',
        description: 'Gérer le système de tickets',
        // `setDefaultMemberPermissions(0)` : réservée aux administrateurs. Sans
        // lui, /ticket config, /ticket add et /ticket remove s'ouvriraient à
        // tout le monde.
        default_member_permissions: '0',
        type: 1,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(construireSlashCommand(ticket).toJSON())), REFERENCE);
    assert.equal(ticket.accesParDefaut, false, 'false, et surtout pas true');
    assert.deepEqual(ticket.permissionsBot,
        ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'ATTACH_FILES', 'READ_MESSAGE_HISTORY']);
});

// ── 2. Routage du panneau ────────────────────────────────────────────────────

test('le panneau ticket est déclaré par la commande, celui de defer par le module', async () => {
    assert.deepEqual(Object.keys(ticket.panneaux), ['ticket']);
    assert.equal(panneauDefer.nom, 'defer');

    const adaptateur = creerAdaptateurDiscord({
        client: { on() {}, once() {}, off() {}, rest: {}, channels: { cache: new Map() } },
    });
    adaptateur.surPanneau('ticket', ticket.panneaux.ticket, '/ticket');
    adaptateur.surPanneau('defer', panneauDefer.executer, 'le module defer');

    // Les identifiants historiques emploient « _ » : aucun recouvrement avec le
    // séparateur neutre « : ». Un vieux bouton n'est donc PAS capté ici.
    for (const ancien of ['ticket_open', 'ticket_close', 'ticket_close_reason', 'defer_apply_42']) {
        assert.equal(adaptateur.routerPanneau({ customId: ancien }), null, ancien);
    }
    // Un panneau ne peut pas être revendiqué deux fois, et le message nomme les
    // deux déclarations.
    assert.throws(() => adaptateur.surPanneau('ticket', () => {}, 'le module tickets'),
        /déclaré deux fois : par \/ticket et par le module tickets/);
});

// ── 3. /ticket setup ─────────────────────────────────────────────────────────

const SALON = { id: 'S1', nom: 'support', mention: '<#S1>' };
const ROLE_STAFF = { id: 'R1', nom: 'Staff', mention: '<@&R1>' };
const CATEGORIE = { id: 'CAT1', nom: 'Tickets', mention: '<#CAT1>' };

test('setup refuse la personne sans « Gérer le serveur », dans les mêmes termes', async () => {
    const ctx = faireCtx({ permissions: {}, options: { salon: SALON, staff: ROLE_STAFF } });
    await sousCommande('setup').executer(ctx);
    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Permission insuffisante',
        cause: 'Configurer les tickets demande la permission **Gérer le serveur**, que vous n\'avez pas sur ce serveur.',
        action: 'Demandez à un administrateur de lancer cette commande, ou de vous accorder cette permission.',
    });
    assert.equal(premier(ctx, 'poserPanneau'), undefined);
});

test('setup vérifie les permissions du bot AVANT d\'écrire en base', async () => {
    // Sans ce contrôle, un salon inaccessible laisse une configuration
    // enregistrée mais inutilisable, et l'erreur ne dit pas laquelle des deux
    // étapes a échoué.
    const ctx = faireCtx({
        guildeId: 'G-PERM',
        permissions: { MANAGE_GUILD: true },
        permissionsCanal: { S1: ['VIEW_CHANNEL'] },
        options: { salon: SALON, staff: ROLE_STAFF },
    });
    await sousCommande('setup').executer(ctx);

    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Je ne peux pas écrire dans ce salon',
        cause: 'Il me manque ces permissions sur <#S1> : **Envoyer des messages**, **Intégrer des liens**.',
        action: 'Ouvrez les paramètres de <#S1> → Permissions, accordez-les à mon rôle, puis relancez la commande. Vous pouvez aussi choisir un autre salon.',
    });
    assert.equal(getDb().prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get('G-PERM'), undefined);
});

test('setup refuse une catégorie sur laquelle le bot ne peut pas créer de salon', async () => {
    const ctx = faireCtx({
        guildeId: 'G-CAT',
        permissions: { MANAGE_GUILD: true },
        permissionsCanal: { S1: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS'], CAT1: [] },
        options: { salon: SALON, staff: ROLE_STAFF, categorie: CATEGORIE },
    });
    await sousCommande('setup').executer(ctx);
    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Je ne peux pas créer de tickets dans cette catégorie',
        cause: 'Il me manque la permission **Gérer les salons** sur la catégorie **Tickets**, nécessaire pour y créer les salons de ticket.',
        action: 'Accordez-moi cette permission sur la catégorie, ou laissez le champ vide pour créer les tickets à la racine du serveur.',
    });
});

test('setup pose le panneau dans le salon CHOISI, pas dans celui de la commande', async () => {
    // C'est la raison d'être de `poserPanneau` : `ctx.choose` répond à
    // l'interaction en cours et aurait posé le panneau dans le mauvais salon.
    const ctx = faireCtx({
        guildeId: 'G-SETUP', canalId: 'AUTRE-SALON',
        permissions: { MANAGE_GUILD: true },
        permissionsCanal: { S1: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS'], CAT1: ['MANAGE_CHANNELS'] },
        options: { salon: SALON, staff: ROLE_STAFF, categorie: CATEGORIE, message: 'Bonjour !' },
    });
    await sousCommande('setup').executer(ctx);

    const [, canalPanneau, contenu, choix, opts] = premier(ctx, 'poserPanneau');
    assert.equal(canalPanneau, 'S1');
    assert.deepEqual(opts, { panneau: 'ticket' });
    assert.ok(estEmbed(contenu));
    assert.equal(contenu.titre, '🎫 Support — Ouvrir un ticket');
    assert.equal(contenu.description,
        'Cliquez sur le bouton ci-dessous pour ouvrir un ticket.\nUn membre du staff vous répondra dès que possible.');
    assert.equal(contenu.couleur, 0xDE3163);
    assert.equal(contenu.horodatage, true);
    // Même bouton qu'avant : libellé, emoji, style primaire.
    assert.deepEqual(choix, [{ cle: 'ouvrir', libelle: 'Ouvrir un ticket', emoji: '🎫', style: 'primaire' }]);

    const config = getDb().prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get('G-SETUP');
    assert.equal(config.channel_id, 'S1');
    assert.equal(config.category_id, 'CAT1');
    assert.equal(config.staff_role_id, 'R1');
    assert.equal(config.welcome_message, 'Bonjour !');
    assert.equal(config.enabled, 1);

    const [, confirmation, optionsConfirmation] = premier(ctx, 'repondre');
    assert.equal(confirmation.titre, '🎫 Système de tickets configuré');
    assert.deepEqual(confirmation.champs, [
        { nom: 'Salon', valeur: '<#S1>', enLigne: true },
        { nom: 'Rôle staff', valeur: '<@&R1>', enLigne: true },
        { nom: 'Catégorie', valeur: 'Tickets', enLigne: true },
        { nom: 'Message d\'accueil', valeur: 'Bonjour !' },
    ]);
    assert.deepEqual(optionsConfirmation, { ephemere: true });
});

// ── 4. Ouverture d'un ticket ─────────────────────────────────────────────────

test('l\'ouverture d\'un ticket produit EXACTEMENT les overwrites d\'origine', async () => {
    // Le point le plus sensible de la migration : un overwrite de travers rend
    // un ticket lisible par tout le serveur, ou invisible pour le staff.
    const db = getDb();
    assurerGuilde('G-OPEN');
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, enabled)
                VALUES (?, ?, ?, ?, ?, 1)`).run('G-OPEN', 'S1', 'CAT1', 'R1', null);

    const ctx = faireCtx({ guildeId: 'G-OPEN', auteurId: 'U-OPEN' });
    ctx.panneau = { nom: 'ticket', cle: 'ouvrir', messageId: 'P1' };
    await ticket.panneaux.ticket(ctx, 'ouvrir');

    const [, guildeCible, spec] = premier(ctx, 'creerCanal');
    assert.equal(guildeCible, 'G-OPEN');
    assert.equal(spec.nom, 'ticket-leeva-1');
    assert.equal(spec.type, 'texte');
    assert.equal(spec.parentId, 'CAT1');

    // Conversion réelle par l'adaptateur, comparée aux bitfields discord.js.
    assert.deepEqual(normaliserOverwrites(spec.permissions), [
        // @everyone porte l'identifiant du serveur.
        { id: 'G-OPEN', type: 0, allow: '0', deny: bits('ViewChannel') },
        {
            id: 'U-OPEN', type: 1, deny: '0',
            allow: bits('ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'),
        },
        {
            id: 'R1', type: 0, deny: '0',
            allow: bits('ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages'),
        },
        {
            id: 'BOT', type: 1, deny: '0',
            allow: bits('ViewChannel', 'SendMessages', 'ManageChannels', 'ReadMessageHistory'),
        },
    ]);
});

test('le message d\'accueil garde ses mentions, son embed et son bouton de fermeture', async () => {
    const db = getDb();
    assurerGuilde('G-ACC');
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, enabled)
                VALUES (?, ?, ?, ?, ?, 1)`).run('G-ACC', 'S1', null, 'R1', null);

    const ctx = faireCtx({ guildeId: 'G-ACC', auteurId: 'U-ACC' });
    await ticket.panneaux.ticket(ctx, 'ouvrir');

    // UN SEUL message : les mentions notifient, celles d'un embed non — elles
    // doivent donc voyager DANS le message du panneau, comme avant migration.
    // Le corps composé de `poserPanneau` le permet ; il a fallu deux envois
    // séparés le temps que le contrat ne l'accepte pas.
    assert.equal(premier(ctx, 'envoyerMessage'), undefined,
        'les mentions ne doivent plus partir dans un message séparé');

    const [, canal, corps, choix, opts] = premier(ctx, 'poserPanneau');
    assert.equal(canal, 'TICKET1');
    assert.deepEqual(opts, { panneau: 'ticket' });
    assert.equal(corps.contenu, '<@U-ACC> | <@&R1>');
    assert.equal(corps.embeds.length, 1);
    const [contenu] = corps.embeds;
    const ticketId = db.prepare('SELECT id FROM tickets WHERE guild_id = ? AND user_id = ?').get('G-ACC', 'U-ACC').id;
    assert.equal(contenu.titre, `🎫 Ticket #${ticketId}`);
    assert.equal(contenu.description,
        'Bienvenue <@U-ACC> !\n\nUn membre du staff va vous répondre sous peu. Décrivez votre problème en détail.');
    assert.deepEqual(contenu.champs, [
        { nom: 'Ouvert par', valeur: '<@U-ACC>', enLigne: true },
        { nom: 'Staff', valeur: '<@&R1>', enLigne: true },
    ]);
    assert.deepEqual(choix, [{ cle: 'fermer', libelle: 'Fermer le ticket', emoji: '🔒', style: 'danger' }]);

    const [, accuse, optionsAccuse] = premier(ctx, 'repondre');
    assert.equal(accuse, '✅ Votre ticket a été créé : <#TICKET1>');
    assert.deepEqual(optionsAccuse, { ephemere: true });
});

test('le corps posé par poserPanneau porte bien content + embeds + components', async () => {
    // Preuve au niveau du CORPS REST, et pas seulement de l'intention : c'est
    // `api.envoyerMessage` qui décide, et une clé oubliée en chemin ferait
    // repartir les mentions dans le vide sans erreur.
    const { creerApi } = require('../bot/platform/discord/api');
    const envois = [];
    const api = creerApi({
        rest: {
            post: async (route, requete) => { envois.push([route, requete]); return { id: 'M1', channel_id: 'TICKET1' }; },
        },
    });
    const { creerContexteEvenement } = require('../bot/platform/discord/events');
    const ctxEvenement = creerContexteEvenement({ nom: 'discord', capacites: {}, moi: { id: 'BOT' }, api });

    await ctxEvenement.poserPanneau(
        'TICKET1',
        { contenu: '<@U> | <@&R>', embeds: [embed({ titre: 'T' })] },
        [{ cle: 'fermer', libelle: 'Fermer le ticket', emoji: '🔒', style: 'danger' }],
        { panneau: 'ticket' },
    );

    assert.equal(envois.length, 1, 'un seul appel REST, donc un seul message');
    const [, { body }] = envois[0];
    assert.equal(body.content, '<@U> | <@&R>');
    assert.equal(body.embeds.length, 1);
    assert.equal(body.embeds[0].title, 'T');
    assert.deepEqual(body.components[0].components.map(b => b.custom_id), ['ticket:fermer']);
});

test('un second ticket est refusé tant que le premier est ouvert', async () => {
    const db = getDb();
    assurerGuilde('G-DUP');
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, staff_role_id, enabled)
                VALUES (?, ?, ?, 1)`).run('G-DUP', 'S1', 'R1');
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run('G-DUP', 'DEJA', 'U-DUP');

    const ctx = faireCtx({ guildeId: 'G-DUP', auteurId: 'U-DUP', canaux: { DEJA: { id: 'DEJA', nom: 'ticket' } } });
    await ticket.panneaux.ticket(ctx, 'ouvrir');

    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Vous avez déjà un ticket ouvert',
        cause: 'Votre ticket en cours est <#DEJA>. Un seul ticket à la fois est autorisé, pour éviter les doublons côté staff.',
        action: 'Poursuivez la discussion dans ce salon. S\'il est résolu, fermez-le avec `/ticket close` avant d\'en ouvrir un nouveau.',
    });
    assert.equal(premier(ctx, 'creerCanal'), undefined);
});

test('un ticket dont le salon a disparu est refermé, et un nouveau peut s\'ouvrir', async () => {
    const db = getDb();
    assurerGuilde('G-ORPH');
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, staff_role_id, enabled)
                VALUES (?, ?, ?, 1)`).run('G-ORPH', 'S1', 'R1');
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run('G-ORPH', 'PARTI', 'U-ORPH');

    const ctx = faireCtx({ guildeId: 'G-ORPH', auteurId: 'U-ORPH', canaux: {} });
    await ticket.panneaux.ticket(ctx, 'ouvrir');

    const ancien = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?').get('G-ORPH', 'PARTI');
    assert.equal(ancien.closed_by, 'system');
    assert.equal(ancien.close_reason, 'Channel supprimé');
    assert.ok(premier(ctx, 'creerCanal'), 'un nouveau ticket doit pouvoir s\'ouvrir');
});

// ── 5. Formulaire de fermeture ───────────────────────────────────────────────

test('le bouton « Fermer » ouvre le même formulaire qu\'avant', async () => {
    const ctx = faireCtx({ guildeId: 'G-FORM' });
    await ticket.panneaux.ticket(ctx, 'fermer');

    const [, questions, opts] = premier(ctx, 'prompt');
    assert.equal(opts.titre, 'Fermer le ticket');
    assert.deepEqual(questions, [{
        cle: 'raison',
        libelle: 'Raison de la fermeture (optionnel)',
        exemple: 'Problème résolu, spam, etc.',
        style: 'paragraphe',
        max: 1000,
        requis: false,
    }]);
    // Formulaire fermé : rien d'autre ne se produit.
    assert.equal(ctx.journal.length, 1);
});

// ── 6. Fermeture et transcript ───────────────────────────────────────────────

function preparerTicketOuvert(guildeId, canalId, userId) {
    const db = getDb();
    assurerGuilde(guildeId);
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run(guildeId, canalId, userId);
    return db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND channel_id = ?').get(guildeId, canalId);
}

test('la fermeture diffère sa réponse, collecte le transcript et remet la conversation', async () => {
    const ligne = preparerTicketOuvert('G-CLOSE', 'C-CLOSE', 'U-OPENER');
    const ctx = faireCtx({
        guildeId: 'G-CLOSE', canalId: 'C-CLOSE', auteurId: 'U-MOD',
        canaux: { 'C-CLOSE': { id: 'C-CLOSE', nom: 'ticket-leeva-1' } },
        messages: [
            {
                id: '2', auteur: { etiquette: 'leeva' }, contenu: 'Merci !',
                piecesJointes: [], creeLe: Date.parse('2026-01-02T10:00:00.000Z'),
            },
            {
                id: '1', auteur: { etiquette: 'staff' }, contenu: 'Bonjour',
                piecesJointes: [{ url: 'https://cdn/f.png' }], creeLe: Date.parse('2026-01-02T09:00:00.000Z'),
            },
        ],
        options: { raison: 'Résolu' },
    });
    await sousCommande('close').executer(ctx);

    // L'acquittement précède la collecte : elle dépasse les trois secondes.
    assert.deepEqual(premier(ctx, 'differer'), ['differer', {}]);
    assert.ok(ctx.journal.findIndex(l => l[0] === 'differer') < ctx.journal.findIndex(l => l[0] === 'listerMessages'));

    // Transcript : ordre chronologique rétabli, format de ligne inchangé.
    const [, canalDM, corps] = ctx.journal.find(l => l[0] === 'envoyerMessage' && String(l[1]).startsWith('DM-'));
    assert.equal(canalDM, 'DM-U-MOD');
    const texte = corps.fichiers[0].donnees.toString('utf8');
    assert.match(texte, /^Transcript du ticket #\d+/);
    assert.ok(texte.includes('[2026-01-02T09:00:00.000Z] staff: Bonjour [Pièces jointes: https:\/\/cdn\/f.png]'));
    assert.ok(texte.includes('[2026-01-02T10:00:00.000Z] leeva: Merci !'));
    assert.ok(texte.indexOf('09:00:00') < texte.indexOf('10:00:00'), 'du plus ancien au plus récent');
    assert.equal(corps.fichiers[0].nom.startsWith(`ticket-${ligne.id}-`), true);

    // Ticket clos en base, puis salon supprimé.
    const apres = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(ligne.id);
    assert.equal(apres.closed_by, 'U-MOD');
    assert.equal(apres.close_reason, 'Résolu');
    assert.ok(apres.closed_at);

    const [, final] = ctx.journal.filter(l => l[0] === 'repondre').pop();
    assert.equal(final.titre, '🎫 Ticket fermé');
    assert.equal(final.description,
        'Fermé par <@U-MOD>\n**Raison :** Résolu\n\n'
        + '📄 Le transcript t\'a été envoyé en message privé (aucun salon de logs disponible).');
});

test('transcript non remis : le ticket reste ouvert et le salon n\'est pas supprimé', async () => {
    // Quasar ne conserve pas les conversations : tant que le transcript n'est
    // pas remis, détruire le salon détruirait la seule copie.
    const ligne = preparerTicketOuvert('G-FAIL', 'C-FAIL', 'U-OPENER');
    const ctx = faireCtx({
        guildeId: 'G-FAIL', canalId: 'C-FAIL', auteurId: 'U-MOD',
        canaux: { 'C-FAIL': { id: 'C-FAIL', nom: 'ticket' } },
        options: { raison: 'Spam' },
    });
    ctx.api.ouvrirMessagePrive = async () => { throw new Error('Cannot send messages to this user'); };

    await sousCommande('close').executer(ctx);

    const [, refus] = ctx.journal.filter(l => l[0] === 'repondre').pop();
    assert.equal(refus.titre, '❌ Fermeture annulée — transcript non archivé');
    assert.equal(refus.description,
        'Quasar ne conserve pas les conversations de tickets : le transcript doit être '
        + 'remis avant que le salon soit supprimé. Ici, aucune des deux voies n\'a fonctionné.\n\n'
        + '**Pour débloquer, au choix :**\n'
        + '• configurer un salon de logs auquel Quasar peut écrire (`/log`) ;\n'
        + '• ou ouvrir vos messages privés pour ce serveur, puis relancer la fermeture.\n\n'
        + '_Le ticket reste ouvert, aucun message n\'a été perdu._');
    assert.equal(refus.couleur, 0xED4245);

    assert.equal(getDb().prepare('SELECT closed_at FROM tickets WHERE id = ?').get(ligne.id).closed_at, null);
    assert.equal(premier(ctx, 'supprimerCanal'), undefined);
});

test('fermer hors d\'un salon de ticket est refusé sans rien acquitter', async () => {
    const ctx = faireCtx({ guildeId: 'G-NOPE', canalId: 'PAS-UN-TICKET', options: { raison: null } });
    await sousCommande('close').executer(ctx);
    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Ce salon n\'est pas un ticket ouvert',
        cause: 'Soit ce salon n\'est pas un ticket, soit il a déjà été fermé.',
        action: 'Utilisez cette commande dans le salon d\'un ticket encore ouvert.',
    });
    assert.equal(premier(ctx, 'differer'), undefined);
});

// ── 7. add / remove ──────────────────────────────────────────────────────────

test('add et remove modifient l\'overwrite d\'UNE personne, sans toucher aux autres', async () => {
    preparerTicketOuvert('G-ADD', 'C-ADD', 'U-OPENER');
    const membre = { id: 'U-INVITE', mention: '<@U-INVITE>' };

    const ctxAdd = faireCtx({ guildeId: 'G-ADD', canalId: 'C-ADD', options: { membre } });
    await sousCommande('add').executer(ctxAdd);
    assert.deepEqual(premier(ctxAdd, 'definirOverwrite').slice(1), [
        'C-ADD', 'U-INVITE',
        { VIEW_CHANNEL: true, SEND_MESSAGES: true, READ_MESSAGE_HISTORY: true },
        { type: 'membre' },
    ]);
    assert.equal(premier(ctxAdd, 'repondre')[1].description, '✅ <@U-INVITE> a été ajouté au ticket.');
    assert.deepEqual(premier(ctxAdd, 'repondre')[2], {}, 'réponse publique, comme avant');

    const ctxRemove = faireCtx({ guildeId: 'G-ADD', canalId: 'C-ADD', options: { membre } });
    await sousCommande('remove').executer(ctxRemove);
    assert.deepEqual(premier(ctxRemove, 'supprimerOverwrite').slice(1), ['C-ADD', 'U-INVITE']);
    assert.equal(premier(ctxRemove, 'repondre')[1].description, '✅ <@U-INVITE> a été retiré du ticket.');

    const ctxHors = faireCtx({ guildeId: 'G-ADD', canalId: 'AILLEURS', options: { membre } });
    await sousCommande('add').executer(ctxHors);
    assert.equal(premier(ctxHors, 'erreurUtilisateur')[1].titre, 'Ce salon n\'est pas un ticket');
    assert.equal(premier(ctxHors, 'definirOverwrite'), undefined);
});

// ── 8. /ticket config ────────────────────────────────────────────────────────

test('config affiche les mêmes champs, dans le même ordre', async () => {
    const db = getDb();
    assurerGuilde('G-CONF');
    db.prepare(`INSERT INTO ticket_config (guild_id, channel_id, category_id, staff_role_id, welcome_message, enabled)
                VALUES (?, ?, ?, ?, ?, 1)`).run('G-CONF', 'S1', null, 'R1', 'Coucou');
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run('G-CONF', 'T1', 'U1');

    const ctx = faireCtx({ guildeId: 'G-CONF', permissions: { MANAGE_GUILD: true } });
    await sousCommande('config').executer(ctx);

    const [, contenu, opts] = premier(ctx, 'repondre');
    assert.equal(contenu.titre, '🎫 Configuration des tickets');
    assert.deepEqual(contenu.champs, [
        { nom: 'Statut', valeur: '✅ Activé', enLigne: true },
        { nom: 'Salon', valeur: '<#S1>', enLigne: true },
        { nom: 'Rôle staff', valeur: '<@&R1>', enLigne: true },
        { nom: 'Catégorie', valeur: 'Aucune (racine)', enLigne: true },
        { nom: 'Tickets ouverts', valeur: '1', enLigne: true },
        { nom: 'Total tickets', valeur: '1', enLigne: true },
        { nom: 'Message d\'accueil', valeur: 'Coucou' },
    ]);
    assert.deepEqual(opts, { ephemere: true });

    const ctxVide = faireCtx({ guildeId: 'G-VIDE', permissions: { MANAGE_GUILD: true } });
    await sousCommande('config').executer(ctxVide);
    assert.equal(premier(ctxVide, 'erreurUtilisateur')[1].titre, 'Les tickets ne sont pas encore configurés');
});

// ── 9. transcriptArchive ─────────────────────────────────────────────────────

test('le transcript part au salon de logs quand il existe, en message privé sinon', async () => {
    const db = getDb();
    assurerGuilde('G-LOG');
    db.prepare('INSERT OR REPLACE INTO modules (guild_id, module_name, enabled, config) VALUES (?, ?, 1, ?)')
        .run('G-LOG', 'moderation', JSON.stringify({ logChannel: 'LOGS' }));

    const { fichier, truncated } = buildTranscriptFile({
        ticketId: 7, guilde: { id: 'G-LOG', nom: 'Serveur' },
        ticket: { user_id: 'U1', opened_at: '2026-01-01' },
        closedBy: 'U-MOD', reason: 'Résolu', transcript: 'ligne', messageCount: 1,
    });
    assert.equal(truncated, false);
    assert.equal(fichier.description, 'Transcript du ticket #7');
    assert.ok(Buffer.isBuffer(fichier.donnees));

    const envois = [];
    const api = {
        async envoyerMessage(canal, corps) { envois.push([canal, corps]); },
        async ouvrirMessagePrive(id) { return `DM-${id}`; },
    };
    const resultat = await deliverTranscript({
        portee: { guildeId: 'G-LOG', api }, moderateurId: 'U-MOD',
        embed: embed({ titre: '🎫 Ticket fermé' }), fichier,
    });
    assert.deepEqual(resultat, { ok: true, via: 'log', truncated: false, error: null });
    assert.equal(envois[0][0], 'LOGS');
    assert.deepEqual(envois[0][1].fichiers, [fichier]);

    // Salon de logs injoignable : repli sur le message privé, texte inchangé.
    const envoisDM = [];
    const apiCasse = {
        async envoyerMessage(canal, corps) {
            if (canal === 'LOGS') throw new Error('Missing Access');
            envoisDM.push([canal, corps]);
        },
        async ouvrirMessagePrive(id) { return `DM-${id}`; },
    };
    const repli = await deliverTranscript({
        portee: { guildeId: 'G-LOG', api: apiCasse }, moderateurId: 'U-MOD',
        embed: embed({ titre: '🎫 Ticket fermé' }), fichier,
    });
    assert.equal(repli.via, 'dm');
    assert.equal(envoisDM[0][0], 'DM-U-MOD');
    assert.equal(envoisDM[0][1].contenu,
        '📄 Transcript du ticket que vous venez de fermer.\n'
        + 'Il t\'arrive en privé parce que ce serveur n\'a pas de salon de logs configuré, '
        + 'ou que Quasar ne peut pas y écrire. Ce fichier est la seule copie de la conversation : '
        + 'le bot n\'en garde aucune.');
});

// ── 10. Arbitrage : la pose du cas ───────────────────────────────────────────

test('sendDeferCase pose le cas et ses deux boutons depuis une portée neutre', async () => {
    // C'est ce qui lève le verrou « Arbitrage indisponible » sur la voie neutre
    // de applyPunishments : tant que ce module était discord.js, un appel neutre
    // n'ouvrait aucun cas et n'appliquait donc AUCUNE sanction.
    const db = getDb();
    assurerGuilde('G-DEFER');
    db.prepare('INSERT INTO defer_config (guild_id, channel_id, enabled) VALUES (?, ?, 1)').run('G-DEFER', 'ARB');

    const poses = [];
    const portee = {
        plateforme: 'discord', capacites: {},
        guildeId: 'G-DEFER',
        moi: { id: 'BOT' },
        api: {
            async envoyerMessage() { return { id: 'X' }; },
            async obtenirCanal(id) { return { id, nom: 'arbitrage' }; },
            async permissionsSurCanal() { return { aPermission: () => true }; },
        },
        repondre() {},
        poserPanneau(canal, contenu, choix, opts) {
            poses.push({ canal, contenu, choix, opts });
            return Promise.resolve({ canalId: canal, messageId: 'ARBMSG' });
        },
    };

    const resultat = await moduleDefer.sendDeferCase(portee, {
        targetUserId: 'U-CIBLE', source: 'escalation',
        reason: 'Trop d\'avertissements', proposedPunishments: 'tempmute 20m',
        evidence: '[Message](https://lien)',
    });
    assert.equal(resultat.ok, true);
    assert.equal(poses.length, 1);
    assert.equal(poses[0].canal, 'ARB');
    assert.deepEqual(poses[0].opts, { panneau: 'defer' });
    assert.deepEqual(poses[0].choix, [
        { cle: `apply:${resultat.caseId}`, libelle: 'Appliquer les sanctions', emoji: '⚖️', style: 'danger' },
        { cle: `ignore:${resultat.caseId}`, libelle: 'Ignorer le cas', emoji: '🕊️', style: 'secondaire' },
    ]);
    assert.equal(poses[0].contenu.titre, `⚖️ Cas d'arbitrage #${resultat.caseId}`);
    assert.equal(poses[0].contenu.description,
        'Une règle de modération automatique propose une sanction. Rien n\'a encore été appliqué.');
    assert.deepEqual(poses[0].contenu.champs.map(c => c.nom), [
        'Membre', 'Déclencheur', 'Motif', 'Sanctions proposées', 'Élément déclencheur',
    ]);

    const ligne = db.prepare('SELECT * FROM defer_cases WHERE id = ?').get(resultat.caseId);
    assert.equal(ligne.status, 'pending');
    assert.equal(ligne.message_id, 'ARBMSG');
    assert.equal(ligne.channel_id, 'ARB');
});

test('sendDeferCase refuse fermé quand l\'arbitrage n\'est pas exploitable', async () => {
    const base = {
        plateforme: 'discord', capacites: {}, guildeId: 'G-KO', moi: { id: 'BOT' },
        repondre() {}, poserPanneau: async () => ({ messageId: 'M' }),
        api: {
            async envoyerMessage() { return { id: 'X' }; },
            async obtenirCanal() { return null; },
            async permissionsSurCanal() { return { aPermission: () => true }; },
        },
    };
    assert.deepEqual(await moduleDefer.sendDeferCase(base, { targetUserId: 'U' }),
        { ok: false, error: 'aucun salon d\'arbitrage actif sur ce serveur' });

    assurerGuilde('G-KO');
    getDb().prepare('INSERT INTO defer_config (guild_id, channel_id, enabled) VALUES (?, ?, 1)').run('G-KO', 'ARB');
    assert.deepEqual(await moduleDefer.sendDeferCase(base, { targetUserId: 'U' }),
        { ok: false, error: 'le salon d\'arbitrage configuré n\'existe plus' });

    const sansDroit = {
        ...base,
        api: { ...base.api, async obtenirCanal(id) { return { id }; }, async permissionsSurCanal() { return { aPermission: () => false }; } },
    };
    assert.deepEqual(await moduleDefer.sendDeferCase(sansDroit, { targetUserId: 'U' }),
        { ok: false, error: 'je n\'ai pas le droit d\'écrire dans le salon d\'arbitrage' });

    assert.deepEqual(await moduleDefer.sendDeferCase(base, {}),
        { ok: false, error: 'membre visé inconnu' });
});

// ── 11. Arbitrage : trancher ─────────────────────────────────────────────────

function poserCas(guildeId, statut = 'pending') {
    const db = getDb();
    assurerGuilde(guildeId);
    const insere = db.prepare(`
        INSERT INTO defer_cases (guild_id, channel_id, target_user_id, source, reason, proposed_punishments, status, message_id)
        VALUES (?, 'ARB', 'U-CIBLE', 'antiraid', 'Raid', 'kick', ?, 'ARBMSG')
    `).run(guildeId, statut);
    return db.prepare('SELECT * FROM defer_cases WHERE id = ?').get(insere.lastInsertRowid);
}

test('trancher exige la permission de modération, et le dit dans les mêmes termes', async () => {
    const cas = poserCas('G-PERM-ARB');
    const ctx = faireCtx({ guildeId: 'G-PERM-ARB', canalId: 'ARB', permissions: {} });
    await panneauDefer.executer(ctx, `apply:${cas.id}`);
    assert.deepEqual(premier(ctx, 'erreurUtilisateur')[1], {
        titre: 'Arbitrage réservé à la modération',
        cause: 'Trancher un cas exige la permission « Exclure temporairement des membres » sur ce serveur.',
        action: 'Demandez à un membre de l\'équipe de modération de traiter ce cas.',
    });
    assert.equal(getDb().prepare('SELECT status FROM defer_cases WHERE id = ?').get(cas.id).status, 'pending');
});

test('un cas inexistant ou d\'un autre serveur est refusé', async () => {
    const ctx = faireCtx({ guildeId: 'G-AUTRE', canalId: 'ARB', permissions: { MODERATE_MEMBERS: true } });
    await panneauDefer.executer(ctx, 'apply:999999');
    assert.equal(premier(ctx, 'erreurUtilisateur')[1].titre, 'Cas introuvable');
});

test('ignorer un cas le clôt, réécrit le message et n\'applique rien', async () => {
    const cas = poserCas('G-IGN');
    const ctx = faireCtx({
        guildeId: 'G-IGN', canalId: 'ARB', auteurId: 'U-MOD',
        permissions: { MODERATE_MEMBERS: true },
    });
    ctx.panneau = { nom: 'defer', cle: `ignore:${cas.id}`, messageId: 'ARBMSG' };
    await panneauDefer.executer(ctx, `ignore:${cas.id}`);

    const apres = getDb().prepare('SELECT * FROM defer_cases WHERE id = ?').get(cas.id);
    assert.equal(apres.status, 'rejected');
    assert.equal(apres.resolved_by, 'U-MOD');

    // Le clic est acquitté PAR la réécriture du panneau (`update()`), et rien
    // d'autre n'est posté : le contournement `differer` + `api.modifierMessage`
    // + `repondre` coûtait un message éphémère que l'original n'avait pas.
    assert.equal(premier(ctx, 'differer'), undefined, 'aucun acquittement différé');
    assert.equal(premier(ctx, 'repondre'), undefined, 'aucun message éphémère');
    assert.equal(premier(ctx, 'modifierMessage'), undefined);

    const [, contenu, choix, opts] = premier(ctx, 'modifierPanneau');
    assert.deepEqual(opts, { panneau: 'defer' });
    assert.equal(contenu.titre, `⚖️ Cas d'arbitrage #${cas.id} — cas ignoré`);
    assert.deepEqual(contenu.champs.map(c => c.nom),
        ['Membre', 'Déclencheur', 'Motif', 'Sanctions proposées', 'Arbitrage', 'Résultat']);
    assert.equal(contenu.champs.at(-1).valeur, 'Aucune sanction appliquée.');
    // Les boutons sont REPOSÉS désactivés, pas retirés : le message doit
    // continuer de dire à quoi le clic correspondait.
    assert.deepEqual(choix.map(c => [c.cle, c.desactive]), [
        [`apply:${cas.id}`, true],
        [`ignore:${cas.id}`, true],
    ]);
});

test('deux clics simultanés ne tranchent qu\'une fois', async () => {
    const cas = poserCas('G-RACE');
    const premierCtx = faireCtx({ guildeId: 'G-RACE', canalId: 'ARB', auteurId: 'MOD-A', permissions: { MODERATE_MEMBERS: true } });
    const secondCtx = faireCtx({ guildeId: 'G-RACE', canalId: 'ARB', auteurId: 'MOD-B', permissions: { MODERATE_MEMBERS: true } });

    await panneauDefer.executer(premierCtx, `ignore:${cas.id}`);
    await panneauDefer.executer(secondCtx, `ignore:${cas.id}`);

    const apres = getDb().prepare('SELECT * FROM defer_cases WHERE id = ?').get(cas.id);
    assert.equal(apres.resolved_by, 'MOD-A', 'la base départage, le second clic ne réécrit pas la décision');
    // Le salon cesse de mentir sur l'état du cas : le message est rafraîchi, et
    // le second clic est acquitté par cette réécriture — pas par un éphémère.
    assert.ok(premier(secondCtx, 'modifierPanneau'));
    assert.equal(premier(secondCtx, 'repondre'), undefined);
});

test('appliquer un cas : deux écritures, aucun message éphémère', async () => {
    const cas = poserCas('G-APPLY');
    const ctx = faireCtx({
        guildeId: 'G-APPLY', canalId: 'ARB', auteurId: 'U-MOD',
        permissions: { MODERATE_MEMBERS: true },
    });
    ctx.panneau = { nom: 'defer', cle: `apply:${cas.id}`, messageId: 'ARBMSG' };
    await panneauDefer.executer(ctx, `apply:${cas.id}`);

    // 1. Acquittement + état « tranché » sur le panneau, dans les trois secondes.
    const acquittement = premier(ctx, 'modifierPanneau');
    assert.ok(acquittement, 'le clic doit être acquitté par la réécriture du panneau');
    assert.match(acquittement[1].titre, /sanctions appliquées/);

    // 2. Le résultat des sanctions, une fois connu, par les coordonnées du
    //    message — c'est le `interaction.message.edit()` d'avant migration.
    const [, canal, message, contenu, choix, opts] = premier(ctx, 'api.modifierPanneau');
    assert.deepEqual([canal, message], ['ARB', 'ARBMSG']);
    assert.deepEqual(opts, { panneau: 'defer' });
    assert.equal(contenu.champs.at(-1).nom, 'Résultat');
    assert.deepEqual(choix.map(c => c.desactive), [true, true]);

    // Et toujours aucun éphémère, ni acquittement différé.
    assert.equal(premier(ctx, 'differer'), undefined);
    assert.equal(premier(ctx, 'repondre'), undefined);
});

// ── 12. Découplage ───────────────────────────────────────────────────────────

test('aucun fichier du lot 5 n\'importe discord.js', () => {
    // `bot/interactions/{ticket,defer}.js` ont été SUPPRIMÉS à la consolidation
    // avec le routage par préfixes qui les alimentait : ils ne répondaient plus
    // qu'« ce bouton date d'une version antérieure ».
    const fichiers = [
        'bot/commands/ticket.js', 'bot/commands/signaler.js', 'bot/commands/mesdonnees.js',
        'bot/modules/defer/index.js', 'bot/panneaux/defer.js', 'bot/utils/transcriptArchive.js',
    ];
    for (const disparu of ['bot/interactions/ticket.js', 'bot/interactions/defer.js']) {
        assert.equal(fs.existsSync(path.join(__dirname, '..', disparu)), false,
            `${disparu} ne devrait plus exister`);
    }
    for (const relatif of fichiers) {
        const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
        assert.equal(/require\(['"]discord\.js['"]\)/.test(source), false, `${relatif} importe discord.js`);
    }
});

test('plus aucune dérogation : sendDeferCase n\'accepte que la portée neutre', () => {
    // `sendDeferCase` dérivait une portée neutre d'une `Guild` discord.js, en
    // montant un client REST au vol, parce que `applyPunishments` en recevait
    // encore une de l'anti-raid et du salon piège. Les deux sont migrés, la voie
    // `guild:` de `applyPunishments` est tombée, et cette dérivation avec elle :
    // AUCUN fichier de l'arbitrage n'importe plus l'adaptateur.
    const fichiers = [
        'bot/commands/ticket.js', 'bot/modules/defer/index.js',
        'bot/panneaux/defer.js', 'bot/utils/transcriptArchive.js',
    ];
    for (const relatif of fichiers) {
        const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
        assert.equal(/require\(['"][^'"]*platform\/discord/.test(source), false,
            `${relatif} importe l'adaptateur Discord`);
        assert.equal(/TRANSITION/.test(source), false, `${relatif} porte encore un marqueur TRANSITION`);
    }
});
