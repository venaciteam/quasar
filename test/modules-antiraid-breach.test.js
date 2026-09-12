// Lot 5b du chantier multiplateforme : anti-raid, mode panique et notification
// de violation.
//
// Ce que ce fichier doit tenir, dans cet ordre d'importance :
//
//  1. AUCUNE RÉGRESSION CÔTÉ DISCORD. Les quatre embeds de ces modules sont
//     désormais construits par `embed()` (bot/platform/embed.js) au lieu d'un
//     `EmbedBuilder`. Les captures ci-dessous ont été relevées sur la version
//     d'avant le lot (`git show dev:<fichier>`) : titre, couleur, ordre et
//     contenu des champs doivent être identiques, champ par champ.
//
//     ⚠️ UNE seule différence est admise, et elle est vérifiée explicitement :
//     `rendreEmbed` pose `inline: Boolean(champ.enLigne)` sur TOUS les champs,
//     donc `inline: false` apparaît là où l'implémentation d'origine n'écrivait
//     aucune clé `inline`. Discord rend les deux formes à l'identique — un champ
//     sans `inline` est un champ non alignés. Aucun champ n'est ajouté, aucun ne
//     disparaît.
//
//  2. `breach/notify.js` est BI-FORMAT : son unique appelant
//     (`bot/modules/breach/index.js`) n'appartient au périmètre d'aucun lot et
//     continue de passer un `Client` discord.js, pendant que la voie neutre
//     passe intégralement par le client REST normalisé.
//
//  3. LE REPLI SALON NE FUIT RIEN. Le pointeur posté dans le salon de logs ne
//     doit contenir ni le corps de la notification, ni le titre de l'incident
//     (art. 33/34 : le contenu sensible reste en message privé).
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getDb } = require('../api/services/database');
const { estEmbed } = require('../bot/platform/embed');
const { versEmbedDiscord } = require('../bot/utils/errors');

const notify = require('../bot/modules/breach/notify');
const { handleMemberJoin, invalidateConfig } = require('../bot/modules/antiraid');
const { liftPanic } = require('../bot/modules/antiraid/panic');
const { forget } = require('../bot/modules/antiraid/window');

const GUILDE = '111111111111111111';
const SALON_LOG = '999999999999999999';
const DESTINATAIRE = '333333333333333333';
const BOT = '222222222222222222';

const nowSec = () => Math.floor(Date.now() / 1000);

// ── Amorçage ─────────────────────────────────────────────────────────────────

const db = getDb();
db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Serveur de test');
db.prepare(`
    INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
    ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
`).run(GUILDE, JSON.stringify({ logChannel: SALON_LOG }));

/** Écrit la configuration anti-raid du serveur et vide le cache de 15 s. */
function configurerAntiraid(patch = {}) {
    const valeurs = {
        enabled: 1,
        join_count: 2,
        join_window_seconds: 10,
        min_account_age_hours: 0,
        punishments: '',            // alerte seule : aucune sanction réelle en test
        panic_duration_seconds: 0,  // mode panique désactivé
        log_channel: SALON_LOG,
        ...patch,
    };
    db.prepare(`
        INSERT INTO antiraid_config
            (guild_id, enabled, join_count, join_window_seconds, min_account_age_hours,
             punishments, panic_duration_seconds, log_channel)
        VALUES (@guild_id, @enabled, @join_count, @join_window_seconds, @min_account_age_hours,
                @punishments, @panic_duration_seconds, @log_channel)
        ON CONFLICT(guild_id) DO UPDATE SET
            enabled = excluded.enabled, join_count = excluded.join_count,
            join_window_seconds = excluded.join_window_seconds,
            min_account_age_hours = excluded.min_account_age_hours,
            punishments = excluded.punishments,
            panic_duration_seconds = excluded.panic_duration_seconds,
            log_channel = excluded.log_channel
    `).run({ guild_id: GUILDE, ...valeurs });
    invalidateConfig();
    forget();
}

// ── Doublures ────────────────────────────────────────────────────────────────

/**
 * Guilde discord.js réduite à ce que l'anti-raid et le mode panique en lisent.
 * `envois` collecte tout ce qui part vers le salon de logs.
 */
function faireGuilde({ memberCount = 42 } = {}) {
    const envois = [];
    // `send` doit rendre une valeur VRAIE : `sendAutomodLog` retombe sur le
    // modlog global quand l'envoi au salon dédié ne rend rien, et le message
    // partirait alors deux fois.
    const salon = { send: async (payload) => { envois.push(payload); return { id: 'log1' }; } };
    const guilde = {
        id: GUILDE,
        memberCount,
        channels: { cache: new Map([[SALON_LOG, salon]]) },
        client: { user: { id: BOT } },
        setIncidentActions: async () => {},
        disableInvites: async () => {},
    };
    return { guilde, envois };
}

/** Membre discord.js, tel que `guildMemberAdd` le fournit encore aujourd'hui. */
function faireMembre(guilde, id, { creeLe = Date.now() - 365 * 24 * 3600 * 1000 } = {}) {
    return { id, guild: guilde, user: { id, bot: false, createdTimestamp: creeLe } };
}

/** Client REST normalisé, réduit aux méthodes que `notify.js` emprunte. */
function faireApi({ guilde = { id: GUILDE, nom: 'Serveur de test' }, canal = { id: SALON_LOG } } = {}) {
    const appels = [];
    return {
        appels,
        async ouvrirMessagePrive(utilisateurId) { appels.push(['ouvrirMessagePrive', utilisateurId]); return 'mp-42'; },
        async envoyerMessage(canalId, contenu) { appels.push(['envoyerMessage', canalId, contenu]); return { id: 'm1' }; },
        async obtenirGuilde(id) { appels.push(['obtenirGuilde', id]); return guilde; },
        async obtenirCanal(id) { appels.push(['obtenirCanal', id]); return canal; },
    };
}

function fairePortee(options) {
    const api = faireApi(options);
    return { portee: { guildeId: GUILDE, api, moi: { id: BOT } }, api };
}

/** Client discord.js réduit à ce que `notify.js` emprunte sur la voie historique. */
function faireClient({ peutEcrire = true, salonPresent = true } = {}) {
    const mps = [];
    const salonEnvois = [];
    const salon = {
        send: async (payload) => { salonEnvois.push(payload); return { id: 'log1' }; },
        permissionsFor: () => ({ has: (nom) => peutEcrire && ['ViewChannel', 'SendMessages'].includes(nom) }),
    };
    const guilde = {
        id: GUILDE,
        members: { me: { id: BOT } },
        channels: { cache: salonPresent ? new Map([[SALON_LOG, salon]]) : new Map() },
    };
    return {
        client: {
            guilds: { cache: new Map([[GUILDE, guilde]]) },
            users: { fetch: async () => ({ send: async (payload) => { mps.push(payload); } }) },
        },
        mps,
        salonEnvois,
    };
}

/**
 * Corps d'embed TEL QU'IL PART SUR LE RÉSEAU. L'aller-retour JSON n'est pas
 * cosmétique : `setAuthor({ nom })` laisse `icon_url: undefined` et
 * `url: undefined` dans l'objet du builder, deux clés que `JSON.stringify`
 * écarte avant l'émission. Les comparer ferait échouer une capture pourtant
 * identique à l'octet près côté Discord.
 */
function corpsEnvoye(embedOuBuilder) {
    const builder = typeof embedOuBuilder?.toJSON === 'function'
        ? embedOuBuilder
        : versEmbedDiscord(embedOuBuilder);
    return JSON.parse(JSON.stringify(builder.toJSON()));
}

// ═══ Anti-raid : alertes ════════════════════════════════════════════════════

test('anti-raid — l\'alerte de vague sort en embed neutre, champs identiques', async () => {
    configurerAntiraid();
    const { guilde, envois } = faireGuilde({ memberCount: 1337 });

    // Deux arrivées dans la fenêtre : le seuil est franchi au second membre.
    await handleMemberJoin(faireMembre(guilde, '444444444444444444'));
    const verdict = await handleMemberJoin(faireMembre(guilde, '555555555555555555'));

    assert.deepEqual(verdict, { removed: false }, 'alerte seule : personne n\'est retiré');
    assert.equal(envois.length, 1, 'une seule alerte par vague');

    const rendu = corpsEnvoye(envois[0].embeds[0]);
    assert.equal(rendu.title, '🚨 Vague d\'arrivées détectée');
    assert.equal(rendu.color, 0xe74c3c);
    assert.equal(typeof rendu.timestamp, 'string');
    assert.deepEqual(rendu.fields, [
        { name: 'Arrivées', value: '2 en moins de 10 s', inline: true },
        { name: 'Déclencheur', value: 'Anti-raid', inline: true },
        { name: 'Membres du serveur', value: '1337', inline: true },
        { name: 'Sanction', value: 'Aucune : ce serveur est réglé en alerte seule.', inline: false },
        { name: 'Mode panique', value: 'Désactivé sur ce serveur (durée réglée à 0).', inline: false },
    ]);
});

test('anti-raid — l\'alerte de compte trop récent sort en embed neutre', async () => {
    // Seuil de vague hors d'atteinte : c'est le contrôle d'âge qui doit parler.
    configurerAntiraid({ join_count: 50, min_account_age_hours: 48 });
    const { guilde, envois } = faireGuilde();

    const membre = faireMembre(guilde, '666666666666666666', { creeLe: Date.now() - 3 * 3600 * 1000 });
    const verdict = await handleMemberJoin(membre);

    assert.deepEqual(verdict, { removed: false });
    assert.equal(envois.length, 1);

    const rendu = corpsEnvoye(envois[0].embeds[0]);
    assert.equal(rendu.title, '⚠️ Compte trop récent');
    assert.equal(rendu.color, 0xf1c40f);
    assert.deepEqual(rendu.fields, [
        { name: 'Membre', value: '<@666666666666666666> (666666666666666666)', inline: true },
        { name: 'Déclencheur', value: 'Anti-raid', inline: true },
        { name: 'Âge du compte', value: '3 h (minimum exigé : 48 h)', inline: true },
        { name: 'Sanction', value: 'Aucune : ce serveur est réglé en alerte seule.', inline: false },
    ]);
});

test('anti-raid — le message de levée du mode panique sort en embed neutre', async () => {
    const { guilde, envois } = faireGuilde();
    db.prepare(`
        INSERT INTO antiraid_panic (guild_id, method, expires_at, previous_invites_disabled, reason)
        VALUES (?, 'incident_actions', ?, 0, 'test')
        ON CONFLICT(guild_id) DO UPDATE SET method = excluded.method, expires_at = excluded.expires_at
    `).run(GUILDE, nowSec() - 5);

    const resultat = await liftPanic(guilde, { liftedBy: '777777777777777777', logChannelId: SALON_LOG });

    assert.deepEqual(resultat, { ok: true });
    assert.equal(envois.length, 1);

    const rendu = corpsEnvoye(envois[0].embeds[0]);
    assert.equal(rendu.title, '✅ Mode panique levé');
    assert.equal(rendu.color, 0x2ecc71);
    assert.deepEqual(rendu.fields, [
        { name: 'Levée', value: 'Manuelle, par <@777777777777777777>', inline: true },
        { name: 'Invitations', value: 'Rouvertes.', inline: false },
    ]);
});

// ═══ Violation de données : embeds ══════════════════════════════════════════

test('violation — buildBreachEmbed rend un embed NEUTRE, identique à la capture', () => {
    const incident = { title: 'Fuite de jetons' };
    const message = { phase: 2, body: 'Corps de la notification', created_at: 1757000000 };

    const neutre = notify.buildBreachEmbed(incident, message);
    assert.equal(estEmbed(neutre), true, 'plus d\'EmbedBuilder : la construction est neutre');

    const rendu = corpsEnvoye(neutre);
    assert.equal(rendu.title, '⚠️ Notification de violation de données');
    assert.equal(rendu.color, notify.COLOR_BREACH);
    assert.equal(rendu.description, 'Corps de la notification');
    assert.deepEqual(rendu.author, { name: 'Incident : Fuite de jetons' });
    assert.deepEqual(rendu.footer, {
        text: `Point de contact : ${notify.CONTACT} — Venacity, sous-traitant (RGPD art. 28)`,
    });
    // L'horodatage est celui de la RÉDACTION du message, pas de l'envoi.
    assert.equal(rendu.timestamp, new Date(1757000000 * 1000).toISOString());
    assert.deepEqual(rendu.fields, [
        { name: 'Notification', value: 'Phase 2 — information complémentaire', inline: false },
    ]);
});

test('violation — sans titre d\'incident, aucun auteur n\'est posé', () => {
    const rendu = corpsEnvoye(notify.buildBreachEmbed(null, { phase: 1, body: 'x' }));
    assert.equal('author' in rendu, false);
    assert.deepEqual(rendu.fields, [
        { name: 'Notification', value: 'Phase 1 — notification initiale', inline: false },
    ]);
});

test('violation — le pointeur du repli salon ne contient AUCUN détail sensible', () => {
    const rendu = corpsEnvoye(notify.buildBreachPointerEmbed());
    const texte = JSON.stringify(rendu);

    assert.equal(rendu.title, '⚠️ Notification importante');
    assert.equal(rendu.fields, undefined, 'aucun champ : rien à y faire fuiter');
    assert.equal(texte.includes('Incident'), false);
    assert.match(rendu.description, /Consultez vos messages privés/);
});

// ═══ Violation de données : bi-format ═══════════════════════════════════════

test('violation — sendDM voie neutre : ouvrirMessagePrive puis envoyerMessage', async () => {
    const { portee, api } = fairePortee();
    const contenu = notify.buildBreachEmbed({ title: 'I' }, { phase: 1, body: 'b' });

    const res = await notify.sendDM(portee, DESTINATAIRE, contenu);

    assert.deepEqual(res, { ok: true, error: null });
    assert.deepEqual(api.appels.map(a => a[0]), ['ouvrirMessagePrive', 'envoyerMessage']);
    assert.equal(api.appels[0][1], DESTINATAIRE);
    assert.equal(api.appels[1][1], 'mp-42');
    // L'embed traverse le contrat SANS être rendu : c'est l'adaptateur qui rend.
    assert.equal(api.appels[1][2], contenu);
    assert.equal(estEmbed(api.appels[1][2]), true);
});

test('violation — sendDM voie historique : le Client discord.js reste servi', async () => {
    const { client, mps } = faireClient();
    const contenu = notify.buildBreachEmbed({ title: 'I' }, { phase: 1, body: 'b' });

    const res = await notify.sendDM(client, DESTINATAIRE, contenu);

    assert.deepEqual(res, { ok: true, error: null });
    assert.equal(mps.length, 1);
    // Rendu en EmbedBuilder par la couche de transition, comme avant le lot.
    assert.equal(typeof mps[0].embeds[0].toJSON, 'function');
    assert.equal(corpsEnvoye(mps[0].embeds[0]).title, '⚠️ Notification de violation de données');
});

test('violation — sendDM : un échec est tracé avec le code de la plateforme', async () => {
    const erreur = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    const client = { users: { fetch: async () => { throw erreur; } } };

    const res = await notify.sendDM(client, DESTINATAIRE, notify.buildBreachPointerEmbed());

    assert.equal(res.ok, false);
    assert.equal(res.error, '[50007] Cannot send messages to this user');
});

test('violation — repli salon voie neutre : le pointeur part dans le salon de logs', async () => {
    const { portee, api } = fairePortee();

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    assert.deepEqual(res, { ok: true, error: null });
    assert.deepEqual(api.appels.map(a => a[0]), ['obtenirGuilde', 'obtenirCanal', 'envoyerMessage']);
    assert.equal(api.appels[2][1], SALON_LOG);
    assert.equal(estEmbed(api.appels[2][2]), true);
    assert.equal(corpsEnvoye(api.appels[2][2]).fields, undefined);
});

test('violation — repli salon voie neutre : bot retiré du serveur, rien n\'est posté', async () => {
    const { portee, api } = fairePortee({ guilde: null });

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    assert.deepEqual(res, { ok: false, error: 'serveur introuvable dans le cache du bot' });
    assert.deepEqual(api.appels.map(a => a[0]), ['obtenirGuilde']);
});

test('violation — repli salon voie neutre : salon de logs disparu, rien n\'est posté', async () => {
    const { portee, api } = fairePortee({ canal: null });

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    assert.deepEqual(res, { ok: false, error: 'aucun salon de logs configure pour le repli' });
    assert.equal(api.appels.some(a => a[0] === 'envoyerMessage'), false);
});

test('violation — repli salon voie historique : le contrôle de permission tient toujours', async () => {
    const refus = faireClient({ peutEcrire: false });
    const res = await notify.sendToGuildChannel(refus.client, GUILDE);
    assert.deepEqual(res, { ok: false, error: 'aucun salon de logs configure pour le repli' });
    assert.equal(refus.salonEnvois.length, 0);

    const ok = faireClient();
    const res2 = await notify.sendToGuildChannel(ok.client, GUILDE);
    assert.deepEqual(res2, { ok: true, error: null });
    assert.equal(ok.salonEnvois.length, 1);
    assert.equal(corpsEnvoye(ok.salonEnvois[0].embeds[0]).title, '⚠️ Notification importante');
});

test('violation — truncate : borne respectée et troncature annoncée', () => {
    const court = 'a'.repeat(10);
    assert.equal(notify.truncate(court), court);

    const long = 'mot '.repeat(2000);
    const coupe = notify.truncate(long);
    assert.ok(coupe.length <= notify.MAX_DESCRIPTION);
    assert.match(coupe, /Message tronqué/);
});
