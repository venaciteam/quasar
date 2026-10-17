// ═══════════════════════════════════════════════════════════════
//  Lot 8b — Verrou de mentions des commandes personnalisées
//
//  Le chemin TEXTE d'une commande personnalisée partait sans verrou, sur les
//  deux plateformes. Le commentaire qui l'expliquait invoquait le contrôle
//  d'accès `everyone` / `admins` / `role` comme seul garde — et ce raisonnement
//  se retourne exactement dans le cas qui compte : une commande en mode
//  `everyone`, qui est le mode PAR DÉFAUT. Le contrôle d'accès a alors fait son
//  travail en laissant passer tout le monde, et plus rien ne protégeait le
//  serveur.
//
//  Scénario : un détenteur de MANAGE_GUILD — le droit de créer une commande —
//  fabrique un `!faq` dont le texte contient `@everyone`. N'importe quel membre
//  le déclenche ensuite, autant de fois qu'il veut.
//
//  Règle retenue : les mentions qu'une commande personnalisée déclenche sont
//  celles que LA PERSONNE QUI LA DÉCLENCHE pourrait faire elle-même.
// ═══════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.QUASAR_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-mentions-')), 'test.db',
);

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const regle = require('../bot/platform/accesCommandePersonnalisee');
const commandesDiscord = require('../bot/platform/discord/commands');
const commandesFluxer = require('../bot/platform/fluxer/commands');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const creerAdaptateurFluxer = require('../bot/platform/fluxer');
const { creerEtat } = require('../bot/platform/fluxer/client');
const { getDb } = require('../api/services/database');

const GUILDE = '900000000000000000';
const SALON = '300000000000000000';
const AUTEUR = '400000000000000000';
const ROLE_OUVERT = '770000000000000000';   // mentionnable
const ROLE_STAFF = '780000000000000000';    // NON mentionnable

/** Membre normalisé, avec ou sans MENTION_EVERYONE. */
const membre = (permissions = []) => ({
    id: AUTEUR, roles: [], aPermission: (nom) => permissions.includes(nom),
});

const ROLES = new Map([
    [ROLE_OUVERT, { id: ROLE_OUVERT, name: 'Événement', mentionable: true }],
    [ROLE_STAFF, { id: ROLE_STAFF, name: 'Staff', mentionable: false }],
]);

// ─── La règle elle-même ──────────────────────────────────────────────────────

test('sans MENTION_EVERYONE, « @everyone » est écrit mais ne notifie personne', () => {
    const texte = `Coucou @everyone ! Voir <@&${ROLE_OUVERT}> et <@${AUTEUR}>.`;
    const verrou = regle.mentionsAutoriseesPour(membre([]), { contenu: texte, roles: ROLES });

    assert.deepEqual(verrou.parse, [], 'aucune catégorie ouverte : @everyone et @here restent du texte');
    assert.deepEqual(verrou.users, [AUTEUR], 'une mention d\'utilisateur passe toujours');
    assert.deepEqual(verrou.roles, [ROLE_OUVERT], 'un rôle mentionnable passe toujours');
});

test('avec MENTION_EVERYONE, rien n\'est restreint', () => {
    const texte = `Coucou @everyone ! <@&${ROLE_STAFF}>`;
    const verrou = regle.mentionsAutoriseesPour(membre(['MENTION_EVERYONE']), { contenu: texte, roles: ROLES });

    assert.deepEqual(
        verrou.parse.sort(), ['everyone', 'roles', 'users'],
        'la personne pourrait taper ce message elle-même : on n\'ajoute aucune restriction',
    );
    // ⚠️ Les deux plateformes REFUSENT un `parse` non vide combiné à une liste
    // `users` ou `roles` non vide (Fluxer : PARSE_AND_USERS_OR_ROLES_CANNOT_BE_USED_TOGETHER).
    // La forme par catégories doit donc rester SEULE.
    assert.ok(!verrou.users?.length, 'pas de liste users à côté d\'un parse non vide');
    assert.ok(!verrou.roles?.length, 'pas de liste roles à côté d\'un parse non vide');
});

test('un rôle NON mentionnable ne part qu\'avec MENTION_EVERYONE', () => {
    const texte = `Alerte <@&${ROLE_STAFF}>`;
    // « mentionable | Whether a member without MENTION_EVERYONE can mention the
    // role » (http-api/permissions.mdx) : un rôle staff est typiquement non
    // mentionnable, précisément pour que les membres ne puissent pas le pinger.
    const sans = regle.mentionsAutoriseesPour(membre([]), { contenu: texte, roles: ROLES });
    assert.deepEqual(sans.roles, [], 'le rôle staff ne doit pas être notifié');

    const avec = regle.mentionsAutoriseesPour(membre(['MENTION_EVERYONE']), { contenu: texte, roles: ROLES });
    assert.ok(avec.parse.includes('roles'));
});

test('un rôle mentionnable passe dans les DEUX cas', () => {
    const texte = `À vos agendas <@&${ROLE_OUVERT}>`;
    const sans = regle.mentionsAutoriseesPour(membre([]), { contenu: texte, roles: ROLES });
    const avec = regle.mentionsAutoriseesPour(membre(['MENTION_EVERYONE']), { contenu: texte, roles: ROLES });

    assert.deepEqual(sans.roles, [ROLE_OUVERT], 'c\'est l\'usage même des commandes personnalisées');
    assert.ok(avec.parse.includes('roles'));
});

test('un rôle INCONNU du cache passe : on ne fait pas taire un ping sur un manque', () => {
    const inconnu = '790000000000000000';
    const verrou = regle.mentionsAutoriseesPour(membre([]), {
        contenu: `<@&${inconnu}>`, roles: ROLES,
    });
    assert.deepEqual(verrou.roles, [inconnu]);
});

test('un membre ILLISIBLE ne peut pas notifier tout le monde', () => {
    // Le cas d'un déclenchement hors serveur. Un « je ne sais pas » ne devient
    // jamais un droit de notifier tout le serveur.
    assert.equal(regle.peutMentionnerTous(null), false);
    const verrou = regle.mentionsAutoriseesPour(null, { contenu: '@everyone', roles: ROLES });
    assert.deepEqual(verrou.parse, []);
});

test('les mentions sont dédoublonnées et plafonnées à 100', () => {
    // Au-delà de 100 entrées, les deux plateformes rejettent le MESSAGE ENTIER.
    // ⚠️ Les identifiants sont construits en CHAÎNE : un snowflake dépasse
    // Number.MAX_SAFE_INTEGER, et `500000000000000000 + i` rendrait la même
    // valeur flottante pour des dizaines de `i` — le test se serait cru vert
    // avec trois identifiants distincts.
    const beaucoup = Array.from({ length: 150 }, (_, i) => `<@5000000000000${String(i).padStart(5, '0')}>`).join(' ');
    const verrou = regle.mentionsAutoriseesPour(membre([]), { contenu: `${beaucoup} <@${AUTEUR}> <@${AUTEUR}>` });
    assert.equal(verrou.users.length, regle.MAX_MENTIONS);
});

test('sans contenu, le verrou protège encore « @everyone »', () => {
    // Forme dégradée : on ne peut pas énumérer, mais la catégorie dangereuse
    // reste fermée.
    const verrou = regle.mentionsAutoriseesPour(membre([]));
    assert.deepEqual(verrou.parse.sort(), ['roles', 'users']);
    assert.ok(!verrou.parse.includes('everyone'));
});

// ─── Le chemin embed ─────────────────────────────────────────────────────────

test('le rejeu des mentions d\'un embed est restreint, jamais élargi', () => {
    const { buildMentionPayload } = require('../api/services/mentions');
    const { allowedMentions: configure } = buildMentionPayload({
        mention_everyone: 1, mention_roles: JSON.stringify([ROLE_STAFF, ROLE_OUVERT]), mention_users: '[]',
    });
    assert.ok(configure.parse.includes('everyone'), 'la configuration de l\'embed demande bien @everyone');

    const sans = regle.restreindreMentionsAuDeclencheur(configure, membre([]), { roles: ROLES });
    assert.deepEqual(sans.parse, [], '@everyone retiré');
    assert.deepEqual(sans.roles, [ROLE_OUVERT], 'le rôle non mentionnable aussi');

    const avec = regle.restreindreMentionsAuDeclencheur(configure, membre(['MENTION_EVERYONE']), { roles: ROLES });
    assert.deepEqual(avec.parse, ['everyone']);
    assert.deepEqual(avec.roles.sort(), [ROLE_OUVERT, ROLE_STAFF].sort());
});

test('on RETIRE, on n\'ajoute jamais', () => {
    // Une configuration qui ne demande pas @everyone ne doit pas se le voir
    // accorder parce que le déclencheur en a le droit.
    const configure = { parse: [], roles: [], users: [AUTEUR] };
    const verrou = regle.restreindreMentionsAuDeclencheur(configure, membre(['MENTION_EVERYONE']), { roles: ROLES });
    assert.deepEqual(verrou.parse, []);
    assert.deepEqual(verrou.users, [AUTEUR]);
});

// ─── UNE seule règle pour les deux plateformes ───────────────────────────────

test('les deux adaptateurs partagent la MÊME fonction, pas une copie', () => {
    assert.equal(commandesDiscord.mentionsAutoriseesPour ?? regle.mentionsAutoriseesPour, regle.mentionsAutoriseesPour);
    // Sur les modules de commandes, et sur les adaptateurs.
    const discord = creerAdaptateurDiscord({
        client: { on() {}, once() {}, off() {}, rest: {}, channels: { cache: new Map() }, guilds: { cache: new Map() } },
        env: {},
    });
    const fluxer = creerAdaptateurFluxer({ env: { FLUXER_TOKEN: 'factice' } });

    const texte = `@everyone <@${AUTEUR}> <@&${ROLE_STAFF}>`;
    for (const personne of [membre([]), membre(['MENTION_EVERYONE'])]) {
        const cote = (a) => JSON.stringify(a.mentionsAutoriseesPour(personne, { contenu: texte, roles: ROLES }));
        assert.equal(
            cote(fluxer), cote(discord),
            'le même corps doit sortir des deux côtés sur les mêmes entrées',
        );
    }
    // Et le verrou d'embed aussi.
    const configure = { parse: ['everyone'], roles: [ROLE_STAFF], users: [] };
    assert.equal(
        JSON.stringify(fluxer.restreindreMentionsAuDeclencheur(configure, membre([]), { roles: ROLES })),
        JSON.stringify(discord.restreindreMentionsAuDeclencheur(configure, membre([]), { roles: ROLES })),
    );
});

// ─── Le corps réellement envoyé, côté Fluxer ─────────────────────────────────

test('Fluxer — le corps d\'une commande texte porte son verrou', () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Venacity');
    db.prepare(`INSERT OR REPLACE INTO custom_commands (guild_id, name, response, access_mode)
                VALUES (?, ?, ?, 'everyone')`)
        .run(GUILDE, 'faq', `@everyone lisez la FAQ, <@&${ROLE_OUVERT}>`);
    const ligne = db.prepare('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?').get(GUILDE, 'faq');

    const sans = commandesFluxer.rendreCommandePersonnalisee(ligne, db, { membre: membre([]), roles: ROLES });
    assert.ok(sans.mentionsAutorisees, 'le chemin texte ne doit JAMAIS partir sans verrou');
    assert.deepEqual(sans.mentionsAutorisees.parse, []);
    assert.deepEqual(sans.mentionsAutorisees.roles, [ROLE_OUVERT]);
    assert.equal(sans.contenu, ligne.response, 'le texte lui-même n\'est pas modifié');

    const avec = commandesFluxer.rendreCommandePersonnalisee(ligne, db, {
        membre: membre(['MENTION_EVERYONE']), roles: ROLES,
    });
    assert.ok(avec.mentionsAutorisees.parse.includes('everyone'));
});

test('Fluxer — le dispatch complet applique le verrou, de bout en bout', async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Venacity');
    db.prepare(`INSERT OR REPLACE INTO custom_commands (guild_id, name, response, access_mode)
                VALUES (?, ?, ?, 'everyone')`)
        .run(GUILDE, 'ping-tous', '@everyone alerte');

    const client = new EventEmitter();
    client.setMaxListeners(0);
    client.etat = creerEtat();
    client.etat.poserGuilde({
        id: GUILDE,
        properties: { id: GUILDE, name: 'Venacity', owner_id: 'proprio' },
        roles: [{ id: GUILDE, name: '@everyone', position: 0, permissions: '0' }],
        channels: [{ id: SALON, name: 'general', type: 0, guild_id: GUILDE }],
        members: [], voice_states: [],
    });
    client.user = { id: 'BOT', username: 'Quasar' };
    client.isReady = () => true;
    client.passerelle = { latence: 1 };

    const envois = [];
    client.rest = {
        async post(chemin, options = {}) {
            if (/\/messages$/.test(chemin)) {
                envois.push(options.body);
                return { id: 'm1', channel_id: SALON, type: 0, author: { id: 'BOT', bot: true }, embeds: [], attachments: [], reactions: [] };
            }
            return null;
        },
        async patch() { return null; }, async put() { return null; },
        async delete() { return null; }, async get() { return null; },
    };

    const adaptateur = creerAdaptateurFluxer({ client, env: { FLUXER_TOKEN: 'factice', COMMAND_PREFIX: '!' } });
    client.emit('clientReady');
    await adaptateur.enregistrerCommandes([]);

    // Un membre ORDINAIRE tape la commande dans un salon public.
    client.emit('dispatch', 'MESSAGE_CREATE', {
        id: 'in1', channel_id: SALON, guild_id: GUILDE, type: 0, content: '!ping-tous',
        author: { id: AUTEUR, username: 'ada' },
        member: { roles: [], guild_id: GUILDE }, attachments: [], embeds: [], mentions: [],
    });
    await new Promise(r => setTimeout(r, 30));

    assert.equal(envois.length, 1, 'la commande répond bien');
    assert.equal(envois[0].content, '@everyone alerte', 'le texte part tel quel');
    assert.ok(envois[0].allowed_mentions, 'et il porte un verrou de mentions');
    assert.deepEqual(
        envois[0].allowed_mentions.parse, [],
        'un membre sans MENTION_EVERYONE ne doit pas pouvoir notifier tout le serveur',
    );
});

// ─── Contrôle permanent ──────────────────────────────────────────────────────

test('aucun dispatch de commande personnalisée n\'envoie sans verrou de mentions', () => {
    // Le contrôle qui empêche la régression. Une commande personnalisée a
    // exactement DEUX formes de réponse, et chacune est gardée par la colonne
    // qu'elle lit : `embed_id` pour l'embed, `response` pour le texte. On exige
    // que le corps de chaque branche porte `mentionsAutorisees`.
    //
    // ⚠️ Un simple COMPTAGE (autant de verrous que d'envois) ne suffisait pas :
    // la branche embed rend une variable et non un littéral, si bien qu'un
    // verrou retiré du chemin texte laissait le compte juste. Le contrôle
    // vérifie donc chaque BRANCHE, nommée.
    const BRANCHES = [
        { guard: /if\s*\(\s*\w+\.embed_id\s*\)/, quoi: 'chemin embed' },
        { guard: /if\s*\(\s*\w+\.response\s*\)/, quoi: 'chemin texte' },
    ];
    const DISPATCHS = [
        { fichier: 'bot/index.js', depuis: 'FROM custom_commands' },
        { fichier: 'bot/platform/fluxer/commands.js', depuis: 'function rendreCommandePersonnalisee' },
    ];

    // ⚠️ Les COMMENTAIRES sont retirés avant de mesurer. Sans cela, une
    // fenêtre de taille fixe dépend de la longueur des explications écrites
    // au-dessus du code : ce contrôle échouait sur du code parfaitement correct
    // dès que le commentaire qui décrit la règle dépassait quelques lignes. Un
    // contrôle qui punit la documentation finit par la faire disparaître.
    // L'INDENTATION est aplatie elle aussi : à vingt-huit espaces par ligne, une
    // fenêtre de neuf cents caractères ne couvre que neuf lignes, et le contrôle
    // dépendrait de la profondeur des accolades autour du code qu'il inspecte.
    const codeSeul = (source) => source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .replace(/[ \t]+/g, ' ');

    for (const { fichier, depuis } of DISPATCHS) {
        const brut = fs.readFileSync(path.join(__dirname, '..', fichier), 'utf8');
        const source = codeSeul(brut);
        const debutPortee = source.indexOf(depuis);
        assert.ok(debutPortee > 0, `${fichier} : ancre « ${depuis} » introuvable, le contrôle est cassé`);
        const portee = source.slice(debutPortee, debutPortee + 4000);

        // Position de chaque branche, pour borner CHACUNE par la suivante.
        // Sans cette borne, les fenêtres se chevauchent : le verrou du chemin
        // texte tombait dans la fenêtre du chemin embed, et retirer celui de
        // l'embed ne faisait plus rien échouer. Une fenêtre qui déborde sur la
        // branche voisine ne contrôle plus rien.
        const positions = BRANCHES.map(({ guard, quoi }) => {
            const trouve = guard.exec(portee);
            assert.ok(trouve, `${fichier} : ${quoi} introuvable, le contrôle est cassé`);
            return { index: trouve.index, quoi };
        }).sort((a, b) => a.index - b.index);

        for (let rang = 0; rang < positions.length; rang += 1) {
            const { index, quoi } = positions[rang];
            const fin = positions[rang + 1]?.index ?? Math.min(index + 1200, portee.length);
            const corps = portee.slice(index, fin);
            assert.match(
                corps, /mentionsAutorisees\s*:/,
                `${fichier} : le ${quoi} d'une commande personnalisée envoie SANS verrou de mentions. `
                + 'Tout envoi doit porter « mentionsAutorisees » — la règle est dans '
                + 'bot/platform/accesCommandePersonnalisee.js, et son absence a valu à une instance '
                + 'publique un canon à @everyone déclenchable par n\'importe quel membre.',
            );
        }

        // Et le commentaire qui justifiait l'absence de verrou ne doit pas
        // revenir : c'est lui qui a tenu le défaut en place pendant une version
        // entière.
        // Cherché dans le source BRUT : c'est un commentaire.
        assert.equal(
            /volontairement SANS (allowedMentions|mentions autoris)/.test(brut), false,
            `${fichier} : le commentaire « volontairement SANS mentions autorisées » est faux, `
            + 'il ne doit pas réapparaître.',
        );
    }
});
