// ═══════════════════════════════════════════════════════════════
//  Lot 6 — Les primitives, en doublure
//
//  `prompt`, `choose` et `choisirMembre` sont ce que le lot 6 réinvente
//  entièrement : là où Discord ouvre une fenêtre et pose des boutons, Fluxer
//  pose des questions et des réactions. Ces parcours ne sont testables que de
//  bout en bout — un rendu correct et un collecteur qui n'écoute rien donnent un
//  dialogue qui ne répond jamais, et aucun test unitaire de rendu ne le verrait.
//
//  L'adaptateur est donc le VRAI, avec un client en doublure : boucle de
//  distribution réelle, collecteurs réels, routage de panneau réel.
// ═══════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Base jetable, posée AVANT le premier require de la chaîne base de données :
// les panneaux persistants y écrivent, et il n'y a aucune raison de salir la
// base de développement.
process.env.QUASAR_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-fluxer-')), 'test.db',
);

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const creerAdaptateurFluxer = require('../bot/platform/fluxer');
const { creerEtat } = require('../bot/platform/fluxer/client');
const { embed } = require('../bot/platform/embed');
const { getDb } = require('../api/services/database');

const GUILDE = '900000000000000000';
const SALON = '300000000000000000';
const AUTEUR = '400000000000000000';
const BOT = '100000000000000000';
const AUTRE = '500000000000000000';

/**
 * Client Fluxer en doublure : aucun réseau, un journal de tout ce qui est
 * envoyé, et un état préchargé comme le ferait la rafale de GUILD_CREATE.
 */
function faireClient({ roles = [], proprietaireId = AUTEUR } = {}) {
    const client = new EventEmitter();
    client.setMaxListeners(0);
    client.etat = creerEtat();
    client.etat.poserGuilde({
        id: GUILDE,
        properties: { id: GUILDE, name: 'Venacity', owner_id: proprietaireId },
        roles: [{ id: GUILDE, name: '@everyone', position: 0, permissions: '0' }, ...roles],
        channels: [{ id: SALON, name: 'general', type: 0, guild_id: GUILDE, permission_overwrites: [] }],
        members: [],
        voice_states: [],
        member_count: 3,
    });
    client.user = { id: BOT, username: 'Quasar' };
    client.isReady = () => true;
    client.passerelle = { latence: 42 };
    client.connecter = async () => {};
    client.deconnecter = () => {};

    const envois = [];
    const reactions = [];
    const suppressions = [];
    let compteur = 0;

    client.rest = {
        async post(chemin, options = {}) {
            if (/\/messages$/.test(chemin)) {
                const id = `msg${++compteur}`;
                const canal = /\/channels\/([^/]+)\/messages$/.exec(chemin)[1];
                envois.push({ canal, corps: options.body, files: options.files, id });
                return { id, channel_id: canal, guild_id: GUILDE, type: 0, author: { id: BOT, bot: true }, content: options.body?.content ?? null, embeds: options.body?.embeds || [], attachments: [], reactions: [] };
            }
            if (chemin === '/users/@me/channels') return { id: `mp-${options.body.recipient_id}` };
            if (/\/typing$/.test(chemin)) return null;
            return null;
        },
        async patch(chemin, options = {}) {
            const [, canal, message] = /\/channels\/([^/]+)\/messages\/([^/]+)/.exec(chemin) || [];
            envois.push({ canal, messageId: message, corps: options.body, modification: true });
            return { id: message, channel_id: canal, guild_id: GUILDE, type: 0, author: { id: BOT, bot: true }, content: options.body?.content ?? null, embeds: options.body?.embeds || [], attachments: [], reactions: [] };
        },
        async put(chemin) {
            const m = /\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/.exec(chemin);
            if (m) reactions.push({ messageId: m[1], emoji: decodeURIComponent(m[2]) });
            return null;
        },
        async delete(chemin) {
            const m = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(chemin);
            if (m) suppressions.push({ canalId: m[1], messageId: m[2] });
            return null;
        },
        // Lecture d'un membre : la doublure répond comme le ferait l'API, pour
        // que `choisirMembre` puisse vérifier qu'une personne est bien sur le
        // serveur avant de la rendre.
        async get(chemin) {
            const m = /^\/guilds\/([^/]+)\/members\/([^/]+)$/.exec(chemin);
            if (m) return { user: { id: m[2], username: `u${m[2].slice(0, 3)}` }, roles: [], guild_id: m[1] };
            return null;
        },
    };

    client.envois = envois;
    client.reactions = reactions;
    client.suppressions = suppressions;
    return client;
}

function faireAdaptateur(options) {
    const client = faireClient(options);
    const adaptateur = creerAdaptateurFluxer({ client, env: { FLUXER_TOKEN: 'factice' } });
    client.emit('clientReady');
    return { adaptateur, client };
}

/** Source d'un contexte de commande, telle que le parseur la produit. */
const source = (membre = { user: { id: AUTEUR, username: 'ada' }, roles: [], guild_id: GUILDE }) => ({
    guildeId: GUILDE, canalId: SALON, messageId: 'origine', creeLe: Date.now(),
    auteur: { id: AUTEUR, username: 'ada', global_name: 'Ada' },
    membre,
});

function contexte(adaptateur, membre) {
    const { creerContexteCommande } = require('../bot/platform/fluxer/context');
    return creerContexteCommande(source(membre), {
        adaptateur,
        descripteur: { nom: 'temoin', description: 'd', accesParDefaut: true, options: [] },
        valeurs: {},
    });
}

/** Injecte un MESSAGE_CREATE dans la boucle de distribution. */
function envoyerMessage(client, contenu, { auteurId = AUTEUR, canalId = SALON } = {}) {
    client.emit('dispatch', 'MESSAGE_CREATE', {
        id: `in${Math.random()}`, channel_id: canalId, guild_id: GUILDE, type: 0,
        content: contenu, author: { id: auteurId, username: 'ada' },
        member: { roles: [], guild_id: GUILDE }, attachments: [], embeds: [], mentions: [],
    });
}

/** Injecte un MESSAGE_REACTION_ADD. */
function reagir(client, { messageId, emoji, utilisateurId = AUTEUR, roles = [] }) {
    client.emit('dispatch', 'MESSAGE_REACTION_ADD', {
        user_id: utilisateurId, channel_id: SALON, message_id: messageId, guild_id: GUILDE,
        emoji: typeof emoji === 'string' ? { name: emoji } : emoji,
        member: { roles, guild_id: GUILDE, user: { id: utilisateurId, username: 'x' } },
    });
}

const tick = () => new Promise(r => setImmediate(r));

// ⚠️ Tous les minuteurs de l'adaptateur sont `unref()` — expiration d'un
// dialogue, auto-suppression d'un message éphémère. C'est délibéré : en
// production la passerelle tient la boucle d'événements ouverte, et un `prompt`
// de cinq minutes ne doit pas retarder un arrêt propre. En test il n'y a pas de
// passerelle : sans cette garde, Node conclurait que plus rien ne peut arriver
// et déclarerait « still pending » toute attente d'expiration.
const garde = setInterval(() => {}, 5);
test.after(() => clearInterval(garde));

// ─── Repli des réponses éphémères (DA §6.3) ──────────────────────────────────

test('repondre sans éphémère poste simplement dans le salon', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await contexte(adaptateur).repondre('bonjour');
    assert.equal(client.envois.length, 1);
    assert.equal(client.envois[0].canal, SALON);
    assert.equal(client.envois[0].corps.content, 'bonjour');
    assert.equal(client.suppressions.length, 0);
});

test('éphémère NON sensible : dans le salon, puis auto-supprimé', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await contexte(adaptateur).repondre('un instant', { ephemere: true });

    assert.equal(client.envois.length, 1, 'le message part dans le salon');
    assert.equal(client.envois[0].canal, SALON);
    assert.equal(client.suppressions.length, 0, 'la suppression est DIFFÉRÉE, pas immédiate');
});

test('éphémère SENSIBLE : message privé, et accusé neutre dans le salon', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await contexte(adaptateur).repondre(
        embed({ titre: 'Vos données', description: 'contenu personnel' }),
        { ephemere: true, sensible: true },
    );

    // Le contenu part en privé...
    const prive = client.envois.find(e => e.canal === `mp-${AUTEUR}`);
    assert.ok(prive, 'le contenu sensible doit partir en message privé');
    assert.equal(prive.corps.embeds[0].title, 'Vos données');

    // ...et le salon ne reçoit qu'un accusé, sans le contenu.
    const salon = client.envois.find(e => e.canal === SALON);
    assert.ok(salon, 'un accusé de réception est posté dans le salon');
    assert.match(salon.corps.content, /message privé/);
    assert.ok(!JSON.stringify(salon.corps).includes('contenu personnel'),
        'le contenu sensible ne doit JAMAIS transiter par le salon');
});

test('repondreEnPrive ouvre le salon privé et y écrit', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await contexte(adaptateur).repondreEnPrive('export');
    assert.equal(client.envois[0].canal, `mp-${AUTEUR}`);
});

test('differer ne lève jamais, même si l\'indicateur est refusé', async () => {
    const { adaptateur, client } = faireAdaptateur();
    client.rest.post = async () => { throw new Error('refusé'); };
    await assert.doesNotReject(() => contexte(adaptateur).differer());
});

// ─── ctx.prompt — dialogue séquentiel ────────────────────────────────────────

test('prompt — séquence complète, une question par champ, retour { cle: valeur }', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const ctx = contexte(adaptateur);

    const promesse = ctx.prompt([
        { cle: 'sujet', libelle: 'Sujet du ticket', max: 100, requis: true },
        { cle: 'details', libelle: 'Décrivez votre demande', max: 1000, style: 'paragraphe' },
    ], { titre: 'Ouverture de ticket' });

    await tick();
    assert.match(client.envois[0].corps.content, /Sujet du ticket/);
    assert.match(client.envois[0].corps.content, /1\/2/, 'la progression est affichée');
    envoyerMessage(client, 'Problème de connexion');

    await tick();
    assert.match(client.envois[1].corps.content, /Décrivez votre demande/);
    envoyerMessage(client, 'Depuis ce matin.');

    assert.deepEqual(await promesse, { sujet: 'Problème de connexion', details: 'Depuis ce matin.' });
});

test('prompt — « annuler » interrompt et rend null', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).prompt([{ cle: 'x', libelle: 'X', requis: true }]);
    await tick();
    envoyerMessage(client, 'Annuler');
    assert.equal(await promesse, null);
});

test('prompt — expiration rend null sans rien laisser traîner', async () => {
    const { adaptateur } = faireAdaptateur();
    // Délai nul : la première lecture d'échéance suffit à expirer.
    assert.equal(await contexte(adaptateur).prompt([{ cle: 'x', libelle: 'X' }], { delai: 0.02 }), null);
});

test('prompt — la longueur est validée À CHAQUE ÉTAPE, et la question reposée', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).prompt([{ cle: 'court', libelle: 'Court', max: 5, requis: true }]);

    await tick();
    envoyerMessage(client, 'beaucoup trop long');
    await tick();
    assert.match(
        client.envois.at(-2).corps.content, /5 caractères maximum/,
        'le dépassement est signalé',
    );
    assert.match(client.envois.at(-1).corps.content, /Court/, 'et la question est reposée');

    envoyerMessage(client, 'ok');
    assert.deepEqual(await promesse, { court: 'ok' });
});

test('prompt — un champ facultatif se passe avec « - »', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).prompt([{ cle: 'note', libelle: 'Note' }]);
    await tick();
    envoyerMessage(client, '-');
    assert.deepEqual(await promesse, { note: '' });
});

test('prompt — sensible : le dialogue bascule en message privé', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).prompt(
        [{ cle: 'motif', libelle: 'Motif du signalement', requis: true }],
        { sensible: true },
    );
    await tick();
    const question = client.envois.find(e => /Motif du signalement/.test(e.corps?.content || ''));
    assert.equal(question.canal, `mp-${AUTEUR}`, 'la question sensible est posée en privé');

    // Et la réponse est attendue DANS le salon privé, pas dans le salon public.
    envoyerMessage(client, 'ignoré', { canalId: SALON });
    await tick();
    envoyerMessage(client, 'harcèlement', { canalId: `mp-${AUTEUR}` });
    assert.deepEqual(await promesse, { motif: 'harcèlement' });
});

test('prompt — le bot ne se répond pas à lui-même', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).prompt([{ cle: 'x', libelle: 'X', requis: true }]);
    await tick();
    // C'est le cas réel : le bot vient de poser la question, et la passerelle la
    // lui renvoie en MESSAGE_CREATE.
    envoyerMessage(client, 'question du bot', { auteurId: BOT });
    await tick();
    envoyerMessage(client, 'la vraie réponse');
    assert.deepEqual(await promesse, { x: 'la vraie réponse' },
        'seul le message de la personne doit résoudre le dialogue');
});

// ─── ctx.choose — réactions emoji ────────────────────────────────────────────

test('choose — réactions posées dans l\'ordre, libellés en ligne dans l\'embed', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choose(
        embed({ titre: 'Panneau de ticket', description: 'Choisissez une action.' }),
        [
            { cle: 'ouvrir', libelle: 'Ouvrir un ticket', emoji: '🎫', style: 'primaire' },
            { cle: 'fermer', libelle: 'Fermer ce ticket', emoji: '🔒', style: 'danger' },
        ],
    );
    await tick();

    const panneau = client.envois[0];
    assert.equal(panneau.corps.embeds[0].title, 'Panneau de ticket');
    assert.match(panneau.corps.embeds[0].description, /Choisissez une action\./);
    assert.match(panneau.corps.embeds[0].description, /🎫 \*\*Ouvrir un ticket\*\*/);
    assert.match(panneau.corps.embeds[0].description, /🔒 \*\*Fermer ce ticket\*\*/);

    assert.deepEqual(client.reactions.map(r => r.emoji), ['🎫', '🔒'], 'dans l\'ordre déclaré');

    reagir(client, { messageId: panneau.id, emoji: '🔒' });
    assert.equal(await promesse, 'fermer');
});

test('choose — le bot IGNORE ses propres réactions', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choose('Panneau', [
        { cle: 'a', libelle: 'A', emoji: '✅' },
    ], { delai: 0.05 });
    await tick();

    // C'est exactement ce qui arrive en vrai : le bot vient de poser l'emoji, et
    // la passerelle lui renvoie sa propre réaction.
    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: BOT });
    assert.equal(await promesse, null, 'le panneau se serait déclenché tout seul');
});

test('choose — « autorise » par défaut : seul l\'auteur agit', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], { delai: 2 });
    await tick();

    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: AUTRE });
    await tick();
    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: AUTEUR });
    assert.equal(await promesse, 'a');
});

test('choose — « autorise: staff » exige MANAGE_GUILD', async () => {
    const STAFF = '770000000000000000';
    const { adaptateur, client } = faireAdaptateur({
        // 1<<5 = MANAGE_GUILD (http-api/permissions.mdx)
        roles: [{ id: STAFF, name: 'Staff', position: 3, permissions: String(1n << 5n) }],
    });
    const promesse = contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], {
        autorise: 'staff', delai: 2,
    });
    await tick();

    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: AUTRE, roles: [] });
    await tick();
    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: AUTRE, roles: [STAFF] });
    assert.equal(await promesse, 'a');
});

test('choose — « autorise: tous » laisse n\'importe qui agir', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], {
        autorise: 'tous', delai: 2,
    });
    await tick();
    reagir(client, { messageId: client.envois[0].id, emoji: '✅', utilisateurId: AUTRE });
    assert.equal(await promesse, 'a');
});

test('choose — une règle « autorise » invalide échoue AVANT tout envoi', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await assert.rejects(
        () => contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], { autorise: 'stafff' }),
        /n'est ni un mode connu/,
    );
    assert.equal(client.envois.length, 0, 'rien ne doit avoir été posté');
});

test('choose — une « suite » inconnue est refusée, même si l\'option est inerte ici', async () => {
    const { adaptateur } = faireAdaptateur();
    await assert.rejects(
        () => contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], { suite: 'saise' }),
        /suite.*inconnue/,
    );
});

test('choose — un choix sans emoji est refusé, avec la raison', async () => {
    const { adaptateur } = faireAdaptateur();
    await assert.rejects(
        () => contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A' }]),
        /n'a pas d'emoji/,
    );
});

test('choose — expiration rend null', async () => {
    const { adaptateur } = faireAdaptateur();
    assert.equal(
        await contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], { delai: 0.02 }),
        null,
    );
});

// ─── Panneaux persistants ────────────────────────────────────────────────────

test('choose persistant — écrit sa ligne en base et rend ses coordonnées', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const resultat = await contexte(adaptateur).choose(
        embed({ titre: 'Tickets' }),
        [{ cle: 'ouvrir', libelle: 'Ouvrir', emoji: '🎫' }],
        { persistant: true, panneau: 'ticket-test' },
    );

    assert.equal(resultat.persistant, true);
    assert.equal(resultat.canalId, SALON);
    assert.ok(resultat.messageId);

    const ligne = getDb().prepare(
        'SELECT * FROM interaction_panels WHERE channel_id = ? AND message_id = ?'
    ).get(SALON, resultat.messageId);
    assert.ok(ligne, 'la ligne interaction_panels est indispensable : sans elle, le panneau meurt au redémarrage');
    assert.equal(ligne.kind, 'ticket-test');
    assert.deepEqual(JSON.parse(ligne.payload), [{ cle: 'ouvrir', emoji: '🎫', libelle: 'Ouvrir' }]);
    assert.equal(ligne.guild_id, GUILDE);
});

test('la réaction d\'un TIERS sur un panneau enregistré est routée, avec un ctx complet', async () => {
    const { adaptateur, client } = faireAdaptateur();

    const recu = [];
    adaptateur.surPanneau('panneau-route', async (ctx, cle) => {
        recu.push({
            cle,
            plateforme: ctx.plateforme,
            auteur: ctx.auteur?.id,
            nomPanneau: ctx.panneau.nom,
            // Le contexte doit être COMPLET : un handler de panneau ouvre
            // souvent un formulaire dans la foulée.
            aPrompt: typeof ctx.prompt === 'function',
            aChoose: typeof ctx.choose === 'function',
            aApi: Boolean(ctx.api),
        });
    }, '/test');

    const pose = await contexte(adaptateur).choose('Panneau', [
        { cle: 'valider', libelle: 'Valider', emoji: '✅' },
        { cle: 'refuser', libelle: 'Refuser', emoji: '❌' },
    ], { persistant: true, panneau: 'panneau-route' });

    // Un tiers réagit, bien après la pose : c'est le cas du panneau qui survit
    // à un redémarrage.
    reagir(client, { messageId: pose.messageId, emoji: '❌', utilisateurId: AUTRE });
    await tick();

    assert.equal(recu.length, 1, 'la réaction doit être routée vers le handler du panneau');
    assert.deepEqual(recu[0], {
        cle: 'refuser', plateforme: 'fluxer', auteur: AUTRE, nomPanneau: 'panneau-route',
        aPrompt: true, aChoose: true, aApi: true,
    });
});

test('un emoji hors du panneau n\'est routé nulle part', async () => {
    const { adaptateur, client } = faireAdaptateur();
    let appele = 0;
    adaptateur.surPanneau('panneau-strict', async () => { appele += 1; });
    const pose = await contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], {
        persistant: true, panneau: 'panneau-strict',
    });

    reagir(client, { messageId: pose.messageId, emoji: '🍕', utilisateurId: AUTRE });
    await tick();
    assert.equal(appele, 0);
});

test('le bot ne déclenche pas le panneau qu\'il vient de poser', async () => {
    const { adaptateur, client } = faireAdaptateur();
    let appele = 0;
    adaptateur.surPanneau('panneau-bot', async () => { appele += 1; });
    const pose = await contexte(adaptateur).choose('P', [{ cle: 'a', libelle: 'A', emoji: '✅' }], {
        persistant: true, panneau: 'panneau-bot',
    });

    reagir(client, { messageId: pose.messageId, emoji: '✅', utilisateurId: BOT });
    await tick();
    assert.equal(appele, 0, 'le piège n°1 des panneaux');
});

test('reposer un panneau sur le même message REMPLACE ses choix', async () => {
    const { adaptateur } = faireAdaptateur();
    adaptateur.enregistrerPanneauPersistant({
        guildeId: GUILDE, canalId: SALON, messageId: 'fixe', panneau: 'v1',
        choix: [{ cle: 'a', emoji: '✅', libelle: 'A' }],
    });
    adaptateur.enregistrerPanneauPersistant({
        guildeId: GUILDE, canalId: SALON, messageId: 'fixe', panneau: 'v2',
        choix: [{ cle: 'b', emoji: '❌', libelle: 'B' }],
    });
    const ligne = getDb().prepare(
        'SELECT * FROM interaction_panels WHERE channel_id = ? AND message_id = ?'
    ).get(SALON, 'fixe');
    assert.equal(ligne.kind, 'v2');
    assert.deepEqual(JSON.parse(ligne.payload), [{ cle: 'b', emoji: '❌', libelle: 'B' }]);
});

test('poserPanneau porte les mentions DANS le message du panneau', async () => {
    // Un corps composé : sans lui, les mentions partent dans un second message
    // — et celles d'un embed ne notifient personne.
    const { adaptateur, client } = faireAdaptateur();
    await contexte(adaptateur).poserPanneau(SALON, {
        contenu: '<@&770000000000000000>',
        embeds: [embed({ titre: 'Nouveau ticket' })],
    }, [{ cle: 'fermer', libelle: 'Fermer', emoji: '🔒' }], { panneau: 'ticket-mentions' });

    const envoi = client.envois[0];
    assert.equal(envoi.corps.content, '<@&770000000000000000>');
    assert.match(envoi.corps.embeds[0].description, /🔒 \*\*Fermer\*\*/, 'la légende va sur l\'embed');
});

test('api.modifierPanneau repose la légende et retire les réactions désactivées', async () => {
    const { adaptateur, client } = faireAdaptateur();
    // Le message existant porte déjà les deux réactions du panneau.
    client.rest.patch = async (chemin, options) => {
        const [, canal, message] = /\/channels\/([^/]+)\/messages\/([^/]+)/.exec(chemin);
        client.envois.push({ canal, messageId: message, corps: options.body, modification: true });
        return {
            id: message, channel_id: canal, guild_id: GUILDE, type: 0,
            author: { id: BOT, bot: true }, embeds: options.body?.embeds || [], attachments: [],
            reactions: [
                { emoji: { name: '✅' }, count: 2 },
                { emoji: { name: '❌' }, count: 1 },
            ],
        };
    };
    const retires = [];
    client.rest.delete = async (chemin) => {
        const m = /\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(chemin);
        if (m) retires.push(decodeURIComponent(m[2]));
        return null;
    };

    await adaptateur.api.modifierPanneau(SALON, 'fixe', embed({ titre: 'Tranché' }), [
        { cle: 'valider', libelle: 'Valider', emoji: '✅' },
        { cle: 'refuser', libelle: 'Refuser', emoji: '❌', desactive: true },
    ], { panneau: 'arbitrage' });

    const reecrit = client.envois.at(-1);
    assert.match(reecrit.corps.embeds[0].description, /✅ \*\*Valider\*\*/);
    assert.match(reecrit.corps.embeds[0].description, /~~Refuser~~/, 'le choix grisé reste LISIBLE');
    assert.deepEqual(retires, ['❌'], 'et sa réaction est retirée : un choix grisé ne doit plus être cliquable');
});

test('api.modifierPanneau exige un nom de panneau valide', async () => {
    const { adaptateur } = faireAdaptateur();
    await assert.rejects(
        () => adaptateur.api.modifierPanneau(SALON, 'x', 'c', [], { panneau: 'a:b' }),
        /nom de panneau invalide/,
    );
});

// ─── ctx.choisirMembre ───────────────────────────────────────────────────────

test('choisirMembre — résolu par mention', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choisirMembre('Qui autoriser ?');
    await tick();
    assert.match(client.envois[0].corps.content, /Mentionnez la personne/);

    envoyerMessage(client, `<@${AUTRE}>`);
    const choisi = await promesse;
    assert.equal(choisi.id, AUTRE);
    assert.equal(choisi.mention, `<@${AUTRE}>`);
});

test('choisirMembre — résolu par identifiant brut', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choisirMembre('Qui ?');
    await tick();
    envoyerMessage(client, AUTRE);
    assert.equal((await promesse).id, AUTRE);
});

test('choisirMembre — parmi: salonVocal refuse quelqu\'un hors du salon', async () => {
    const VOCAL = '700000000000000000';
    const { adaptateur, client } = faireAdaptateur();
    client.etat.poserCanal({ id: VOCAL, name: 'Vocal', type: 2, guild_id: GUILDE });
    client.etat.poserEtatVocal({
        guild_id: GUILDE, user_id: AUTRE, channel_id: VOCAL,
        member: { user: { id: AUTRE, username: 'bob' }, roles: [], guild_id: GUILDE },
    });

    const promesse = contexte(adaptateur).choisirMembre('Qui expulser ?', {
        parmi: 'salonVocal', canalId: VOCAL, delai: 5,
    });
    await tick();
    assert.match(client.envois[0].corps.content, /Personnes présentes/);

    // Quelqu'un qui n'est pas dans le salon : refusé, et la question reste ouverte.
    envoyerMessage(client, '<@111111111>');
    await tick();
    assert.match(client.envois.at(-1).corps.content, /pas dans le salon vocal/);

    envoyerMessage(client, `<@${AUTRE}>`);
    const choisi = await promesse;
    assert.equal(choisi.id, AUTRE);
    assert.equal(choisi.nom, 'bob', 'le nom vient de l\'état vocal, sans appel REST');
});

test('choisirMembre — salon vocal vide rend null sans rien demander', async () => {
    const VIDE = '710000000000000000';
    const { adaptateur, client } = faireAdaptateur();
    client.etat.poserCanal({ id: VIDE, name: 'Vide', type: 2, guild_id: GUILDE });
    assert.equal(
        await contexte(adaptateur).choisirMembre('Qui ?', { parmi: 'salonVocal', canalId: VIDE }),
        null,
    );
    assert.equal(client.envois.length, 0, 'aucune question posée : il n\'y a personne à désigner');
});

test('choisirMembre — un périmètre inconnu échoue AVANT tout envoi', async () => {
    const { adaptateur, client } = faireAdaptateur();
    await assert.rejects(
        () => contexte(adaptateur).choisirMembre('Qui ?', { parmi: 'salonVocaux' }),
        /parmi.*inconnu/,
    );
    assert.equal(client.envois.length, 0);
});

test('choisirMembre — « annuler » rend null', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const promesse = contexte(adaptateur).choisirMembre('Qui ?');
    await tick();
    envoyerMessage(client, 'annuler');
    assert.equal(await promesse, null);
});

// ─── Contexte : permissions calculées ────────────────────────────────────────

test('le membre porte des permissions CALCULÉES depuis les rôles du serveur', () => {
    const MODO = '780000000000000000';
    const { adaptateur } = faireAdaptateur({
        // 1<<40 = MODERATE_MEMBERS (http-api/permissions.mdx)
        roles: [{ id: MODO, name: 'Modo', position: 2, permissions: String(1n << 40n) }],
        proprietaireId: 'quelqun-dautre',
    });

    const sans = contexte(adaptateur, { user: { id: AUTEUR }, roles: [], guild_id: GUILDE });
    assert.equal(sans.membre.aPermission('MODERATE_MEMBERS'), false);
    assert.equal(sans.membre.estAdmin, false);

    const avec = contexte(adaptateur, { user: { id: AUTEUR }, roles: [MODO], guild_id: GUILDE });
    assert.equal(avec.membre.aPermission('MODERATE_MEMBERS'), true);
    assert.equal(avec.membre.estAdmin, false, 'une permission n\'en fait pas un administrateur');
});

test('le propriétaire du serveur détient tout, sans porter aucun rôle', () => {
    const { adaptateur } = faireAdaptateur({ proprietaireId: AUTEUR });
    const ctx = contexte(adaptateur, { user: { id: AUTEUR }, roles: [], guild_id: GUILDE });
    assert.equal(ctx.membre.estAdmin, true, '« The guild owner receives the complete 64-bit mask »');
    assert.equal(ctx.proprietaireId, AUTEUR);
});

test('ADMINISTRATOR emporte toutes les autres permissions', () => {
    const ADMIN = '790000000000000000';
    const { adaptateur } = faireAdaptateur({
        roles: [{ id: ADMIN, name: 'Admin', position: 5, permissions: String(1n << 3n) }],
        proprietaireId: 'quelqun-dautre',
    });
    const ctx = contexte(adaptateur, { user: { id: AUTEUR }, roles: [ADMIN], guild_id: GUILDE });
    assert.equal(ctx.membre.estAdmin, true);
    assert.equal(ctx.membre.aPermission('BAN_MEMBERS'), true, 'sans que le bit soit posé');
});

test('le contexte porte la guilde, le salon et la latence de passerelle', () => {
    const { adaptateur } = faireAdaptateur();
    const ctx = contexte(adaptateur);
    assert.equal(ctx.guildeId, GUILDE);
    assert.equal(ctx.canalId, SALON);
    assert.equal(ctx.guilde.nom, 'Venacity');
    assert.equal(ctx.latencePasserelle, 42);
    assert.equal(ctx.plateforme, 'fluxer');
});

test('ctx.deployerCommandeServeur est inerte et rend true', async () => {
    const { adaptateur } = faireAdaptateur();
    const ctx = contexte(adaptateur);
    assert.equal(await ctx.deployerCommandeServeur({ nom: 'faq', description: 'd' }), true);
    assert.equal(await ctx.retirerCommandeServeur('faq'), true);
});

// ─── Ce qu'un dialogue en cours consomme, et ce qu'il laisse passer ──────────

test('une réponse de dialogue n\'est PAS relue comme une commande', async () => {
    const { adaptateur, client } = faireAdaptateur();
    // Une commande est indexée : sans la consommation, « !help » tapé en réponse
    // à un formulaire partirait au parseur.
    await adaptateur.enregistrerCommandes([{
        nom: 'help',
        descripteur: { nom: 'help', description: 'd', accesParDefaut: true, options: [], executer() { throw new Error('exécutée à tort'); } },
        execute() { throw new Error('exécutée à tort'); },
    }]);

    const promesse = contexte(adaptateur).prompt([{ cle: 'sujet', libelle: 'Sujet', requis: true }]);
    await tick();
    envoyerMessage(client, '!help');
    assert.deepEqual(await promesse, { sujet: '!help' }, 'la saisie est prise telle quelle');
});

test('une réponse de dialogue reste VISIBLE des handlers métier', async () => {
    // C'est le pendant du test précédent, et il compte autant : le salon piège
    // et l'anti-raid ne doivent pas cesser de voir les messages d'une personne
    // en train de remplir un formulaire.
    const { adaptateur, client } = faireAdaptateur();
    const vus = [];
    adaptateur.surEvenement('messageCree', async (ctx, message) => { vus.push(message.contenu); });

    const promesse = contexte(adaptateur).prompt([{ cle: 'sujet', libelle: 'Sujet', requis: true }]);
    await tick();
    envoyerMessage(client, 'ma réponse');
    await promesse;
    await tick();

    assert.ok(vus.includes('ma réponse'), 'la modération doit continuer de voir chaque message');
});
