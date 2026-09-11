// ═══════════════════════════════════════════════════════════════
//  Registre de commandes déclaratif — partie neutre
//
//  C'est la pièce qui remplace les 62 `SlashCommandBuilder` du dépôt. Une
//  commande se DÉCRIT une fois ; chaque adaptateur en DÉRIVE sa forme (slash
//  côté Discord, commande préfixée côté Fluxer). Ce fichier ne connaît aucune
//  plateforme : il porte le vocabulaire du descripteur et sa validation.
//
//  La validation est volontairement stricte et exécutée AU CHARGEMENT du
//  fichier de commande. Elle est le principal filet du chantier : 27 commandes
//  restent à migrer, et une faute de frappe sur un type d'option produirait
//  sinon une commande déployée sans son option, ou un lot entier refusé par
//  Discord — deux symptômes qui ne désignent pas leur cause.
// ═══════════════════════════════════════════════════════════════

const { estPermissionCanonique, PERMISSIONS } = require('./permissions');
const { estTypeCanalCanonique, TYPES_CANAL } = require('./channels');

// Types d'option du descripteur. La colonne Discord et la colonne Fluxer de la
// DA (§5.1) se dérivent toutes deux de cette liste ; l'adaptateur qui ne sait
// pas rendre un type doit le dire, pas l'ignorer.
const TYPES_OPTION = Object.freeze([
    'texte',        // chaîne libre
    'entier',       // nombre entier
    'booleen',      // vrai / faux
    'utilisateur',  // { id, nom, mention }
    'canal',        // { id, nom, type, mention }
    'role',         // { id, nom, mention }
    'choix',        // chaîne contrainte à `choix: [{ nom, valeur }]`
]);

const PLATEFORMES_CONNUES = Object.freeze(['discord', 'fluxer']);

// ─── Clés reconnues ──────────────────────────────────────────────────────────
//
// La validation LÈVE sur une clé inconnue, exactement comme `creerCapacites`.
// Sans cette sévérité, un `maxLength` écrit à la place de `max`, ou un
// `autocomplete` à la place de `autocompletion`, serait accepté puis déployé
// SANS la contrainte : l'option existerait, elle ne validerait simplement rien.
// Vingt-sept commandes restent à migrer par cinq agents : c'est la faute la plus
// probable du chantier, et la plus silencieuse.

/** Clés d'un descripteur de commande. */
const CLES_COMMANDE = Object.freeze([
    'nom',              // string, nom de la commande
    'description',      // string, 1 à 100 caractères
    'permission',       // string, nom canonique exigé du MEMBRE (cf. platform/permissions.js)
    'accesParDefaut',   // boolean, false = réservée aux administrateurs (cf. ci-dessous)
    'permissionsBot',   // string[], permissions dont le BOT a besoin (cf. ci-dessous)
    'plateformes',      // string[], omission = toutes
    'dansMessagePrive', // boolean, false = commande réservée aux serveurs
    'panneaux',         // { [panneau]: handler } — panneaux persistants (cf. ci-dessous)
    'options',          // Option[], exclusif avec sousCommandes
    'sousCommandes',    // SousCommande[], exclusif avec options
    'executer',         // (ctx) => Promise<void>
    'completer',        // (ctx) => Promise<void>, autocomplétion
]);

/** Clés d'une sous-commande. */
const CLES_SOUS_COMMANDE = Object.freeze([
    'nom', 'description', 'options', 'executer', 'permissionsBot',
]);

/** Clés d'une option. */
const CLES_OPTION = Object.freeze([
    'nom',            // string
    'description',    // string, obligatoire (Discord la refuse vide)
    'type',           // string, cf. TYPES_OPTION
    'requis',         // boolean
    'reste',          // boolean, capte la fin de ligne côté Fluxer, dernière option seulement
    'choix',          // [{ nom, valeur }], obligatoire pour type 'choix'
    'min',            // number, longueur minimale (texte) ou valeur minimale (entier)
    'max',            // number, longueur maximale (texte) ou valeur maximale (entier)
    'autocompletion', // boolean, exclusif avec 'choix'
    'typesCanal',     // string[], noms canoniques (cf. platform/channels.js), type 'canal' seulement
]);

// ─── Panneaux persistants : un seul mot pour trois endroits ──────────────────
//
//  Un panneau persistant est un message durable dont les choix restent actifs
//  entre deux redémarrages : panneau de tickets, panneau de rôles-réactions,
//  panneau de salon vocal temporaire. Il se nomme, et ce NOM circule en trois
//  points qui doivent employer le même mot — `panneau` :
//
//    1. DÉCLARATION, dans le descripteur de la commande qui le porte :
//
//         panneaux: {
//             ticket: async (ctx, cle) => { … },
//         }
//
//       Le chargeur enregistre le handler au démarrage. C'est la seule voie :
//       `bot/index.js` est interdit aux lots parallèles, et sans cette clé un
//       lot devrait y écrire son préfixe en dur pour router ses propres clics.
//
//    2. POSE du panneau, depuis la commande :
//
//         await ctx.choose(embed({ … }), choix, { persistant: true, panneau: 'ticket' });
//
//       Rend `{ persistant: true, canalId, messageId }`, à stocker dans la
//       table `interaction_panels` pour retrouver le panneau plus tard.
//
//    3. ROUTAGE d'un clic, fait par l'adaptateur : il retrouve le handler
//       déclaré en 1 et lui passe un contexte complet plus la clé du choix.
//
//  Le nom du panneau est une donnée MÉTIER, pas un détail de plateforme : côté
//  Discord il devient le préfixe d'un `customId`, côté Fluxer il n'y a pas de
//  `customId` du tout. D'où `panneau` et non « préfixe » ou « identifiant ».

// Le nom d'un panneau ne peut pas contenir le séparateur que l'adaptateur
// Discord place entre le panneau et la clé du choix : `ticket:ouvrir` ne serait
// plus déchiffrable si le panneau s'appelait `a:b`.
const SEPARATEUR_INTERDIT_PANNEAU = ':';

function erreur(nomCommande, message) {
    return new Error(`Descripteur de commande « ${nomCommande || '?'} » invalide : ${message}`);
}

/**
 * Valide la clé `panneaux` d'un descripteur.
 * @returns {string[]} les noms de panneaux déclarés (éventuellement vide)
 */
function validerPanneaux(nomCommande, panneaux) {
    if (panneaux === undefined) return [];
    if (typeof panneaux !== 'object' || panneaux === null || Array.isArray(panneaux)) {
        throw erreur(nomCommande, '« panneaux » doit être un objet { nomDuPanneau: handler }.');
    }

    for (const [panneau, handler] of Object.entries(panneaux)) {
        if (!panneau || panneau.includes(SEPARATEUR_INTERDIT_PANNEAU)) {
            throw erreur(
                nomCommande,
                `nom de panneau invalide « ${panneau} » : attendu une chaîne non vide `
                + `et sans « ${SEPARATEUR_INTERDIT_PANNEAU} », qui sépare le panneau de la clé du choix.`,
            );
        }
        if (typeof handler !== 'function') {
            throw erreur(nomCommande, `panneau « ${panneau} » : le handler doit être une fonction (ctx, cle).`);
        }
    }
    return Object.keys(panneaux);
}

function validerOptions(nomCommande, contexte, options) {
    if (options === undefined) return [];
    if (!Array.isArray(options)) throw erreur(nomCommande, `${contexte} : « options » doit être un tableau.`);

    const vues = new Set();
    options.forEach((option, index) => {
        const ou = `${contexte}, option ${option?.nom || `#${index + 1}`}`;
        if (!option || typeof option.nom !== 'string' || !option.nom) {
            throw erreur(nomCommande, `${ou} : « nom » est obligatoire.`);
        }
        if (vues.has(option.nom)) throw erreur(nomCommande, `${ou} : nom d'option en double.`);
        vues.add(option.nom);

        for (const cle of Object.keys(option)) {
            if (!CLES_OPTION.includes(cle)) {
                throw erreur(nomCommande, `${ou} : clé inconnue « ${cle} ». Clés reconnues : ${CLES_OPTION.join(', ')}.`);
            }
        }

        if (typeof option.description !== 'string' || !option.description) {
            throw erreur(nomCommande, `${ou} : « description » est obligatoire (Discord la refuse vide).`);
        }
        if (!TYPES_OPTION.includes(option.type)) {
            throw erreur(nomCommande, `${ou} : type « ${option.type} » inconnu. Types acceptés : ${TYPES_OPTION.join(', ')}.`);
        }
        if (option.type === 'choix') {
            if (!Array.isArray(option.choix) || option.choix.length === 0) {
                throw erreur(nomCommande, `${ou} : un type « choix » exige un tableau « choix » non vide.`);
            }
            for (const choix of option.choix) {
                if (!choix || typeof choix.nom !== 'string' || choix.valeur === undefined) {
                    throw erreur(nomCommande, `${ou} : chaque choix doit porter { nom, valeur }.`);
                }
            }
        } else if (option.choix !== undefined) {
            throw erreur(nomCommande, `${ou} : « choix » n'a de sens que sur une option de type « choix ».`);
        }

        // `autocompletion` et `choix` s'excluent : Discord refuse une option qui
        // déclare les deux, et le lot entier avec.
        if (option.autocompletion && option.type === 'choix') {
            throw erreur(nomCommande, `${ou} : « autocompletion » et « choix » s'excluent.`);
        }

        // Sept commandes filtrent leur sélecteur de salon. Le filtre passe par
        // les noms canoniques, jamais par un entier de plateforme.
        if (option.typesCanal !== undefined) {
            if (option.type !== 'canal') {
                throw erreur(nomCommande, `${ou} : « typesCanal » n'a de sens que sur une option de type « canal ».`);
            }
            if (!Array.isArray(option.typesCanal) || option.typesCanal.length === 0) {
                throw erreur(nomCommande, `${ou} : « typesCanal » doit être un tableau non vide.`);
            }
            for (const type of option.typesCanal) {
                if (!estTypeCanalCanonique(type)) {
                    throw erreur(nomCommande, `${ou} : type de salon « ${type} » inconnu. Valeurs acceptées : ${TYPES_CANAL.join(', ')}.`);
                }
            }
        }

        // `min`/`max` ne sont interprétables que sur un texte (longueur) ou un
        // entier (valeur). Ailleurs, ils seraient silencieusement ignorés.
        for (const borne of ['min', 'max']) {
            if (option[borne] === undefined) continue;
            if (option.type !== 'texte' && option.type !== 'entier') {
                throw erreur(nomCommande, `${ou} : « ${borne} » ne s'applique qu'aux types « texte » et « entier ».`);
            }
            if (typeof option[borne] !== 'number') {
                throw erreur(nomCommande, `${ou} : « ${borne} » doit être un nombre.`);
            }
        }

        // `reste: true` capte tout le reste de la ligne côté Fluxer : une option
        // qui la suivrait ne pourrait jamais être remplie. La règle est
        // inapplicable côté Discord (les options y sont nommées), mais elle est
        // vérifiée ici pour que le descripteur reste valable sur les DEUX
        // plateformes — c'est tout l'intérêt d'un registre unique.
        if (option.reste && index !== options.length - 1) {
            throw erreur(nomCommande, `${ou} : « reste: true » n'est possible que sur la DERNIÈRE option.`);
        }
        // Discord n'accepte pas une option facultative avant une option requise.
        if (option.requis && index > 0 && options.slice(0, index).some(o => !o.requis)) {
            throw erreur(nomCommande, `${ou} : une option requise ne peut pas suivre une option facultative.`);
        }
    });

    return options;
}

/**
 * Valide un descripteur et le rend prêt à être consommé par les adaptateurs.
 *
 * @param {object} descripteur
 * @param {string}   descripteur.nom
 * @param {string}   descripteur.description
 * @param {string}   [descripteur.permission]     nom canonique exigé du MEMBRE
 * @param {boolean}  [descripteur.accesParDefaut]  false = administrateurs, true = tout le monde
 * @param {string[]} [descripteur.permissionsBot]  permissions dont le BOT a besoin
 * @param {Object<string, Function>} [descripteur.panneaux] panneaux persistants
 *   portés par cette commande, `{ nomDuPanneau: async (ctx, cle) => {} }`
 * @param {string[]} [descripteur.plateformes]     omission = toutes
 * @param {Array}    [descripteur.options]
 * @param {Array}    [descripteur.sousCommandes]   chacune { nom, description, options?, executer }
 * @param {Function} [descripteur.executer]        (ctx) => Promise<void>
 * @param {Function} [descripteur.completer]       autocomplétion, optionnelle
 * @returns {object} le descripteur lui-même, validé et augmenté du pont de
 *   compatibilité `data`. Il n'est volontairement PAS gelé : les adaptateurs
 *   doivent pouvoir y attacher ce dont ils ont besoin, et geler en surface
 *   donnerait l'illusion d'une immuabilité que les options imbriquées n'ont pas.
 */
function definirCommande(descripteur) {
    if (!descripteur || typeof descripteur !== 'object') {
        throw new Error('definirCommande attend un objet descripteur.');
    }
    const nom = descripteur.nom;
    if (typeof nom !== 'string' || !nom) throw erreur(nom, '« nom » est obligatoire.');

    for (const cle of Object.keys(descripteur)) {
        if (!CLES_COMMANDE.includes(cle)) {
            throw erreur(nom, `clé inconnue « ${cle} ». Clés reconnues : ${CLES_COMMANDE.join(', ')}.`);
        }
    }

    if (typeof descripteur.description !== 'string' || !descripteur.description) {
        throw erreur(nom, '« description » est obligatoire.');
    }
    if (descripteur.permission !== undefined && !estPermissionCanonique(descripteur.permission)) {
        throw erreur(nom, `permission « ${descripteur.permission} » inconnue. Noms acceptés : ${PERMISSIONS.join(', ')}.`);
    }

    // ─── Accès : jamais ouvert par défaut ────────────────────────────────────
    //
    // `permission` nomme la permission exigée du membre. `accesParDefaut: false`
    // correspond au `setDefaultMemberPermissions(0)` de Discord : réservée aux
    // administrateurs, ce qu'aucun nom de permission n'exprime (`/ticket` s'en
    // sert). `accesParDefaut: true` déclare l'ouverture VOLONTAIRE (`/ping`).
    //
    // Ne déclarer ni l'un ni l'autre est refusé. C'est le défaut le plus
    // dangereux du registre : une commande d'administration migrée en oubliant
    // le champ deviendrait accessible à n'importe quel membre — sans erreur,
    // sans journal, et sans que rien ne distingue « ouverte exprès » de
    // « ouverte par oubli ».
    if (descripteur.accesParDefaut !== undefined && typeof descripteur.accesParDefaut !== 'boolean') {
        throw erreur(nom, '« accesParDefaut » doit valoir true (ouverte à tous) ou false (administrateurs).');
    }
    if (descripteur.permission === undefined && descripteur.accesParDefaut === undefined) {
        throw erreur(
            nom,
            'l\'accès n\'est pas déclaré. Renseignez « permission » (nom canonique exigé du membre), '
            + '« accesParDefaut: false » (réservée aux administrateurs) ou « accesParDefaut: true » '
            + '(ouverte à tout le monde, volontairement). L\'ouverture n\'est jamais implicite.',
        );
    }
    if (descripteur.permission !== undefined && descripteur.accesParDefaut !== undefined) {
        throw erreur(
            nom,
            '« permission » et « accesParDefaut » se contredisent : déclarez l\'un OU l\'autre. '
            + 'Une permission nommée décrit déjà qui voit la commande.',
        );
    }

    // Permissions dont le BOT a besoin — à ne pas confondre avec `permission`,
    // qui porte sur le membre. Elles alimentent le contrôle du masque du lien
    // d'invitation (test/invite-permissions.test.js) : sans elles, une commande
    // migrée sort du balayage `PermissionFlagsBits` et le garde-fou devient un
    // faux témoin.
    if (descripteur.permissionsBot !== undefined) {
        if (!Array.isArray(descripteur.permissionsBot)) {
            throw erreur(nom, '« permissionsBot » doit être un tableau de noms canoniques (éventuellement vide).');
        }
        for (const permission of descripteur.permissionsBot) {
            if (!estPermissionCanonique(permission)) {
                throw erreur(nom, `permissionsBot : « ${permission} » inconnue. Noms acceptés : ${PERMISSIONS.join(', ')}.`);
            }
        }
    }
    if (descripteur.plateformes !== undefined) {
        if (!Array.isArray(descripteur.plateformes) || descripteur.plateformes.length === 0) {
            throw erreur(nom, '« plateformes » doit être un tableau non vide (l\'omettre signifie « toutes »).');
        }
        for (const plateforme of descripteur.plateformes) {
            if (!PLATEFORMES_CONNUES.includes(plateforme)) {
                throw erreur(nom, `plateforme « ${plateforme} » inconnue. Valeurs acceptées : ${PLATEFORMES_CONNUES.join(', ')}.`);
            }
        }
    }

    validerPanneaux(nom, descripteur.panneaux);

    const sousCommandes = descripteur.sousCommandes;
    if (sousCommandes !== undefined) {
        if (!Array.isArray(sousCommandes) || sousCommandes.length === 0) {
            throw erreur(nom, '« sousCommandes » doit être un tableau non vide.');
        }
        if (descripteur.options) {
            // Discord l'interdit : une commande porte des options OU des
            // sous-commandes, jamais les deux. Le lot serait refusé en bloc.
            throw erreur(nom, 'une commande à sous-commandes ne peut pas porter d\'options à sa racine.');
        }
        const vues = new Set();
        for (const sous of sousCommandes) {
            if (!sous || typeof sous.nom !== 'string' || !sous.nom) throw erreur(nom, 'chaque sous-commande doit porter un « nom ».');
            for (const cle of Object.keys(sous)) {
                if (!CLES_SOUS_COMMANDE.includes(cle)) {
                    throw erreur(nom, `sous-commande « ${sous.nom} » : clé inconnue « ${cle} ». Clés reconnues : ${CLES_SOUS_COMMANDE.join(', ')}.`);
                }
            }
            if (vues.has(sous.nom)) throw erreur(nom, `sous-commande « ${sous.nom} » en double.`);
            vues.add(sous.nom);
            if (typeof sous.description !== 'string' || !sous.description) {
                throw erreur(nom, `sous-commande « ${sous.nom} » : « description » est obligatoire.`);
            }
            if (typeof sous.executer !== 'function' && typeof descripteur.executer !== 'function') {
                throw erreur(nom, `sous-commande « ${sous.nom} » : « executer » manquant, et la commande n'en porte pas non plus.`);
            }
            validerOptions(nom, `sous-commande ${sous.nom}`, sous.options);
        }
    } else {
        if (typeof descripteur.executer !== 'function') {
            throw erreur(nom, '« executer » est obligatoire pour une commande sans sous-commandes.');
        }
        validerOptions(nom, 'racine', descripteur.options);
    }

    // ─── Pont de compatibilité, temporaire ───────────────────────────────────
    // `reservedCommandNames()` (bot/commands/customcmd.js) établit la liste des
    // noms déjà pris par Quasar en lisant `mod.data.name` sur chaque fichier de
    // bot/commands/. Un descripteur neutre n'a pas de `data` : sans ce pont,
    // /ping et /autorole sortiraient de cette liste et un homonyme personnalisé
    // pourrait être créé — puis resterait inerte (bot/index.js résout d'abord
    // ses propres commandes) et serait écarté au déploiement, sans qu'aucun
    // message ne relie le symptôme à sa cause.
    //
    // Volontairement réduit à `{ name }` et non énumérable : ce n'est PAS le
    // builder de la plateforme, et rien ne doit se mettre à appeler
    // `data.toJSON()` dessus. Le rendu passe par platform/discord/commands.js.
    // À retirer quand customcmd.js lira le registre (lot 3).
    Object.defineProperty(descripteur, 'data', {
        value: Object.freeze({ name: nom }),
        enumerable: false,
    });

    return descripteur;
}

/**
 * Descripteur neutre ou module discord.js historique ?
 *
 * Les deux formats cohabitent pendant les lots 1 à 5. Le critère est `executer`
 * (français, neutre) contre `execute` (anglais, hérité) : un module qui porte
 * les deux est une migration à moitié faite, et on le signale plutôt que de
 * choisir à sa place.
 */
function estDescripteurNeutre(mod) {
    if (!mod || typeof mod !== 'object') return false;
    const neutre = typeof mod.nom === 'string'
        && (typeof mod.executer === 'function' || Array.isArray(mod.sousCommandes));
    if (neutre && typeof mod.execute === 'function') {
        throw new Error(
            `La commande « ${mod.nom} » porte à la fois « executer » (neutre) et « execute » (discord.js). `
            + 'Une commande migrée ne garde que « executer ».'
        );
    }
    return neutre;
}

/** La commande est-elle déclarée disponible sur cette plateforme ? */
function commandeDisponible(descripteur, nomPlateforme) {
    if (!Array.isArray(descripteur?.plateformes)) return true;
    return descripteur.plateformes.includes(nomPlateforme);
}

/** La sous-commande visée, ou `undefined` si la commande n'en a pas. */
function trouverSousCommande(descripteur, nomSousCommande) {
    if (!Array.isArray(descripteur?.sousCommandes)) return undefined;
    return descripteur.sousCommandes.find(sous => sous.nom === nomSousCommande);
}

module.exports = {
    TYPES_OPTION,
    PLATEFORMES_CONNUES,
    SEPARATEUR_INTERDIT_PANNEAU,
    validerPanneaux,
    CLES_COMMANDE,
    CLES_SOUS_COMMANDE,
    CLES_OPTION,
    definirCommande,
    estDescripteurNeutre,
    commandeDisponible,
    trouverSousCommande,
};
