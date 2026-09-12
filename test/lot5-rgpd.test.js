// Lot 5 — parcours RGPD et signalement au contrat neutre.
//
// Deux commandes portent ici des obligations légales : /mes-donnees (droit
// d'accès, art. 15) et, plus indirectement, /signaler (canal de signalement
// exigé par la Discord Developer Policy). Leur migration n'est donc pas
// seulement une non-régression technique : un texte qui change de sens est un
// défaut bloquant. Les références ci-dessous sont relevées sur la v4.10.0,
// AVANT migration, et écrites en dur — les recalculer depuis le code testé ne
// prouverait rien.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { construireSlashCommand } = require('../bot/platform/discord/commands');
const creerAdaptateurDiscord = require('../bot/platform/discord');
const { estEmbed } = require('../bot/platform/embed');
const { getDb } = require('../api/services/database');

const signaler = require('../bot/commands/signaler');
const mesDonnees = require('../bot/commands/mesdonnees');

/** Corps RÉELLEMENT envoyé à Discord (cf. test/platform-commands.test.js). */
const corpsEnvoye = (builder) => JSON.parse(JSON.stringify(builder.toJSON()));

/** Contexte neutre réduit : tout est journalisé, rien ne part sur le réseau. */
function faireCtx({ guildeId = 'G1', auteurId = 'U1', nomGuilde = 'Mon Serveur', reponsesPrompt } = {}) {
    const journal = [];
    return {
        journal,
        plateforme: 'discord',
        capacites: { interactions: true, ephemere: true },
        guildeId,
        canalId: 'C1',
        guilde: guildeId ? { id: guildeId, nom: nomGuilde } : null,
        auteur: { id: auteurId, nom: 'Leeva', etiquette: 'leeva', mention: `<@${auteurId}>` },
        db: getDb(),
        differer(options = {}) { journal.push(['differer', options]); return Promise.resolve(); },
        repondre(contenu, options = {}) { journal.push(['repondre', contenu, options]); return Promise.resolve(); },
        modifierPanneau(contenu) { journal.push(['modifierPanneau', contenu]); return Promise.resolve(); },
        choose(message, choix, options = {}) {
            journal.push(['choose', message, choix, options]);
            return Promise.resolve({ persistant: true, canalId: 'C1', messageId: 'M1' });
        },
        prompt(questions, options = {}) {
            journal.push(['prompt', questions, options]);
            return Promise.resolve(reponsesPrompt ?? null);
        },
    };
}

const sousCommande = (descripteur, nom) => descripteur.sousCommandes.find(s => s.nom === nom);
const premier = (ctx, type) => ctx.journal.find(ligne => ligne[0] === type);

// ── 1. JSON déployé : byte-identique à la v4.10.0 ────────────────────────────

test('/signaler produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [
            { type: 1, name: 'bug', description: 'Quasar fonctionne mal : commande en erreur, dashboard cassé…', options: [] },
            { type: 1, name: 'abus', description: 'Le bot est utilisé de façon abusive sur ce serveur', options: [] },
        ],
        name: 'signaler',
        description: 'Signaler un bug de Quasar ou un usage abusif du bot',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(signaler)), REFERENCE);
    // Aucun `default_member_permissions` : la commande est ouverte à tous les
    // membres, et c'est VOLONTAIRE — un membre ordinaire est justement celui qui
    // subit un abus, et le dashboard ne lui est pas accessible.
    assert.equal(corpsEnvoye(construireSlashCommand(signaler)).default_member_permissions, undefined);
    assert.equal(signaler.accesParDefaut, true);
    assert.deepEqual(signaler.permissionsBot, []);
});

test('/mes-donnees produit le JSON de son SlashCommandBuilder d\'origine', () => {
    const REFERENCE = {
        options: [],
        name: 'mes-donnees',
        description: 'Voir les données que Quasar traite vous concernant et exercer vos droits',
        type: 1,
    };
    assert.deepEqual(corpsEnvoye(construireSlashCommand(mesDonnees)), REFERENCE);
    assert.equal(mesDonnees.accesParDefaut, true, 'l\'exercice des droits ne se réserve pas aux administrateurs');
    assert.deepEqual(mesDonnees.permissionsBot, []);
});

// ── 2. /signaler : les deux formulaires, champ par champ ─────────────────────

test('les deux formulaires de /signaler gardent leurs champs, leurs limites et leur obligation', async () => {
    // Référence : les ModalBuilder de la v4.10.0. Les clés `description` et
    // `contact` sont celles que `sendReport` attend : les renommer casserait le
    // relais sans qu'aucun test d'API ne s'en aperçoive.
    const ctxBug = faireCtx();
    await sousCommande(signaler, 'bug').executer(ctxBug);
    const [, questionsBug, optionsBug] = premier(ctxBug, 'prompt');

    assert.equal(optionsBug.titre, 'Signaler un bug de Quasar');
    assert.deepEqual(questionsBug, [
        {
            cle: 'description',
            libelle: 'Que s\'est-il passé ?',
            exemple: 'Décrivez le problème et ce que vous faisiez au moment où il est arrivé.',
            style: 'paragraphe',
            max: 1500,
            requis: true,
        },
        {
            cle: 'contact',
            libelle: 'Vous recontacter (facultatif)',
            exemple: 'Pseudo Discord, e-mail… laissez vide si vous préférez.',
            style: 'ligne',
            max: 200,
            requis: false,
        },
    ]);

    // Formulaire fermé ou expiré : rien n'est transmis et rien n'est affiché.
    assert.equal(ctxBug.journal.filter(l => l[0] !== 'prompt').length, 0);

    const ancien = process.env.ABUSE_REPORT_URL;
    process.env.ABUSE_REPORT_URL = 'https://relais.exemple/';
    try {
        const ctxAbus = faireCtx();
        await sousCommande(signaler, 'abus').executer(ctxAbus);
        const [, questionsAbus, optionsAbus] = premier(ctxAbus, 'prompt');
        assert.equal(optionsAbus.titre, 'Signaler un usage abusif');
        assert.equal(questionsAbus[0].libelle, 'Que se passe-t-il ?');
        assert.equal(
            questionsAbus[0].exemple,
            'Décris l\'usage abusif du bot sur ce serveur, aussi précisément que possible.',
        );
        // Le second champ est strictement le même sur les deux formulaires.
        assert.deepEqual(questionsAbus[1], questionsBug[1]);
    } finally {
        if (ancien === undefined) delete process.env.ABUSE_REPORT_URL; else process.env.ABUSE_REPORT_URL = ancien;
    }
});

test('sans relais d\'abus configuré, /signaler abus oriente vers trois interlocuteurs, dans l\'ordre', async () => {
    // Aucun signalement d'abus ne quitte une instance non configurée : on
    // n'ouvre pas de formulaire, on nomme qui peut réellement agir.
    const ancien = process.env.ABUSE_REPORT_URL;
    delete process.env.ABUSE_REPORT_URL;
    try {
        const ctx = faireCtx();
        await sousCommande(signaler, 'abus').executer(ctx);
        assert.equal(premier(ctx, 'prompt'), undefined, 'aucun formulaire ne doit s\'ouvrir');

        const [, contenu, options] = premier(ctx, 'repondre');
        assert.ok(estEmbed(contenu), 'embed neutre attendu');
        assert.equal(contenu.titre, '🚨 Signaler un usage abusif');
        assert.deepEqual(contenu.champs.map(c => c.nom), [
            '1. L\'équipe de ce serveur',
            '2. La personne ou l\'organisation qui héberge cette instance',
            '3. Discord',
        ]);
        assert.equal(
            contenu.pied.texte,
            'Pour un dysfonctionnement technique du bot, utilisez plutôt /signaler bug.',
        );
        // Le contenu d'un signalement est une donnée personnelle : sur une
        // plateforme sans éphémère natif, `sensible` route vers le message privé
        // au lieu d'une auto-suppression à 15 secondes (DA §6.3 et §10).
        assert.deepEqual(options, { ephemere: true, sensible: true });
    } finally {
        if (ancien !== undefined) process.env.ABUSE_REPORT_URL = ancien;
    }
});

test('un relais injoignable rend un échec explicite, avec un code d\'incident', async () => {
    // Port fermé sur la boucle locale : aucun appel ne sort de la machine.
    const ancien = process.env.ABUSE_REPORT_URL;
    process.env.ABUSE_REPORT_URL = 'http://127.0.0.1:1';
    const erreurs = [];
    const consoleErreur = console.error;
    console.error = (...args) => erreurs.push(args.join(' '));
    try {
        const ctx = faireCtx({ reponsesPrompt: { description: 'Le staff détourne les tickets.', contact: '' } });
        await sousCommande(signaler, 'abus').executer(ctx);

        // L'acquittement est DIFFÉRÉ avant le POST : un relais lent dépasse les
        // trois secondes accordées à une interaction, et la personne verrait un
        // échec alors que son signalement est parti.
        assert.deepEqual(premier(ctx, 'differer'), ['differer', { ephemere: true }]);
        assert.equal(
            ctx.journal.findIndex(l => l[0] === 'differer') < ctx.journal.findIndex(l => l[0] === 'repondre'),
            true, 'l\'acquittement doit précéder toute réponse',
        );

        const [, echec, optionsEchec] = premier(ctx, 'repondre');
        assert.equal(echec.titre, '❌ Signalement non transmis');
        assert.deepEqual(optionsEchec, { ephemere: true, sensible: true });
        assert.match(echec.pied.texte, /^Code : /);
        assert.equal(erreurs.length, 1, 'un échec de relais se trace une fois, avec son code');
        assert.match(erreurs[0], /\/signaler abus \| relais=http:\/\/127\.0\.0\.1:1/);
    } finally {
        console.error = consoleErreur;
        if (ancien === undefined) delete process.env.ABUSE_REPORT_URL; else process.env.ABUSE_REPORT_URL = ancien;
    }
});

// ── 3. /mes-donnees : droit d'accès, texte pour texte ────────────────────────

test('le droit d\'accès énonce les mêmes catégories, dans le même ordre, mot pour mot', async () => {
    const ctx = faireCtx({ guildeId: 'G-ACCES', auteurId: 'U-ACCES' });
    await mesDonnees.executer(ctx);

    const [, panneau, choix, options] = premier(ctx, 'choose');
    assert.ok(estEmbed(panneau));
    assert.equal(panneau.titre, '🔒 Les données que Quasar traite vous concernant');
    assert.equal(
        panneau.description,
        'Voici les catégories de données que Quasar traite à votre sujet **sur le serveur Mon Serveur**. '
        + 'Ces informations ne sont visibles que par vous.',
    );

    // L'ordre des catégories fait partie du message : on va du fait générique
    // (l'identifiant) au plus concret (sanctions, tickets), puis aux droits.
    assert.deepEqual(panneau.champs.map(c => c.nom), [
        '🪪 Votre identifiant Discord',
        '⚖️ Sanctions de modération vous concernant',
        '🎫 Tickets que vous avez ouverts',
        '✅ Comment exercer vos droits',
    ]);

    const parNom = new Map(panneau.champs.map(c => [c.nom, c.valeur]));
    assert.equal(
        parNom.get('🪪 Votre identifiant Discord'),
        'Quasar vous reconnaît par votre identifiant technique Discord, uniquement là où vous êtes concerné·e '
        + '(une sanction, un ticket, une préférence). Il ne stocke ni votre nom réel, ni votre e-mail, ni votre mot de passe.',
    );
    assert.equal(
        parNom.get('⚖️ Sanctions de modération vous concernant'),
        'Aucune sanction enregistrée vous concernant sur ce serveur.',
    );
    assert.equal(
        parNom.get('🎫 Tickets que vous avez ouverts'),
        'Aucun ticket ouvert à votre nom sur ce serveur.',
    );
    // Le partage des rôles est le point juridiquement sensible : l'équipe du
    // serveur décide (responsable de traitement), Venacity route et exécute
    // (sous-traitant). Inverser les deux changerait le sens du message.
    assert.equal(
        parNom.get('✅ Comment exercer vos droits'),
        'Vous pouvez demander à accéder à ces données, à les corriger ou à les supprimer.\n'
        + '• **En premier lieu, l\'équipe d\'administration de ce serveur** : elle est responsable de vos données ici, '
        + 'c\'est elle qui prend les décisions.\n'
        + '• **Venacity** (contact@vena.city) héberge Quasar en tant que sous-traitant : elle transmet votre demande '
        + 'à l\'équipe du serveur et exécute sa décision, sans se substituer à elle.\n'
        + 'Plus de détails dans la politique de confidentialité publique de Venacity (strata.vena.city).',
    );
    assert.equal(
        panneau.pied.texte,
        'Vous pouvez aussi déposer une demande de suppression directement ci-dessous.',
    );

    assert.deepEqual(choix, [{
        cle: 'erase',
        libelle: 'Demander la suppression de mes données',
        emoji: '🗑️',
        style: 'danger',
    }]);
    // Persistant : les clics doivent survivre à un redémarrage, comme le faisait
    // le routage par préfixe `mesdonnees_` de bot/index.js.
    //
    // ⚠️ `sensible: true` n'est pas décoratif, et son absence a coûté une fuite
    // réelle : sur une plateforme sans éphémère natif, c'est CE drapeau — et lui
    // seul — qui impose le message privé. Sans lui, cet inventaire de données
    // personnelles partait dans le salon où la commande était tapée, avec sa
    // phrase « Ces informations ne sont visibles que par vous ». La
    // non-régression du parcours complet est dans
    // test/platform-fluxer-rgpd.test.js.
    assert.deepEqual(options, {
        persistant: true, panneau: 'mesdonnees', ephemere: true, sensible: true,
    });
});

test('les compteurs réels remontent dans les catégories concernées', async () => {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)').run('G-CPT', 'Compteurs');
    db.prepare(`INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, active)
                VALUES (?, ?, ?, 'warn', 'r', 1)`).run('G-CPT', 'U-CPT', 'MOD');
    db.prepare(`INSERT INTO sanctions (guild_id, user_id, moderator_id, type, reason, active)
                VALUES (?, ?, ?, 'warn', 'r', 0)`).run('G-CPT', 'U-CPT', 'MOD');
    db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id, opened_at) VALUES (?, ?, ?, datetime('now'))")
        .run('G-CPT', 'C-CPT', 'U-CPT');

    const ctx = faireCtx({ guildeId: 'G-CPT', auteurId: 'U-CPT' });
    await mesDonnees.executer(ctx);
    const parNom = new Map(premier(ctx, 'choose')[1].champs.map(c => [c.nom, c.valeur]));

    assert.equal(
        parNom.get('⚖️ Sanctions de modération vous concernant'),
        '**2** sanction(s) enregistrée(s) vous concernant ici, dont **1** encore active(s).'
        + '\nPour en connaître le détail, adressez-vous à l\'équipe d\'administration du serveur.',
    );
    assert.equal(
        parNom.get('🎫 Tickets que vous avez ouverts'),
        '**1** ticket(s) ouvert(s) à votre nom sur ce serveur. '
        + 'Le contenu des conversations n\'est jamais conservé par Quasar, seulement le fait qu\'un ticket a existé.',
    );
});

test('en message privé, /mes-donnees dit pourquoi il ne peut pas répondre', async () => {
    const ctx = faireCtx({ guildeId: null });
    await mesDonnees.executer(ctx);
    const [, contenu, options] = premier(ctx, 'repondre');
    assert.equal(contenu.titre, '❌ À utiliser sur un serveur');
    assert.deepEqual(options, { ephemere: true, sensible: true });
    assert.equal(premier(ctx, 'choose'), undefined);
});

// ── 4. /mes-donnees : droit d'effacement, par le panneau ─────────────────────

test('le panneau de /mes-donnees est déclaré, et un clic y est routé', async () => {
    // Sans la clé `panneaux`, le lot 5 aurait dû écrire son préfixe dans
    // bot/index.js — fichier qui lui est interdit.
    assert.deepEqual(Object.keys(mesDonnees.panneaux), ['mesdonnees']);

    const adaptateur = creerAdaptateurDiscord({
        client: { on() {}, once() {}, off() {}, rest: {}, channels: { cache: new Map() } },
    });
    adaptateur.surPanneau('mesdonnees', mesDonnees.panneaux.mesdonnees);

    // Le séparateur neutre est « : » ; l'historique « _ ». Aucun recouvrement :
    // un vieux bouton `mesdonnees_erase` n'est PAS capté par le routage neutre.
    assert.equal(adaptateur.routerPanneau({ customId: 'mesdonnees_erase' }), null);

    // Clic routé jusqu'au handler déclaré. La clé est volontairement inconnue :
    // le parcours réel écrit en base, ce que ce test-ci n'a pas à faire.
    const routage = adaptateur.routerPanneau({ customId: 'mesdonnees:inconnue', user: { id: '1' }, client: {} });
    assert.ok(routage, 'le clic doit être routé');
    await routage;
});

test('une clé de panneau inconnue est ignorée sans rien répondre', async () => {
    // Le routage envoie tout le panneau : le filtre sur la clé remplace le
    // `if (customId !== 'mesdonnees_erase') return` de l'ancien routeur.
    const ctx = faireCtx();
    await mesDonnees.panneaux.mesdonnees(ctx, 'autre-chose');
    assert.deepEqual(ctx.journal, []);
});

test('la demande d\'effacement est enregistrée puis annoncée dans les mêmes termes', async () => {
    const ctx = faireCtx({ guildeId: 'G-EFF', auteurId: 'U-EFF' });
    await mesDonnees.panneaux.mesdonnees(ctx, 'erase');

    const ligne = getDb().prepare(`
        SELECT * FROM erasure_requests WHERE guild_id = ? AND subject_id = ?
    `).get('G-EFF', 'U-EFF');
    assert.ok(ligne, 'la demande doit être enregistrée');
    assert.equal(ligne.status, 'pending');
    assert.equal(ligne.source, 'command');
    assert.equal(ligne.category, 'mixed');
    assert.equal(ligne.details, 'Demande déposée via /mes-donnees');
    // Un mois (art. 12.3), exprimé en 30 jours comme la table l'attend.
    assert.equal(ligne.due_at - ligne.requested_at, 30 * 24 * 60 * 60);

    const [, contenu, options] = premier(ctx, 'repondre');
    assert.equal(contenu.titre, '✅ Demande de suppression transmise');
    assert.equal(
        contenu.description,
        'Votre demande de suppression a été **transmise à l\'équipe d\'administration de ce serveur**, '
        + 'qui est responsable de vos données et décide des suites à donner. '
        + 'Elle dispose d\'**un mois** pour y répondre.\n\n'
        + 'Venacity (contact@vena.city), qui héberge Quasar, a acheminé votre demande et exécutera la décision de l\'équipe. '
        + 'Certaines données peuvent devoir être conservées (par exemple une sanction encore active) ; '
        + 'le cas échéant, l\'équipe du serveur vous le fera savoir.',
    );
    assert.equal(contenu.pied.texte, 'Vous pouvez fermer ce message : votre demande est enregistrée.');
    assert.deepEqual(options, { ephemere: true, sensible: true });
});

test('une seconde demande ne duplique rien et le dit', async () => {
    const ctx = faireCtx({ guildeId: 'G-EFF2', auteurId: 'U-EFF2' });
    await mesDonnees.panneaux.mesdonnees(ctx, 'erase');
    const ctx2 = faireCtx({ guildeId: 'G-EFF2', auteurId: 'U-EFF2' });
    await mesDonnees.panneaux.mesdonnees(ctx2, 'erase');

    const total = getDb().prepare(`
        SELECT COUNT(*) AS n FROM erasure_requests WHERE guild_id = ? AND subject_id = ?
    `).get('G-EFF2', 'U-EFF2').n;
    assert.equal(total, 1, 'une seule demande en cours par personne et par serveur');

    const [, contenu] = premier(ctx2, 'repondre');
    assert.equal(contenu.titre, '📨 Demande déjà en cours');
    assert.equal(
        contenu.description,
        'Une demande de suppression vous concernant est **déjà en attente de traitement** sur ce serveur. '
        + 'Inutile d\'en déposer une nouvelle : l\'équipe d\'administration du serveur en a été informée '
        + 'et dispose d\'un mois pour y répondre.\n\n'
        + 'Pour un suivi ou une précision, vous pouvez contacter l\'équipe du serveur ou Venacity (contact@vena.city).',
    );
});

// ── 5. Découplage effectif ───────────────────────────────────────────────────

test('les fichiers migrés du lot 5 n\'importent plus discord.js', () => {
    for (const relatif of ['bot/commands/signaler.js', 'bot/commands/mesdonnees.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', relatif), 'utf8');
        assert.equal(
            /require\(['"]discord\.js['"]\)/.test(source), false,
            `${relatif} importe encore discord.js`,
        );
        // Le rendu de la plateforme non plus : un import de bot/platform/discord/
        // depuis du code métier rendrait la commande inutilisable sur Fluxer.
        assert.equal(
            /require\(['"][^'"]*platform\/discord/.test(source), false,
            `${relatif} importe l'adaptateur Discord`,
        );
    }
});
