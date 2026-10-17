// Compléments de contrat du lot 0.7, plus le correctif du verrou de mentions.
//
// Onze fichiers étaient bloqués faute de ces champs et de ces primitives. Chaque
// test dit ce qui casserait sans lui — un contrat en lecture seule pour six
// agents ne se relit pas, il se vérifie.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const creerAdaptateurDiscord = require('../bot/platform/discord');
const { corpsMessage, requeteMessage } = require('../bot/platform/discord/api');
const { embed, CHAMPS_EMBED } = require('../bot/platform/embed');
const { rendreEmbed, rendreSelecteurMembre } = require('../bot/platform/discord/render');
const { normaliserMembre, normaliserGuilde, creerContexteCommande } = require('../bot/platform/discord/context');
const { normaliserMessage, normaliserSanction, creerContexteEvenement, EVENEMENTS } = require('../bot/platform/discord/events');
const { CAPACITES_PAR_DEFAUT } = require('../bot/platform/capabilities');

const GUILDE = '100000000000000001';
const MEMBRE = '1234567890123456789';

function faireClient(extra = {}) {
    return {
        on() {}, once() {}, off() {},
        rest: {}, channels: { cache: new Map() }, guilds: { cache: new Map() },
        ...extra,
    };
}

// ── Faille : le verrou de mentions ───────────────────────────────────────────

test('le verrou de mentions part en snake_case, sinon Discord l\'ignore', () => {
    // Discord IGNORE une clé qu'il ne connaît pas, il ne la rejette pas : un
    // `allowedMentions` laissé en camelCase ne produisait aucune erreur, le
    // verrou disparaissait simplement, et un contenu non maîtrisé posté par
    // `api.envoyerMessage` pouvait pinger @everyone.
    const corps = corpsMessage({
        contenu: '@everyone alerte',
        mentionsAutorisees: { parse: [], roles: ['1'], users: [], repliedUser: false },
    });

    assert.equal(corps.content, '@everyone alerte');
    // Le verrou est là, sous le nom que l'API lit réellement.
    assert.deepEqual(corps.allowed_mentions, {
        parse: [], roles: ['1'], users: [], replied_user: false,
    });
    assert.equal('allowedMentions' in corps, false, 'la clé camelCase ne doit plus exister');
    assert.equal('repliedUser' in corps.allowed_mentions, false);
});

test('toute clé produite par le rendu a une correspondance REST déclarée', () => {
    // Le garde qui empêche la PROCHAINE clé ajoutée au rendu de retraverser en
    // camelCase, donc d'être ignorée en silence par Discord comme l'était le
    // verrou de mentions.
    const { CLES_CORPS_REST } = require('../bot/platform/discord/api');
    const { CLES_CORPS } = require('../bot/platform/discord/render');

    // Clé neutre du corps -> clé que `rendreContenu` en produit. Écrite ici pour
    // que l'ajout d'une clé neutre sans correspondance REST fasse échouer ce
    // test, et pas une écriture en production.
    const RENDUES = {
        contenu: 'content', embeds: 'embeds', fichiers: 'files',
        composants: 'components', mentionsAutorisees: 'allowedMentions',
    };
    for (const cleNeutre of CLES_CORPS) {
        const cleRendue = RENDUES[cleNeutre];
        assert.ok(cleRendue, `clé neutre « ${cleNeutre} » ajoutée sans correspondance : complétez RENDUES et CLES_CORPS_REST`);
        assert.ok(cleRendue in CLES_CORPS_REST, `« ${cleRendue} » absente de CLES_CORPS_REST`);
    }

    // Et une clé inconnue dans le verrou de mentions lève, plutôt que de partir
    // dans un corps que l'API acceptera sans l'appliquer.
    assert.throws(
        () => corpsMessage({ mentionsAutorisees: { repliedUser: false, inconnue: 1 } }),
        /clé « inconnue » inconnue du corps REST/,
    );
});

test('les pièces jointes voyagent à côté du corps, pas dedans', () => {
    // `@discordjs/rest` attend `files` EN DEHORS de `body`. Les y laisser
    // produisait un champ JSON que Discord ignore : la pièce jointe partait dans
    // le vide, sans erreur — et un ticket ne rendait pas son transcript.
    const requete = requeteMessage({
        contenu: 'Transcript',
        fichiers: [{ nom: 'transcript.txt', donnees: Buffer.from('bonjour') }],
    });
    assert.equal('files' in requete.body, false, 'files n\'a rien à faire dans le corps');
    assert.deepEqual(requete.files.map(f => f.name), ['transcript.txt']);
    assert.ok(Buffer.isBuffer(requete.files[0].data));
});

// ── 1. ctx.differer ──────────────────────────────────────────────────────────

test('ctx.differer acquitte sans répondre, et interdit ensuite un formulaire', async () => {
    // Lire cent messages puis les supprimer en lot dépasse les trois secondes :
    // sans acquittement différé, la commande est muette alors que les messages
    // partent bien.
    const journal = [];
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: { id: GUILDE, name: 'S' }, channel: { id: 'C1' }, channelId: 'C1',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        deferred: false, replied: false,
        deferReply(o) { journal.push(['deferReply', o]); this.deferred = true; return Promise.resolve(); },
        editReply(p) { journal.push(['editReply', p]); return Promise.resolve(p); },
        reply(p) { journal.push(['reply', p]); this.replied = true; return Promise.resolve(p); },
        options: { getSubcommand: () => null },
    };
    const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });

    await ctx.differer();
    assert.deepEqual(journal[0], ['deferReply', {}]);
    await ctx.differer({ ephemere: true }); // la forme éphémère passe l'option
    assert.deepEqual(journal[1], ['deferReply', { ephemeral: true }]);

    // Une réponse après differer REMPLIT la réponse différée.
    await ctx.repondre('fini');
    assert.deepEqual(journal[2], ['editReply', { content: 'fini' }]);

    // Et le formulaire est désormais impossible, avec un message qui le dit.
    await assert.rejects(
        () => ctx.prompt([{ cle: 'x', libelle: 'X' }]),
        /déjà acquittée.*ctx\.differer\(\)/s,
    );
});

// ── 2 à 6, 19. Membre normalisé ──────────────────────────────────────────────

test('le membre porte son exclusion, l\'âge de son compte et son identité', () => {
    const natif = normaliserMembre({
        id: MEMBRE, displayName: 'Leeva',
        user: { id: MEMBRE, username: 'leeva', tag: 'leeva', createdTimestamp: 1700000000000, bot: false },
        communicationDisabledUntilTimestamp: 1800000000000,
        voice: { channelId: 'V1' },
        roles: { cache: new Map() }, permissions: { has: () => false },
    });
    assert.equal(natif.timeoutJusqua, 1800000000000, 'garde « ce membre n\'est pas exclu » de /unmute');
    assert.equal(natif.compteCreeLe, 1700000000000);
    assert.equal(natif.etiquette, 'leeva');
    assert.equal(natif.nomUtilisateur, 'leeva');
    assert.equal(natif.canalVocalId, 'V1');

    // Réponse REST brute : dates ISO, discriminateur, voice_state.
    const rest = normaliserMembre({
        nick: 'Lee',
        user: { id: MEMBRE, username: 'leeva', discriminator: '4242' },
        communication_disabled_until: '2027-01-01T00:00:00.000Z',
        voice_state: { channel_id: 'V2' },
        roles: ['R1'],
    });
    assert.equal(rest.timeoutJusqua, Date.parse('2027-01-01T00:00:00.000Z'));
    assert.equal(rest.etiquette, 'leeva#4242', 'ancien compte : le discriminateur compte');
    assert.equal(rest.canalVocalId, 'V2');
    // L'âge du compte se déduit du snowflake quand l'objet ne le porte pas :
    // c'est la plateforme qui connaît la convention, pas l'anti-raid.
    assert.equal(typeof rest.compteCreeLe, 'number');
    assert.equal(new Date(rest.compteCreeLe).getUTCFullYear(), 2024);

    // Discriminateur « 0 » : il n'y en a plus, « leeva#0 » serait un artefact.
    assert.equal(normaliserMembre({ user: { id: MEMBRE, username: 'leeva', discriminator: '0' } }).etiquette, 'leeva');
    // Ni exclusion, ni salon vocal : null, jamais undefined.
    assert.equal(normaliserMembre({ id: MEMBRE, user: { id: MEMBRE } }).timeoutJusqua, null);
    assert.equal(normaliserMembre({ id: MEMBRE, user: { id: MEMBRE } }).canalVocalId, null);
});

test('l\'avatar est une fonction, à la taille demandée', () => {
    // L'embed d'accueil veut 128, le journal 64 : figer une taille obligerait le
    // métier à réécrire l'URL, donc à connaître le CDN d'une plateforme.
    const tailles = [];
    const natif = normaliserMembre({
        id: MEMBRE, user: { id: MEMBRE, username: 'l' },
        displayAvatarURL: (o) => { tailles.push(o.size); return `natif-${o.size}`; },
    });
    assert.equal(typeof natif.avatar, 'function');
    assert.equal(natif.avatar(64), 'natif-64');
    assert.equal(natif.avatar(), 'natif-128', 'défaut à 128');
    assert.deepEqual(tailles, [64, 128]);

    // REST : avatar de serveur, puis avatar de compte, puis avatar par défaut.
    const surServeur = normaliserMembre({ user: { id: MEMBRE, username: 'l' }, avatar: 'hm', guild_id: GUILDE });
    assert.match(surServeur.avatar(64), new RegExp(`/guilds/${GUILDE}/users/${MEMBRE}/avatars/hm\\.png\\?size=64$`));
    const surCompte = normaliserMembre({ user: { id: MEMBRE, username: 'l', avatar: 'hu' } });
    assert.match(surCompte.avatar(128), new RegExp(`/avatars/${MEMBRE}/hu\\.png\\?size=128$`));
    const sansAvatar = normaliserMembre({ user: { id: MEMBRE, username: 'l', discriminator: '0' } });
    assert.match(sansAvatar.avatar(), /\/embed\/avatars\/[0-5]\.png$/);
});

// ── 7, 22. Guilde normalisée ─────────────────────────────────────────────────

test('la guilde porte son effectif et son rôle par défaut', () => {
    const natif = normaliserGuilde({ id: GUILDE, name: 'S', memberCount: 120, roles: { everyone: { id: 'EVERY' } } });
    assert.equal(natif.membreCount, 120, 'alerte de vague et {membercount} du gabarit d\'accueil');
    assert.equal(natif.roleParDefautId, 'EVERY');

    assert.equal(normaliserGuilde({ id: GUILDE, name: 'S', member_count: 7 }).membreCount, 7);
    // Sans information : `null`, jamais 0 — un seuil comparé à un effectif
    // inventé déclencherait une alerte de vague sur un serveur vide.
    assert.equal(normaliserGuilde({ id: GUILDE, name: 'S' }).membreCount, null);
    // @everyone porte l'identifiant du serveur, mais c'est une connaissance de
    // plateforme : le repli la garde hors du code métier.
    assert.equal(normaliserGuilde({ id: GUILDE, name: 'S' }).roleParDefautId, GUILDE);
});

// ── 8, 9, 16, 17. Message normalisé ──────────────────────────────────────────

test('le message porte ses pièces jointes, des deux provenances', () => {
    // Le journal de suppression n'a souvent que cette liste de noms comme
    // trace : le fichier disparaît avec le message.
    const cache = new Map([['a', { id: 'A1', name: 't.txt', url: 'http://u', size: 12 }]]);
    assert.deepEqual(
        normaliserMessage({ id: 'M1', channelId: 'C1', attachments: { cache } }).piecesJointes,
        [{ id: 'A1', nom: 't.txt', url: 'http://u', taille: 12 }],
    );
    assert.deepEqual(
        normaliserMessage({ id: 'M1', channel_id: 'C1', attachments: [{ id: 'A2', filename: 'p.png', url: 'http://v', size: 99 }] }).piecesJointes,
        [{ id: 'A2', nom: 'p.png', url: 'http://v', taille: 99 }],
    );
    assert.deepEqual(normaliserMessage({ id: 'M1' }).piecesJointes, []);
});

test('le lien du message est repris ou construit par l\'adaptateur', () => {
    // Le reconstruire dans un handler mettrait une URL discord.com dans du code
    // censé être neutre.
    assert.equal(normaliserMessage({ id: 'M1', url: 'https://deja/la' }).lien, 'https://deja/la');
    assert.equal(
        normaliserMessage({ id: 'M1', channel_id: 'C1', guild_id: 'G1' }).lien,
        'https://discord.com/channels/G1/C1/M1',
    );
    // Message privé : pas de serveur, Discord attend « @me ».
    assert.equal(normaliserMessage({ id: 'M1', channel_id: 'C1' }).lien, 'https://discord.com/channels/@me/C1/M1');
    assert.equal(normaliserMessage({ channelId: 'C1' }).lien, null);
});

test('le message dit s\'il est système, d\'un webhook, et dans un fil', () => {
    // Ces quatre champs sont sur le MESSAGE et pas derrière `api.obtenirCanal` :
    // le chemin rapide du salon piège s'exécute pour chaque message de chaque
    // serveur et ne peut pas payer un aller-retour.
    const humain = normaliserMessage({ id: 'M1', type: 0, channel: { isThread: () => false, parentId: 'CAT' } });
    assert.equal(humain.estSysteme, false);
    assert.equal(humain.estFil, false);
    assert.equal(humain.canalParentId, 'CAT');

    // Type 19 = réponse, humaine elle aussi.
    assert.equal(normaliserMessage({ id: 'M1', type: 19 }).estSysteme, false);
    // Type 7 = message d'arrivée : personne ne l'a écrit. Sans ce test, un
    // salon piège posé sur le salon système sanctionne chaque arrivée.
    assert.equal(normaliserMessage({ id: 'M1', type: 7 }).estSysteme, true);

    assert.equal(normaliserMessage({ id: 'M1', webhookId: 'W1' }).estWebhook, true);
    assert.equal(normaliserMessage({ id: 'M1', webhook_id: 'W1' }).estWebhook, true);
    assert.equal(normaliserMessage({ id: 'M1' }).estWebhook, false);

    // Fil : détecté par la méthode discord.js, ou par le type côté REST.
    assert.equal(normaliserMessage({ id: 'M1', channel: { isThread: () => true, parentId: 'P' } }).estFil, true);
    for (const type of [10, 11, 12]) {
        assert.equal(normaliserMessage({ id: 'M1', channel: { type, parent_id: 'P' } }).estFil, true, `type ${type}`);
    }
    assert.equal(normaliserMessage({ id: 'M1', channel: { type: 0 } }).estFil, false);
});

test('un embed peut porter un lien, rendu sur son titre', () => {
    assert.ok(CHAMPS_EMBED.includes('lien'));
    const rendu = rendreEmbed(embed({ titre: 'Message modifié', lien: 'https://d/c/1/2/3' })).toJSON();
    assert.equal(rendu.url, 'https://d/c/1/2/3', 'le journal de modification pointe sur le message');
    assert.equal(rendreEmbed(embed({ titre: 'T' })).toJSON().url, undefined);
});

// ── 10, 11. Payload d'événement ──────────────────────────────────────────────

test('membreModifie porte le serveur en troisième argument', () => {
    // Sans serveur, un handler qui compare deux états de membre ne sait pas dans
    // quel journal écrire. Ajouté EN QUEUE : les deux premiers arguments ne
    // bougent pas.
    const [, normaliser] = EVENEMENTS.membreModifie;
    const guild = { id: GUILDE, name: 'Serveur' };
    const payload = normaliser({ id: 'M', nick: 'avant', guild }, { id: 'M', nick: 'apres', guild });

    assert.equal(payload.length, 3);
    assert.equal(payload[0].pseudo, 'avant');
    assert.equal(payload[1].pseudo, 'apres');
    assert.equal(payload[2].id, GUILDE);

    // Repli sur l'état d'avant si l'après ne porte pas le serveur.
    assert.equal(normaliser({ id: 'M', guild }, { id: 'M' })[2].id, GUILDE);
});

test('une sanction automatique porte son filtre, son terme et sa durée', () => {
    const sanction = normaliserSanction({
        guildId: GUILDE, userId: 'U1', ruleId: 'R1',
        ruleTriggerType: 1, matchedKeyword: 'insulte',
        action: { type: 3, metadata: { durationSeconds: 600 } },
    });
    // Valeur NATIVE assumée : c'est la clé de automodSync.TRIGGER_BY_DISCORD_TYPE,
    // et l'AutoMod n'a pas de second implémenteur.
    assert.equal(sanction.declencheurNatif, 1, 'champ « Filtre » du journal');
    assert.equal(sanction.motCle, 'insulte', 'champ « Terme détecté »');
    assert.equal(sanction.dureeSecondes, 600, 'champ « Durée » et colonne sanctions.duration');

    const sansMetadata = normaliserSanction({ guildId: GUILDE, userId: 'U1', action: { type: 1 } });
    assert.equal(sansMetadata.dureeSecondes, null);
    assert.equal(sansMetadata.motCle, null);
});

// ── 12, 13, 20. Lecteurs REST ────────────────────────────────────────────────

test('obtenirBannissement rend la personne bannie, ou null', async () => {
    const bans = { fetch: async (id) => (id === 'BANNI'
        ? { user: { id: 'BANNI', username: 'parti', tag: 'parti' }, reason: 'Raid' }
        : (() => { throw Object.assign(new Error('x'), { code: 10026 }); })()) };
    const guilde = { id: GUILDE, name: 'S', bans };
    const { api } = creerAdaptateurDiscord({ client: faireClient({ guilds: { cache: new Map([[GUILDE, guilde]]) } }) });

    const ban = await api.obtenirBannissement(GUILDE, 'BANNI');
    assert.equal(ban.utilisateur.etiquette, 'parti', 'l\'embed de /unban affiche l\'étiquette');
    assert.equal(ban.raison, 'Raid');

    // « Bannissement inconnu » remonte en 'deja_fait' et non 'introuvable' :
    // pour une LECTURE, les deux veulent dire « rien à lire ».
    assert.equal(await api.obtenirBannissement(GUILDE, 'LIBRE'), null);
});

test('permissionsSurCanal répond salon par salon', async () => {
    // Rien ne disait si le bot peut écrire dans UN salon donné : l'envoi était
    // tenté et le motif de repli se déduisait d'une erreur.
    const { BITS } = require('../bot/platform/discord/permissions');
    const membre = { id: 'B1', guild: null };
    const canal = {
        id: 'C1', guildId: GUILDE,
        permissionsFor: (cible) => (cible === membre
            ? { has: (bit) => bit === BITS.SEND_MESSAGES }
            : null),
    };
    const guilde = { id: GUILDE, name: 'S', members: { cache: new Map([['B1', membre]]), fetch: async () => membre } };
    const { api } = creerAdaptateurDiscord({ client: faireClient({
        channels: { cache: new Map([['C1', canal]]) },
        guilds: { cache: new Map([[GUILDE, guilde]]) },
    }) });

    const perms = await api.permissionsSurCanal('C1', 'B1');
    assert.equal(perms.aPermission('SEND_MESSAGES'), true);
    assert.equal(perms.aPermission('MANAGE_MESSAGES'), false);

    // Salon sans permissions propres (message privé) : null, pas « aucune ».
    const sansPerms = creerAdaptateurDiscord({ client: faireClient({
        channels: { cache: new Map([['MP', { id: 'MP' }]]) },
    }) });
    assert.equal(await sansPerms.api.permissionsSurCanal('MP', 'B1'), null);
});

test('listerMembresVocal rend les personnes présentes', async () => {
    const membres = new Map([['U1', { id: 'U1', displayName: 'A', user: { id: 'U1', username: 'a' }, roles: { cache: new Map() } }]]);
    const client = faireClient({ channels: { cache: new Map([['V1', { id: 'V1', members: membres }]]) } });
    const { api } = creerAdaptateurDiscord({ client });

    const liste = await api.listerMembresVocal('V1');
    assert.deepEqual(liste.map(m => m.id), ['U1']);

    // Salon vidé : [] et non null — la distinction décide de la suppression du
    // salon temporaire.
    client.channels.cache.set('V2', { id: 'V2', members: new Map() });
    assert.deepEqual(await api.listerMembresVocal('V2'), []);
    // Salon non vocal : null, il n'y a pas de réponse à la question.
    client.channels.cache.set('T1', { id: 'T1' });
    assert.equal(await api.listerMembresVocal('T1'), null);
});

// ── 14. Écritures de serveur ─────────────────────────────────────────────────

test('la pause des invitations est une capacité déclarée', () => {
    assert.equal(CAPACITES_PAR_DEFAUT.pauseInvitations, false, 'false par défaut, comme toutes les autres');
    assert.equal(creerAdaptateurDiscord({ client: faireClient() }).capacites.pauseInvitations, true);
});

test('mettreInvitationsEnPause dit quelle voie elle a empruntée', async () => {
    // Le repli permanent n'est PAS équivalent à la pause à échéance : il
    // n'expire pas tout seul, et l'appelant doit pouvoir le dire dans son
    // journal — sinon un serveur reste fermé indéfiniment.
    const appels = [];
    const faireGuilde = (incidentRefuse) => ({
        id: GUILDE, name: 'S', features: [],
        setIncidentActions: async (o) => {
            if (incidentRefuse && o.invitesDisabledUntil) throw new Error('non éligible');
            appels.push(['incident', o.invitesDisabledUntil]);
        },
        disableInvites: async (v) => appels.push(['permanent', v]),
    });

    const nominal = creerAdaptateurDiscord({ client: faireClient({ guilds: { cache: new Map([[GUILDE, faireGuilde(false)]]) } }) });
    assert.equal(await nominal.api.mettreInvitationsEnPause(GUILDE, Date.now() + 60000), 'incident');
    assert.equal(appels[0][0], 'incident');

    appels.length = 0;
    const replié = creerAdaptateurDiscord({ client: faireClient({ guilds: { cache: new Map([[GUILDE, faireGuilde(true)]]) } }) });
    assert.equal(await replié.api.mettreInvitationsEnPause(GUILDE, Date.now() + 60000), 'permanent');
    assert.deepEqual(appels, [['permanent', true]]);

    appels.length = 0;
    assert.equal(await nominal.api.mettreInvitationsEnPause(GUILDE, null), 'levee');
    assert.deepEqual(appels, [['incident', null]]);
});

test('obtenirEtatInvitations distingue la pause à échéance du repli permanent', async () => {
    const echeance = new Date(Date.now() + 60000);
    const enPause = creerAdaptateurDiscord({ client: faireClient({ guilds: { cache: new Map([[GUILDE, {
        id: GUILDE, name: 'S', features: [], incidentsData: { invitesDisabledUntil: echeance },
    }]]) } }) });
    assert.deepEqual(await enPause.api.obtenirEtatInvitations(GUILDE), {
        enPauseJusqua: echeance.getTime(), desactiveesEnDur: false,
    });

    const enDur = creerAdaptateurDiscord({ client: faireClient({ guilds: { cache: new Map([[GUILDE, {
        id: GUILDE, name: 'S', features: ['INVITES_DISABLED'],
    }]]) } }) });
    assert.deepEqual(await enDur.api.obtenirEtatInvitations(GUILDE), {
        enPauseJusqua: null, desactiveesEnDur: true,
    });
});

test('listerGuildes distingue « aucun serveur » de « je ne sais pas encore »', async () => {
    // C'est le garde-fou du balayage du mode panique : au démarrage la
    // passerelle n'a pas livré la liste, et conclure « aucun serveur » ferait
    // SUPPRIMER des échéances — un serveur resterait fermé indéfiniment.
    const pasPret = creerAdaptateurDiscord({ client: faireClient({ isReady: () => false }) });
    assert.equal(await pasPret.api.listerGuildes(), null, 'indéterminable, pas vide');

    const pretSansServeur = creerAdaptateurDiscord({ client: faireClient({ isReady: () => true }) });
    assert.deepEqual(await pretSansServeur.api.listerGuildes(), [], 'connecté et réellement aucun serveur');

    const pretAvecServeurs = creerAdaptateurDiscord({ client: faireClient({
        isReady: () => true, guilds: { cache: new Map([[GUILDE, {}], ['G2', {}]]) },
    }) });
    assert.deepEqual(await pretAvecServeurs.api.listerGuildes(), [GUILDE, 'G2']);

    // Sans `isReady` (doublure réduite), c'est la présence de `user` qui tranche.
    const parUser = creerAdaptateurDiscord({ client: faireClient({ user: { id: 'B' } }) });
    assert.deepEqual(await parUser.api.listerGuildes(), []);
});

// ── 18. Commandes personnalisées ─────────────────────────────────────────────

test('le déploiement d\'une commande personnalisée est inerte sans interactions', async () => {
    // Sur Fluxer, une commande personnalisée sera une commande préfixée résolue
    // en base par le parseur : il n'y a rien à déployer, et « rien à faire » est
    // un succès. Le code métier n'a pas à tester la plateforme.
    const appels = [];
    const adaptateur = creerAdaptateurDiscord({
        client: faireClient({ rest: { post: async () => appels.push('post'), get: async () => [], delete: async () => appels.push('delete') } }),
        env: { DISCORD_CLIENT_ID: 'APP' },
    });

    assert.equal(await adaptateur.deployerCommandeServeur(GUILDE, { nom: 'faq', description: 'La FAQ' }), true);
    assert.deepEqual(appels, ['post']);

    appels.length = 0;
    adaptateur.capacites = { ...adaptateur.capacites, interactions: false };
    assert.equal(await adaptateur.deployerCommandeServeur(GUILDE, { nom: 'faq', description: 'd' }), true);
    assert.equal(await adaptateur.retirerCommandeServeur(GUILDE, 'faq'), true);
    assert.deepEqual(appels, [], 'aucun appel réseau quand la plateforme n\'a pas d\'interactions');
});

// ── 21. Un événement pose un panneau ─────────────────────────────────────────

test('un événement pose un panneau au format exact de ctx.choose', async () => {
    // Le panneau TempVoice n'est posé par aucune commande : c'est
    // voiceStateUpdate qui le pose à la création du salon. Le customId doit être
    // identique, sinon `surPanneau` ne routerait que la moitié des panneaux.
    let envoye = null;
    const adaptateur = {
        nom: 'discord', capacites: {}, moi: { id: 'B' },
        api: { envoyerMessage: async (canalId, corps) => { envoye = { canalId, corps }; return { id: 'M1' }; } },
    };

    const resultat = await creerContexteEvenement(adaptateur).poserPanneau(
        'V1',
        embed({ titre: 'Votre salon' }),
        [{ cle: 'lock', libelle: 'Verrouiller', style: 'danger' }],
        { panneau: 'tempvoice' },
    );

    assert.deepEqual(resultat, { canalId: 'V1', messageId: 'M1' });
    assert.equal(envoye.corps.composants[0].components[0].custom_id, 'tempvoice:lock');

    // Un panneau posé par un événement est routé comme les autres.
    const routeur = creerAdaptateurDiscord({ client: faireClient() });
    let vu = null;
    routeur.surPanneau('tempvoice', (ctx, cle) => { vu = cle; });
    await routeur.routerPanneau({ customId: 'tempvoice:lock', user: { id: '1' }, client: {} });
    assert.equal(vu, 'lock');

    await assert.rejects(
        () => creerContexteEvenement(adaptateur).poserPanneau('V1', 'x', [], { panneau: 'a:b' }),
        /nom de panneau invalide/,
    );
});

// ── 23. ctx.choisirMembre ────────────────────────────────────────────────────

test('choisirMembre valide son périmètre et sa règle d\'accès AVANT tout envoi', async () => {
    const journal = [];
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: { id: GUILDE, name: 'S' }, channel: { id: 'C1' }, channelId: 'C1',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        deferred: false, replied: false,
        reply(p) { journal.push(p); this.replied = true; return Promise.resolve(p); },
        options: { getSubcommand: () => null },
    };
    const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });

    await assert.rejects(() => ctx.choisirMembre('Qui ?', { parmi: 'vocal' }), /parmi.*inconnu/s);
    await assert.rejects(() => ctx.choisirMembre('Qui ?', { autorise: 'modo' }), /n'est ni un mode connu/);
    assert.deepEqual(journal, [], 'aucun message ne doit avoir été posté');
});

test('choisirMembre rend null quand le salon vocal n\'a personne d\'autre', async () => {
    // Afficher un menu vide serait refusé par Discord ; répondre « il n'y a
    // personne » est la seule issue utile.
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: { id: GUILDE, name: 'S' }, channel: { id: 'V1' }, channelId: 'V1',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        deferred: false, replied: false,
        reply() { throw new Error('rien ne doit être envoyé'); },
        options: { getSubcommand: () => null },
    };
    // Seuls la personne qui commande et un bot sont dans le salon.
    const membres = new Map([
        ['U1', { id: 'U1', user: { id: 'U1', username: 'leeva' }, roles: { cache: new Map() } }],
        ['B1', { id: 'B1', user: { id: 'B1', username: 'quasar', bot: true }, roles: { cache: new Map() } }],
    ]);
    const adaptateur = creerAdaptateurDiscord({ client: faireClient({
        channels: { cache: new Map([['V1', { id: 'V1', members: membres }]]) },
    }) });
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });

    assert.equal(await ctx.choisirMembre('Qui ?', { parmi: 'salonVocal' }), null);
});

test('le sélecteur de membre se rend selon son périmètre', () => {
    const serveur = rendreSelecteurMembre('qmembre:1:0', { perimetre: 'serveur' }).toJSON();
    // 5 = USER_SELECT : Discord fait lui-même la recherche et la pagination.
    assert.equal(serveur.components[0].type, 5);
    assert.equal(serveur.components[0].custom_id, 'qmembre:1:0');

    // Salon vocal : le sélecteur natif ne sait pas s'y restreindre, on construit
    // un menu sur la liste lue.
    const vocal = rendreSelecteurMembre('qmembre:1:1', {
        perimetre: 'salonVocal',
        membres: [{ id: 'U1', nom: 'Alice' }, { id: 'U2', nom: 'Bob' }],
    }).toJSON();
    assert.equal(vocal.components[0].type, 3, 'STRING_SELECT');
    assert.deepEqual(vocal.components[0].options.map(o => [o.label, o.value]), [['Alice', 'U1'], ['Bob', 'U2']]);

    // Plafond de Discord : on tronque plutôt que de faire refuser le message.
    const trop = Array.from({ length: 30 }, (_, i) => ({ id: `U${i}`, nom: `N${i}` }));
    assert.equal(rendreSelecteurMembre('x', { perimetre: 'salonVocal', membres: trop }).toJSON().components[0].options.length, 25);
});

// ── 24 à 27. Dernier addendum : panneaux unifiés, date, sensible ─────────────

test('poserPanneau est la MÊME méthode sur un contexte de commande et d\'événement', async () => {
    // `/ticket setup salon:#support` doit poser son panneau dans #support et
    // non dans le salon de l'interaction — ce que `ctx.choose` ne sait pas
    // faire. Deux voies distinctes auraient produit deux customId à router.
    const envois = [];
    const api = { envoyerMessage: async (canalId, corps) => { envois.push({ canalId, corps }); return { id: `M${envois.length}` }; } };
    const adaptateur = { nom: 'discord', capacites: {}, moi: { id: 'B' }, api };

    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: { id: GUILDE, name: 'S' }, channel: { id: 'ICI' }, channelId: 'ICI',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        deferred: false, replied: false,
        reply() { throw new Error('poserPanneau ne répond pas à l\'interaction'); },
        options: { getSubcommand: () => null },
    };
    const ctxCommande = creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });
    const ctxEvenement = creerContexteEvenement(adaptateur);

    const choix = [{ cle: 'ouvrir', libelle: 'Ouvrir un ticket' }];
    const depuisCommande = await ctxCommande.poserPanneau('AILLEURS', embed({ titre: 'Tickets' }), choix, { panneau: 'ticket' });
    const depuisEvenement = await ctxEvenement.poserPanneau('AILLEURS', embed({ titre: 'Tickets' }), choix, { panneau: 'ticket' });

    // Le salon vient de l'argument, jamais de l'interaction.
    assert.equal(depuisCommande.canalId, 'AILLEURS');
    assert.equal(envois[0].canalId, 'AILLEURS');
    assert.deepEqual(Object.keys(depuisCommande).sort(), ['canalId', 'messageId']);
    assert.deepEqual(Object.keys(depuisEvenement).sort(), ['canalId', 'messageId']);

    // Et le customId est identique des deux côtés : le routage ne fait aucune
    // différence selon l'origine.
    const idCommande = envois[0].corps.composants[0].components[0].custom_id;
    const idEvenement = envois[1].corps.composants[0].components[0].custom_id;
    assert.equal(idCommande, 'ticket:ouvrir');
    assert.equal(idCommande, idEvenement);

    for (const ctx of [ctxCommande, ctxEvenement]) {
        await assert.rejects(() => ctx.poserPanneau('C', 'x', [], { panneau: 'a:b' }), /nom de panneau invalide/);
        await assert.rejects(() => ctx.poserPanneau(null, 'x', [], { panneau: 'ok' }), /salon de destination/);
    }
});

test('un panneau peut se déclarer SANS commande, et être routé', async () => {
    // Le module `defer` n'a aucune commande — il se configure au dashboard — et
    // ses boutons ne pouvaient être ni posés ni routés : un panneau devait
    // s'accrocher à une commande qui n'existe pas.
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const registre = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'panneaux'));
    fs.writeFileSync(path.join(dossier, 'defer.js'), `
        const { definirPanneau } = require(${registre});
        module.exports = definirPanneau({
            nom: 'defer',
            executer: async (ctx, cle) => { global.__deferVu = { cle, nom: ctx.panneau.nom }; },
        });
    `);

    try {
        const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
        const charges = adaptateur.chargerPanneaux({ dossier });
        assert.deepEqual(charges.map(c => [c.nom, c.enregistre]), [['defer', true]]);

        await adaptateur.routerPanneau({ customId: 'defer:apply', user: { id: '1' }, client: {} });
        assert.deepEqual(global.__deferVu, { cle: 'apply', nom: 'defer' });
        delete global.__deferVu;
    } finally {
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});

test('une exception dans un panneau autonome passe par le filet, nommée', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'quasar-panneaux-'));
    const registre = JSON.stringify(path.join(__dirname, '..', 'bot', 'platform', 'panneaux'));
    fs.writeFileSync(path.join(dossier, 'casse.js'), `
        const { definirPanneau } = require(${registre});
        module.exports = definirPanneau({ nom: 'casse', executer: async () => { throw new Error('boum'); } });
    `);

    try {
        const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
        const vus = [];
        adaptateur.chargerPanneaux({ dossier, surErreur: (err, ctx) => vus.push([ctx.panneau, err.message]) });

        await adaptateur.routerPanneau({ customId: 'casse:x', user: { id: '1' }, client: {} });
        assert.deepEqual(vus, [['casse', 'boum']]);
    } finally {
        fs.rmSync(dossier, { recursive: true, force: true });
    }
});

test('une collision entre un panneau de module et un panneau de commande nomme les deux', () => {
    // Les deux déclarations peuvent venir de deux lots qui ne se relisent pas :
    // « déjà enregistré » ne dit pas par qui.
    const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
    adaptateur.surPanneau('ticket', () => {}, '/ticket');
    assert.throws(
        () => adaptateur.surPanneau('ticket', () => {}, 'le module tickets'),
        /déclaré deux fois : par \/ticket et par le module tickets/,
    );
});

test('le message porte sa date d\'émission, des trois provenances', () => {
    // Le transcript d'un ticket écrit « [ISO] auteur : contenu » : sans date, on
    // dégrade une pièce qui est souvent la seule copie d'une conversation.
    assert.equal(normaliserMessage({ id: 'M1', createdTimestamp: 1700000000000 }).creeLe, 1700000000000);
    assert.equal(
        normaliserMessage({ id: 'M1', timestamp: '2026-01-01T00:00:00.000Z' }).creeLe,
        Date.parse('2026-01-01T00:00:00.000Z'),
    );
    // Dernier recours : le snowflake. La convention appartient à la plateforme.
    const parSnowflake = normaliserMessage({ id: '1234567890123456789' }).creeLe;
    assert.equal(typeof parSnowflake, 'number');
    assert.equal(new Date(parSnowflake).getUTCFullYear(), 2024);
    assert.equal(normaliserMessage({ channelId: 'C1' }).creeLe, null);
});

test('ctx.choose accepte « sensible », au même titre que repondre', async () => {
    // `/mes-donnees` pose son panneau d'effacement sur une réponse qui contient
    // des données personnelles : sur une plateforme sans éphémère natif, ce
    // panneau doit partir en message privé, jamais en auto-suppression.
    let envoye = null;
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: { ws: { ping: 1 } },
        guild: { id: GUILDE, name: 'S' }, channel: { id: 'C1' }, channelId: 'C1',
        user: { id: 'U1', username: 'leeva' },
        member: { id: 'U1', roles: { cache: new Map() }, permissions: { has: () => false } },
        deferred: false, replied: false,
        // Le collecteur expire immédiatement : ce test porte sur l'ENVOI du
        // panneau, pas sur le clic.
        reply(p) {
            envoye = p; this.replied = true;
            return Promise.resolve({
                id: 'M1', channelId: 'C1',
                awaitMessageComponent: () => Promise.reject(new Error('expiré')),
            });
        },
        options: { getSubcommand: () => null },
    };
    const adaptateur = creerAdaptateurDiscord({ client: faireClient() });
    const ctx = creerContexteCommande(interaction, { adaptateur, descripteur: require('../bot/commands/ping') });

    // L'appel ne doit pas être refusé, et l'éphémère de Discord reste appliqué.
    const choisi = await ctx.choose('Effacer vos données ?', [{ cle: 'oui', libelle: 'Oui' }], {
        ephemere: true, sensible: true,
    });
    assert.equal(choisi, null, 'collecteur expiré');
    assert.equal(envoye.ephemeral, true, 'l\'éphémère natif de Discord reste appliqué');
    assert.equal(envoye.components.length, 1, 'le panneau a bien été posté');
});
