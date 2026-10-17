// ═══════════════════════════════════════════════════════════════
//  Lot 6 — Le parseur de commandes préfixées
//
//  Chaque règle de la DA §5.3 a son test, chaque type d'option le sien. Ce
//  fichier est le filet du lot : le parseur remplace à lui seul ce que la
//  plateforme fait pour nous côté Discord — le typage des options ET le contrôle
//  d'accès. Une règle qui se relâche ici ouvre une commande d'administration à
//  tout le serveur, sans erreur et sans journal.
// ═══════════════════════════════════════════════════════════════

const test = require('node:test');
const assert = require('node:assert/strict');

const { definirCommande } = require('../bot/platform/commands');
const {
    decouper, convertir, remplirOptions, analyser, construireIndex, construireUsage,
    construireAide, construireSlashCommand, verifierAcces, verifierAccesCommandePersonnalisee,
    entreeDepuisExport, PREFIXE_PAR_DEFAUT,
} = require('../bot/platform/fluxer/commands');

const PREFIXE = PREFIXE_PAR_DEFAUT;

/** Membre normalisé en doublure, avec le jeu de permissions qu'on lui donne. */
const membre = (permissions = [], roles = []) => ({
    id: '4', roles, aPermission: (nom) => permissions.includes(nom),
});

// ─── Règle 1 : le préfixe ────────────────────────────────────────────────────

test('règle 1 — le préfixe est configurable, et lui seul déclenche', () => {
    const index = construireIndex([{ nom: 'ping', descripteur: { nom: 'ping' } }]);
    assert.equal(analyser('ping', { prefixe: PREFIXE, index }), null, 'sans préfixe, ce n\'est pas une commande');
    assert.equal(analyser('bonjour !', { prefixe: PREFIXE, index }), null, 'un « ! » en fin de phrase non plus');
    assert.equal(analyser('!', { prefixe: PREFIXE, index }), null, 'le préfixe seul non plus');
    assert.equal(analyser('!ping', { prefixe: PREFIXE, index }).commande, 'ping');
    // Un autre préfixe : la même ligne cesse d'être une commande.
    assert.equal(analyser('!ping', { prefixe: '?', index }), null);
    assert.equal(analyser('?ping', { prefixe: '?', index }).commande, 'ping');
});

test('règle 1 — la casse du nom de commande est ignorée', () => {
    const index = construireIndex([{ nom: 'ping', descripteur: { nom: 'ping' } }]);
    assert.equal(analyser('!PING', { prefixe: PREFIXE, index }).commande, 'ping');
});

// ─── Règle 2 : commande puis sous-commande ───────────────────────────────────

test('règle 2 — le second jeton est une sous-commande SI le descripteur en déclare', () => {
    const avec = definirCommande({
        nom: 'autorole', description: 'd', permission: 'MANAGE_ROLES',
        sousCommandes: [
            { nom: 'add', description: 'd', options: [{ nom: 'role', type: 'role', description: 'd', requis: true }], async executer() {} },
            { nom: 'list', description: 'd', async executer() {} },
        ],
    });
    const sans = definirCommande({
        nom: 'warn', description: 'd', permission: 'MODERATE_MEMBERS',
        options: [{ nom: 'membre', type: 'utilisateur', description: 'd', requis: true }],
        async executer() {},
    });
    const index = construireIndex([
        { nom: 'autorole', descripteur: avec }, { nom: 'warn', descripteur: sans },
    ]);

    const a = analyser('!autorole add <@&7>', { prefixe: PREFIXE, index });
    assert.equal(a.sousCommande.nom, 'add');
    assert.equal(a.jetons.length, 1, 'la sous-commande est consommée, pas comptée comme option');

    // Sur une commande SANS sous-commandes, le second jeton reste une option.
    const w = analyser('!warn <@4>', { prefixe: PREFIXE, index });
    assert.equal(w.sousCommande, null);
    assert.equal(w.jetons.length, 1);

    // Sous-commande inconnue : elle n'est pas consommée, et le remplissage
    // échouera sur une option requise manquante — ce qui produit l'aide.
    const inconnue = analyser('!autorole nimporte', { prefixe: PREFIXE, index });
    assert.equal(inconnue.sousCommande, null);
});

// ─── Règle 3 : remplissage positionnel ───────────────────────────────────────

test('règle 3 — les options se remplissent dans l\'ordre du descripteur', () => {
    const options = [
        { nom: 'membre', type: 'utilisateur', description: 'd', requis: true },
        { nom: 'duree', type: 'entier', description: 'd', requis: true },
    ];
    const ligne = '<@4> 30';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.membre.id, '4');
    assert.equal(valeurs.duree, 30);
});

// ─── Règle 4 : reste de ligne ────────────────────────────────────────────────

test('règle 4 — « reste: true » capte la fin de la ligne, espaces compris', () => {
    const options = [
        { nom: 'membre', type: 'utilisateur', description: 'd', requis: true },
        { nom: 'raison', type: 'texte', description: 'd', reste: true },
    ];
    const ligne = '<@4> spam  répété   plusieurs fois';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.membre.id, '4');
    assert.equal(valeurs.raison, 'spam  répété   plusieurs fois', 'les espaces internes sont conservés');
});

test('règle 4 — une option « reste » absente n\'invente pas de valeur', () => {
    const options = [
        { nom: 'membre', type: 'utilisateur', description: 'd', requis: true },
        { nom: 'raison', type: 'texte', description: 'd', reste: true },
    ];
    const ligne = '<@4>';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.raison, undefined, 'le code métier applique son propre défaut');
});

// ─── Règle 5 : forme nommée, prioritaire ─────────────────────────────────────

test('règle 5 — « cle:valeur » est acceptée et prime sur la position', () => {
    const options = [
        { nom: 'salon', type: 'canal', description: 'd' },
        { nom: 'nombre', type: 'entier', description: 'd' },
    ];
    // `nombre:5` est lu en premier ; `<#3>` remplit alors `salon` par position.
    const ligne = 'nombre:5 <#3>';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.nombre, 5);
    assert.equal(valeurs.salon.id, '3');
});

test('règle 5 — une forme nommée sur une option « reste » capte la fin de ligne', () => {
    const options = [
        { nom: 'membre', type: 'utilisateur', description: 'd' },
        { nom: 'raison', type: 'texte', description: 'd', reste: true },
    ];
    const ligne = '<@4> raison:publicité répétée depuis trois jours';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.raison, 'publicité répétée depuis trois jours');
});

test('règle 5 — un « : » qui n\'est pas un nom d\'option déclaré reste une valeur', () => {
    const options = [{ nom: 'texte', type: 'texte', description: 'd', reste: true }];
    // Sans la condition « nom déclaré », l'URL serait lue comme `https:...`.
    const ligne = 'https://vena.city/soutenir';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.texte, 'https://vena.city/soutenir');

    // Et un emoji personnalisé, qui porte deux « : », doit survivre.
    const emoji = [{ nom: 'emoji', type: 'texte', description: 'd' }];
    const ligne2 = '<:quasar:55>';
    assert.equal(remplirOptions(emoji, decouper(ligne2), ligne2).valeurs.emoji, '<:quasar:55>');
});

test('les guillemets permettent un espace dans une option qui n\'est pas la dernière', () => {
    const options = [
        { nom: 'nom', type: 'texte', description: 'd' },
        { nom: 'nombre', type: 'entier', description: 'd' },
    ];
    const ligne = '"salon de test" 4';
    const { valeurs } = remplirOptions(options, decouper(ligne), ligne);
    assert.equal(valeurs.nom, 'salon de test');
    assert.equal(valeurs.nombre, 4);
});

// ─── Règle 6 : usage dérivé ──────────────────────────────────────────────────

test('règle 6 — une option requise manquante produit un message d\'usage dérivé', () => {
    const options = [{ nom: 'membre', type: 'utilisateur', description: 'Le membre à avertir', requis: true }];
    const resultat = remplirOptions(options, [], '');
    assert.ok(resultat.erreur, 'un manque doit être signalé');
    assert.ok(resultat.manquante, 'et distingué d\'une valeur invalide');
    assert.match(resultat.erreur, /membre/);
});

test('règle 6 — l\'usage et l\'aide se dérivent entièrement du descripteur', () => {
    const descripteur = definirCommande({
        nom: 'warn', description: 'Avertir un membre', permission: 'MODERATE_MEMBERS',
        options: [
            { nom: 'membre', type: 'utilisateur', description: 'Le membre à avertir', requis: true },
            { nom: 'raison', type: 'texte', description: 'Motif', reste: true },
        ],
        async executer() {},
    });
    assert.equal(construireUsage(descripteur, null, PREFIXE), '!warn <membre> [raison]');

    const aide = construireAide(descripteur, null, PREFIXE);
    assert.match(aide, /!warn <membre> \[raison\]/);
    assert.match(aide, /Le membre à avertir/, 'la description de chaque option y figure');
    assert.match(aide, /capte la fin de la ligne/, 'et la particularité de « reste »');
});

test('la forme dérivée d\'un descripteur porte ses sous-commandes', () => {
    const descripteur = definirCommande({
        nom: 'ticket', description: 'd', accesParDefaut: false,
        sousCommandes: [{ nom: 'close', description: 'Fermer', async executer() {} }],
    });
    const forme = construireSlashCommand(descripteur, { prefixe: PREFIXE });
    assert.equal(forme.nom, 'ticket');
    assert.equal(forme.sousCommandes[0].usage, '!ticket close');
});

// ─── Types d'option ──────────────────────────────────────────────────────────

test('type texte — les bornes min et max portent la LONGUEUR', () => {
    const option = { nom: 't', type: 'texte', description: 'd', min: 3, max: 5 };
    assert.ok(convertir(option, 'ab').erreur);
    assert.equal(convertir(option, 'abcd').valeur, 'abcd');
    assert.ok(convertir(option, 'abcdef').erreur);
});

test('type entier — rejeté si non numérique, bornes sur la VALEUR', () => {
    const option = { nom: 'n', type: 'entier', description: 'd', min: 1, max: 100 };
    assert.match(convertir(option, 'douze').erreur, /nombre entier/);
    assert.match(convertir(option, '12abc').erreur, /nombre entier/);
    assert.match(convertir(option, '1e3').erreur, /nombre entier/, 'la notation scientifique aussi');
    assert.equal(convertir(option, '12').valeur, 12);
    assert.ok(convertir(option, '0').erreur);
    assert.ok(convertir(option, '101').erreur);
    assert.equal(convertir({ nom: 'n', type: 'entier', description: 'd' }, '-5').valeur, -5);
});

test('type booleen — oui/non/true/false', () => {
    const option = { nom: 'b', type: 'booleen', description: 'd' };
    for (const vrai of ['oui', 'true', 'OUI', 'vrai', '1']) assert.equal(convertir(option, vrai).valeur, true, vrai);
    for (const faux of ['non', 'false', 'NON', 'faux', '0']) assert.equal(convertir(option, faux).valeur, false, faux);
    assert.match(convertir(option, 'peut-être').erreur, /oui.*non/);
});

test('type choix — validé contre la liste déclarée', () => {
    const option = {
        nom: 'c', type: 'choix', description: 'd',
        choix: [{ nom: 'Tout le monde', valeur: 'everyone' }, { nom: 'Administrateurs', valeur: 'admins' }],
    };
    assert.equal(convertir(option, 'everyone').valeur, 'everyone');
    assert.equal(convertir(option, 'Administrateurs').valeur, 'admins', 'le libellé est accepté aussi');
    assert.match(convertir(option, 'personne').erreur, /everyone/);
});

test('type utilisateur — mention ou identifiant brut', () => {
    const option = { nom: 'u', type: 'utilisateur', description: 'd' };
    assert.equal(convertir(option, '<@1501314428688998182>').valeur.id, '1501314428688998182');
    assert.equal(convertir(option, '<@!1501314428688998182>').valeur.id, '1501314428688998182', 'forme héritée');
    assert.equal(convertir(option, '1501314428688998182').valeur.id, '1501314428688998182');
    assert.match(convertir(option, 'ada').erreur, /mention/);
    // Une mention de SALON n'est pas une personne.
    assert.ok(convertir(option, '<#1501314428688998182>').erreur);
});

test('type canal — mention, identifiant, et filtre typesCanal', () => {
    const option = { nom: 'c', type: 'canal', description: 'd' };
    assert.equal(convertir(option, '<#3333333>').valeur.id, '3333333');
    assert.match(convertir(option, 'general').erreur, /salon/);

    const filtre = { nom: 'c', type: 'canal', description: 'd', typesCanal: ['vocal'] };
    const resolveur = { canal: (id) => ({ id, nom: 'general', type: 'texte', mention: `<#${id}>` }) };
    assert.match(convertir(filtre, '<#3333333>', resolveur).erreur, /vocal/);
    const vocal = { canal: (id) => ({ id, nom: 'Vocal', type: 'vocal', mention: `<#${id}>` }) };
    assert.equal(convertir(filtre, '<#3333333>', vocal).valeur.type, 'vocal');
});

test('type role — mention ou identifiant', () => {
    const option = { nom: 'r', type: 'role', description: 'd' };
    assert.equal(convertir(option, '<@&7777777>').valeur.id, '7777777');
    assert.equal(convertir(option, '7777777').valeur.id, '7777777');
    assert.match(convertir(option, '@Modo').erreur, /rôle/);
});

test('une entité non résolue reste ACTIONNABLE, même sans nom', () => {
    // Toutes les méthodes d'`api` prennent des identifiants : une entité
    // réduite à `{ id, mention }` suffit pour agir. C'est l'affichage qui perd.
    const valeur = convertir({ nom: 'u', type: 'utilisateur', description: 'd' }, '4444444').valeur;
    assert.equal(valeur.id, '4444444');
    assert.equal(valeur.mention, '<@4444444>');
    assert.equal(valeur.nom, null);
});

// ─── Contrôle d'accès à l'exécution ──────────────────────────────────────────

test('accesParDefaut: false n\'est exécutable que par un ADMINISTRATEUR', () => {
    const ticket = definirCommande({ nom: 'ticket', description: 'd', accesParDefaut: false, async executer() {} });
    assert.equal(verifierAcces(ticket, membre(['ADMINISTRATOR'])), null);

    const refus = verifierAcces(ticket, membre(['MANAGE_GUILD']));
    assert.ok(refus, 'un membre sans ADMINISTRATOR est refusé');
    assert.match(refus.titre, /administrateur/i);

    // Membre illisible : REFUSÉ. Un « je ne sais pas » ne devient jamais un droit.
    assert.ok(verifierAcces(ticket, null));
});

test('permission nommée — le membre doit la porter', () => {
    const warn = definirCommande({
        nom: 'warn', description: 'd', permission: 'MODERATE_MEMBERS', async executer() {},
    });
    assert.equal(verifierAcces(warn, membre(['MODERATE_MEMBERS'])), null);
    const refus = verifierAcces(warn, membre([]));
    assert.match(refus.cause, /MODERATE_MEMBERS/);
    assert.ok(verifierAcces(warn, null), 'membre illisible : refusé');
});

test('accesParDefaut: true est ouvert, volontairement', () => {
    const ping = definirCommande({ nom: 'ping', description: 'd', accesParDefaut: true, async executer() {} });
    assert.equal(verifierAcces(ping, membre([])), null);
    assert.equal(verifierAcces(ping, null), null, 'ouverte même sans membre lisible');
});

test('dansMessagePrive: false refuse la commande hors serveur', () => {
    const cmd = definirCommande({
        nom: 'x', description: 'd', accesParDefaut: true, dansMessagePrive: false, async executer() {},
    });
    assert.equal(verifierAcces(cmd, membre([]), { enPrive: false }), null);
    assert.match(verifierAcces(cmd, null, { enPrive: true }).titre, /serveur/i);
});

test('un descripteur sans accès déclaré est REFUSÉ à l\'exécution', () => {
    // `definirCommande` le refuse déjà au chargement ; ce test couvre le
    // descripteur construit à la main, et vérifie qu'on ne retombe pas sur
    // « ouvert à tous » — le défaut le plus dangereux du registre.
    const refus = verifierAcces({ nom: 'x', description: 'd' }, membre(['ADMINISTRATOR']));
    assert.ok(refus, 'aucun accès déclaré : on refuse, même à un administrateur');
});

// ─── Commandes personnalisées ────────────────────────────────────────────────

test('commande personnalisée — mode everyone laisse passer tout le monde', () => {
    assert.equal(verifierAccesCommandePersonnalisee({ name: 'faq', access_mode: 'everyone' }, membre([])), null);
    // Valeur absente : ligne antérieure à la migration, comportement historique.
    assert.equal(verifierAccesCommandePersonnalisee({ name: 'faq', access_mode: null }, membre([])), null);
});

test('commande personnalisée — mode admins, et contournement administrateur', () => {
    const ligne = { name: 'faq', access_mode: 'admins' };
    assert.ok(verifierAccesCommandePersonnalisee(ligne, membre([])));
    assert.equal(verifierAccesCommandePersonnalisee(ligne, membre(['ADMINISTRATOR'])), null);
});

test('commande personnalisée — mode role, rôle porté, rôle absent, rôle supprimé', () => {
    const roles = new Map([['77', { id: '77' }]]);
    const ligne = { name: 'faq', access_mode: 'role', access_role_id: '77' };

    assert.equal(verifierAccesCommandePersonnalisee(ligne, membre([], ['77']), { roles }), null);
    assert.match(verifierAccesCommandePersonnalisee(ligne, membre([], []), { roles }).titre, /rôle/i);
    // Un administrateur passe quel que soit le mode : c'est ce qui rend le
    // réglage réparable.
    assert.equal(verifierAccesCommandePersonnalisee(ligne, membre(['ADMINISTRATOR'], []), { roles }), null);

    // Rôle supprimé du serveur : on refuse plutôt que de retomber sur « tout le
    // monde », ce qui ouvrirait en grand une commande volontairement restreinte.
    const supprime = { name: 'faq', access_mode: 'role', access_role_id: '99' };
    assert.match(
        verifierAccesCommandePersonnalisee(supprime, membre([], ['99']), { roles }).titre,
        /indisponible/i,
    );
});

test('commande personnalisée — un mode inconnu en base retombe sur le PLUS RESTRICTIF', () => {
    const ligne = { name: 'faq', access_mode: 'nimporte-quoi' };
    assert.ok(verifierAccesCommandePersonnalisee(ligne, membre([])), 'un non-administrateur est refusé');
    assert.equal(verifierAccesCommandePersonnalisee(ligne, membre(['ADMINISTRATOR'])), null);
});

test('une commande inconnue du registre est signalée comme telle', () => {
    const index = construireIndex([{ nom: 'ping', descripteur: { nom: 'ping' } }]);
    const analyse = analyser('!faq', { prefixe: PREFIXE, index });
    assert.equal(analyse.inconnue, true);
    assert.equal(analyse.commande, 'faq');
});

// ─── Chargement ──────────────────────────────────────────────────────────────

test('une commande Discord-only est écartée du chargement', () => {
    const musique = definirCommande({
        nom: 'play', description: 'd', accesParDefaut: true, plateformes: ['discord'], async executer() {},
    });
    assert.equal(entreeDepuisExport(musique, 'play.js', null), null);
});

test('une commande au format historique est REFUSÉE, avec le fichier nommé', () => {
    const historique = { data: { name: 'vieux' }, execute() {} };
    assert.throws(
        () => entreeDepuisExport(historique, 'vieux.js', null),
        /vieux\.js.*format historique/s,
    );
});

test('les 26 commandes du bot se chargent et se dérivent sans erreur', () => {
    const path = require('path');
    const { chargerCommandes } = require('../bot/platform/fluxer/commands');
    const { DISABLED_COMMAND_FILES } = require('../bot/utils/disabledCommands');

    const entrees = chargerCommandes({
        dossier: path.join(__dirname, '..', 'bot', 'commands'),
        exclus: DISABLED_COMMAND_FILES,
    });

    assert.ok(entrees.length > 0, 'aucune commande chargée');
    const noms = entrees.map(e => e.nom);
    assert.equal(new Set(noms).size, noms.length, 'doublon de nom de commande');
    // La famille musique déclare `plateformes: ['discord']` : elle ne doit pas
    // apparaître ici, sinon l'aide dérivée proposerait une commande morte.
    for (const musique of ['play', 'musicconfig']) {
        assert.ok(!noms.includes(musique), `${musique} ne devrait pas être chargée sur Fluxer`);
    }
    // Chaque entrée porte sa forme dérivée et son exécution.
    for (const entree of entrees) {
        assert.equal(typeof entree.execute, 'function', `${entree.nom} : pas exécutable`);
        assert.ok(entree.data.usage.startsWith('!'), `${entree.nom} : usage non dérivé`);
    }
});
