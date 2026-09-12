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
const { enterPanic, liftPanic, sweepExpiredPanics } = require('../bot/modules/antiraid/panic');
// Requis AVANT toute autre chose liée à l'AutoMod : le premier test de la
// section vérifie que `automodSync` n'est PAS encore en cache.
const evenementAutomod = require('../bot/events/autoModerationActionExecution');
const CHEMIN_AUTOMODSYNC = require.resolve('../bot/utils/automodSync');

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

/**
 * Client REST normalisé, réduit aux méthodes que ce lot emprunte. Chaque appel
 * est tracé : c'est la preuve que la voie neutre ne passe QUE par le contrat.
 */
function faireApi({
    guilde = { id: GUILDE, nom: 'Serveur de test' },
    canal = { id: SALON_LOG },
    permissions = { aPermission: () => true },
    membre = { id: BOT, aPermission: () => true },
    etatInvitations = { enPauseJusqua: null, desactiveesEnDur: false },
    guildes = [GUILDE],
    voie = 'incident',
    echecPause = null,
} = {}) {
    const appels = [];
    return {
        appels,
        async ouvrirMessagePrive(utilisateurId) { appels.push(['ouvrirMessagePrive', utilisateurId]); return 'mp-42'; },
        async envoyerMessage(canalId, contenu) { appels.push(['envoyerMessage', canalId, contenu]); return { id: 'm1' }; },
        async obtenirGuilde(id) { appels.push(['obtenirGuilde', id]); return guilde; },
        async obtenirCanal(id) { appels.push(['obtenirCanal', id]); return canal; },
        async obtenirMembre(g, m) { appels.push(['obtenirMembre', g, m]); return membre; },
        async permissionsSurCanal(c, m) { appels.push(['permissionsSurCanal', c, m]); return permissions; },
        async obtenirEtatInvitations(id) { appels.push(['obtenirEtatInvitations', id]); return etatInvitations; },
        async listerGuildes() { appels.push(['listerGuildes']); return guildes; },
        async mettreInvitationsEnPause(id, jusquA, raison) {
            appels.push(['mettreInvitationsEnPause', id, jusquA, raison]);
            if (echecPause) throw echecPause;
            return jusquA === null ? 'levee' : voie;
        },
    };
}

function fairePortee(options) {
    const api = faireApi(options);
    return { portee: { guildeId: GUILDE, api, moi: { id: BOT } }, api };
}

/**
 * Adaptateur de plateforme réduit à ce que le balayage du mode panique lit :
 * un `api`, une identité et un jeu de capacités. Pas de `guildeId` — un
 * adaptateur n'en désigne aucun, c'est la ligne en base qui le nomme.
 */
function faireAdaptateur(options = {}) {
    const api = faireApi(options);
    return {
        adaptateur: {
            nom: 'discord',
            capacites: { pauseInvitations: true, automod: true, ...(options.capacites || {}) },
            moi: { id: BOT },
            api,
        },
        api,
    };
}

/**
 * Portée d'écriture réduite à ce que `notify.js` emprunte, dans la forme que lui
 * passe désormais `bot/modules/breach/index.js` : l'ADAPTATEUR de plateforme.
 *
 * La voie historique — un `Client` discord.js, son cache de salons et
 * `permissionsFor` — a été retirée à la consolidation, en même temps que la
 * boucle est passée à l'adaptateur.
 */
function faireClient({ peutEcrire = true, salonPresent = true } = {}) {
    const mps = [];
    const salonEnvois = [];
    return {
        client: {
            moi: { id: BOT, nom: 'Quasar#0000' },
            api: {
                async ouvrirMessagePrive() { return 'dm-canal'; },
                async obtenirGuilde() { return { id: GUILDE, nom: 'Serveur de test' }; },
                async obtenirCanal(id) {
                    return salonPresent && id === SALON_LOG ? { id, nom: 'logs', type: 'texte' } : null;
                },
                async permissionsSurCanal() {
                    return { aPermission: (nom) => peutEcrire && ['VIEW_CHANNEL', 'SEND_MESSAGES'].includes(nom) };
                },
                async envoyerMessage(canalId, contenu) {
                    (canalId === 'dm-canal' ? mps : salonEnvois).push(contenu);
                    return { id: 'log1', canalId };
                },
            },
        },
        mps,
        salonEnvois,
    };
}

/**
 * Contexte d'événement neutre, tel que l'adaptateur le sert à un handler :
 * ni serveur, ni interlocuteur — un événement agit par `api`. `envois` collecte
 * ce que le handler poste, avec le salon visé.
 */
function faireCtx() {
    const envois = [];
    return {
        envois,
        ctx: {
            plateforme: 'discord',
            capacites: { automod: true },
            moi: { id: BOT },
            api: {
                async envoyerMessage(canalId, contenu) { envois.push({ canalId, contenu }); return { id: 'm1' }; },
            },
        },
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

// ═══ Mode panique ═══════════════════════════════════════════════════════════

function semerPanique({ method = 'incident_actions', echu = true, previous = 0 } = {}) {
    db.prepare(`
        INSERT INTO antiraid_panic (guild_id, method, expires_at, previous_invites_disabled, reason)
        VALUES (?, ?, ?, ?, 'test')
        ON CONFLICT(guild_id) DO UPDATE SET method = excluded.method,
            expires_at = excluded.expires_at, previous_invites_disabled = excluded.previous_invites_disabled
    `).run(GUILDE, method, nowSec() + (echu ? -5 : 600), previous);
}

const ligneDePanique = () => db.prepare('SELECT * FROM antiraid_panic WHERE guild_id = ?').get(GUILDE);
const oublierPanique = () => db.prepare('DELETE FROM antiraid_panic WHERE guild_id = ?').run(GUILDE);

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

test('violation — sendDM par l\'adaptateur : deux appels, un embed neutre', async () => {
    const { client, mps } = faireClient();
    const contenu = notify.buildBreachEmbed({ title: 'I' }, { phase: 1, body: 'b' });

    const res = await notify.sendDM(client, DESTINATAIRE, contenu);

    assert.deepEqual(res, { ok: true, error: null });
    assert.equal(mps.length, 1);
    // L'embed voyage NEUTRE jusqu'au client REST, qui le rend lui-même.
    assert.equal(estEmbed(mps[0]), true);
    assert.equal(mps[0].titre, '⚠️ Notification de violation de données');
});

test('violation — sendDM : un échec est tracé avec le code de la plateforme', async () => {
    const erreur = Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    const portee = {
        moi: { id: BOT },
        api: {
            async ouvrirMessagePrive() { throw erreur; },
            async envoyerMessage() { throw new Error('jamais atteint'); },
        },
    };

    const res = await notify.sendDM(portee, DESTINATAIRE, notify.buildBreachPointerEmbed());

    assert.equal(res.ok, false);
    assert.equal(res.error, '[50007] Cannot send messages to this user');
});

test('violation — sendDM : une cible non neutre est refusée, jamais envoyée à l\'aveugle', async () => {
    // Un `Client` discord.js n'est plus une portée d'écriture. On le refuse
    // explicitement plutôt que de laisser l'envoi partir dans le vide : la
    // traçabilité (art. 33.5) doit pouvoir dire QUI n'a pas reçu.
    const res = await notify.sendDM({ users: { fetch: async () => ({}) } }, DESTINATAIRE,
        notify.buildBreachPointerEmbed());
    assert.deepEqual(res, { ok: false, error: 'client ou destinataire indisponible' });
});

test('violation — repli salon voie neutre : le pointeur part dans le salon de logs', async () => {
    const { portee, api } = fairePortee();

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    assert.deepEqual(res, { ok: true, error: null });
    assert.deepEqual(api.appels.map(a => a[0]),
        ['obtenirGuilde', 'obtenirCanal', 'permissionsSurCanal', 'envoyerMessage']);
    const envoi = api.appels[3];
    assert.equal(envoi[1], SALON_LOG);
    assert.equal(estEmbed(envoi[2]), true);
    assert.equal(corpsEnvoye(envoi[2]).fields, undefined);
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

test('violation — repli salon par l\'adaptateur : le contrôle de permission tient toujours', async () => {
    const refus = faireClient({ peutEcrire: false });
    const res = await notify.sendToGuildChannel(refus.client, GUILDE);
    assert.deepEqual(res, { ok: false, error: 'aucun salon de logs configure pour le repli' });
    assert.equal(refus.salonEnvois.length, 0);

    const ok = faireClient();
    const res2 = await notify.sendToGuildChannel(ok.client, GUILDE);
    assert.deepEqual(res2, { ok: true, error: null });
    assert.equal(ok.salonEnvois.length, 1);
    assert.equal(ok.salonEnvois[0].titre, '⚠️ Notification importante');
});

test('violation — truncate : borne respectée et troncature annoncée', () => {
    const court = 'a'.repeat(10);
    assert.equal(notify.truncate(court), court);

    const long = 'mot '.repeat(2000);
    const coupe = notify.truncate(long);
    assert.ok(coupe.length <= notify.MAX_DESCRIPTION);
    assert.match(coupe, /Message tronqué/);
});

test('violation — repli salon voie neutre : sans droit d\'écriture, rien n\'est posté', async () => {
    const { portee, api } = fairePortee({ permissions: { aPermission: (nom) => nom === 'VIEW_CHANNEL' } });

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    // MÊME motif que la voie historique : il est stocké en base et relu par le
    // dashboard, les deux voies ne peuvent pas en avoir deux versions.
    assert.deepEqual(res, { ok: false, error: 'aucun salon de logs configure pour le repli' });
    assert.equal(api.appels.some(a => a[0] === 'envoyerMessage'), false);
});

test('violation — repli salon voie neutre : permissions illisibles valent refus', async () => {
    const { portee, api } = fairePortee({ permissions: null });

    const res = await notify.sendToGuildChannel(portee, GUILDE);

    assert.deepEqual(res, { ok: false, error: 'aucun salon de logs configure pour le repli' });
    assert.equal(api.appels.some(a => a[0] === 'envoyerMessage'), false);
});

// ═══ Mode panique : voie neutre ═════════════════════════════════════════════

test('panique — pose neutre : une seule méthode du contrat, méthode « incident » en base', async () => {
    oublierPanique();
    const { portee, api } = fairePortee({ voie: 'incident' });

    const res = await enterPanic(portee, { durationSeconds: 300, reason: 'Vague', logChannelId: SALON_LOG });

    assert.equal(res.ok, true);
    assert.equal(res.method, 'incident_actions');
    assert.equal(res.extended, false);
    // La ligne persistée porte la valeur de colonne historique, pas le
    // vocabulaire de la voie rendue par le contrat.
    assert.equal(ligneDePanique().method, 'incident_actions');

    const pause = api.appels.find(a => a[0] === 'mettreInvitationsEnPause');
    assert.equal(pause[1], GUILDE);
    assert.equal(pause[2], res.expiresAt * 1000, 'échéance en millisecondes');
    assert.equal(pause[3], 'Vague');
    assert.equal(api.appels.some(a => a[0] === 'obtenirEtatInvitations'), true, 'état d\'origine relevé');
});

test('panique — pose neutre : la voie « permanent » est enregistrée comme telle', async () => {
    oublierPanique();
    const { portee } = fairePortee({ voie: 'permanent' });

    const res = await enterPanic(portee, { durationSeconds: 300, reason: 'Vague', logChannelId: SALON_LOG });

    assert.equal(res.ok, true);
    assert.equal(res.method, 'invites_disabled');
    // C'est cette valeur qui fera choisir la levée : un repli sans échéance ne
    // se lève que par le balayage, et sa ligne ne doit pas être supprimée avant.
    assert.equal(ligneDePanique().method, 'invites_disabled');
});

test('panique — sans la capacité, la mesure est sautée, jamais tentée', async () => {
    oublierPanique();
    const { adaptateur, api } = faireAdaptateur({ capacites: { pauseInvitations: false } });
    const portee = { guildeId: GUILDE, api: adaptateur.api, moi: adaptateur.moi, capacites: adaptateur.capacites };

    const res = await enterPanic(portee, { durationSeconds: 300, reason: 'Vague' });

    assert.deepEqual(res, { ok: false, skipped: 'indisponible' });
    assert.deepEqual(api.appels, [], 'aucun appel : on ne tente pas ce que la plateforme ne sait pas faire');
    assert.equal(ligneDePanique(), undefined);
});

test('panique — permission manquante : même motif que la voie historique', async () => {
    oublierPanique();
    const { portee, api } = fairePortee({ membre: { id: BOT, aPermission: () => false } });

    const res = await enterPanic(portee, { durationSeconds: 300, reason: 'Vague' });

    assert.equal(res.ok, false);
    assert.match(res.error, /Gérer le serveur/);
    assert.equal(api.appels.some(a => a[0] === 'mettreInvitationsEnPause'), false);
});

test('panique — permission indéterminable : on tente, on n\'invente pas un refus', async () => {
    oublierPanique();
    // Adaptateur pas encore connecté : `moiId` absent de la portée.
    const api = faireApi();
    const res = await enterPanic({ guildeId: GUILDE, api }, { durationSeconds: 300, reason: 'Vague' });

    assert.equal(res.ok, true);
    assert.equal(api.appels.some(a => a[0] === 'obtenirMembre'), false);
});

test('panique — levée neutre : une seule méthode, la ligne disparaît', async () => {
    semerPanique({ method: 'incident_actions' });
    const { portee, api } = fairePortee();

    const res = await liftPanic(portee, { liftedBy: '777777777777777777', logChannelId: SALON_LOG });

    assert.deepEqual(res, { ok: true });
    assert.equal(ligneDePanique(), undefined);
    const pause = api.appels.find(a => a[0] === 'mettreInvitationsEnPause');
    assert.equal(pause[2], null, 'null = levée');
});

test('panique — levée neutre : invitations déjà fermées avant moi, rien n\'est rouvert', async () => {
    semerPanique({ method: 'incident_actions', previous: 1 });
    const { portee, api } = fairePortee();

    const res = await liftPanic(portee, { logChannelId: SALON_LOG });

    assert.deepEqual(res, { ok: true });
    assert.equal(ligneDePanique(), undefined, 'mon échéance est retirée');
    assert.equal(api.appels.some(a => a[0] === 'mettreInvitationsEnPause'), false,
        'la décision de quelqu\'un d\'autre n\'est pas défaite');
});

test('panique — balayage neutre : « je ne sais pas » ne supprime AUCUNE échéance', async () => {
    semerPanique();
    const { adaptateur, api } = faireAdaptateur({ guildes: null });

    assert.equal(await sweepExpiredPanics(adaptateur), 0);
    assert.ok(ligneDePanique(), 'la ligne survit : listerGuildes() a rendu null, pas []');
    assert.deepEqual(api.appels.map(a => a[0]), ['listerGuildes']);
});

test('panique — balayage neutre : « aucun serveur » oublie les échéances orphelines', async () => {
    semerPanique();
    const { adaptateur, api } = faireAdaptateur({ guildes: [] });

    assert.equal(await sweepExpiredPanics(adaptateur), 0);
    assert.equal(ligneDePanique(), undefined, 'plus rien à lever : la ligne est oubliée');
    assert.equal(api.appels.some(a => a[0] === 'mettreInvitationsEnPause'), false);
});

test('panique — balayage neutre : une échéance échue est levée par le contrat', async () => {
    semerPanique();
    const { adaptateur, api } = faireAdaptateur({ guildes: [GUILDE] });

    assert.equal(await sweepExpiredPanics(adaptateur), 1);
    assert.equal(ligneDePanique(), undefined);
    const pause = api.appels.find(a => a[0] === 'mettreInvitationsEnPause');
    assert.deepEqual([pause[1], pause[2]], [GUILDE, null]);
});

// ═══ Événement AutoMod ══════════════════════════════════════════════════════

test('automod — le descripteur déclare la capacité qui le cantonne', () => {
    assert.equal(evenementAutomod.nom, 'sanctionAutomatique');
    assert.equal(evenementAutomod.capaciteRequise, 'automod');
    assert.equal(typeof evenementAutomod.executer, 'function');
    assert.equal('execute' in evenementAutomod, false, 'plus de handler discord.js');
});

test('automod — automodSync n\'est chargé QU\'À l\'exécution', async () => {
    assert.equal(CHEMIN_AUTOMODSYNC in require.cache, false,
        'le require du module ne doit pas tirer discord.js par automodSync');

    await evenementAutomod.executer(faireCtx().ctx, {
        guildeId: GUILDE, membreId: '888888888888888888', regleId: 'r-inconnue',
        action: 1, contenu: null, canalId: null,
        declencheurNatif: 1, motCle: null, dureeSecondes: null,
    });

    assert.equal(CHEMIN_AUTOMODSYNC in require.cache, true, 'chargé à l\'appel, sous garde de capacité');
});

test('automod — une exclusion temporaire : historique écrit et embed complet', async () => {
    const { ACTIONS, TRIGGERS } = require('../bot/utils/automodSync');
    db.prepare(`
        INSERT INTO automod_rules (guild_id, discord_rule_id, trigger_type, name, enabled, log_channel)
        VALUES (?, 'regle-42', 'KEYWORD', 'Insultes', 1, ?)
        ON CONFLICT DO NOTHING
    `).run(GUILDE, SALON_LOG);

    const { ctx, envois } = faireCtx();
    await evenementAutomod.executer(ctx, {
        guildeId: GUILDE,
        membreId: '888888888888888888',
        regleId: 'regle-42',
        action: ACTIONS.TIMEOUT.discordType,
        contenu: 'contenu incriminé',
        canalId: '555555555555555555',
        declencheurNatif: TRIGGERS.KEYWORD.discordType,
        motCle: 'gros mot',
        dureeSecondes: 600,
    });

    const sanction = db.prepare(
        "SELECT * FROM sanctions WHERE guild_id = ? AND type = 'mute' ORDER BY id DESC"
    ).get(GUILDE);
    assert.equal(sanction.reason, 'AutoMod Discord — Insultes (Mots interdits et liens)');
    assert.equal(sanction.duration, '10m');
    assert.equal(sanction.moderator_id, BOT, 'modérateur = identité du bot, lue sur le contexte');

    assert.equal(envois.length, 1);
    const rendu = corpsEnvoye(envois[0].contenu);
    assert.equal(rendu.title, '🔇 Exclusion temporaire par AutoMod');
    assert.equal(rendu.color, 0xe67e22);
    assert.deepEqual(rendu.footer, { text: 'Filtré par Discord — Quasar ne fait qu\'enregistrer.' });
    assert.deepEqual(rendu.fields.map(f => [f.name, f.value, f.inline]), [
        ['Membre', '<@888888888888888888> (888888888888888888)', true],
        ['Règle', 'Insultes', true],
        ['Filtre', 'Mots interdits et liens', true],
        ['Salon', '<#555555555555555555>', true],
        ['Durée', '10m', true],
        ['Numéro de sanction', `#${sanction.id}`, true],
        ['Terme détecté', '`gros mot`', false],
        ['Contenu', '```contenu incriminé```', false],
    ]);
    // Le salon dédié de la règle est privilégié sur le modlog global.
    assert.equal(envois[0].canalId, SALON_LOG);
});

test('automod — une alerte n\'est pas une sanction : journalisée, jamais historisée', async () => {
    const { ACTIONS, TRIGGERS } = require('../bot/utils/automodSync');
    const avant = db.prepare('SELECT COUNT(*) c FROM sanctions WHERE guild_id = ?').get(GUILDE).c;

    const { ctx, envois } = faireCtx();
    await evenementAutomod.executer(ctx, {
        guildeId: GUILDE, membreId: '888888888888888888', regleId: 'regle-42',
        action: ACTIONS.SEND_ALERT_MESSAGE.discordType, contenu: null, canalId: null,
        declencheurNatif: TRIGGERS.KEYWORD.discordType, motCle: null, dureeSecondes: null,
    });

    assert.equal(db.prepare('SELECT COUNT(*) c FROM sanctions WHERE guild_id = ?').get(GUILDE).c, avant);
    assert.equal(envois.length, 1);
    assert.equal(corpsEnvoye(envois[0].contenu).title, '🛡️ Alerte AutoMod');
});

test('automod — action inconnue : rien n\'est écrit, rien n\'est journalisé', async () => {
    const avant = db.prepare('SELECT COUNT(*) c FROM sanctions WHERE guild_id = ?').get(GUILDE).c;
    const { ctx, envois } = faireCtx();

    await evenementAutomod.executer(ctx, {
        guildeId: GUILDE, membreId: '888888888888888888', regleId: 'regle-42',
        action: 99, contenu: null, canalId: null,
        declencheurNatif: 1, motCle: null, dureeSecondes: null,
    });

    assert.equal(db.prepare('SELECT COUNT(*) c FROM sanctions WHERE guild_id = ?').get(GUILDE).c, avant);
    assert.equal(envois.length, 0);
});
