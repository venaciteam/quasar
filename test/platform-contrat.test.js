// Compléments de contrat livrés au lot 0.1, après audit.
//
// Raison d'être commune : `bot/platform/**` devient EN LECTURE SEULE pour les
// lots 1 à 5 (DA §11.5). Tout ce qui manque au contrat doit donc exister
// maintenant, et être verrouillé par un test — sinon cinq agents découvriront
// le manque en même temps, sans avoir le droit d'y remédier.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EmbedBuilder } = require('discord.js');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const { embed, estEmbed } = require('../bot/platform/embed');
const { rendreContenu, rendreEmbed } = require('../bot/platform/discord/render');
const { appliquerDeltas } = require('../bot/platform/discord/api');
const { definirCommande } = require('../bot/platform/commands');
const { definirEvenement } = require('../bot/platform/events');
const { construireSlashCommand } = require('../bot/platform/discord/commands');
const { getDb } = require('../api/services/database');

/** Client discord.js réduit, avec capture des abonnements. */
function faireClient() {
    const abonnements = new Map();
    return {
        abonnements,
        client: {
            on: (nom, fn) => abonnements.set(nom, fn),
            once: (nom, fn) => abonnements.set(nom, fn),
            off: () => {},
            rest: {},
            channels: { cache: new Map() },
        },
    };
}

// ── 1. Un embed Discord ne passe jamais pour un embed neutre ─────────────────

test('un APIEmbed ou un EmbedBuilder est REFUSÉ, pas rendu à moitié', () => {
    // Le vocabulaire neutre ne partage que `description` et `image` avec le
    // format Discord. Reconnaître un embed sur ces clés-là ferait passer un
    // APIEmbed pour l'un des nôtres : la description survivrait, le titre, la
    // couleur, les champs et le pied disparaîtraient — sans un mot. Il reste
    // 146 EmbedBuilder à migrer.
    assert.equal(estEmbed({ title: 'T', description: 'D', color: 1, fields: [] }), false);
    assert.equal(estEmbed({ description: 'D' }), false, 'description seule ne suffit pas');
    assert.equal(estEmbed({ image: { url: 'x' } }), false, 'image seule non plus');

    assert.throws(() => rendreContenu(new EmbedBuilder().setTitle('T')), /embed\(/);
    assert.throws(() => rendreContenu({ title: 'T', color: 1 }), /Embed au format Discord/);
    assert.throws(() => rendreEmbed({ title: 'T' }), /Embed au format Discord/);
});

test('un contenu non reconnu lève au lieu de produire un message vide', () => {
    // Sans ça, l'erreur remontait sous la forme « Cannot send an empty
    // message », très loin de l'appel fautif.
    assert.throws(() => rendreContenu({ nimportequoi: 1 }), /non reconnu/);
    assert.throws(() => rendreContenu({}), /objet vide/);
});

test('les formes légitimes passent toujours, embed neutre recopié compris', () => {
    assert.deepEqual(Object.keys(rendreContenu('texte')), ['content']);
    assert.deepEqual(Object.keys(rendreContenu(embed({ titre: 'T' }))), ['embeds']);
    assert.deepEqual(Object.keys(rendreContenu({ ...embed({ titre: 'T' }) })), ['embeds']);
    assert.deepEqual(Object.keys(rendreContenu(null)), []);
});

test('un corps composé porte contenu, embeds et pièces jointes', () => {
    // Sans `fichiers`, un ticket ne peut pas rendre son transcript à sa
    // fermeture — et le module refuse alors de fermer plutôt que de perdre la
    // conversation.
    const payload = rendreContenu({
        contenu: 'Voici le transcript.',
        embeds: [embed({ titre: 'Ticket fermé' })],
        fichiers: [{ nom: 'transcript.txt', donnees: Buffer.from('bonjour'), description: 'Conversation' }],
    });
    assert.equal(payload.content, 'Voici le transcript.');
    assert.equal(payload.embeds.length, 1);
    assert.deepEqual(payload.files.map(f => f.name), ['transcript.txt']);
    assert.equal(payload.files[0].description, 'Conversation');
});

// ── 2. Voie d'entrée des événements ──────────────────────────────────────────

test('chargerEvenements branche les DEUX formats sur le bon événement natif', async () => {
    // Sans ce chargeur, un handler migré en { nom: 'roleCree', executer } était
    // abonné à client.on('roleCree') — un événement que discord.js n'émet
    // jamais. Pas d'erreur, pas de journal, la fonctionnalité disparaît.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-events-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'events'));
    fs.writeFileSync(path.join(dossier, 'neutre.js'), `
        const { definirEvenement } = require(${chemin});
        module.exports = definirEvenement({
            nom: 'roleCree',
            executer: async (ctx, role) => { global.__vuNeutre = { ctx, role }; },
        });
    `);
    fs.writeFileSync(path.join(dossier, 'historique.js'), `
        module.exports = { name: 'roleDelete', once: false, execute: async (role) => { global.__vuLegacy = role; } };
    `);

    const { client, abonnements } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const charges = adaptateur.chargerEvenements({ dossier });

    assert.deepEqual(
        charges.map(c => [c.nom, c.neutre, c.branche]).sort(),
        [['roleCree', true, true], ['roleDelete', false, true]],
    );
    assert.ok(abonnements.has('roleCreate'), 'roleCree doit être branché sur roleCreate');
    assert.ok(abonnements.has('roleDelete'));

    abonnements.get('roleCreate')({ id: '1', name: 'Membre', position: 2 });
    abonnements.get('roleDelete')({ id: '2', name: 'Ancien' });
    await new Promise(setImmediate);

    assert.equal(global.__vuNeutre.role.nom, 'Membre');
    assert.equal(global.__vuNeutre.role.mention, '<@&1>');
    assert.equal(global.__vuNeutre.ctx.plateforme, 'discord');
    // Le format historique reçoit toujours l'objet natif : les 16 handlers pas
    // encore migrés ne doivent rien voir changer.
    assert.equal(global.__vuLegacy.name, 'Ancien');

    delete global.__vuNeutre; delete global.__vuLegacy;
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('une exception dans un handler passe par le filet, jamais par un rejet flottant', async () => {
    // La promesse rendue à l'EventEmitter partait dans le filet global du
    // processus, où elle devenait un « rejet non capté » anonyme : on perdait le
    // nom de l'événement, donc le seul indice utile.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-events-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'events'));
    fs.writeFileSync(path.join(dossier, 'casse.js'), `
        const { definirEvenement } = require(${chemin});
        module.exports = definirEvenement({
            nom: 'roleCree',
            executer: async () => { throw new Error('boum'); },
        });
    `);
    fs.writeFileSync(path.join(dossier, 'casseSync.js'), `
        module.exports = { name: 'roleDelete', execute: () => { throw new Error('boum sync'); } };
    `);

    const { client, abonnements } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const vus = [];
    adaptateur.chargerEvenements({ dossier, surErreur: (err, ctx) => vus.push([ctx.evenement, err.message]) });

    abonnements.get('roleCreate')({ id: '1', name: 'R' });
    abonnements.get('roleDelete')({ id: '2', name: 'R' });
    await new Promise(setImmediate);

    // Le throw synchrone comme le rejet asynchrone, et l'événement est nommé.
    assert.deepEqual(vus.sort(), [['roleCree', 'boum'], ['roleDelete', 'boum sync']]);
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('un handler qui exige une capacité absente n\'est pas branché', () => {
    // C'est la voie par laquelle `sanctionAutomatique` reste Discord-only sans
    // qu'un seul fichier métier nomme la plateforme.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-events-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'events'));
    fs.writeFileSync(path.join(dossier, 'automod.js'), `
        const { definirEvenement } = require(${chemin});
        module.exports = definirEvenement({
            nom: 'sanctionAutomatique', capaciteRequise: 'automod', executer: async () => {},
        });
    `);

    const { client, abonnements } = faireClient();
    const discord = creerAdaptateurDiscord({ client });
    assert.deepEqual(discord.chargerEvenements({ dossier }).map(c => c.branche), [true]);
    assert.ok(abonnements.has('autoModerationActionExecution'));

    // Même dossier, sur un adaptateur qui ne déclare pas la capacité.
    const { client: client2, abonnements: abo2 } = faireClient();
    const sansAutomod = creerAdaptateurDiscord({ client: client2 });
    sansAutomod.capacites = { ...sansAutomod.capacites, automod: false };
    assert.deepEqual(sansAutomod.chargerEvenements({ dossier }).map(c => c.branche), [false]);
    assert.equal(abo2.has('autoModerationActionExecution'), false);

    fs.rmSync(dossier, { recursive: true, force: true });
});

test('definirEvenement refuse un nom hors table et une clé inconnue', () => {
    assert.throws(() => definirEvenement({ nom: 'roleCreate', executer() {} }), /Événement neutre inconnu/);
    // `once` au lieu de `une` produirait un abonnement permanent là où on en
    // voulait un seul.
    assert.throws(() => definirEvenement({ nom: 'pret', once: true, executer() {} }), /clé inconnue/);
    assert.throws(() => definirEvenement({ nom: 'pret' }), /executer/);
});

// ── 2 bis. Voie d'entrée des panneaux persistants ────────────────────────────

test('un panneau neutre est routé, un préfixe historique ne l\'est pas', async () => {
    // Le routage des clics vivait dans le interactionCreate de bot/index.js,
    // par préfixes en dur. Les lots 4 et 5 auraient donc dû modifier un fichier
    // qui leur est interdit.
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });

    let vu = null;
    adaptateur.surPanneau('ticket', async (ctx, cle) => { vu = { ctx, cle }; });

    // Les panneaux historiques utilisent « _ », les neutres « : » : aucun
    // recouvrement possible, le routage neutre peut donc passer en premier.
    assert.equal(adaptateur.routerPanneau({ customId: 'ticket_open' }), null);
    assert.equal(adaptateur.routerPanneau({ customId: 'tv_lock' }), null);
    assert.equal(adaptateur.routerPanneau({ customId: 'inconnu:x' }), null);
    assert.equal(adaptateur.routerPanneau({}), null);

    await adaptateur.routerPanneau({ customId: 'ticket:ouvrir', user: { id: '1' }, client: {} });
    assert.equal(vu.cle, 'ouvrir');
    assert.equal(vu.ctx.panneau.nom, 'ticket');
    assert.equal(vu.ctx.panneau.cle, 'ouvrir');
    // Contexte complet : c'est ce qui permet au handler d'ouvrir un formulaire.
    for (const methode of ['repondre', 'prompt', 'choose', 'modifierPanneau']) {
        assert.equal(typeof vu.ctx[methode], 'function', `ctx.${methode} manquant`);
    }
});

test('surPanneau refuse un nom de panneau ambigu ou déjà pris', () => {
    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    adaptateur.surPanneau('ticket', () => {});
    assert.throws(() => adaptateur.surPanneau('ticket', () => {}), /déjà enregistré/);
    // Un « : » dans le préfixe rendrait la clé du choix indéchiffrable.
    assert.throws(() => adaptateur.surPanneau('a:b', () => {}), /nom de panneau invalide/);
    assert.throws(() => adaptateur.surPanneau('', () => {}), /nom de panneau invalide/);
});

// ── 3. Base de données ───────────────────────────────────────────────────────

test('la table interaction_panels existe, avec sa contrainte d\'unicité', () => {
    const db = getDb();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_panels'").get();
    assert.ok(table, 'table interaction_panels absente : le lot 5 n\'a pas le droit de la créer lui-même');

    db.prepare('INSERT INTO interaction_panels (guild_id, channel_id, message_id, kind, payload) VALUES (?,?,?,?,?)')
        .run('1', '2', '3', 'ticket', '[]');
    // Un même message ne porte qu'un panneau : sans cette contrainte, un
    // redéploiement du panneau créerait un doublon et le clic serait routé deux
    // fois.
    assert.throws(
        () => db.prepare('INSERT INTO interaction_panels (guild_id, channel_id, message_id, kind, payload) VALUES (?,?,?,?,?)')
            .run('1', '2', '3', 'reactionrole', '[]'),
        /UNIQUE/,
    );
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_interaction_panels_message'").get());
});

// ── 5. Overwrites unitaires ──────────────────────────────────────────────────

test('un overwrite unitaire applique des deltas, il ne remplace pas le jeu', () => {
    const { BITS } = require('../bot/platform/discord/permissions');

    // Départ : CONNECT autorisée, SEND_MESSAGES refusée.
    let etat = { allow: BITS.CONNECT, deny: BITS.SEND_MESSAGES };

    // Verrouillage : CONNECT passe de « autorisée » à « refusée ». Le bit doit
    // quitter `allow` — le laisser des deux côtés ferait primer le refus, ce
    // qui marche par hasard ici mais pas au déverrouillage.
    etat = appliquerDeltas(etat.allow, etat.deny, { CONNECT: false });
    assert.equal(etat.allow & BITS.CONNECT, 0n);
    assert.equal(etat.deny & BITS.CONNECT, BITS.CONNECT);
    assert.equal(etat.deny & BITS.SEND_MESSAGES, BITS.SEND_MESSAGES, 'les autres bits ne bougent pas');

    // Déverrouillage : `null` rend la permission à l'héritage, sur les DEUX
    // masques.
    etat = appliquerDeltas(etat.allow, etat.deny, { CONNECT: null });
    assert.equal(etat.allow & BITS.CONNECT, 0n);
    assert.equal(etat.deny & BITS.CONNECT, 0n);

    assert.throws(() => appliquerDeltas(0n, 0n, { CONNECTE: true }), /Permission inconnue/);
});

test('le client REST porte les lectures et les écritures dont les lots ont besoin', () => {
    const { api } = creerAdaptateurDiscord({ client: faireClient().client });
    for (const methode of [
        'obtenirMessage', 'listerMessages', 'retirerReaction',
        'definirOverwrite', 'supprimerOverwrite', 'obtenirRole', 'verifierRoleAttribuable',
        // Lot 0.4 : le pré-contrôle de sanction, sans lequel la voie neutre
        // protège moins que la voie historique.
        'verifierMembreSanctionnable',
    ]) {
        assert.equal(typeof api[methode], 'function', `méthode « ${methode} » absente du client REST`);
    }
});

// ── 7 et 9. Sévérité du registre ─────────────────────────────────────────────

test('une commande qui ne déclare pas son accès est REFUSÉE', () => {
    // C'est le défaut le plus dangereux du registre : une commande
    // d'administration migrée en oubliant le champ deviendrait accessible à
    // n'importe quel membre, sans erreur ni journal.
    assert.throws(
        () => definirCommande({ nom: 'x', description: 'd', async executer() {} }),
        /l'accès n'est pas déclaré/,
    );
    // Déclarer les deux se contredit : une permission nommée dit déjà qui voit.
    assert.throws(
        () => definirCommande({ nom: 'x', description: 'd', permission: 'MANAGE_GUILD', accesParDefaut: false, async executer() {} }),
        /se contredisent/,
    );
});

test('accesParDefaut: false rend le setDefaultMemberPermissions(0) de /ticket', () => {
    // Sans lui, /ticket config, /ticket add et /ticket remove deviendraient
    // accessibles à tout le monde au lot 5.
    const reserve = construireSlashCommand(definirCommande({
        nom: 't', description: 'd', accesParDefaut: false, async executer() {},
    })).toJSON();
    assert.equal(reserve.default_member_permissions, '0');

    // Ouverture volontaire : rien n'est posé, c'est le défaut de Discord.
    const ouverte = construireSlashCommand(definirCommande({
        nom: 't', description: 'd', accesParDefaut: true, async executer() {},
    })).toJSON();
    assert.equal(ouverte.default_member_permissions, undefined);
});

test('le registre refuse une clé inconnue, comme creerCapacites', () => {
    const base = { nom: 'x', description: 'd', accesParDefaut: true, async executer() {} };
    // Un `maxLength` écrit à la place de `max` serait sinon accepté et déployé
    // SANS la contrainte : l'option existerait, elle ne validerait rien.
    assert.throws(() => definirCommande({ ...base, maxLength: 3 }), /clé inconnue « maxLength »/);
    assert.throws(
        () => definirCommande({ ...base, options: [{ nom: 'o', type: 'texte', description: 'd', maxLength: 3 }] }),
        /clé inconnue « maxLength »/,
    );
    assert.throws(
        () => definirCommande({ ...base, sousCommandes: [{ nom: 's', description: 'd', autocomplete: true, async executer() {} }] }),
        /clé inconnue « autocomplete »/,
    );
    // Clés reconnues mais posées au mauvais endroit.
    assert.throws(
        () => definirCommande({ ...base, options: [{ nom: 'o', type: 'booleen', description: 'd', max: 3 }] }),
        /« max » ne s'applique/,
    );
    assert.throws(
        () => definirCommande({ ...base, options: [{ nom: 'o', type: 'texte', description: 'd', typesCanal: ['texte'] }] }),
        /« typesCanal » n'a de sens/,
    );
    assert.throws(
        () => definirCommande({ ...base, permissionsBot: ['MANAGE_ROLE'] }),
        /permissionsBot/,
    );
});

test('typesCanal filtre le sélecteur de salon, en noms canoniques', () => {
    // Sept commandes filtrent leur sélecteur. Sans cette correspondance, elles
    // devraient passer un ChannelType, donc connaître la plateforme.
    const json = construireSlashCommand(definirCommande({
        nom: 'x', description: 'd', accesParDefaut: true,
        options: [{ nom: 'salon', type: 'canal', description: 'd', typesCanal: ['vocal', 'conference'] }],
        async executer() {},
    })).toJSON();
    // 2 = GuildVoice, 13 = GuildStageVoice
    assert.deepEqual(json.options[0].channel_types, [2, 13]);

    assert.throws(() => definirCommande({
        nom: 'x', description: 'd', accesParDefaut: true,
        options: [{ nom: 'salon', type: 'canal', description: 'd', typesCanal: ['forum'] }],
        async executer() {},
    }), /type de salon « forum » inconnu/);
});

// ── 8. Validation avant rendu ────────────────────────────────────────────────

test('une règle « autorise » invalide lève à l\'appel, pas dans le collecteur', async () => {
    // Elle était évaluée dans le filtre du collecteur, appelé par un écouteur
    // async de discord.js : l'exception devenait un rejet flottant que le
    // try/catch de choose() ne pouvait pas attraper, et le panneau restait muet
    // jusqu'à son expiration.
    const { validerAutorise } = require('../bot/platform/discord/context');
    assert.throws(() => validerAutorise('modo'), /n'est ni un mode connu/);
    assert.throws(() => validerAutorise(42), /n'est ni un mode connu/);
    for (const valeur of [undefined, 'auteur', 'tous', 'staff', 'MANAGE_GUILD', () => true]) {
        assert.doesNotThrow(() => validerAutorise(valeur), `refusée à tort : ${String(valeur)}`);
    }
});

// ── 12. L'échappatoire ne doit pas fuir ──────────────────────────────────────

test('« .brut » n\'est utilisé nulle part hors de bot/platform/', () => {
    // C'est la sortie de secours la plus tentante pour cinq agents pressés : un
    // seul `.brut` dans une commande migrée, et elle redevient Discord-only sans
    // qu'aucun test ne s'en aperçoive.
    const racine = path.join(__dirname, '..');
    const fautifs = [];

    (function parcourir(dossier) {
        for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
            if (entree.name === 'node_modules' || entree.name.startsWith('.')) continue;
            const chemin = path.join(dossier, entree.name);
            if (entree.isDirectory()) {
                if (chemin === path.join(racine, 'bot', 'platform')) continue;
                parcourir(chemin);
                continue;
            }
            if (!entree.name.endsWith('.js')) continue;
            const source = fs.readFileSync(chemin, 'utf8');
            // `.brut` précédé d'un identifiant : on ne veut pas des mots
            // français qui finiraient par « brut » dans un commentaire.
            if (/\w\.brut\b/.test(source)) fautifs.push(path.relative(racine, chemin));
        }
    })(path.join(racine, 'bot'));

    assert.deepEqual(fautifs, [],
        `« .brut » est une échappatoire de transition réservée à bot/platform/. `
        + `Ces fichiers doivent passer par le contrat neutre : ${fautifs.join(', ')}`);
});

// ── Déclaration d'un panneau par une commande (lot 0.5) ──────────────────────

test('une commande déclare son panneau, le chargeur l\'enregistre, un clic est routé', async () => {
    // C'est la promesse du registre : un lot déclare `panneaux` dans son
    // descripteur, ses clics sont routés, et aucun fichier partagé n'est touché.
    // Sans cette voie, `surPanneau` existait sans appelant et un lot n'avait que
    // deux issues, toutes deux interdites — appeler l'adaptateur au chargement,
    // ou écrire son préfixe en dur dans `bot/index.js`.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'commands'));
    fs.writeFileSync(path.join(dossier, 'ticket.js'), `
        const { definirCommande } = require(${chemin});
        module.exports = definirCommande({
            nom: 'ticket',
            description: 'Tickets',
            accesParDefaut: false,
            panneaux: {
                // Le NOM du panneau : le même qu'à la pose
                // (ctx.choose({ panneau: 'ticket' })) et qu'au routage.
                ticket: async (ctx, cle) => { global.__panneauVu = { cle, nom: ctx.panneau.nom }; },
            },
            async executer() {},
        });
    `);

    const { client } = faireClient();
    const adaptateur = creerAdaptateurDiscord({ client });
    const entrees = adaptateur.chargerCommandes({ dossier });

    assert.deepEqual(entrees.map(e => e.nom), ['ticket']);
    assert.deepEqual(entrees[0].panneaux, ['ticket'], 'l\'entrée annonce les panneaux qu\'elle porte');

    // Clic simulé : le routage doit retrouver le handler déclaré.
    const routage = adaptateur.routerPanneau({ customId: 'ticket:ouvrir', user: { id: '1' }, client: {} });
    assert.ok(routage, 'le clic doit être routé');
    await routage;

    assert.deepEqual(global.__panneauVu, { cle: 'ouvrir', nom: 'ticket' });
    delete global.__panneauVu;
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('un chargement sans adaptateur n\'enregistre rien', () => {
    // `deploy.js` charge les commandes sans adaptateur, pour n'en lire que le
    // JSON. Y enregistrer des panneaux les poserait deux fois — et la seconde
    // échouerait sur un doublon.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'commands'));
    fs.writeFileSync(path.join(dossier, 'ticket.js'), `
        const { definirCommande } = require(${chemin});
        module.exports = definirCommande({
            nom: 'ticket', description: 'Tickets', accesParDefaut: false,
            panneaux: { ticket: async () => {} },
            async executer() {},
        });
    `);

    const { chargerCommandes } = require('../bot/platform/discord/commands');
    assert.doesNotThrow(() => {
        chargerCommandes({ dossier });
        chargerCommandes({ dossier });
    });
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('deux commandes ne peuvent pas revendiquer le même panneau', () => {
    // Le message doit nommer LES DEUX commandes : « déjà enregistré » ne dit pas
    // laquelle, et six agents travaillent sur des fichiers qu'ils ne se
    // relisent pas.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'commands'));
    for (const nom of ['ticket', 'support']) {
        fs.writeFileSync(path.join(dossier, `${nom}.js`), `
            const { definirCommande } = require(${chemin});
            module.exports = definirCommande({
                nom: '${nom}', description: 'd', accesParDefaut: false,
                panneaux: { ticket: async () => {} },
                async executer() {},
            });
        `);
    }

    const adaptateur = creerAdaptateurDiscord({ client: faireClient().client });
    assert.throws(
        () => adaptateur.chargerCommandes({ dossier }),
        /Panneau « ticket » déclaré deux fois : par \/support et par \/ticket|par \/ticket et par \/support/,
    );
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('le nom du panneau est le même mot à la pose et au routage', () => {
    // `ctx.choose({ persistant: true, panneau })` doit produire un customId que
    // `routerPanneau` sait redécouper. Un désaccord de vocabulaire entre les
    // deux ferait poser des panneaux que personne ne route.
    const { rendreChoix } = require('../bot/platform/discord/render');
    const rangee = rendreChoix([{ cle: 'ouvrir', libelle: 'Ouvrir' }], 'ticket');
    const customId = rangee[0].toJSON().components[0].custom_id;
    assert.equal(customId, 'ticket:ouvrir');

    const adaptateur = creerAdaptateurDiscord({ client: faireClient().client });
    let vu = null;
    adaptateur.surPanneau('ticket', (ctx, cle) => { vu = cle; });
    adaptateur.routerPanneau({ customId, user: { id: '1' }, client: {} });
    assert.equal(vu, 'ouvrir');
});
