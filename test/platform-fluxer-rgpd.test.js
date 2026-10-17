// ═══════════════════════════════════════════════════════════════
//  Lot 0.9 — La fuite de /mes-donnees, et sa non-régression
//
//  `ctx.choose` de l'adaptateur Fluxer sortait par sa branche `persistant`
//  AVANT de lire `ephemere` / `sensible`, et postait sur le salon courant sans
//  condition. `bot/commands/mesdonnees.js` est le seul appelant de cette forme
//  — `{ persistant: true, ephemere: true }` — et son embed affirme « Ces
//  informations ne sont visibles que par vous ».
//
//  Conséquence observée : un membre tapait `!mes-donnees` dans un salon public,
//  et le bot y affichait ses compteurs de sanctions, de tickets et de
//  signalements. Pas de message privé, et pas même l'auto-suppression à quinze
//  secondes — la branche persistante ne la programmait pas. Le message restait.
//
//  Ce fichier rejoue l'appel EXACT de la commande. Il ne teste pas une
//  mécanique, il teste une promesse faite à une personne.
// ═══════════════════════════════════════════════════════════════

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.QUASAR_DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-rgpd-')), 'test.db',
);

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const creerAdaptateurFluxer = require('../bot/platform/fluxer');
const { creerEtat } = require('../bot/platform/fluxer/client');
const { creerContexteCommande } = require('../bot/platform/fluxer/context');
const { embed } = require('../bot/platform/embed');
const { getDb } = require('../api/services/database');

const GUILDE = '900000000000000000';
const SALON_PUBLIC = '300000000000000000';
const AUTEUR = '400000000000000000';
const BOT = '100000000000000000';
const MP = `mp-${AUTEUR}`;

// Compteur d'identifiants de message GLOBAL au fichier. Par adaptateur, deux
// tests réutiliseraient « msg1 » sur deux salons différents — et une assertion
// portant sur le seul `message_id` deviendrait ambiguë. La base, elle, est
// partagée par tous les tests du fichier.
let compteurMessages = 0;

const garde = setInterval(() => {}, 5);
test.after(() => clearInterval(garde));

/** Client en doublure : journalise tout envoi, sans réseau. */
function faireAdaptateur() {
    const client = new EventEmitter();
    client.setMaxListeners(0);
    client.etat = creerEtat();
    client.etat.poserGuilde({
        id: GUILDE,
        properties: { id: GUILDE, name: 'Venacity', owner_id: 'proprio' },
        roles: [{ id: GUILDE, name: '@everyone', position: 0, permissions: '0' }],
        channels: [{ id: SALON_PUBLIC, name: 'general', type: 0, guild_id: GUILDE, permission_overwrites: [] }],
        members: [], voice_states: [],
    });
    client.user = { id: BOT, username: 'Quasar' };
    client.isReady = () => true;
    client.passerelle = { latence: 12 };
    client.baseMedia = 'https://media.test';

    const envois = [];
    const supprimes = [];
    client.rest = {
        async post(chemin, options = {}) {
            if (chemin === '/users/@me/channels') return { id: MP };
            if (/\/messages$/.test(chemin)) {
                const canal = /\/channels\/([^/]+)\/messages$/.exec(chemin)[1];
                const id = `msg${++compteurMessages}`;
                envois.push({ canal, corps: options.body, id });
                return { id, channel_id: canal, type: 0, author: { id: BOT, bot: true }, embeds: options.body?.embeds || [], attachments: [], reactions: [] };
            }
            return null;
        },
        async patch() { return null; },
        async put() { return null; },
        async delete(chemin) {
            const m = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(chemin);
            if (m) supprimes.push({ canalId: m[1], messageId: m[2] });
            return null;
        },
        async get() { return null; },
    };
    client.envois = envois;
    client.supprimes = supprimes;

    const adaptateur = creerAdaptateurFluxer({ client, env: { FLUXER_TOKEN: 'factice' } });
    client.emit('clientReady');
    return { adaptateur, client };
}

function contexte(adaptateur) {
    return creerContexteCommande({
        guildeId: GUILDE, canalId: SALON_PUBLIC, messageId: 'origine', creeLe: Date.now(),
        auteur: { id: AUTEUR, username: 'ada', global_name: 'Ada' },
        membre: { user: { id: AUTEUR, username: 'ada' }, roles: [], guild_id: GUILDE },
    }, {
        adaptateur,
        descripteur: { nom: 'mes-donnees', description: 'd', accesParDefaut: true, options: [] },
        valeurs: {},
    });
}

// L'embed de `bot/commands/mesdonnees.js`, à la phrase près : c'est elle qui
// fait de cette fuite un manquement et pas un défaut d'affichage.
const PHRASE = 'Ces informations ne sont visibles que par vous.';
const EMBED_DONNEES = embed({
    titre: '🔒 Les données que Quasar traite vous concernant',
    couleur: 0xc8a86e,
    description: `Voici les catégories de données que Quasar traite à votre sujet **sur le serveur Venacity**. ${PHRASE}`,
    champs: [{ nom: '⚖️ Sanctions', valeur: '3 au total, dont 1 active' }],
    pied: { texte: 'Vous pouvez aussi déposer une demande de suppression directement ci-dessous.' },
});
const CHOIX = [{ cle: 'effacement', libelle: 'Demander la suppression de mes données', emoji: '🗑️', style: 'danger' }];
const PANNEAU = 'mesdonnees';

// ─── La preuve ───────────────────────────────────────────────────────────────

test('/mes-donnees — l\'inventaire personnel ne touche JAMAIS le salon public', async () => {
    const { adaptateur, client } = faireAdaptateur();

    // L'appel EXACT de bot/commands/mesdonnees.js.
    const resultat = await contexte(adaptateur).choose(EMBED_DONNEES, CHOIX, {
        persistant: true, panneau: PANNEAU, ephemere: true, sensible: true,
    });

    // ── 1. Rien de l'inventaire dans le salon public ─────────────────────────
    const publics = client.envois.filter(e => e.canal === SALON_PUBLIC);
    for (const envoi of publics) {
        const brut = JSON.stringify(envoi.corps);
        assert.ok(!brut.includes('Sanctions'), 'un compteur de sanctions est parti dans le salon public');
        assert.ok(!brut.includes(PHRASE), 'la phrase « visibles que par vous » est partie dans le salon public');
        assert.ok(!brut.includes('données que Quasar traite'), 'le titre de l\'inventaire est parti dans le salon public');
    }

    // ── 2. Le panneau est en message privé ───────────────────────────────────
    const prives = client.envois.filter(e => e.canal === MP);
    assert.equal(prives.length, 1, 'l\'inventaire doit partir en message privé, une fois');
    assert.equal(prives[0].corps.embeds[0].title, '🔒 Les données que Quasar traite vous concernant');
    assert.match(prives[0].corps.embeds[0].description, /Sanctions|visibles que par vous/);
    // La légende du choix est bien dans le panneau privé, sinon l'emoji serait muet.
    assert.match(prives[0].corps.embeds[0].description, /🗑️ \*\*Demander la suppression de mes données\*\*/);

    // ── 3. La ligne de panneau pointe le canal PRIVÉ ─────────────────────────
    assert.equal(resultat.persistant, true);
    assert.equal(resultat.canalId, MP, 'les coordonnées rendues doivent être celles du message privé');

    const ligne = getDb().prepare(
        'SELECT * FROM interaction_panels WHERE channel_id = ? AND message_id = ?'
    ).get(MP, resultat.messageId);
    assert.ok(ligne, 'sans ligne, le bouton de suppression serait muet après un redémarrage');
    assert.equal(ligne.kind, PANNEAU);
    assert.equal(
        ligne.guild_id, GUILDE,
        'la ligne porte le SERVEUR dont on parle, pas le salon privé : c\'est ce qui la rend purgeable',
    );

    // ── 4. Et un accusé neutre, lui, peut rester dans le salon ───────────────
    // (posé par `repondre`, pas par `choose` : aucun accusé ici, et c'est
    // acceptable — la personne reçoit son message privé.)
    assert.equal(publics.length, 0, 'choose sensible ne poste rien dans le salon');
});

test('le bouton de suppression reste routé DEPUIS le message privé', async () => {
    // Un panneau posé en privé n'a d'intérêt que si sa réaction y est captée :
    // c'est le parcours du droit à l'effacement (art. 17) en entier.
    const { adaptateur, client } = faireAdaptateur();

    const recu = [];
    adaptateur.surPanneau(PANNEAU, async (ctx, cle) => {
        recu.push({ cle, canalId: ctx.canalId, guildeId: ctx.guildeId, auteur: ctx.auteur?.id });
    }, '/mes-donnees');

    const pose = await contexte(adaptateur).choose(EMBED_DONNEES, CHOIX, {
        persistant: true, panneau: PANNEAU, ephemere: true, sensible: true,
    });

    // Réaction dans le salon PRIVÉ : « In a private channel the field is
    // delivered as session_id and excludes nobody » (gateway/events.md), le
    // dispatch arrive donc bien.
    client.emit('dispatch', 'MESSAGE_REACTION_ADD', {
        user_id: AUTEUR, channel_id: MP, message_id: pose.messageId,
        emoji: { name: '🗑️' },
        // Pas de `member` : « present in a guild channel » seulement.
    });
    await new Promise(r => setImmediate(r));

    assert.equal(recu.length, 1, 'la réaction en message privé doit être routée');
    assert.equal(recu[0].cle, 'effacement');
    assert.equal(recu[0].canalId, MP, 'le handler répond dans le salon privé');
    assert.equal(recu[0].guildeId, GUILDE, 'et sait de quel serveur il parle, grâce à la ligne en base');
    assert.equal(recu[0].auteur, AUTEUR);
});

test('un panneau éphémère NON sensible s\'auto-supprime, et sa ligne part avec lui', async () => {
    // L'autre moitié du repli. La branche persistante ne programmait AUCUNE
    // suppression : un panneau « éphémère » restait indéfiniment, avec sa ligne.
    const { adaptateur, client } = faireAdaptateur();
    const horloge = { minuteurs: [] };
    const vraiSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delai) => {
        const faux = { unref() { return faux; } };
        horloge.minuteurs.push({ fn, delai });
        return faux;
    };
    let pose;
    try {
        pose = await contexte(adaptateur).choose('Panneau non sensible', CHOIX, {
            persistant: true, panneau: 'temoin-ephemere', ephemere: true,
        });
    } finally {
        global.setTimeout = vraiSetTimeout;
    }

    assert.equal(pose.canalId, SALON_PUBLIC, 'sans « sensible », le panneau reste dans le salon');
    assert.ok(
        getDb().prepare('SELECT 1 FROM interaction_panels WHERE channel_id = ? AND message_id = ?')
            .get(SALON_PUBLIC, pose.messageId),
        'la ligne existe tant que le panneau vit',
    );

    const suppression = horloge.minuteurs.find(m => m.delai === 15000);
    assert.ok(suppression, 'l\'auto-suppression à 15 s doit être programmée — elle ne l\'était pas du tout');
    suppression.fn();
    await new Promise(r => setImmediate(r));

    assert.deepEqual(
        client.supprimes, [{ canalId: SALON_PUBLIC, messageId: pose.messageId }],
        'le message doit être supprimé',
    );
    assert.equal(
        getDb().prepare('SELECT 1 FROM interaction_panels WHERE channel_id = ? AND message_id = ?')
            .get(SALON_PUBLIC, pose.messageId),
        undefined,
        'et sa ligne avec lui, sinon routerPanneau relirait une ligne morte à chaque réaction',
    );
});

test('un panneau persistant ORDINAIRE reste dans le salon, et durable', async () => {
    // Non-régression de la forme la plus courante : `/ticket setup`, les
    // rôles-réactions, les salons vocaux temporaires. Ni `ephemere`, ni
    // `sensible` : rien ne doit changer pour eux.
    const { adaptateur, client } = faireAdaptateur();
    const pose = await contexte(adaptateur).choose(embed({ titre: 'Tickets' }), CHOIX, {
        persistant: true, panneau: 'ticket-ordinaire',
    });

    assert.equal(pose.canalId, SALON_PUBLIC);
    assert.equal(client.envois.filter(e => e.canal === MP).length, 0, 'aucun message privé ouvert');
    assert.ok(getDb().prepare('SELECT 1 FROM interaction_panels WHERE channel_id = ? AND message_id = ?')
        .get(SALON_PUBLIC, pose.messageId));
});

// ─── Hygiène de interaction_panels ───────────────────────────────────────────

test('la ligne d\'un panneau part avec son message et avec son salon', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const compter = () => getDb().prepare('SELECT COUNT(*) AS n FROM interaction_panels WHERE channel_id = ?')
        .get(SALON_PUBLIC).n;

    const a = await contexte(adaptateur).choose('A', CHOIX, { persistant: true, panneau: 'hygiene-a' });
    const b = await contexte(adaptateur).choose('B', CHOIX, { persistant: true, panneau: 'hygiene-b' });
    const avant = compter();
    assert.ok(avant >= 2);

    // Message supprimé : sa ligne seule part.
    client.emit('dispatch', 'MESSAGE_DELETE', { id: a.messageId, channel_id: SALON_PUBLIC, guild_id: GUILDE });
    assert.equal(compter(), avant - 1);

    // Salon supprimé : tout ce qu'il portait part. C'est le cas du salon vocal
    // temporaire, qui posait une ligne par salon créé et n'en retirait aucune.
    client.emit('dispatch', 'CHANNEL_DELETE', { id: SALON_PUBLIC, guild_id: GUILDE, type: 0 });
    assert.equal(compter(), 0, 'un salon supprimé ne doit laisser aucun panneau derrière lui');
    assert.ok(b.messageId, 'le second panneau existait bien avant la suppression du salon');
});

test('une suppression en lot emporte les panneaux qu\'elle efface', async () => {
    const { adaptateur, client } = faireAdaptateur();
    const pose = await contexte(adaptateur).choose('C', CHOIX, { persistant: true, panneau: 'hygiene-lot' });

    client.emit('dispatch', 'MESSAGE_DELETE_BULK', {
        ids: [pose.messageId, 'un-autre'], channel_id: SALON_PUBLIC, guild_id: GUILDE,
    });
    assert.equal(
        getDb().prepare('SELECT 1 FROM interaction_panels WHERE channel_id = ? AND message_id = ?')
            .get(SALON_PUBLIC, pose.messageId),
        undefined,
    );
});

test('interaction_panels est purgée au départ d\'un serveur', () => {
    // La table n'était listée NULLE PART : ni dans PURGE_STEPS, ni dans un
    // DELETE ailleurs dans le dépôt. Sa croissance n'était bornée par rien.
    const { PURGE_STEPS } = require('../bot/modules/retention/purge');
    const tables = PURGE_STEPS.map(s => s.table);
    assert.ok(tables.includes('interaction_panels'), 'interaction_panels doit être purgée avec le serveur');
    // Elle porte `guild_id NOT NULL` : elle appartenait à cette liste depuis le
    // premier jour.
    const colonnes = getDb().prepare('PRAGMA table_info(interaction_panels)').all();
    const guildId = colonnes.find(c => c.name === 'guild_id');
    assert.equal(guildId.notnull, 1);
});

// ─── Point 2 : le rendu Discord ne change pas d'un octet ─────────────────────

test('« sensible: true » ne change RIEN au rendu Discord', async () => {
    // `sensible` est une STRATÉGIE de repli, et Discord n'en a pas besoin : son
    // éphémère est réellement privé. L'ajouter à l'appel de /mes-donnees ne doit
    // donc rien changer là-bas — sans quoi on aurait corrigé une fuite en
    // cassant la plateforme en production.
    const creerAdaptateurDiscord = require('../bot/platform/discord');
    const contexteDiscord = require('../bot/platform/discord/context');

    const rendu = async (options) => {
        let payload = null;
        const interaction = {
            id: '1', createdTimestamp: 0,
            guild: { id: GUILDE, ownerId: 'proprio' },
            channel: { id: SALON_PUBLIC },
            user: { id: AUTEUR, username: 'ada' },
            member: { id: AUTEUR, roles: [], user: { id: AUTEUR }, permissions: null },
            options: { getString: () => null, getSubcommand: () => null },
            client: { ws: { ping: 1 } },
            async reply(p) { payload = p; return { id: 'ir' }; },
            async fetchReply() { return { id: 'msg-discord', channelId: SALON_PUBLIC }; },
        };
        const adaptateur = creerAdaptateurDiscord({
            client: { on() {}, once() {}, off() {}, rest: {}, channels: { cache: new Map() }, guilds: { cache: new Map() } },
            env: {},
        });
        const ctx = contexteDiscord.creerContexteCommande(interaction, {
            adaptateur,
            descripteur: { nom: 'mes-donnees', description: 'd', accesParDefaut: true, options: [] },
        });
        const resultat = await ctx.choose(EMBED_DONNEES, CHOIX, options);
        return { payload: JSON.stringify(payload), resultat };
    };

    const avant = await rendu({ persistant: true, panneau: PANNEAU, ephemere: true });
    const apres = await rendu({ persistant: true, panneau: PANNEAU, ephemere: true, sensible: true });

    assert.equal(apres.payload, avant.payload, 'le corps envoyé à Discord doit être identique');
    assert.deepEqual(apres.resultat, avant.resultat);
    // Et l'éphémère y est bien posé : c'est lui qui rend le message privé.
    assert.match(avant.payload, /"ephemeral":true/);
    assert.match(avant.payload, /mesdonnees:effacement/, 'le customId route toujours vers le panneau');
});

/**
 * Texte des arguments d'un appel, depuis sa parenthèse ouvrante.
 *
 * Équilibre les parenthèses en SAUTANT les chaînes — apostrophes, guillemets et
 * gabarits — parce qu'une parenthèse dans un message d'erreur ferait sinon
 * fermer l'appel bien trop tôt, et le contrôle deviendrait aveugle. Ce n'est pas
 * un analyseur JavaScript : il n'a qu'à délimiter un appel correctement écrit.
 */
function argumentsDeLAppel(source, indexParenthese) {
    let profondeur = 0;
    let i = indexParenthese;
    while (i < source.length) {
        const c = source[i];
        if (c === '\'' || c === '"' || c === '`') {
            const guillemet = c;
            i += 1;
            while (i < source.length && source[i] !== guillemet) {
                if (source[i] === '\\') i += 1;
                i += 1;
            }
        } else if (c === '(') {
            profondeur += 1;
        } else if (c === ')') {
            profondeur -= 1;
            if (profondeur === 0) return source.slice(indexParenthese, i + 1);
        }
        i += 1;
    }
    return source.slice(indexParenthese);
}

// ─── Point 3 : aucun autre appelant n'est exposé à la même faille ────────────

test('seul /mes-donnees combine un panneau et un repli d\'éphémère', () => {
    // La faille ne se déclenchait que sur la RENCONTRE de `persistant` et de
    // `ephemere`/`sensible`. Ce test énumère les appels de `choose` et de
    // `poserPanneau` dans tout `bot/` et fige la liste de ceux qui portent un
    // drapeau de confidentialité. Un nouvel appelant devra passer par ici — et
    // donc par une relecture — plutôt que d'hériter d'un repli silencieux.
    const dossiers = ['commands', 'events', 'modules', 'interactions', 'panneaux', 'utils'];
    const racine = path.join(__dirname, '..', 'bot');

    const fichiers = [];
    const parcourir = (dossier) => {
        if (!fs.existsSync(dossier)) return;
        for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
            const chemin = path.join(dossier, entree.name);
            if (entree.isDirectory()) parcourir(chemin);
            else if (entree.name.endsWith('.js')) fichiers.push(chemin);
        }
    };
    for (const d of dossiers) parcourir(path.join(racine, d));

    const avecDrapeau = [];
    const tousLesAppels = [];
    for (const fichier of fichiers) {
        const source = fs.readFileSync(fichier, 'utf8');
        const motif = /\.(choose|poserPanneau)\s*\(/g;
        let trouve;
        while ((trouve = motif.exec(source)) !== null) {
            const relatif = path.relative(racine, fichier);
            tousLesAppels.push(`${relatif} (${trouve[1]})`);
            // Les ARGUMENTS de l'appel, et eux seuls. Une fenêtre de taille
            // fixe ne suffit pas : un `ctx.repondre(…, { ephemere: true })`
            // écrit quelques lignes plus bas y tomberait, et le contrôle
            // signalerait deux appels de `/ticket` qui n'ont rien à voir.
            const args = argumentsDeLAppel(source, motif.lastIndex - 1);
            if (/\bephemere\s*:|\bsensible\s*:/.test(args)) avecDrapeau.push(`${relatif} (${trouve[1]})`);
        }
    }

    assert.ok(tousLesAppels.length >= 4, `trop peu d'appels trouvés (${tousLesAppels.length}) : le balayage est cassé`);
    assert.deepEqual(
        avecDrapeau, ['commands/mesdonnees.js (choose)'],
        'Un nouvel appel de choose/poserPanneau porte « ephemere » ou « sensible » : vérifiez que la '
        + 'destination du message respecte le repli de la DA §6.3 sur les DEUX plateformes, puis '
        + 'ajoutez-le ici. `poserPanneau` prend un salon EXPLICITE et n\'applique aucun repli : '
        + 'c\'est à son appelant de choisir le bon salon.',
    );
});
