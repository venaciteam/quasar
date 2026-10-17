// Le contexte neutre, de bout en bout, sur les deux commandes témoins.
//
// Raison d'être : la dérivation d'un descripteur en commande slash ne prouve que
// la moitié du contrat. L'autre moitié — un contexte qui lit ses options, écrit
// en base, rend un embed et répond — est ce que vont consommer les 27 migrations
// suivantes. Ce fichier l'exerce sans jeton, sans réseau et sans client réel.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const creerAdaptateurDiscord = require('../bot/platform/discord');
const { creerContexteCommande, creerContextePanneau } = require('../bot/platform/discord/context');
const { rendreEmbed, rendreChoix, rendrePrompt } = require('../bot/platform/discord/render');
const { embed } = require('../bot/platform/embed');
const { getDb } = require('../api/services/database');

const GUILDE = '100000000000000001';
const SALON = '100000000000000002';
const AUTEUR = '100000000000000003';
const ROLE = '100000000000000004';

// ── Doublures ────────────────────────────────────────────────────────────────

/** Client discord.js réduit à ce que la couche plateforme lui demande. */
function faireClient({ rolePosition = 1, roleGere = false, positionBot = 5 } = {}) {
    const role = { id: ROLE, name: 'Membre', position: rolePosition, managed: roleGere };
    const guilde = {
        id: GUILDE,
        name: 'Serveur de test',
        roles: { cache: new Map([[ROLE, role]]), fetch: async () => role },
        members: { me: { roles: { highest: { position: positionBot } } } },
    };
    return {
        role,
        guilde,
        client: {
            ws: { ping: 42 },
            guilds: { cache: new Map([[GUILDE, guilde]]) },
            // `on` est requis depuis que l'adaptateur branche lui-même le
            // redéploiement des commandes à l'invitation du bot.
            on: () => {},
            once: () => {},
            off: () => {},
            rest: {},
        },
    };
}

/** Interaction de commande, avec capture de la réponse. */
function faireInteraction({ client, sousCommande = null, options = {}, estAdmin = true }) {
    const reponses = [];
    return {
        reponses,
        interaction: {
            id: '999999999999999999',
            createdTimestamp: Date.now() - 5,
            client,
            guild: client.guilds.cache.get(GUILDE),
            channel: { id: SALON },
            channelId: SALON,
            user: { id: AUTEUR, username: 'leeva', globalName: 'Leeva', tag: 'leeva#0' },
            member: {
                id: AUTEUR,
                displayName: 'Leeva',
                roles: { cache: new Map() },
                permissions: { has: () => estAdmin },
            },
            deferred: false,
            replied: false,
            options: {
                getSubcommand: () => sousCommande,
                getString: (nom) => options[nom] ?? null,
                getInteger: (nom) => options[nom] ?? null,
                getBoolean: (nom) => options[nom] ?? null,
                getUser: (nom) => options[nom] ?? null,
                getChannel: (nom) => options[nom] ?? null,
                getRole: (nom) => options[nom] ?? null,
            },
            reply(payload) { reponses.push(payload); return Promise.resolve(payload); },
            followUp(payload) { reponses.push(payload); return Promise.resolve(payload); },
            editReply(payload) { reponses.push(payload); return Promise.resolve(payload); },
        },
    };
}

/** Exécute un descripteur comme le ferait le pont du chargeur. */
async function executer(descripteur, { client, sousCommande = null, options = {} }) {
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, reponses } = faireInteraction({ client, sousCommande, options });
    const sous = descripteur.sousCommandes?.find(s => s.nom === sousCommande);
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur, sousCommande: sous });
    await (sous?.executer || descripteur.executer)(ctx);
    return { reponses, ctx };
}

beforeEach(() => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Serveur de test');
    db.prepare('DELETE FROM autoroles WHERE guild_id = ?').run(GUILDE);
});

// ── /ping ────────────────────────────────────────────────────────────────────

test('/ping répond l\'embed attendu, sans rien savoir de Discord', async () => {
    const { client } = faireClient();
    const { reponses } = await executer(require('../bot/commands/ping'), { client });

    assert.equal(reponses.length, 1);
    const corps = JSON.parse(JSON.stringify(reponses[0].embeds[0].toJSON()));
    assert.equal(corps.title, '🏓 Pong !');
    assert.equal(corps.color, 0xc8a86e);
    assert.deepEqual(corps.fields.map(f => f.name), ['Latence', 'API Discord']);
    // La latence de passerelle vient du contexte, pas de `client.ws.ping` lu
    // directement par la commande.
    assert.equal(corps.fields[1].value, '42ms');
    assert.ok(corps.timestamp, 'horodatage attendu');
});

// ── /autorole ────────────────────────────────────────────────────────────────

test('/autorole add enregistre le rôle et le confirme', async () => {
    const { client, role } = faireClient();
    const { reponses } = await executer(require('../bot/commands/autorole'), {
        client, sousCommande: 'add', options: { role },
    });

    const ligne = getDb().prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').get(GUILDE);
    assert.equal(ligne.role_id, ROLE);

    const corps = reponses[0].embeds[0].toJSON();
    assert.equal(corps.title, '✅ Autorole ajouté');
    assert.match(corps.description, new RegExp(`<@&${ROLE}>`));
});

test('/autorole add refuse un rôle plus haut que celui du bot, sans rien écrire', async () => {
    // Le contrôle passe par ctx.api.verifierRoleAttribuable : la commande ne lit
    // ni la hiérarchie, ni le cache des rôles.
    const { client, role } = faireClient({ rolePosition: 9, positionBot: 5 });
    const { reponses } = await executer(require('../bot/commands/autorole'), {
        client, sousCommande: 'add', options: { role },
    });

    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM autoroles WHERE guild_id = ?').get(GUILDE).n, 0);
    const corps = reponses[0].embeds[0].toJSON();
    assert.match(corps.title, /hiérarchie/);
    assert.equal(reponses[0].ephemeral, true, 'un refus d\'usage reste éphémère');
});

test('/autorole add refuse un rôle géré par une intégration', async () => {
    const { client, role } = faireClient({ roleGere: true });
    const { reponses } = await executer(require('../bot/commands/autorole'), {
        client, sousCommande: 'add', options: { role },
    });
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM autoroles WHERE guild_id = ?').get(GUILDE).n, 0);
    assert.match(reponses[0].embeds[0].toJSON().description, /intégration/);
});

test('/autorole remove sur un rôle non configuré explique au lieu de mentir', async () => {
    const { client, role } = faireClient();
    const { reponses } = await executer(require('../bot/commands/autorole'), {
        client, sousCommande: 'remove', options: { role },
    });
    assert.match(reponses[0].embeds[0].toJSON().title, /n'est pas un autorôle/);
});

test('/autorole list rend la liste, ou le dit en éphémère quand elle est vide', async () => {
    const { client, role } = faireClient();
    const descripteur = require('../bot/commands/autorole');

    const vide = await executer(descripteur, { client, sousCommande: 'list' });
    assert.equal(vide.reponses[0].content, 'Aucun autorole configuré.');
    assert.equal(vide.reponses[0].ephemeral, true);

    await executer(descripteur, { client, sousCommande: 'add', options: { role } });
    const pleine = await executer(descripteur, { client, sousCommande: 'list' });
    assert.match(pleine.reponses[0].embeds[0].toJSON().description, new RegExp(`<@&${ROLE}>`));
});

// ── Contrat du contexte ──────────────────────────────────────────────────────

test('une option non déclarée lève au lieu de rendre undefined', async () => {
    // Une faute de frappe sur get() produirait sinon une commande qui « ne fait
    // rien », sans le moindre indice.
    const { client } = faireClient();
    const descripteur = require('../bot/commands/autorole');
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction } = faireInteraction({ client, sousCommande: 'add' });
    const sous = descripteur.sousCommandes.find(s => s.nom === 'add');
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur, sousCommande: sous });

    assert.throws(() => ctx.options.get('roles'), /non déclarée/);
    assert.equal(ctx.options.sousCommande, 'add');
});

test('le contexte ne fuit rien de discord.js dans ses données', () => {
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction } = faireInteraction({ client });
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    assert.equal(ctx.plateforme, 'discord');
    assert.equal(ctx.guildeId, GUILDE);
    assert.equal(ctx.canalId, SALON);
    assert.deepEqual(Object.keys(ctx.auteur).sort(), ['estBot', 'etiquette', 'id', 'mention', 'nom']);
    assert.equal(ctx.auteur.mention, `<@${AUTEUR}>`);
    // L'échappatoire `brut` — l'objet discord.js d'origine, attaché en propriété
    // non énumérable — a été RETIRÉE à la consolidation. Elle a servi le temps
    // des lots 1 à 5 ; la garder aurait suffi à ce qu'une seule commande
    // redevienne Discord-only sans que rien ne l'indique.
    assert.equal(ctx.auteur.brut, undefined, '« brut » ne doit plus exister sur une entité normalisée');
    assert.equal(ctx.membre.brut, undefined);
});

// ── Rendu ────────────────────────────────────────────────────────────────────

test('un embed neutre se rend à l\'identique, couleur entière ou hexadécimale', () => {
    const attendu = { title: 'T', description: 'D', color: 0xc8a86e };
    assert.equal(rendreEmbed(embed({ titre: 'T', description: 'D', couleur: 0xc8a86e })).toJSON().color, attendu.color);
    assert.equal(rendreEmbed(embed({ couleur: '#c8a86e' })).toJSON().color, attendu.color);
    // Une couleur illisible ne doit pas faire échouer le rendu du reste.
    assert.equal(rendreEmbed(embed({ titre: 'T', couleur: 'rouge' })).toJSON().title, 'T');
});

test('ctx.choose se rend en boutons, dans la limite de Discord', () => {
    const rangees = rendreChoix([
        { cle: 'ouvrir', libelle: 'Ouvrir un ticket', emoji: '🎫', style: 'primaire' },
        { cle: 'fermer', libelle: 'Fermer ce ticket', emoji: '🔒', style: 'danger' },
    ], 'qpanel:ticket');

    const json = rangees[0].toJSON();
    assert.equal(json.components.length, 2);
    assert.equal(json.components[0].custom_id, 'qpanel:ticket:ouvrir');
    assert.equal(json.components[0].label, 'Ouvrir un ticket');
    assert.equal(json.components[0].style, 1);
    assert.equal(json.components[1].style, 4);

    // 26 choix : Discord rejetterait le message entier, on lève avant.
    const trop = Array.from({ length: 26 }, (_, i) => ({ cle: `c${i}`, libelle: `C${i}` }));
    assert.throws(() => rendreChoix(trop, 'p'), /25 au maximum/);
});

test('ctx.prompt se rend en formulaire, dans la limite de Discord', () => {
    const modal = rendrePrompt([
        { cle: 'sujet', libelle: 'Sujet du ticket', max: 100, requis: true },
        { cle: 'details', libelle: 'Décrivez votre demande', max: 1000, style: 'paragraphe' },
    ], { titre: 'Ouverture de ticket' }, 'qprompt:1:0');

    const json = modal.toJSON();
    assert.equal(json.custom_id, 'qprompt:1:0');
    assert.equal(json.title, 'Ouverture de ticket');
    assert.equal(json.components.length, 2);
    assert.equal(json.components[0].components[0].custom_id, 'sujet');
    assert.equal(json.components[0].components[0].required, true);
    assert.equal(json.components[1].components[0].style, 2, 'paragraphe');
    assert.equal(json.components[1].components[0].required, false);

    assert.throws(() => rendrePrompt([], {}, 'x'), /au moins une question/);
    const trop = Array.from({ length: 6 }, (_, i) => ({ cle: `c${i}`, libelle: `C${i}` }));
    assert.throws(() => rendrePrompt(trop, {}, 'x'), /5 au maximum/);
});

// ── Enchaînements après un ctx.choose ────────────────────────────────────────

/** Interaction minimale, non acquittée, avec capture. */
function faireInteractionNue(surReponse = () => {}) {
    const journal = [];
    const interaction = {
        id: '1', createdTimestamp: Date.now(),
        client: { ws: { ping: 1 } },
        guild: { id: GUILDE }, channel: { id: SALON }, channelId: SALON,
        user: { id: AUTEUR, username: 'leeva' },
        member: { id: AUTEUR, roles: { cache: new Map() }, permissions: { has: () => true } },
        deferred: false, replied: false,
        reply(p) { journal.push(['reply', p]); this.replied = true; return Promise.resolve(surReponse(p)); },
        followUp(p) { journal.push(['followUp', p]); return Promise.resolve(p); },
        editReply(p) { journal.push(['editReply', p]); return Promise.resolve(p); },
        showModal(m) { journal.push(['showModal', m]); this.replied = true; return Promise.resolve(); },
        deferUpdate() { journal.push(['deferUpdate']); this.deferred = true; return Promise.resolve(); },
    };
    return { interaction, journal };
}

/** Panneau éphémère dont le clic est déjà décidé. */
function faireChoose() {
    const clics = [];
    const clic = {
        customId: null,
        user: { id: AUTEUR },
        deferred: false, replied: false,
        deferUpdate() { clics.push('deferUpdate'); this.deferred = true; return Promise.resolve(); },
        reply(p) { clics.push(['reply', p]); this.replied = true; return Promise.resolve(p); },
        followUp(p) { clics.push(['followUp', p]); return Promise.resolve(p); },
        editReply(p) { clics.push(['editReply', p]); return Promise.resolve(p); },
        showModal(m) { clics.push(['showModal', m]); this.replied = true; return Promise.resolve(); },
    };
    const message = {
        id: 'm1', channelId: SALON,
        awaitMessageComponent: ({ filter }) => {
            clic.customId = `${prefixeVu}:ouvrir`;
            filter(clic);
            return Promise.resolve(clic);
        },
    };
    let prefixeVu = '';
    const { interaction, journal } = faireInteractionNue((payload) => {
        prefixeVu = payload.components[0].toJSON().components[0].custom_id.split(':').slice(0, -1).join(':');
        return message;
    });
    return { interaction, journal, clic, clics };
}

test('après un clic, ctx.repondre poste une suite et ne réécrit pas le panneau', async () => {
    // Le contexte basculait sur le clic acquitté par deferUpdate, donc `deferred`
    // : `repondre` partait alors en editReply et REMPLAÇAIT le panneau, boutons
    // compris. Ce n'est presque jamais l'intention — et pour le cas où ça l'est,
    // il y a `modifierPanneau`.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, clic, clics } = faireChoose();
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    // `suite` non déclarée : le défaut est 'message'.
    const cle = await ctx.choose('Choisissez.', [{ cle: 'ouvrir', libelle: 'Ouvrir' }]);
    assert.equal(cle, 'ouvrir');
    assert.equal(clics[0], 'deferUpdate', 'le clic est acquitté sans rien afficher');

    await ctx.repondre('Voilà la suite.');
    assert.deepEqual(clics[1], ['followUp', { content: 'Voilà la suite.' }]);

    await ctx.modifierPanneau({ contenu: 'Choix enregistré.', composants: [] });
    assert.deepEqual(clics[2], ['editReply', { content: 'Choix enregistré.', components: [] }]);
    assert.equal(clic.deferred, true);
});

test('ctx.prompt refuse une interaction déjà acquittée, et le dit', async () => {
    // Discord n'ouvre un formulaire que sur une interaction vierge. Sans ce
    // garde, l'échec remontait en DiscordAPIError opaque au milieu du parcours
    // « panneau de ticket → formulaire ».
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction } = faireChoose();
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    await ctx.choose('Choisissez.', [{ cle: 'ouvrir', libelle: 'Ouvrir' }]);
    await assert.rejects(
        () => ctx.prompt([{ cle: 'sujet', libelle: 'Sujet' }]),
        /déjà acquittée.*suite: 'saisie'/s,
    );
});

test('ctx.choose({ suite: \'saisie\' }) laisse le clic vierge pour un formulaire', async () => {
    // C'est le parcours « panneau puis formulaire » du lot 5 : sans cette
    // option, il est impossible sur un panneau éphémère.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, clic, clics } = faireChoose();
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    await ctx.choose('Choisissez.', [{ cle: 'ouvrir', libelle: 'Ouvrir' }], { suite: 'saisie' });
    assert.equal(clics.includes('deferUpdate'), false, 'le clic ne doit pas être acquitté');
    assert.equal(clic.deferred, false);

    // Le formulaire s'ouvre donc bien sur le clic. `awaitModalSubmit` n'existe
    // pas sur la doublure : l'expiration rend `null`, ce qui suffit à prouver
    // que showModal a été appelé.
    clic.awaitModalSubmit = () => Promise.reject(new Error('expiré'));
    assert.equal(await ctx.prompt([{ cle: 'sujet', libelle: 'Sujet' }]), null);
    assert.equal(clics.some(c => Array.isArray(c) && c[0] === 'showModal'), true);
});

test('une règle « autorise » invalide échoue AVANT que le panneau ne soit posté', async () => {
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, journal } = faireInteractionNue();
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    await assert.rejects(
        () => ctx.choose('Choisissez.', [{ cle: 'a', libelle: 'A' }], { autorise: 'modo' }),
        /n'est ni un mode connu/,
    );
    assert.deepEqual(journal, [], 'aucun message ne doit avoir été posté');
});

test('une « suite » inconnue est refusée avant que le panneau ne soit posté', async () => {
    // Même sévérité que le reste du registre : une valeur mal orthographiée
    // retomberait sur le défaut, et « panneau puis formulaire » échouerait plus
    // tard sur un « L'interaction a échoué » sans rapport visible avec la faute.
    const { validerSuite, SUITES_CHOOSE } = require('../bot/platform/discord/context');

    // Le vocabulaire décrit l'INTENTION de l'appelant, jamais la mécanique d'une
    // plateforme : « acquitter » ne veut rien dire sur Fluxer, où un choose est
    // une réaction emoji sans accusé de réception.
    assert.deepEqual([...SUITES_CHOOSE], ['message', 'saisie']);
    for (const valeur of [undefined, 'message', 'saisie']) {
        assert.doesNotThrow(() => validerSuite(valeur), `refusée à tort : ${String(valeur)}`);
    }
    for (const valeur of ['formulaire', 'saise', false, 0]) {
        assert.throws(() => validerSuite(valeur), /suite.*inconnue/s, `acceptée à tort : ${String(valeur)}`);
    }

    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, journal } = faireInteractionNue();
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    await assert.rejects(
        () => ctx.choose('Choisissez.', [{ cle: 'a', libelle: 'A' }], { suite: 'formulaire' }),
        /Valeurs acceptées : 'message', 'saisie'/,
    );
    assert.deepEqual(journal, [], 'aucun message ne doit avoir été posté');
});

// ── Panneaux persistants : poser, réécrire, acquitter ────────────────────────

/** Clic de panneau, tel que `routerPanneau` le sert : NON acquitté. */
function faireClicPanneau() {
    const journal = [];
    const interaction = {
        id: '2', createdTimestamp: Date.now(),
        client: { ws: { ping: 1 } },
        guild: { id: GUILDE }, channel: { id: SALON }, channelId: SALON,
        message: { id: 'PANNEAU-MSG' },
        user: { id: AUTEUR, username: 'leeva' },
        member: { id: AUTEUR, roles: { cache: new Map() }, permissions: { has: () => true } },
        deferred: false, replied: false,
        customId: 'defer:apply:42',
        update(p) { journal.push(['update', p]); this.replied = true; return Promise.resolve(p); },
        reply(p) { journal.push(['reply', p]); this.replied = true; return Promise.resolve(p); },
        followUp(p) { journal.push(['followUp', p]); return Promise.resolve(p); },
        editReply(p) { journal.push(['editReply', p]); return Promise.resolve(p); },
        deferReply(p) { journal.push(['deferReply', p]); this.deferred = true; return Promise.resolve(p); },
        deferUpdate() { journal.push(['deferUpdate']); this.deferred = true; return Promise.resolve(); },
    };
    return { interaction, journal };
}

test('ctx.modifierPanneau acquitte un clic vierge par update(), et complète par editReply()', async () => {
    // C'est le BUG corrigé à la consolidation : `modifierPanneau` appelait
    // `editReply` sans condition, ce qui échoue sur un clic de panneau — il
    // arrive non acquitté. Le panneau d'arbitrage contournait par
    // `differer({ ephemere: true })` + `api.modifierMessage` + `repondre()`, au
    // prix de quatre messages éphémères que l'original n'avait pas.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, journal } = faireClicPanneau();
    const ctx = creerContextePanneau(interaction, { adaptateur, panneau: 'defer', cle: 'apply:42' });

    // 1. Rien n'est acquitté -> update(), qui réécrit ET acquitte en un appel.
    await ctx.modifierPanneau(embed({ titre: 'Cas tranché' }));
    assert.deepEqual(journal.map(l => l[0]), ['update']);
    assert.equal(journal[0][1].embeds[0].toJSON().title, 'Cas tranché');

    // 2. L'interaction est maintenant répondue -> editReply(), qui complète.
    await ctx.modifierPanneau(embed({ titre: 'Cas tranché — résultat' }));
    assert.deepEqual(journal.map(l => l[0]), ['update', 'editReply']);

    // Et AUCUN message éphémère au passage.
    assert.equal(journal.some(l => l[0] === 'reply' || l[0] === 'followUp' || l[0] === 'deferReply'), false);
});

test('ctx.modifierPanneau repose des choix désactivés, sans les retirer', async () => {
    // Un panneau tranché doit continuer de dire à quoi le clic correspondait.
    // Les boutons sont donc REPOSÉS `desactive: true`, jamais effacés — c'était
    // le comportement d'origine du salon d'arbitrage.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction, journal } = faireClicPanneau();
    const ctx = creerContextePanneau(interaction, { adaptateur, panneau: 'defer', cle: 'apply:42' });

    await ctx.modifierPanneau(
        embed({ titre: 'Cas tranché' }),
        [
            { cle: 'apply:42', libelle: 'Appliquer les sanctions', style: 'danger', desactive: true },
            { cle: 'ignore:42', libelle: 'Ignorer le cas', style: 'secondaire', desactive: true },
        ],
        { panneau: 'defer' },
    );

    const [[, payload]] = journal;
    assert.equal(payload.components.length, 1);
    assert.deepEqual(payload.components[0].components.map(b => [b.custom_id, b.disabled]), [
        ['defer:apply:42', true],
        ['defer:ignore:42', true],
    ]);
});

test('ctx.modifierPanneau refuse un nom de panneau invalide plutôt que de poser un customId illisible', async () => {
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction } = faireClicPanneau();
    const ctx = creerContextePanneau(interaction, { adaptateur, panneau: 'defer', cle: 'apply:42' });

    await assert.rejects(
        async () => ctx.modifierPanneau('x', [{ cle: 'a', libelle: 'A' }], { panneau: 'a:b' }),
        /nom de panneau invalide/,
    );
});

test('ctx.poserPanneau accepte un corps composé : contenu + embeds + composants', async () => {
    // Les mentions d'un embed NE NOTIFIENT PAS. Sans corps composé, l'ouverture
    // d'un ticket devait poster les mentions dans un message séparé du panneau.
    const envois = [];
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    adaptateur.api.envoyerMessage = async (canalId, corps) => {
        envois.push([canalId, corps]);
        return { id: 'M1', canalId };
    };
    const { interaction } = faireClicPanneau();
    const ctx = creerContextePanneau(interaction, { adaptateur, panneau: 'ticket', cle: 'ouvrir' });

    const pose = await ctx.poserPanneau(
        'SALON-TICKET',
        { contenu: '<@1> | <@&2>', embeds: [embed({ titre: 'Ticket #1' })] },
        [{ cle: 'fermer', libelle: 'Fermer le ticket', style: 'danger' }],
        { panneau: 'ticket' },
    );

    assert.deepEqual(pose, { canalId: 'SALON-TICKET', messageId: 'M1' });
    assert.equal(envois.length, 1, 'un seul message, pas deux');
    const [[canal, corps]] = envois;
    assert.equal(canal, 'SALON-TICKET');
    assert.equal(corps.contenu, '<@1> | <@&2>');
    assert.equal(corps.embeds.length, 1);
    assert.deepEqual(corps.composants[0].components.map(b => b.custom_id), ['ticket:fermer']);
});

test('ctx.poserPanneau refuse un corps qui déclare lui-même ses composants', async () => {
    // Ce sont les choix qui décident des composants. Accepter les deux laisserait
    // un panneau poser des boutons que personne ne route.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const { interaction } = faireClicPanneau();
    const ctx = creerContextePanneau(interaction, { adaptateur, panneau: 'ticket', cle: 'ouvrir' });

    await assert.rejects(
        async () => ctx.poserPanneau('S', { contenu: 'x', composants: [] }, [{ cle: 'a', libelle: 'A' }], { panneau: 'ticket' }),
        /composants/,
    );
});

// ── Commandes personnalisées : le contexte délègue à l'adaptateur ────────────

test('ctx.deployerCommandeServeur et ctx.retirerCommandeServeur passent par l\'adaptateur', async () => {
    // `/cmd create|edit|delete` montait son PROPRE client REST discord.js, sur
    // les variables d'environnement. Le contexte porte désormais les deux
    // méthodes, et le serveur n'est pas un paramètre : une commande agit sur le
    // sien, et le laisser choisir ouvrirait un déploiement sur n'importe quel
    // serveur depuis n'importe quelle interaction.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const appels = [];
    adaptateur.deployerCommandeServeur = async (...args) => { appels.push(['deployer', ...args]); return true; };
    adaptateur.retirerCommandeServeur = async (...args) => { appels.push(['retirer', ...args]); return true; };

    const { interaction } = faireInteraction({ client });
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: require('../bot/commands/ping'),
    });

    assert.equal(await ctx.deployerCommandeServeur({ nom: 'faq', description: 'La FAQ' }), true);
    assert.equal(await ctx.retirerCommandeServeur('faq'), true);
    assert.deepEqual(appels, [
        ['deployer', GUILDE, { nom: 'faq', description: 'La FAQ' }],
        ['retirer', GUILDE, 'faq'],
    ]);
});

test('la voie d\'enregistrement de /cmd est celle du contexte, pas un client REST monté à la main', () => {
    // `enregistrementNeutre(ctx)` est ce que `/cmd create|edit|delete` passe à
    // `syncCustomCommandRename` : même signature que la voie du dashboard, donc
    // les deux sont interchangeables et la route du lot 7 n'a rien à réécrire.
    const { enregistrementNeutre } = require('../bot/commands/customcmd');
    const vus = [];
    const ctx = {
        guildeId: GUILDE,
        deployerCommandeServeur: (commande) => { vus.push(['deployer', commande]); return true; },
        retirerCommandeServeur: (nom) => { vus.push(['retirer', nom]); return true; },
    };

    const voie = enregistrementNeutre(ctx);
    voie.deployer(GUILDE, 'faq', 'Réponse à la FAQ');
    voie.retirer(GUILDE, 'faq');

    assert.equal(vus[0][0], 'deployer');
    assert.equal(vus[0][1].nom, 'faq');
    // La description vient de `buildCustomCommandDescription`, la même que le
    // redéploiement au démarrage : sans ça, une commande changerait de libellé
    // au premier reboot suivant sa création.
    const { buildCustomCommandDescription } = require('../bot/utils/slashCommandSpec');
    assert.equal(vus[0][1].description, buildCustomCommandDescription({ name: 'faq', response: 'Réponse à la FAQ' }));
    assert.deepEqual(vus[1], ['retirer', 'faq']);
});
