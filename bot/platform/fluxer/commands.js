// ═══════════════════════════════════════════════════════════════
//  Rendu Fluxer du registre de commandes : le parseur préfixé
//
//  C'est la pièce qui remplace les slash commands. Le même descripteur qui
//  produit un `SlashCommandBuilder` côté Discord produit ici un PARSEUR, et les
//  règles sont celles de la DA §5.3, dans l'ordre :
//
//    1. le préfixe est configurable par COMMAND_PREFIX, défaut « ! » ;
//    2. le premier jeton désigne la commande, le second une sous-commande si le
//       descripteur en déclare ;
//    3. les options se remplissent POSITIONNELLEMENT, dans l'ordre du descripteur ;
//    4. `reste: true` capte tout le reste de la ligne, espaces compris ;
//    5. la forme nommée `cle:valeur` est acceptée et PRIORITAIRE sur la position ;
//    6. une option requise manquante déclenche un message d'aide DÉRIVÉ du
//       descripteur, jamais une erreur brute.
//
//  ─── Ce que le parseur porte en plus, et pourquoi ───────────────────────────
//
//  Côté Discord, deux contrôles sont faits PAR LA PLATEFORME avant que le code
//  ne soit appelé : `default_member_permissions` masque la commande à qui n'a
//  pas le droit, et `dm_permission` la retire des messages privés. Fluxer n'a
//  rien de tel — une commande préfixée est un message comme un autre, tapé par
//  n'importe qui. Les deux contrôles sont donc refaits ICI, à l'exécution.
//
//  ⚠️ C'est le point le plus sensible du lot 6. Un descripteur
//  `accesParDefaut: false` (`/ticket`, et ses sous-commandes `config`, `add`,
//  `remove`) serait, sans ce contrôle, exécutable par n'importe quel membre du
//  serveur — sans erreur, sans journal, et sans que rien ne le distingue d'un
//  fonctionnement normal.
// ═══════════════════════════════════════════════════════════════

const { trouverSousCommande } = require('../commands');
const {
    chargerCommandes: chargerCommandesNeutre,
    entreeDepuisExport: entreeDepuisExportNeutre,
    enregistrerPanneaux,
    refuserModuleHistorique,
} = require('../chargeur-commandes');
const { verifierAccesCommandePersonnalisee } = require('../accesCommandePersonnalisee');

const NOM_PLATEFORME = 'fluxer';
const PREFIXE_PAR_DEFAUT = '!';

// Formes de mention acceptées pour chaque type d'option. `<@!id>` est la forme
// héritée d'une mention de membre avec pseudonyme : certains clients la
// produisent encore, et la refuser rendrait une commande inutilisable sans que
// personne comprenne pourquoi.
const MENTION_UTILISATEUR = /^<@!?(\d+)>$/;
const MENTION_CANAL = /^<#(\d+)>$/;
const MENTION_ROLE = /^<@&(\d+)>$/;
const IDENTIFIANT = /^\d{5,}$/;

// Valeurs acceptées pour un booléen (DA §5.1, colonne Fluxer). `oui`/`non`
// d'abord : c'est ce qu'une personne francophone tape, et le reste du bot
// vouvoie en français.
const VRAI = new Set(['oui', 'true', 'vrai', 'o', 'y', 'yes', '1']);
const FAUX = new Set(['non', 'false', 'faux', 'n', 'no', '0']);

/**
 * Découpe une ligne en jetons, en respectant les guillemets.
 *
 * Les guillemets ne sont PAS dans la DA, et c'est délibéré de les ajouter : sans
 * eux, `!welcome message:Bonjour à tous` s'arrête au premier espace sur une
 * option qui n'est pas la dernière. La règle 4 (`reste: true`) ne couvre que la
 * DERNIÈRE option ; toutes les autres ont besoin d'une façon de contenir un
 * espace. Les deux formes de guillemets sont acceptées, et un guillemet non
 * fermé capte jusqu'à la fin de ligne plutôt que d'échouer.
 *
 * @returns {Array<{valeur: string, debut: number, fin: number}>} les positions
 *   servent à `reste: true`, qui reprend la ligne BRUTE à partir d'un jeton.
 */
function decouper(ligne) {
    const jetons = [];
    let i = 0;
    while (i < ligne.length) {
        while (i < ligne.length && /\s/.test(ligne[i])) i += 1;
        if (i >= ligne.length) break;

        const debut = i;
        const quote = (ligne[i] === '"' || ligne[i] === '«') ? ligne[i] : null;
        if (quote) {
            const fermeture = quote === '«' ? '»' : quote;
            i += 1;
            let valeur = '';
            while (i < ligne.length && ligne[i] !== fermeture) { valeur += ligne[i]; i += 1; }
            if (i < ligne.length) i += 1; // guillemet fermant
            jetons.push({ valeur, debut, fin: i });
            continue;
        }

        let valeur = '';
        while (i < ligne.length && !/\s/.test(ligne[i])) { valeur += ligne[i]; i += 1; }
        jetons.push({ valeur, debut, fin: i });
    }
    return jetons;
}

/**
 * Ligne d'usage dérivée du descripteur (règle 6).
 *
 * Entièrement calculée : le descripteur porte déjà noms, types, descriptions et
 * obligations. C'est un gain net sur l'existant, où l'aide est maintenue à la
 * main et diverge du code à chaque évolution.
 */
function construireUsage(descripteur, sousCommande = null, prefixe = PREFIXE_PAR_DEFAUT) {
    const chemin = sousCommande ? `${descripteur.nom} ${sousCommande.nom}` : descripteur.nom;
    const options = (sousCommande?.options || descripteur.options || [])
        .map(o => (o.requis ? `<${o.nom}>` : `[${o.nom}]`))
        .join(' ');
    return `${prefixe}${chemin}${options ? ` ${options}` : ''}`.trim();
}

/** Détail d'une option, pour le message d'aide. */
function decrireOption(option) {
    const morceaux = [`\`${option.nom}\``, `(${option.type}${option.requis ? ', requis' : ''})`];
    if (option.description) morceaux.push(`— ${option.description}`);
    if (option.type === 'choix') {
        morceaux.push(`· valeurs : ${option.choix.map(c => `\`${c.valeur}\``).join(', ')}`);
    }
    if (option.reste) morceaux.push('· capte la fin de la ligne');
    return morceaux.join(' ');
}

/**
 * Message d'aide complet d'une commande ou d'une sous-commande.
 *
 * Rendu en TEXTE et non en embed : c'est une réponse d'erreur d'usage, qui doit
 * rester lisible même sans la permission EMBED_LINKS — laquelle est exactement
 * celle qui peut manquer sur le salon où quelqu'un tape une commande au hasard.
 */
function construireAide(descripteur, sousCommande = null, prefixe = PREFIXE_PAR_DEFAUT) {
    const lignes = [`**Usage** : \`${construireUsage(descripteur, sousCommande, prefixe)}\``];
    const description = sousCommande?.description || descripteur.description;
    if (description) lignes.push(description);

    const options = sousCommande?.options || descripteur.options || [];
    if (options.length > 0) {
        lignes.push('', ...options.map(o => `• ${decrireOption(o)}`));
    }
    if (!sousCommande && Array.isArray(descripteur.sousCommandes)) {
        lignes.push('', '**Sous-commandes** :');
        for (const sous of descripteur.sousCommandes) {
            lignes.push(`• \`${prefixe}${descripteur.nom} ${sous.nom}\` — ${sous.description}`);
        }
    }
    return lignes.join('\n');
}

/**
 * Forme DÉRIVÉE d'un descripteur pour cette plateforme.
 *
 * Le pendant exact de `construireSlashCommand` côté Discord : « descripteur ->
 * forme de la plateforme ». Ici la forme n'est pas un builder à déployer mais
 * une ligne d'usage et l'index des options que le parseur consulte — il n'y a
 * rien à enregistrer auprès de Fluxer, une commande préfixée n'existe que dans
 * ce processus.
 */
function construireSlashCommand(descripteur, { prefixe = PREFIXE_PAR_DEFAUT } = {}) {
    return {
        nom: descripteur.nom,
        description: descripteur.description,
        usage: construireUsage(descripteur, null, prefixe),
        aide: construireAide(descripteur, null, prefixe),
        sousCommandes: (descripteur.sousCommandes || []).map(sous => ({
            nom: sous.nom,
            description: sous.description,
            usage: construireUsage(descripteur, sous, prefixe),
            aide: construireAide(descripteur, sous, prefixe),
        })),
    };
}

// ─── Conversion d'un jeton en valeur typée ───────────────────────────────────

/**
 * Identifiant porté par une mention, ou identifiant brut.
 *
 * Les deux formes sont acceptées pour les trois types d'entité : une personne
 * colle souvent un identifiant plutôt que de mentionner (c'est même la seule
 * voie pour `!unban`, où la personne n'est plus sur le serveur et n'est donc
 * plus mentionnable).
 */
function extraireId(texte, motif) {
    const mention = motif.exec(texte);
    if (mention) return mention[1];
    return IDENTIFIANT.test(texte) ? texte : null;
}

/**
 * @param {object} resolveur  { utilisateur(id), canal(id), role(id) } — résout
 *   une entité depuis l'état local. Absent, les entités sont rendues sous leur
 *   forme minimale : `{ id, mention }` et le reste à null. C'est suffisant pour
 *   agir (toutes les méthodes d'`api` prennent des identifiants) mais pas pour
 *   afficher un nom, d'où la résolution quand elle est possible.
 * @returns {{valeur: any}|{erreur: string}}
 */
function convertir(option, brut, resolveur = {}) {
    const texte = String(brut ?? '').trim();

    switch (option.type) {
        case 'texte': {
            if (option.min !== undefined && texte.length < option.min) {
                return { erreur: `\`${option.nom}\` doit faire au moins ${option.min} caractères.` };
            }
            if (option.max !== undefined && texte.length > option.max) {
                return { erreur: `\`${option.nom}\` doit faire au plus ${option.max} caractères.` };
            }
            return { valeur: texte };
        }

        case 'entier': {
            // `Number()` accepterait « 12abc » via parseInt et « 1e3 » : on exige
            // une écriture décimale entière, signe compris. Un rejet ici est un
            // message d'usage, pas une exception.
            if (!/^-?\d+$/.test(texte)) {
                return { erreur: `\`${option.nom}\` attend un nombre entier (reçu : \`${texte}\`).` };
            }
            const valeur = Number.parseInt(texte, 10);
            if (option.min !== undefined && valeur < option.min) {
                return { erreur: `\`${option.nom}\` doit valoir au moins ${option.min}.` };
            }
            if (option.max !== undefined && valeur > option.max) {
                return { erreur: `\`${option.nom}\` doit valoir au plus ${option.max}.` };
            }
            return { valeur };
        }

        case 'booleen': {
            const bas = texte.toLowerCase();
            if (VRAI.has(bas)) return { valeur: true };
            if (FAUX.has(bas)) return { valeur: false };
            return { erreur: `\`${option.nom}\` attend \`oui\` ou \`non\` (reçu : \`${texte}\`).` };
        }

        case 'choix': {
            const trouve = option.choix.find(c => String(c.valeur) === texte || c.nom === texte);
            if (!trouve) {
                return {
                    erreur: `\`${option.nom}\` doit valoir ${option.choix.map(c => `\`${c.valeur}\``).join(', ')} `
                        + `(reçu : \`${texte}\`).`,
                };
            }
            return { valeur: trouve.valeur };
        }

        case 'utilisateur': {
            const id = extraireId(texte, MENTION_UTILISATEUR);
            if (!id) {
                return { erreur: `\`${option.nom}\` attend une mention (\`@personne\`) ou un identifiant.` };
            }
            return { valeur: resolveur.utilisateur?.(id) ?? { id, nom: null, etiquette: null, mention: `<@${id}>`, estBot: false } };
        }

        case 'canal': {
            const id = extraireId(texte, MENTION_CANAL);
            if (!id) {
                return { erreur: `\`${option.nom}\` attend une mention de salon (\`#salon\`) ou un identifiant.` };
            }
            const canal = resolveur.canal?.(id) ?? { id, nom: null, type: null, typeNatif: null, guildeId: null, parentId: null, mention: `<#${id}>` };
            // `typesCanal` filtre le sélecteur côté Discord ; ici il n'y a pas de
            // sélecteur, donc c'est un contrôle de SAISIE. Sans lui, `/tempvoice
            // salon:#general` accepterait un salon texte là où un vocal est
            // attendu, et l'échec surviendrait bien plus loin.
            if (option.typesCanal && canal.type && !option.typesCanal.includes(canal.type)) {
                return {
                    erreur: `\`${option.nom}\` attend un salon de type ${option.typesCanal.join(' ou ')} `
                        + `(reçu : ${canal.type}).`,
                };
            }
            return { valeur: canal };
        }

        case 'role': {
            const id = extraireId(texte, MENTION_ROLE);
            if (!id) {
                return { erreur: `\`${option.nom}\` attend une mention de rôle (\`@rôle\`) ou un identifiant.` };
            }
            return { valeur: resolveur.role?.(id) ?? { id, nom: null, mention: `<@&${id}>`, position: null, gere: false, couleur: '#000000', guildeId: null } };
        }

        default:
            return { erreur: `Type d'option « ${option.type} » non rendu par l'adaptateur Fluxer.` };
    }
}

/**
 * Remplit les options déclarées à partir des jetons.
 *
 * Applique les règles 3, 4 et 5 dans cet ordre : la forme nommée est lue
 * D'ABORD sur l'ensemble des jetons, puis les jetons restants sont distribués
 * positionnellement sur les options non encore remplies. C'est ce qui rend la
 * forme nommée réellement prioritaire — l'inverse la ferait consommer par la
 * position avant d'être reconnue.
 *
 * @param {string} ligne  ligne BRUTE après la commande, pour `reste: true`
 * @returns {{valeurs: object}|{erreur: string, option?: object}}
 */
function remplirOptions(options, jetons, ligne, resolveur = {}) {
    const declarees = options || [];
    if (declarees.length === 0) return { valeurs: {} };

    const parNom = new Map(declarees.map(o => [o.nom, o]));
    const valeurs = {};
    const restants = [];

    // ── Règle 5 : forme nommée `cle:valeur`, prioritaire ────────────────────
    //
    // Un jeton n'est une forme nommée que si ce qui précède le premier « : »
    // est un nom d'option DÉCLARÉ. Sans cette condition, `https://example.com`
    // et `<:emoji:55>` seraient lus comme des options nommées.
    for (let i = 0; i < jetons.length; i += 1) {
        const jeton = jetons[i];
        const separateur = jeton.valeur.indexOf(':');
        const cle = separateur > 0 ? jeton.valeur.slice(0, separateur) : null;
        const option = cle ? parNom.get(cle) : null;

        if (!option || valeurs[option.nom] !== undefined) { restants.push(jeton); continue; }

        // Une option `reste: true` nommée capte la fin de la LIGNE, à partir de
        // la valeur — c'est la règle 4, et elle vaut aussi sous forme nommée.
        const brut = option.reste
            ? ligne.slice(jeton.debut + separateur + 1)
            : jeton.valeur.slice(separateur + 1);

        const converti = convertir(option, brut, resolveur);
        if (converti.erreur) return { erreur: converti.erreur, option };
        valeurs[option.nom] = converti.valeur;
        if (option.reste) { i = jetons.length; break; }
    }

    // ── Règles 3 et 4 : position, puis reste de ligne ───────────────────────
    let curseur = 0;
    for (const option of declarees) {
        if (valeurs[option.nom] !== undefined) continue;
        if (curseur >= restants.length) continue;

        if (option.reste) {
            const brut = ligne.slice(restants[curseur].debut).trim();
            const converti = convertir(option, brut, resolveur);
            if (converti.erreur) return { erreur: converti.erreur, option };
            valeurs[option.nom] = converti.valeur;
            curseur = restants.length;
            break;
        }

        const converti = convertir(option, restants[curseur].valeur, resolveur);
        if (converti.erreur) return { erreur: converti.erreur, option };
        valeurs[option.nom] = converti.valeur;
        curseur += 1;
    }

    // ── Règle 6 : option requise manquante ──────────────────────────────────
    for (const option of declarees) {
        if (option.requis && valeurs[option.nom] === undefined) {
            return { erreur: `L'option \`${option.nom}\` est obligatoire.`, option, manquante: true };
        }
    }

    return { valeurs };
}

// ─── Contrôle d'accès, refait à l'exécution ──────────────────────────────────

/**
 * La personne peut-elle exécuter cette commande ?
 *
 * @returns {null|{titre, cause, action}} `null` = accès accordé.
 *
 * ⚠️ Un membre illisible (message privé, cache froid) ne PASSE PAS sur une
 * commande restreinte. C'est la règle de `memberIsAdministrator` dans
 * `bot/index.js`, et elle vaut ici pour la même raison : transformer un « je ne
 * sais pas » en droit accordé ouvrirait `/ticket config` à n'importe qui.
 */
function verifierAcces(descripteur, membre, { enPrive = false } = {}) {
    if (descripteur.dansMessagePrive === false && enPrive) {
        return {
            titre: 'Commande réservée aux serveurs',
            cause: 'Cette commande agit sur un serveur, et un message privé n\'en désigne aucun.',
            action: 'Relancez-la depuis un salon du serveur concerné.',
        };
    }

    // `accesParDefaut: true` : ouverture VOLONTAIRE, déclarée. Rien à vérifier.
    if (descripteur.accesParDefaut === true) return null;

    if (descripteur.accesParDefaut === false) {
        if (membre?.aPermission?.('ADMINISTRATOR')) return null;
        return {
            titre: 'Commande réservée aux administrateurs',
            cause: 'Cette commande est réservée aux membres ayant la permission « Administrateur » sur ce serveur.',
            action: 'Demandez à un administrateur de la lancer.',
        };
    }

    if (descripteur.permission) {
        // ADMINISTRATOR emporte tout le reste : `masqueMembre` rend déjà le
        // masque complet à qui le détient, le test ci-dessous suffit donc.
        if (membre?.aPermission?.(descripteur.permission)) return null;
        return {
            titre: 'Permission insuffisante',
            cause: `Cette commande demande la permission « ${descripteur.permission} » sur ce serveur.`,
            action: 'Demandez à un administrateur de vous l\'accorder, ou de lancer la commande.',
        };
    }

    // `definirCommande` refuse un descripteur qui ne déclare ni l'un ni l'autre :
    // ce cas ne devrait pas exister. S'il survient malgré tout (descripteur
    // construit à la main), on REFUSE — l'ouverture n'est jamais implicite.
    return {
        titre: 'Commande indisponible',
        cause: 'Son niveau d\'accès n\'est pas déclaré, je ne peux donc pas savoir qui a le droit de la lancer.',
        action: 'Signalez-le à l\'administration de l\'instance.',
    };
}

// ─── Commandes personnalisées ────────────────────────────────────────────────

/**
 * Corps du message d'une commande personnalisée.
 *
 * Les deux chemins divergent DÉLIBÉRÉMENT, exactement comme dans
 * `bot/index.js` : l'embed rejoue strictement les mentions cochées sur lui
 * (`parse: []` plus les listes explicites), le texte laisse la plateforme
 * analyser son contenu. Ne pas les « harmoniser ».
 *
 * @returns {object|null} corps neutre prêt pour `api.envoyerMessage`, ou `null`
 *   si la ligne ne porte ni embed ni réponse.
 */
function rendreCommandePersonnalisee(ligne, db) {
    if (ligne.embed_id) {
        const embedRow = db.prepare(
            'SELECT data, mention_roles, mention_users, mention_everyone, mention_here FROM embeds WHERE id = ?'
        ).get(ligne.embed_id);
        if (embedRow) {
            const { construireEmbedEnregistre } = require('../../commands/embed');
            const { buildMentionPayload } = require('../../../api/services/mentions');
            const { content, allowedMentions } = buildMentionPayload(embedRow);
            const corps = {
                embeds: [construireEmbedEnregistre(JSON.parse(embedRow.data))],
                mentionsAutorisees: allowedMentions,
            };
            if (content) corps.contenu = content;
            return corps;
        }
    }
    if (ligne.response) return { contenu: ligne.response };
    return null;
}

// ─── Index et chargement ─────────────────────────────────────────────────────

/**
 * Entrée normalisée d'une commande, quel que soit son format d'origine.
 *
 * @typedef {object} EntreeCommande
 * @property {string}   nom
 * @property {object}   data          forme dérivée (usage, aide, sous-commandes)
 * @property {Function} [execute]     (source) => Promise<void>
 * @property {string}   fichier
 * @property {boolean}  neutre
 * @property {object}   [descripteur]
 * @property {string[]} panneaux
 */

function entreeDepuisDescripteur(descripteur, fichier, adaptateur) {
    const entree = {
        nom: descripteur.nom,
        data: construireSlashCommand(descripteur, { prefixe: adaptateur?.prefixe }),
        fichier,
        neutre: true,
        descripteur,
        panneaux: Object.keys(descripteur.panneaux || {}),
    };

    // Le pont vers le contexte neutre est différé : `context.js` dépend de
    // `render.js` et de la table des permissions, et le charger au sommet de ce
    // fichier créerait un cycle avec l'adaptateur qui l'instancie.
    entree.execute = async (source) => {
        if (!adaptateur) {
            throw new Error(
                `La commande ${descripteur.nom} a été chargée sans adaptateur : elle ne peut pas être exécutée. `
                + 'Passez `adaptateur` à chargerCommandes().'
            );
        }
        const { creerContexteCommande } = require('./context');
        const sous = trouverSousCommande(descripteur, source.sousCommande);
        const ctx = creerContexteCommande(source, {
            adaptateur, descripteur, sousCommande: sous, valeurs: source.valeurs,
        });

        // Une sous-commande sans `executer` retombe sur celui de la commande :
        // `definirCommande` a déjà refusé le descripteur si ni l'une ni l'autre
        // n'en a.
        const executer = sous?.executer || descripteur.executer;
        return executer(ctx);
    };

    // ⚠️ `completer` est volontairement IGNORÉ. L'autocomplétion est une
    // interaction ; Fluxer n'en a pas. Enregistrer le handler donnerait une
    // entrée qui ne serait jamais appelée — et laisserait croire, à la lecture
    // de `client.commands`, que l'autocomplétion fonctionne.

    return entree;
}

/**
 * Charge toutes les commandes de `bot/commands/` — descripteurs neutres seuls.
 *
 * Le parcours, le refus du format historique et l'enregistrement des panneaux
 * vivent dans `bot/platform/chargeur-commandes.js`, partagés avec Discord :
 * seule la DÉRIVATION est propre à Fluxer, et c'est elle qu'on passe ici.
 */
function chargerCommandes({ dossier, exclus = [], adaptateur = null } = {}) {
    return chargerCommandesNeutre({
        dossier,
        exclus,
        adaptateur,
        nomPlateforme: NOM_PLATEFORME,
        fabriquerEntree: (descripteur, fichier) => entreeDepuisDescripteur(descripteur, fichier, adaptateur),
    });
}

/** @see bot/platform/chargeur-commandes.js */
function entreeDepuisExport(valeur, fichier, adaptateur) {
    return entreeDepuisExportNeutre(valeur, fichier, {
        nomPlateforme: NOM_PLATEFORME,
        fabriquerEntree: (descripteur, nomFichier) => entreeDepuisDescripteur(descripteur, nomFichier, adaptateur),
    });
}

/**
 * Construit l'index du parseur à partir des entrées chargées.
 *
 * C'est ce que fait `enregistrerCommandes(descripteurs)` sur l'adaptateur : là
 * où Discord déploie auprès de la plateforme, Fluxer n'a personne à prévenir et
 * se contente de savoir reconnaître ce qu'on lui tape.
 */
function construireIndex(entrees) {
    const index = new Map();
    for (const entree of entrees || []) {
        if (!entree?.descripteur) continue;
        index.set(entree.nom.toLowerCase(), entree);
    }
    return index;
}

/**
 * Analyse un message et rend ce qu'il faut pour l'exécuter.
 *
 * @param {string} contenu
 * @param {object} options
 * @param {string}   options.prefixe
 * @param {Map}      options.index      nom -> entrée
 * @returns {null|object} `null` si le message n'est pas une commande — le cas de
 *   l'immense majorité des messages, qui ne doivent pas payer plus qu'un test de
 *   préfixe.
 *
 *   Sinon : `{ commande, entree, descripteur, sousCommande, jetons, ligne }`,
 *   ou `{ inconnue: true, commande }` si aucune commande déclarée ne correspond
 *   — c'est là que l'appelant consulte `custom_commands`.
 */
function analyser(contenu, { prefixe = PREFIXE_PAR_DEFAUT, index } = {}) {
    if (typeof contenu !== 'string') return null;
    const texte = contenu.trim();
    if (!texte.startsWith(prefixe) || texte.length === prefixe.length) return null;

    const apresPrefixe = texte.slice(prefixe.length);
    const jetons = decouper(apresPrefixe);
    if (jetons.length === 0) return null;

    // Règle 2 : le premier jeton désigne la commande.
    const nom = jetons[0].valeur.toLowerCase();
    const entree = index?.get(nom);
    if (!entree) return { inconnue: true, commande: nom, ligne: apresPrefixe, jetons };

    const descripteur = entree.descripteur;
    let sousCommande = null;
    let reste = jetons.slice(1);
    let debutLigne = jetons[1]?.debut ?? apresPrefixe.length;

    // Règle 2, suite : le second jeton est une sous-commande SI le descripteur
    // en déclare. Sur une commande sans sous-commandes, il reste une option.
    if (Array.isArray(descripteur.sousCommandes)) {
        const nomSous = reste[0]?.valeur?.toLowerCase();
        sousCommande = descripteur.sousCommandes.find(s => s.nom.toLowerCase() === nomSous) || null;
        if (sousCommande) {
            reste = reste.slice(1);
            debutLigne = jetons[2]?.debut ?? apresPrefixe.length;
        }
    }

    return {
        commande: nom,
        entree,
        descripteur,
        sousCommande,
        jetons: reste,
        ligne: apresPrefixe,
        debutLigne,
    };
}

module.exports = {
    NOM_PLATEFORME,
    PREFIXE_PAR_DEFAUT,
    decouper,
    extraireId,
    convertir,
    remplirOptions,
    analyser,
    construireIndex,
    construireUsage,
    construireAide,
    decrireOption,
    construireSlashCommand,
    verifierAcces,
    rendreCommandePersonnalisee,
    chargerCommandes,
    entreeDepuisExport,
    // Réexportés depuis la couche neutre : les deux adaptateurs partagent la
    // MÊME fonction, pas une copie, et le test de miroir le vérifie par
    // identité de référence.
    refuserModuleHistorique,
    enregistrerPanneaux,
    verifierAccesCommandePersonnalisee,
    VRAI,
    FAUX,
};
