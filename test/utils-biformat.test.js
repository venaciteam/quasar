// Les trois utilitaires transversaux en bi-format (lot 0.3 du chantier
// multiplateforme) : bot/utils/errors.js, bot/utils/logger.js,
// bot/utils/punishments.js.
//
// Ce que ce fichier doit tenir, dans cet ordre d'importance :
//
//  1. AUCUNE RÉGRESSION CÔTÉ DISCORD. Pendant toute la migration, vingt-sept
//     commandes et seize events continuent d'appeler ces fonctions avec des
//     objets discord.js. Les captures de référence ci-dessous ont été relevées
//     sur la version d'AVANT le lot (`git show HEAD:bot/utils/<fichier>`, HEAD
//     étant alors le socle du lot 0) et comparées une à une : ce qui est envoyé
//     doit rester identique, y compris l'ABSENCE de clé `inline` sur le champ
//     « Raison » d'un embed de sanction.
//  2. La détection de format ne se trompe pas, dans les deux sens.
//  3. Chaque voie neutre passe bien par le contrat (`ctx.repondre`,
//     `ctx.erreurUtilisateur`, `ctx.api`) et jamais par discord.js.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder } = require('discord.js');

const { getDb } = require('../api/services/database');
const { embed, estEmbed } = require('../bot/platform/embed');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const { creerContexteCommande } = require('../bot/platform/discord/context');

const {
    estContexteNeutre, resoudrePorteeNeutre, versEmbedDiscord,
    buildErrorEmbed, construireEmbedErreur, userError, replyWithEmbed, reportIncident,
} = require('../bot/utils/errors');
const { sendLog } = require('../bot/utils/logger');
const {
    applyPunishments, sendAutomodLog, buildLogEmbed, unreachableTarget, sweepExpiredBans,
} = require('../bot/utils/punishments');

const GUILDE = '111111111111111111';
const SALON_LOG = '999999999999999999';
const CIBLE = '333333333333333333';
const BOT = '222222222222222222';

// ── Amorçage ─────────────────────────────────────────────────────────────────

const db = getDb();
db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run(GUILDE, 'Serveur de test');
db.prepare(`
    INSERT INTO modules (guild_id, module_name, enabled, config) VALUES (?, 'moderation', 1, ?)
    ON CONFLICT(guild_id, module_name) DO UPDATE SET config = excluded.config
`).run(GUILDE, JSON.stringify({ logChannel: SALON_LOG, enabledLogs: { member_join: true } }));

// ── Doublures ────────────────────────────────────────────────────────────────

/** Client REST normalisé, réduit aux méthodes que les trois fichiers empruntent. */
function faireApi() {
    const appels = [];
    const trace = (nom) => (...args) => { appels.push([nom, ...args]); };
    return {
        appels,
        api: {
            async envoyerMessage(canalId, contenu) { trace('envoyerMessage')(canalId, contenu); return { id: 'msg1', canalId }; },
            async supprimerMessage(canalId, messageId) { trace('supprimerMessage')(canalId, messageId); },
            async bannirMembre(g, m, r) { trace('bannirMembre')(g, m, r); },
            async debannirMembre(g, m, r) { trace('debannirMembre')(g, m, r); },
            async exclureMembre(g, m, r) { trace('exclureMembre')(g, m, r); },
            async appliquerTimeout(g, m, expireLe, r) { trace('appliquerTimeout')(g, m, expireLe, r); },
            async ouvrirMessagePrive(u) { trace('ouvrirMessagePrive')(u); return 'dm-canal'; },
            async obtenirMembre(g, m) { trace('obtenirMembre')(g, m); return { id: m, aPermission: () => true }; },
            async obtenirGuilde(g) { trace('obtenirGuilde')(g); return { id: g, nom: 'Serveur de test' }; },
        },
    };
}

/** Portée neutre minimale : un serveur, un client REST, l'identité du bot. */
function fairePortee() {
    const { api, appels } = faireApi();
    return { portee: { guildeId: GUILDE, api, moi: { id: BOT } }, appels, api };
}

/** Contexte neutre réduit à ce que errors.js consomme. */
function faireContexte({ avecErreurUtilisateur = true } = {}) {
    const reponses = [];
    const erreurs = [];
    const { api } = faireApi();
    const ctx = {
        plateforme: 'discord',
        capacites: { interactions: true, ephemere: true },
        guildeId: GUILDE,
        canalId: SALON_LOG,
        auteur: { id: '444444444444444444', nom: 'Leeva' },
        commande: 'warn',
        api,
        async repondre(contenu, options = {}) { reponses.push({ contenu, options }); },
    };
    if (avecErreurUtilisateur) {
        ctx.erreurUtilisateur = (spec) => { erreurs.push(spec); };
    }
    return { ctx, reponses, erreurs };
}

/** Guilde discord.js réduite, avec capture de ce qui est envoyé au salon de logs. */
function faireGuilde() {
    const envois = [];
    const canal = { send: async (payload) => { envois.push(payload); return { id: 'msg1' }; } };
    return {
        envois,
        guild: {
            id: GUILDE,
            name: 'Serveur de test',
            ownerId: '555555555555555555',
            client: { user: { id: BOT }, users: { fetch: async () => ({ send: async () => {} }) } },
            channels: { cache: new Map([[SALON_LOG, canal]]) },
            members: {
                me: { permissions: { has: () => true } },
                ban: async () => {},
            },
        },
    };
}

/** Interaction discord.js réduite, avec capture de la réponse. */
function faireInteraction(etat = {}) {
    const reponses = [];
    return {
        reponses,
        interaction: {
            deferred: Boolean(etat.deferred),
            replied: Boolean(etat.replied),
            commandName: 'warn',
            guild: { id: GUILDE },
            user: { id: '444444444444444444' },
            async reply(p) { reponses.push(['reply', p]); },
            async editReply(p) { reponses.push(['editReply', p]); },
            async followUp(p) { reponses.push(['followUp', p]); },
        },
    };
}

/** Embeds d'un payload discord.js, sérialisés et débarrassés de l'horodatage. */
function embedsEnvoyes(payload) {
    return (payload.embeds || []).map(e => {
        const json = typeof e.toJSON === 'function' ? e.toJSON() : e;
        const { timestamp, ...reste } = json;
        return reste;
    });
}

// ═══════════════════════════════════════════════════════════════
//  1. Détection du format
// ═══════════════════════════════════════════════════════════════

test('détection — un vrai contexte neutre est reconnu, une interaction ne l\'est pas', () => {
    const adaptateur = creerAdaptateurDiscord({
        client: { once: () => {}, guilds: { cache: new Map() }, rest: {}, ws: { ping: 1 } },
    });
    const interaction = {
        id: '1', createdTimestamp: Date.now(), client: adaptateur.client,
        guild: { id: GUILDE }, channel: { id: SALON_LOG }, channelId: SALON_LOG,
        user: { id: '444444444444444444', username: 'leeva' },
        member: { id: '444444444444444444', roles: { cache: new Map() }, permissions: { has: () => true } },
        options: { getSubcommand: () => null },
    };
    const ctx = creerContexteCommande(interaction, {
        adaptateur, descripteur: { nom: 'warn', options: [] },
    });

    // Le contexte produit par la couche, et non une doublure : c'est lui que
    // les six lots de migration vont passer à ces trois fichiers.
    assert.equal(estContexteNeutre(ctx), true);
    assert.equal(estContexteNeutre(interaction), false);
    assert.equal(estContexteNeutre(adaptateur), false, 'l\'adaptateur n\'est pas un contexte : il ne répond à personne');
});

test('détection — les trois champs sont exigés ensemble', () => {
    const complet = { plateforme: 'discord', capacites: {}, repondre() {} };
    assert.equal(estContexteNeutre(complet), true);
    assert.equal(estContexteNeutre({ ...complet, plateforme: undefined }), false);
    assert.equal(estContexteNeutre({ ...complet, capacites: undefined }), false);
    assert.equal(estContexteNeutre({ ...complet, repondre: undefined }), false);
    // Un objet métier doté d'un « repondre » quelconque ne doit pas passer.
    assert.equal(estContexteNeutre({ repondre() {} }), false);
    for (const valeur of [null, undefined, 'ctx', 42, []]) {
        assert.equal(estContexteNeutre(valeur), false);
    }
});

test('détection — la portée neutre se reconnaît au client REST normalisé', () => {
    const { portee } = fairePortee();
    const resolue = resoudrePorteeNeutre(portee);
    assert.equal(resolue.guildeId, GUILDE);
    assert.equal(resolue.moiId, BOT);

    // Un contexte est une portée valide : il porte guildeId et api.
    const { ctx } = faireContexte();
    assert.equal(resoudrePorteeNeutre(ctx).guildeId, GUILDE);

    // Les objets discord.js n'en sont pas : ils n'ont pas d'« api ».
    const { guild } = faireGuilde();
    assert.equal(resoudrePorteeNeutre(guild), null);
    assert.equal(resoudrePorteeNeutre({ guilds: { cache: new Map() } }), null, 'un Client discord.js reste historique');
    // Un « api » qui n'est pas le client normalisé ne trompe pas la détection.
    assert.equal(resoudrePorteeNeutre({ api: { get() {} } }), null);
});

test('détection — un embed neutre est rendu pour la voie historique, un EmbedBuilder passe tel quel', () => {
    const neutre = embed({ titre: 'T', description: 'D', couleur: 0x112233 });
    const rendu = versEmbedDiscord(neutre);
    assert.equal(typeof rendu.toJSON, 'function');
    assert.deepEqual(rendu.toJSON(), { title: 'T', description: 'D', color: 0x112233 });

    const builder = new EmbedBuilder().setTitle('T');
    assert.equal(versEmbedDiscord(builder), builder);
    assert.equal(versEmbedDiscord('texte'), 'texte');
});

// ═══════════════════════════════════════════════════════════════
//  2. errors.js
// ═══════════════════════════════════════════════════════════════

test('errors — buildErrorEmbed : capture de référence inchangée', () => {
    // Relevé sur la version d'avant le lot. Ni le texte, ni la couleur, ni
    // l'ordre des clés ne bougent.
    assert.deepEqual(
        buildErrorEmbed({
            title: 'Membre introuvable',
            cause: 'Cette personne n\'est plus sur le serveur.',
            action: 'Vérifiez.',
        }).toJSON(),
        {
            title: '❌ Membre introuvable',
            color: 15548997,
            description: 'Cette personne n\'est plus sur le serveur.\n\n**Que faire :** Vérifiez.',
        },
    );

    // Comparaison par sérialisation : `setFooter` laisse un `icon_url:
    // undefined` dans la structure, que JSON.stringify élimine — c'est bien le
    // corps ENVOYÉ qui doit être identique, pas la structure intermédiaire.
    assert.deepEqual(
        JSON.parse(JSON.stringify(
            buildErrorEmbed({ title: 'Avec code', cause: 'c', action: 'a', code: 'QSR-1234' }).toJSON(),
        )),
        {
            title: '❌ Avec code',
            color: 15548997,
            description: 'c\n\n**Que faire :** a',
            footer: { text: 'Code : QSR-1234 — à transmettre en cas de signalement' },
        },
    );

    // Le neutre porte exactement le même contenu.
    const neutre = construireEmbedErreur({ title: 'Avec code', cause: 'c', action: 'a', code: 'QSR-1234' });
    assert.equal(estEmbed(neutre), true);
    assert.equal(neutre.titre, '❌ Avec code');
    assert.equal(neutre.pied.texte, 'Code : QSR-1234 — à transmettre en cas de signalement');
});

test('errors — userError, voie historique : les trois états de l\'interaction', async () => {
    const spec = { title: 'Refusé', cause: 'Parce que.', action: 'Faites autrement.' };
    const attendu = buildErrorEmbed(spec).toJSON();

    const vierge = faireInteraction();
    await userError(vierge.interaction, spec);
    assert.equal(vierge.reponses[0][0], 'reply');
    assert.equal(vierge.reponses[0][1].ephemeral, true);
    assert.deepEqual(vierge.reponses[0][1].embeds[0].toJSON(), attendu);

    const differee = faireInteraction({ deferred: true });
    await userError(differee.interaction, spec);
    assert.equal(differee.reponses[0][0], 'editReply');
    // `ephemeral` est absent d'une édition : Discord le refuse après le defer.
    assert.equal('ephemeral' in differee.reponses[0][1], false);

    const repondue = faireInteraction({ replied: true });
    await userError(repondue.interaction, spec);
    assert.equal(repondue.reponses[0][0], 'followUp');
});

test('errors — userError, voie neutre : délégation à ctx.erreurUtilisateur', async () => {
    const { ctx, erreurs, reponses } = faireContexte();
    await userError(ctx, { title: 'Refusé', cause: 'Parce que.', action: 'Autrement.' });

    assert.equal(erreurs.length, 1, 'la primitive du contexte doit être empruntée, pas réimplémentée');
    assert.deepEqual(erreurs[0], {
        titre: 'Refusé', cause: 'Parce que.', action: 'Autrement.', ephemere: true,
    });
    assert.equal(reponses.length, 0, 'rien ne doit passer par ctx.repondre quand la primitive existe');

    // Les deux orthographes sont acceptées : le code migré écrit « titre ».
    await userError(ctx, { titre: 'Migré', cause: 'c', ephemere: false });
    assert.equal(erreurs[1].titre, 'Migré');
    assert.equal(erreurs[1].ephemere, false);
});

test('errors — userError, voie neutre : repli quand le contexte n\'a pas la primitive', async () => {
    // Cas réel : le contexte d'autocomplétion répond, mais ne porte pas
    // erreurUtilisateur. Mieux vaut rendre l'embed que d'échouer.
    const { ctx, reponses } = faireContexte({ avecErreurUtilisateur: false });
    await userError(ctx, { title: 'Refusé', cause: 'c', action: 'a' });

    assert.equal(reponses.length, 1);
    assert.equal(estEmbed(reponses[0].contenu), true, 'l\'embed rendu doit être NEUTRE, jamais un EmbedBuilder');
    assert.equal(reponses[0].contenu.titre, '❌ Refusé');
    assert.equal(reponses[0].options.ephemere, true);
});

test('errors — replyWithEmbed refuse un embed Discord sur la voie neutre', async () => {
    const { ctx } = faireContexte();
    await assert.rejects(
        () => replyWithEmbed(ctx, new EmbedBuilder().setTitle('T')),
        /embed\(\{/,
        'le message doit désigner la correction à faire, pas disparaître dans un catch',
    );
});

test('errors — reportIncident lit la trace au bon endroit selon le format', async () => {
    const lignes = [];
    const vraiErreur = console.error;
    console.error = (...m) => lignes.push(m.join(' '));
    try {
        const { interaction } = faireInteraction();
        const codeHistorique = reportIncident(interaction, new Error('boum'), {});

        const { ctx, reponses } = faireContexte();
        const codeNeutre = reportIncident(ctx, new Error('boum'), {});
        await new Promise(r => setImmediate(r));

        assert.match(lignes[0], new RegExp(`${codeHistorique} \\| warn \\| guild=${GUILDE} \\| user=444444444444444444`));
        // Même ligne, mêmes informations : « commande » et « guildeId » côté
        // neutre là où l'interaction portait « commandName » et « guild.id ».
        assert.match(lignes[2], new RegExp(`${codeNeutre} \\| warn \\| guild=${GUILDE} \\| user=444444444444444444`));

        assert.equal(reponses.length, 1);
        assert.equal(estEmbed(reponses[0].contenu), true);
        assert.equal(reponses[0].contenu.pied.texte, `Code : ${codeNeutre} — à transmettre en cas de signalement`);
    } finally {
        console.error = vraiErreur;
    }
});

// ═══════════════════════════════════════════════════════════════
//  3. logger.js
// ═══════════════════════════════════════════════════════════════

test('logger — sendLog, voie historique : capture de référence inchangée', async () => {
    const { guild, envois } = faireGuilde();
    const e = new EmbedBuilder().setTitle('📥 Membre rejoint').setColor(1).addFields({ name: 'n', value: 'v' });

    await sendLog(guild, 'member_join', e);
    assert.equal(envois.length, 1);
    assert.deepEqual(envois[0], { embeds: [e] }, 'l\'EmbedBuilder doit voyager tel quel, sans passer par un rendu');

    // Type désactivé : rien ne part, comme avant.
    await sendLog(guild, 'msg_edit', e);
    assert.equal(envois.length, 1);
});

test('logger — sendLog, voie neutre : passe par api.envoyerMessage', async () => {
    const { portee, appels } = fairePortee();
    const neutre = embed({ titre: '📥 Membre rejoint' });

    await sendLog(portee, 'member_join', neutre);
    assert.deepEqual(appels[0], ['envoyerMessage', SALON_LOG, neutre]);

    // Les réglages du serveur s'appliquent de la même façon.
    await sendLog(portee, 'msg_edit', neutre);
    assert.equal(appels.length, 1);
});

test('logger — un embed neutre posté avec une guilde discord.js est rendu au vol', async () => {
    // Le cas de figure le plus probable pendant les six lots : un fichier à
    // demi migré, qui construit avec embed() mais tient encore une Guild.
    const { guild, envois } = faireGuilde();
    await sendLog(guild, 'member_join', embed({ titre: 'T', couleur: 0x112233 }));

    assert.equal(envois.length, 1);
    assert.deepEqual(embedsEnvoyes(envois[0]), [{ title: 'T', color: 0x112233 }]);
});

// ═══════════════════════════════════════════════════════════════
//  4. punishments.js
// ═══════════════════════════════════════════════════════════════

test('punishments — embed de sanction, voie historique : capture de référence inchangée', async () => {
    const { guild, envois } = faireGuilde();

    await applyPunishments('warn', {
        guild,
        member: { id: CIBLE },
        userId: CIBLE,
        reason: 'Test de non-régression',
        source: 'automod',
        moderatorId: BOT,
    });

    assert.equal(envois.length, 1);
    const [envoye] = embedsEnvoyes(envois[0]);
    assert.equal(envoye.title, '⚠️ Avertissement automatique');
    assert.equal(envoye.color, 15844367);
    assert.deepEqual(envoye.fields.slice(0, 3), [
        { name: 'Membre', value: `<@${CIBLE}> (${CIBLE})`, inline: true },
        { name: 'Déclencheur', value: 'AutoMod Discord', inline: true },
        // ⚠️ AUCUNE clé `inline` sur ce champ : c'était déjà le cas, et un
        // `inline: false` ajouté ici changerait le corps envoyé à Discord.
        { name: 'Raison', value: 'Test de non-régression' },
    ]);
    assert.equal('inline' in envoye.fields[2], false);
    assert.match(envoye.fields[3].name, /ID sanction/);

    // L'horodatage est bien posé, comme avant.
    const json = envois[0].embeds[0].toJSON();
    assert.equal(typeof json.timestamp, 'string');
});

test('punishments — voie neutre : chaque action passe par le client REST', async () => {
    const { portee, appels } = fairePortee();

    const resultats = await applyPunishments('delete, tempmute 20m, kick, tempban 1d, dm', {
        portee,
        member: { id: CIBLE },
        userId: CIBLE,
        message: { id: 'msg42', canalId: 'chan42' },
        reason: 'Raid',
        source: 'antiraid',
        moderatorId: BOT,
        logChannelId: SALON_LOG,
        responseMessage: 'Vous avez été sanctionné.',
    });

    assert.deepEqual(resultats.map(r => [r.action, r.ok]), [
        ['delete', true], ['tempmute', true], ['kick', true], ['tempban', true], ['dm', true],
    ]);

    const parNom = appels.map(a => a[0]);
    assert.deepEqual(
        parNom.filter(n => n !== 'envoyerMessage' && n !== 'obtenirMembre'),
        ['supprimerMessage', 'appliquerTimeout', 'exclureMembre', 'bannirMembre', 'ouvrirMessagePrive'],
    );

    const suppression = appels.find(a => a[0] === 'supprimerMessage');
    assert.deepEqual(suppression, ['supprimerMessage', 'chan42', 'msg42']);

    // `appliquerTimeout` attend une ÉCHÉANCE, pas une durée.
    const timeout = appels.find(a => a[0] === 'appliquerTimeout');
    assert.equal(timeout[1], GUILDE);
    assert.ok(timeout[3] > Date.now() + 19 * 60_000 && timeout[3] <= Date.now() + 20 * 60_000);

    // Les logs partent dans le salon dédié, en embed NEUTRE.
    const logs = appels.filter(a => a[0] === 'envoyerMessage' && a[1] === SALON_LOG);
    assert.equal(logs.length, 4, 'delete, tempmute, kick et tempban journalisent');
    for (const [, , contenu] of logs) {
        assert.equal(estEmbed(contenu), true, 'aucun EmbedBuilder ne doit traverser la voie neutre');
    }

    // Le MP part par le salon privé ouvert, pas par le salon de logs.
    const mp = appels.find(a => a[0] === 'envoyerMessage' && a[1] === 'dm-canal');
    assert.equal(mp[2], 'Vous avez été sanctionné.');

    // L'échéance du tempban est bien persistée.
    const ligne = db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(GUILDE, CIBLE);
    assert.ok(ligne, 'le bannissement temporaire doit être enregistré pour le balayage');
    db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?').run(GUILDE, CIBLE);
});

test('punishments — voie neutre : une portée sans serveur ne sanctionne rien', async () => {
    const { api } = faireApi();
    const resultats = await applyPunishments('ban', { portee: { api }, userId: CIBLE });
    assert.deepEqual(resultats, [{ action: 'ban', ok: false, error: 'Serveur indisponible.' }]);
});

test('punishments — voie neutre : le nom du serveur du MP vient du contrat', async () => {
    const { portee, appels } = fairePortee();
    await applyPunishments('dm', {
        portee, member: { id: CIBLE }, userId: CIBLE, reason: 'Spam', source: 'automod', moderatorId: BOT,
    });
    const mp = appels.find(a => a[0] === 'envoyerMessage' && a[1] === 'dm-canal');
    assert.match(mp[2], /\*\*Serveur de test\*\*/);
    assert.match(mp[2], /Motif : Spam/);
});

test('punishments — unreachableTarget dans les deux formats', () => {
    const { guild } = faireGuilde();
    assert.equal(unreachableTarget(guild, null), 'Cible inconnue.');
    assert.match(unreachableTarget(guild, guild.ownerId), /propriétaire du serveur/);
    assert.match(unreachableTarget(guild, BOT), /moi-même/);
    assert.equal(unreachableTarget(guild, CIBLE), null);

    const { portee } = fairePortee();
    assert.match(unreachableTarget(portee, BOT), /moi-même/, 'l\'identité du bot vient de portee.moi');
    assert.equal(unreachableTarget(portee, CIBLE), null);
    // Le propriétaire n'est contrôlé que s'il est déclaré : le contrat neutre
    // ne le donne pas (cf. en-tête de punishments.js).
    assert.equal(unreachableTarget(portee, '555555555555555555'), null);
    assert.match(
        unreachableTarget({ ...portee, proprietaireId: '555555555555555555' }, '555555555555555555'),
        /propriétaire du serveur/,
    );
});

test('punishments — sendAutomodLog accepte les deux formats', async () => {
    const { guild, envois } = faireGuilde();
    const builder = new EmbedBuilder().setTitle('Alerte');
    await sendAutomodLog(guild, builder, 'mod_ban', SALON_LOG);
    assert.deepEqual(envois[0], { embeds: [builder] });

    const { portee, appels } = fairePortee();
    const neutre = buildLogEmbed({ title: 'Alerte', color: 1, targetId: CIBLE, reason: 'r', source: 'antiraid' });
    assert.equal(estEmbed(neutre), true, 'buildLogEmbed rend désormais un embed NEUTRE');
    await sendAutomodLog(portee, neutre, 'mod_ban', SALON_LOG);
    assert.deepEqual(appels[0], ['envoyerMessage', SALON_LOG, neutre]);
});

test('punishments — le balayeur accepte l\'adaptateur et lève par api.debannirMembre', async () => {
    db.prepare(`
        INSERT INTO temp_bans (guild_id, user_id, expires_at, reason, source)
        VALUES (?, ?, ?, 'échu', 'automod')
        ON CONFLICT(guild_id, user_id) DO UPDATE SET expires_at = excluded.expires_at
    `).run(GUILDE, CIBLE, Math.floor(Date.now() / 1000) - 5);

    const { portee, appels } = fairePortee();
    // Forme réellement reçue en production : l'adaptateur, dont `api` et `moi`
    // sont les deux seuls champs empruntés ici.
    await sweepExpiredBans({ nom: 'discord', api: portee.api, moi: { id: BOT } });

    assert.deepEqual(appels[0], ['debannirMembre', GUILDE, CIBLE, 'Fin du bannissement temporaire']);
    assert.equal(
        db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(GUILDE, CIBLE),
        undefined,
        'l\'échéance doit être oubliée une fois la levée faite',
    );
    const log = appels.find(a => a[0] === 'envoyerMessage');
    assert.equal(log[1], SALON_LOG);
    assert.equal(log[2].titre, '🔓 Fin de bannissement temporaire');
});

test('punishments — le balayeur neutre ne touche à rien tant que le bot n\'est pas connecté', async () => {
    db.prepare(`
        INSERT INTO temp_bans (guild_id, user_id, expires_at, reason, source)
        VALUES (?, ?, ?, 'échu', 'automod')
        ON CONFLICT(guild_id, user_id) DO UPDATE SET expires_at = excluded.expires_at
    `).run(GUILDE, CIBLE, Math.floor(Date.now() / 1000) - 5);

    const { portee, appels } = fairePortee();
    // `moi.id` à null = adaptateur pas encore connecté. Supprimer l'échéance ici
    // transformerait un bannissement temporaire en bannissement définitif.
    await sweepExpiredBans({ nom: 'discord', api: portee.api, moi: { id: null } });

    assert.equal(appels.length, 0);
    assert.ok(db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(GUILDE, CIBLE));
    db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ?').run(GUILDE, CIBLE);
});
