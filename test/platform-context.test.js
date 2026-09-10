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
const { creerContexteCommande } = require('../bot/platform/discord/context');
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
            once: () => {},
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
    // `brut` reste accessible pour le code pas encore migré, mais invisible
    // d'une sérialisation : rien ne peut le recopier par mégarde.
    assert.equal(JSON.parse(JSON.stringify(ctx.auteur)).brut, undefined);
    assert.ok(ctx.auteur.brut, 'échappatoire de transition encore disponible');
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
