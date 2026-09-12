// ═══════════════════════════════════════════════════════════════
//  Lot 6 — Miroir des deux adaptateurs
//
//  Le chantier multiplateforme ne tient qu'à une promesse : une commande, un
//  événement ou un module écrit une seule fois trouve LA MÊME CHOSE sur les deux
//  plateformes. Ce fichier est le seul endroit qui la vérifie mécaniquement.
//
//  Trois surfaces sont comparées clé pour clé et arité pour arité :
//    • l'adaptateur, ce que `resolvePlatform()` rend ;
//    • le client REST `api`, les 34 méthodes de la DA §4.3 ;
//    • le contexte `ctx`, ce qu'une commande reçoit.
//
//  Et une quatrième chose, plus fine : chaque normaliseur doit rendre les MÊMES
//  CLÉS sur un payload représentatif de sa plateforme. Une clé qui manque d'un
//  côté, c'est un `undefined` silencieux le jour de la bascule.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const creerAdaptateurDiscord = require('../bot/platform/discord');
const creerAdaptateurFluxer = require('../bot/platform/fluxer');
const contexteDiscord = require('../bot/platform/discord/context');
const contexteFluxer = require('../bot/platform/fluxer/context');
const evenementsDiscord = require('../bot/platform/discord/events');
const evenementsFluxer = require('../bot/platform/fluxer/events');
const { EVENEMENTS_NEUTRES } = require('../bot/platform/events');
const { PERMISSIONS } = require('../bot/platform/permissions');
const { NOMS_CAPACITES } = require('../bot/platform/capabilities');
const commandesDiscord = require('../bot/platform/discord/commands');
const commandesFluxer = require('../bot/platform/fluxer/commands');
const renderDiscord = require('../bot/platform/discord/render');
const renderFluxer = require('../bot/platform/fluxer/render');
const snowflakeDiscord = require('../bot/platform/discord/snowflake');
const snowflakeFluxer = require('../bot/platform/fluxer/snowflake');

// Doublures minimales : aucun réseau, aucun jeton, aucune base.
const clientDiscord = () => ({ on() {}, once() {}, off() {}, rest: {}, guilds: { cache: new Map() } });
const adaptateurs = () => [
    creerAdaptateurDiscord({ client: clientDiscord(), env: {} }),
    creerAdaptateurFluxer({ env: { FLUXER_TOKEN: 'factice' } }),
];

/** Compare deux surfaces : noms puis arités. */
function comparerSurfaces(a, b, quoi) {
    const clesA = Object.keys(a).sort();
    const clesB = Object.keys(b).sort();
    assert.deepEqual(
        clesB.filter(cle => !clesA.includes(cle)), [],
        `${quoi} : Fluxer expose des clés que Discord n'a pas`,
    );
    assert.deepEqual(
        clesA.filter(cle => !clesB.includes(cle)), [],
        `${quoi} : Fluxer n'expose pas des clés que Discord a`,
    );
    for (const cle of clesA) {
        if (typeof a[cle] !== 'function') continue;
        assert.equal(typeof b[cle], 'function', `${quoi} : « ${cle} » n'est pas une fonction côté Fluxer`);
        assert.equal(
            b[cle].length, a[cle].length,
            `${quoi} : « ${cle} » n'a pas la même arité (Discord ${a[cle].length}, Fluxer ${b[cle].length})`,
        );
    }
}

test('les deux adaptateurs exposent la même surface', () => {
    const [discord, fluxer] = adaptateurs();
    comparerSurfaces(discord, fluxer, 'adaptateur');
    assert.equal(discord.nom, 'discord');
    assert.equal(fluxer.nom, 'fluxer');
});

test('les deux clients REST exposent les mêmes méthodes', () => {
    const [discord, fluxer] = adaptateurs();
    comparerSurfaces(discord.api, fluxer.api, 'api');
    // La DA §4.3 ne les compte pas, mais leur nombre est un garde-fou utile :
    // une méthode ajoutée d'un seul côté échouerait déjà sur la comparaison,
    // et celle-ci rend le compte lisible dans le rapport de test.
    assert.ok(Object.keys(fluxer.api).length >= 30, 'le client REST neutre a maigri');
});

test('les deux plateformes déclarent toutes les capacités du contrat', () => {
    const [discord, fluxer] = adaptateurs();
    for (const capacite of NOMS_CAPACITES) {
        assert.equal(typeof discord.capacites[capacite], 'boolean', `Discord : ${capacite}`);
        assert.equal(typeof fluxer.capacites[capacite], 'boolean', `Fluxer : ${capacite}`);
    }
    // Ce que Fluxer ne sait PAS faire, et que le code métier teste.
    assert.equal(fluxer.capacites.interactions, false);
    assert.equal(fluxer.capacites.ephemere, false);
    assert.equal(fluxer.capacites.automod, false);
    assert.equal(fluxer.capacites.audioBot, false);
    assert.equal(fluxer.capacites.pauseInvitations, false);
    // Ce qu'il sait faire.
    assert.equal(fluxer.capacites.timeout, true);
    assert.equal(fluxer.capacites.bulkDelete, true);
});

test('les deux tables de permissions traduisent tout le vocabulaire canonique', () => {
    const [discord, fluxer] = adaptateurs();
    for (const nom of PERMISSIONS) {
        assert.equal(typeof discord.permissions[nom], 'bigint', `Discord : ${nom}`);
        assert.equal(typeof fluxer.permissions[nom], 'bigint', `Fluxer : ${nom}`);
    }
    // Les bits sont lus dans http-api/permissions.mdx, jamais déduits de
    // Discord. Ce test ne vérifie donc PAS qu'ils sont égaux — il verrouille la
    // valeur SOURCÉE de la seule permission dont la position est inhabituelle,
    // et le fait qu'elle soit un BigInt : Fluxer définit des bits jusqu'à
    // 1<<54 (VIEW_CHANNEL_MEMBERS), et un `number` y perdrait des bits en
    // silence dès qu'une de ces permissions entrerait dans le vocabulaire.
    assert.equal(fluxer.permissions.MODERATE_MEMBERS, 1n << 40n);
    assert.equal(fluxer.permissions.ADMINISTRATOR, 1n << 3n);
});

test('les deux tables d\'événements couvrent tout le vocabulaire neutre', () => {
    for (const nom of EVENEMENTS_NEUTRES) {
        assert.ok(evenementsDiscord.EVENEMENTS[nom], `Discord : ${nom} absent`);
        assert.ok(evenementsFluxer.EVENEMENTS[nom], `Fluxer : ${nom} absent`);
    }
    // `sanctionAutomatique` est déclaré des deux côtés, mais SANS événement
    // natif côté Fluxer. C'est cette valeur `null`, et non une absence, qui
    // distingue « la plateforme ne l'a pas » de « l'adaptateur a oublié ».
    assert.equal(evenementsFluxer.EVENEMENTS.sanctionAutomatique[0], null);
    assert.equal(evenementsDiscord.EVENEMENTS.sanctionAutomatique[0], 'autoModerationActionExecution');
});

test('s\'abonner à un événement que Fluxer n\'a pas échoue en le disant', () => {
    const fluxer = creerAdaptateurFluxer({ env: { FLUXER_TOKEN: 'factice' } });
    assert.throws(
        () => fluxer.surEvenement('sanctionAutomatique', () => {}),
        /n'existe pas sur Fluxer/,
    );
});

// ─── Normaliseurs : les mêmes clés, des deux côtés ───────────────────────────

/**
 * Payloads REPRÉSENTATIFS de chaque plateforme. Ils ne sont pas identiques —
 * c'est bien le sujet : Fluxer parle snake_case et Discord expose des objets
 * camelCase. Ce qui doit être identique, c'est ce qui en RESSORT.
 */
const CAS = [
    {
        nom: 'utilisateur',
        discord: { fn: contexteDiscord.normaliserUtilisateur, payload: { id: '1', username: 'ada', globalName: 'Ada', tag: 'ada', bot: false } },
        fluxer: { fn: contexteFluxer.normaliserUtilisateur, payload: { id: '1', username: 'ada', global_name: 'Ada', discriminator: '0042' } },
    },
    {
        nom: 'role',
        discord: { fn: contexteDiscord.normaliserRole, payload: { id: '2', name: 'Mod', position: 4, managed: false, color: 3447003, guildId: '9' } },
        fluxer: { fn: contexteFluxer.normaliserRole, payload: { id: '2', name: 'Mod', position: 4, color: 3447003, guild_id: '9' } },
    },
    {
        nom: 'canal',
        discord: { fn: contexteDiscord.normaliserCanal, payload: { id: '3', name: 'general', type: 0, guildId: '9', parentId: '8' } },
        fluxer: { fn: contexteFluxer.normaliserCanal, payload: { id: '3', name: 'general', type: 0, guild_id: '9', parent_id: '8' } },
    },
    {
        nom: 'membre',
        discord: {
            fn: contexteDiscord.normaliserMembre,
            payload: {
                id: '4', nick: 'Ada', roles: ['2'], joined_at: '2026-01-01T00:00:00.000Z',
                user: { id: '4', username: 'ada', discriminator: '0' }, permissions: null,
            },
        },
        fluxer: {
            fn: contexteFluxer.normaliserMembre,
            payload: {
                nick: 'Ada', roles: ['2'], joined_at: '2026-01-01T00:00:00.000Z', mute: false, deaf: false,
                communication_disabled_until: null, guild_id: '9',
                user: { id: '4', username: 'ada', discriminator: '0042' },
            },
        },
    },
    {
        nom: 'guilde',
        discord: { fn: contexteDiscord.normaliserGuilde, payload: { id: '9', name: 'Venacity', ownerId: '4', memberCount: 12 } },
        fluxer: { fn: contexteFluxer.normaliserGuilde, payload: { id: '9', name: 'Venacity', owner_id: '4', member_count: 12 } },
    },
    {
        nom: 'message',
        discord: {
            fn: evenementsDiscord.normaliserMessage,
            payload: {
                id: '5', channel_id: '3', guild_id: '9', type: 0, content: 'salut',
                author: { id: '4', username: 'ada' }, timestamp: '2026-01-01T00:00:00.000Z',
                attachments: [], embeds: [], reactions: [],
            },
        },
        fluxer: {
            fn: evenementsFluxer.normaliserMessage,
            payload: {
                id: '5', channel_id: '3', guild_id: '9', type: 0, content: 'salut',
                author: { id: '4', username: 'ada' }, timestamp: '2026-01-01T00:00:00.000Z',
                attachments: [], embeds: [], reactions: [],
            },
        },
    },
    {
        nom: 'reaction',
        discord: {
            fn: evenementsDiscord.normaliserReaction,
            payload: { message: { id: '5', channelId: '3', guildId: '9' }, emoji: { id: null, name: '🎮' } },
        },
        fluxer: {
            fn: evenementsFluxer.normaliserReaction,
            payload: { message_id: '5', channel_id: '3', guild_id: '9', emoji: { name: '🎮' } },
        },
    },
    {
        nom: 'etatVocal',
        discord: {
            fn: evenementsDiscord.normaliserEtatVocal,
            payload: { guildId: '9', id: '4', channelId: '7', serverMute: false, selfMute: true, serverDeaf: false, selfDeaf: false, member: null },
        },
        fluxer: {
            fn: evenementsFluxer.normaliserEtatVocal,
            payload: { guild_id: '9', user_id: '4', channel_id: '7', mute: false, self_mute: true, deaf: false, self_deaf: false, member: null },
        },
    },
];

for (const cas of CAS) {
    test(`normaliserX rend les mêmes clés des deux côtés : ${cas.nom}`, () => {
        const cotéDiscord = cas.discord.fn(cas.discord.payload);
        const cotéFluxer = cas.fluxer.fn(cas.fluxer.payload);
        assert.ok(cotéDiscord && cotéFluxer, `${cas.nom} : un des deux normaliseurs rend null`);

        // `Object.keys` suffit et c'est voulu : ce qui est non énumérable n'est
        // pas du contrat, et un getter (`muet`, `sourd`) l'est.
        const clesD = Object.keys(cotéDiscord).sort();
        const clesF = Object.keys(cotéFluxer).sort();
        assert.deepEqual(clesF, clesD, `${cas.nom} : les clés diffèrent`);

        // Et le TYPE de chaque valeur, pour qu'une clé présente mais toujours
        // nulle d'un côté se voie. Les valeurs nulles sont tolérées : une même
        // clé peut légitimement être renseignée d'un côté et pas de l'autre sur
        // ces payloads réduits.
        for (const cle of clesD) {
            const d = cotéDiscord[cle];
            const f = cotéFluxer[cle];
            if (d === null || f === null || d === undefined || f === undefined) continue;
            assert.equal(typeof f, typeof d, `${cas.nom}.${cle} : types différents`);
        }
    });
}

test('les entités normalisées ne laissent fuir aucun objet natif', () => {
    // `.brut` a existé le temps des lots 1 à 5 et a été retiré à la
    // consolidation. Le vérifier des deux côtés évite qu'un adaptateur le
    // réintroduise en croyant bien faire.
    for (const cas of CAS) {
        const cotéFluxer = cas.fluxer.fn(cas.fluxer.payload);
        assert.equal(cotéFluxer.brut, undefined, `${cas.nom} : « brut » a été réintroduit côté Fluxer`);
    }
});

// ─── Le contexte, construit en doublure des deux côtés ───────────────────────

test('le contexte d\'une commande a la même surface des deux côtés', () => {
    const [discord, fluxer] = adaptateurs();
    const descripteur = { nom: 'temoin', description: 'témoin', accesParDefaut: true, options: [] };

    const interaction = {
        id: '1', createdTimestamp: 0,
        guild: { id: '9', ownerId: '4' },
        channel: { id: '3' },
        user: { id: '4', username: 'ada' },
        member: { id: '4', roles: [], user: { id: '4', username: 'ada' }, permissions: null },
        options: { getString: () => null, getSubcommand: () => null },
        client: { ws: { ping: 12 } },
    };
    const ctxDiscord = contexteDiscord.creerContexteCommande(interaction, { adaptateur: discord, descripteur });

    const source = {
        guildeId: '9', canalId: '3', messageId: '5', creeLe: 0,
        auteur: { id: '4', username: 'ada' },
        membre: { user: { id: '4', username: 'ada' }, roles: [], guild_id: '9' },
    };
    const ctxFluxer = contexteFluxer.creerContexteCommande(source, { adaptateur: fluxer, descripteur, valeurs: {} });

    comparerSurfaces(ctxDiscord, ctxFluxer, 'ctx de commande');
    assert.equal(ctxFluxer.plateforme, 'fluxer');
    assert.equal(ctxDiscord.plateforme, 'discord');
});

test('le contexte d\'un panneau a la même surface des deux côtés', () => {
    const [discord, fluxer] = adaptateurs();

    const clic = {
        id: '1', createdTimestamp: 0, customId: 'ticket:ouvrir',
        guild: { id: '9', ownerId: '4' }, channel: { id: '3' },
        user: { id: '4', username: 'ada' },
        member: { id: '4', roles: [], user: { id: '4' }, permissions: null },
        message: { id: '5' },
        client: { ws: { ping: 12 } },
    };
    const ctxDiscord = contexteDiscord.creerContextePanneau(clic, { adaptateur: discord, panneau: 'ticket', cle: 'ouvrir' });
    const ctxFluxer = contexteFluxer.creerContextePanneau({
        guildeId: '9', canalId: '3', messageId: '5', creeLe: 0,
        auteur: { id: '4', username: 'ada' },
        membre: { user: { id: '4' }, roles: [], guild_id: '9' },
    }, { adaptateur: fluxer, panneau: 'ticket', cle: 'ouvrir' });

    comparerSurfaces(ctxDiscord, ctxFluxer, 'ctx de panneau');
    assert.deepEqual(Object.keys(ctxFluxer.panneau).sort(), Object.keys(ctxDiscord.panneau).sort());
});

test('le contexte d\'un événement a la même surface des deux côtés', () => {
    const [discord, fluxer] = adaptateurs();
    comparerSurfaces(
        evenementsDiscord.creerContexteEvenement(discord),
        evenementsFluxer.creerContexteEvenement(fluxer),
        'ctx d\'événement',
    );
});

test('aucun fichier de l\'adaptateur Fluxer ne charge discord.js', () => {
    const fs = require('fs');
    const path = require('path');
    const dossier = path.join(__dirname, '..', 'bot', 'platform', 'fluxer');
    for (const fichier of fs.readdirSync(dossier).filter(f => f.endsWith('.js'))) {
        // Les commentaires sont retirés : ce fichier PARLE de discord.js à
        // plusieurs endroits, et c'est très bien — ce qu'on interdit, c'est de
        // le charger.
        const source = fs.readFileSync(path.join(dossier, fichier), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        assert.ok(
            !/require\(['"]discord\.js['"]\)/.test(source),
            `${fichier} charge discord.js — l'adaptateur Fluxer doit en être totalement libre`,
        );
        assert.ok(
            !/require\(['"]\.\.\/discord\//.test(source),
            `${fichier} charge un fichier de l'adaptateur Discord`,
        );
    }
});


// ═══════════════════════════════════════════════════════════════
//  Les modules remontés au contrat : la MÊME fonction, pas une copie
//
//  L'identité de référence (`===`) est le seul contrôle qui prouve ce qu'on
//  cherche. Comparer les COMPORTEMENTS laisserait passer deux implémentations
//  jumelles — et c'est exactement l'état qu'on vient de défaire : elles étaient
//  identiques, jusqu'au jour où un correctif n'en aurait touché qu'une.
// ═══════════════════════════════════════════════════════════════

test('le contrôle d\'accès des commandes personnalisées est UNE seule fonction', () => {
    const neutre = require('../bot/platform/accesCommandePersonnalisee').verifierAccesCommandePersonnalisee;
    assert.equal(commandesDiscord.verifierAccesCommandePersonnalisee, neutre);
    assert.equal(commandesFluxer.verifierAccesCommandePersonnalisee, neutre);

    // Et les deux adaptateurs l'exposent, pour que leur dispatch NATIF puisse
    // l'appeler sans contexte neutre sous la main.
    const [discord, fluxer] = adaptateurs();
    const membre = { roles: ['77'], aPermission: () => false };
    const ligne = { name: 'faq', access_mode: 'role', access_role_id: '77' };
    const roles = new Map([['77', {}]]);
    assert.equal(discord.verifierAccesCommandePersonnalisee(ligne, membre, { roles }), null);
    assert.equal(fluxer.verifierAccesCommandePersonnalisee(ligne, membre, { roles }), null);
});

test('le chargeur de commandes est UNE seule mécanique, deux dérivations', () => {
    const neutre = require('../bot/platform/chargeur-commandes');
    assert.equal(commandesDiscord.enregistrerPanneaux, neutre.enregistrerPanneaux);
    assert.equal(commandesFluxer.enregistrerPanneaux, neutre.enregistrerPanneaux);
    assert.equal(commandesDiscord.refuserModuleHistorique, neutre.refuserModuleHistorique);
    assert.equal(commandesFluxer.refuserModuleHistorique, neutre.refuserModuleHistorique);

    // Le refus du format historique est donc EXACTEMENT le même message des
    // deux côtés — c'était l'endroit le plus probable d'une divergence.
    const historique = { data: { name: 'vieux' }, execute() {} };
    const messageDiscord = (() => {
        try { commandesDiscord.entreeDepuisExport(historique, 'vieux.js', null); } catch (e) { return e.message; }
    })();
    const messageFluxer = (() => {
        try { commandesFluxer.entreeDepuisExport(historique, 'vieux.js', null); } catch (e) { return e.message; }
    })();
    assert.equal(messageFluxer, messageDiscord);
    assert.match(messageDiscord, /vieux\.js/);
});

test('le chargeur de panneaux est UNE seule fonction', () => {
    const neutre = require('../bot/platform/panneaux').chargerPanneaux;
    assert.equal(typeof neutre, 'function');

    // Les deux adaptateurs délèguent à ce même chargeur : on le prouve en
    // enregistrant un panneau depuis un dossier temporaire, des deux côtés.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const chemin = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'panneaux'));
    fs.writeFileSync(path.join(dossier, 'temoin.js'), `
        const { definirPanneau } = require(${chemin});
        module.exports = definirPanneau({ nom: 'temoin-miroir', executer: async () => {} });
    `);

    for (const adaptateur of adaptateurs()) {
        const charges = adaptateur.chargerPanneaux({ dossier });
        assert.deepEqual(
            charges.map(c => [c.nom, c.enregistre]), [['temoin-miroir', true]],
            `${adaptateur.nom} : le panneau autonome doit être enregistré`,
        );
    }
    fs.rmSync(dossier, { recursive: true, force: true });
});

test('l\'arithmétique des snowflakes est UNE seule fonction, une époque par plateforme', () => {
    const neutre = require('../bot/platform/snowflake');
    assert.equal(snowflakeDiscord.dateDuSnowflake, neutre.dateDuSnowflake);
    assert.equal(snowflakeFluxer.dateDuSnowflake, neutre.dateDuSnowflake);
    // Les deux plateformes partagent l'époque, chacune la déclare avec sa source.
    assert.equal(snowflakeDiscord.EPOQUE_SNOWFLAKE, snowflakeFluxer.EPOQUE_SNOWFLAKE);
    assert.equal(snowflakeFluxer.EPOQUE_SNOWFLAKE, 1420070400000n);
    // Un identifiant illisible rend « je ne sais pas », jamais une date inventée.
    assert.equal(neutre.dateDuSnowflake('pas-un-identifiant'), null);
});

// ═══════════════════════════════════════════════════════════════
//  Les quatre ajouts au contrat, réalisés des deux côtés
// ═══════════════════════════════════════════════════════════════

test('poserPanneau accepte un corps composé des deux côtés', async () => {
    // Les mentions d'un embed ne notifient personne : un panneau de ticket doit
    // pouvoir porter `contenu` ET `embeds` dans LE MÊME message que ses choix.
    const envoyes = [];
    const faireAdaptateurFactice = (adaptateur) => {
        adaptateur.api.envoyerMessage = async (canalId, contenu) => {
            envoyes.push({ plateforme: adaptateur.nom, canalId, contenu });
            return { id: 'm1', canalId };
        };
        adaptateur.api.ajouterReaction = async () => null;
        adaptateur.enregistrerPanneauPersistant = () => {};
        return adaptateur;
    };

    const corps = { contenu: '<@&77>', embeds: [{ titre: 'Nouveau ticket', description: 'Bonjour' }] };
    const choix = [{ cle: 'fermer', libelle: 'Fermer', emoji: '🔒' }];

    for (const [adaptateur, poser] of [
        [faireAdaptateurFactice(creerAdaptateurDiscord({ client: clientDiscord(), env: {} })), contexteDiscord.poserPanneau],
        [faireAdaptateurFactice(creerAdaptateurFluxer({ env: { FLUXER_TOKEN: 'factice' } })), contexteFluxer.poserPanneau],
    ]) {
        await poser(adaptateur, '3', corps, choix, { panneau: 'ticket-miroir' });
    }

    assert.equal(envoyes.length, 2);
    for (const envoi of envoyes) {
        assert.equal(envoi.contenu.contenu, '<@&77>', `${envoi.plateforme} : la mention doit rester dans le message`);
        assert.equal(envoi.contenu.embeds.length, 1, `${envoi.plateforme} : l'embed doit être conservé`);
    }
});

test('rendreChoix accepte rangées et « nouvelleRangee » des deux côtés', () => {
    const parRangees = [
        [{ cle: 'a', libelle: 'A', emoji: '1️⃣' }],
        [{ cle: 'b', libelle: 'B', emoji: '2️⃣' }, { cle: 'c', libelle: 'C', emoji: '3️⃣' }],
    ];
    const parMarqueur = [
        { cle: 'a', libelle: 'A', emoji: '1️⃣' },
        { cle: 'b', libelle: 'B', emoji: '2️⃣', nouvelleRangee: true },
        { cle: 'c', libelle: 'C', emoji: '3️⃣' },
    ];

    // Côté Discord, la mise en page se voit dans les rangées de boutons.
    assert.equal(renderDiscord.rendreChoix(parRangees, 'p').length, 2);
    assert.equal(renderDiscord.rendreChoix(parMarqueur, 'p').length, 2);

    // Côté Fluxer, elle n'a pas de rendu — mais la forme d'entrée passe, et
    // l'ORDRE déclaré est conservé : c'est lui qui décide de l'ordre des
    // réactions apposées.
    for (const forme of [parRangees, parMarqueur]) {
        const { reactions } = renderFluxer.rendreChoix(forme, 'p');
        assert.deepEqual(reactions.map(r => r.cle), ['a', 'b', 'c']);
    }

    // Et le découpage est calculé à l'identique des deux côtés : un descripteur
    // valide sur une plateforme doit l'être sur l'autre.
    for (const forme of [parRangees, parMarqueur]) {
        assert.deepEqual(renderFluxer.decouperRangees(forme), renderDiscord.decouperRangees(forme));
    }
    for (const rendre of [renderDiscord.decouperRangees, renderFluxer.decouperRangees]) {
        assert.throws(() => rendre([[{ cle: 'a' }], { cle: 'b' }]), /mélange de choix et de rangées/);
    }
});

test('api.modifierPanneau exige les mêmes arguments des deux côtés', async () => {
    const [discord, fluxer] = adaptateurs();
    for (const adaptateur of [discord, fluxer]) {
        await assert.rejects(
            () => adaptateur.api.modifierPanneau('3', '5', 'contenu', [], { panneau: 'a:b' }),
            /nom de panneau invalide/,
            `${adaptateur.nom} : un nom de panneau ambigu doit être refusé`,
        );
        await assert.rejects(
            () => adaptateur.api.modifierPanneau(null, null, 'contenu', [], { panneau: 'ok' }),
            /obligatoires/,
            `${adaptateur.nom} : le salon et le message sont obligatoires`,
        );
    }
});
