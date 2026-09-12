// ═══════════════════════════════════════════════════════════════
//  Adaptateur Discord
//
//  Seul endroit du dépôt, avec `bot/modules/music/`, où `require('discord.js')`
//  a le droit d'exister à la fin du chantier. Il assemble les cinq pièces —
//  client, commandes, contexte, événements, rendu — derrière le contrat de la
//  DA §4, et n'ajoute aucune logique métier.
//
//  La fabrique est appelée par `resolvePlatform()`. Elle accepte un `client`
//  déjà construit : c'est ce qui permet aux tests de travailler sans jeton, et
//  ce qui laisse `bot/index.js` maître du cycle de vie.
// ═══════════════════════════════════════════════════════════════

const { Routes } = require('discord.js');
const { creerClient } = require('./client');
const { creerCapacites } = require('../capabilities');
const { creerApi } = require('./api');
const { chargerCommandes, construireSlashCommand } = require('./commands');
const { surEvenement, chargerEvenements, EVENEMENTS, NOMS_EVENEMENTS } = require('./events');
const { chargerPanneaux } = require('../panneaux');
const { creerContextePanneau, poserPanneau } = require('./context');
const { BITS } = require('./permissions');
const { verifierAccesCommandePersonnalisee } = require('../accesCommandePersonnalisee');

// Séparateur entre le préfixe d'un panneau neutre et la clé du choix. C'est
// aussi lui qui distingue un `customId` de panneau d'un identifiant jetable de
// collecteur (`qprompt:`, `qchoose:`, `qmembre:`) : le nom en tête ne désigne
// aucun panneau enregistré, donc `routerPanneau` rend `null` et laisse le
// collecteur faire son travail.
const SEPARATEUR_PANNEAU = ':';

// Type CHAT_INPUT dans l'API Discord — la forme d'une commande personnalisée.
const TYPE_COMMANDE_TEXTE = 1;

// Discord sait tout faire de ce que Quasar demande. La table §4.2 de la DA est
// reprise ici colonne par colonne — c'est le seul endroit où elle est écrite
// pour cette plateforme.
const CAPACITES_DISCORD = creerCapacites({
    interactions: true,
    ephemere: true,
    automod: true,
    audioBot: true,
    timeout: true,
    bulkDelete: true,
    fils: true,
    // Action d'incident « pause des invitations », sur laquelle repose le mode
    // panique de l'anti-raid. Fluxer n'a pas d'équivalent.
    pauseInvitations: true,
});

/**
 * @param {object} [options]
 * @param {import('discord.js').Client} [options.client] client déjà instancié
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {object} adaptateur conforme au contrat de la DA §4
 */
function creerAdaptateurDiscord({ client = null, env = process.env } = {}) {
    const clientDiscord = client || creerClient();

    // Nom de panneau -> handler. Vit sur l'adaptateur, donc pour la durée du
    // processus : un panneau posté avant un redémarrage redevient routable dès
    // que sa déclaration s'est réenregistrée au démarrage suivant.
    const panneaux = new Map();
    // Nom de panneau -> d'où vient la déclaration (« /ticket », « module
    // defer »). Sert uniquement au message de collision : « déjà enregistré »
    // ne dit pas PAR QUI, et les deux déclarations peuvent venir de deux lots
    // qui ne se relisent pas.
    const sourcesPanneaux = new Map();

    const adaptateur = {
        nom: 'discord',
        capacites: CAPACITES_DISCORD,
        permissions: BITS,

        // Identité du bot. Renseignée à la connexion : avant, elle est nulle, et
        // le code qui en dépend (filtrage de ses propres réactions, notamment)
        // doit s'abonner à `pret` plutôt que de la lire au chargement.
        moi: { id: null, nom: null },

        // ⚠️ Échappatoire de transition : `api/` et le dashboard consomment
        // encore le client discord.js directement (lot 7). Rien dans bot/ ne
        // doit s'en servir — c'est précisément ce que la couche remplace.
        client: clientDiscord,

        api: creerApi(clientDiscord),

        // ─── Cycle de vie ────────────────────────────────────────────────────

        async connecter(jeton = env.DISCORD_TOKEN) {
            await clientDiscord.login(jeton);
            // `login` rend avant que `clientReady` ne soit émis : `moi` se
            // remplit donc à l'événement, pas au retour de cet appel.
            return adaptateur;
        },

        async deconnecter() {
            return clientDiscord.destroy();
        },

        // ─── Enregistrement ──────────────────────────────────────────────────

        /**
         * Déploie les commandes sur Discord.
         *
         * Délègue à `./deploy.js`, qui porte des règles qu'aucune réécriture ne
         * doit perdre : plafond de 100 commandes par serveur, arbitrage stable
         * des commandes personnalisées, journalisation des rejets, et
         * déploiement ciblé à l'invitation du bot. Le require est différé pour
         * éviter le cycle (deploy.js charge le chargeur de commandes).
         *
         * @param {import('./commands').EntreeCommande[]} entrees
         */
        async enregistrerCommandes(entrees) {
            const { deployCommands } = require('./deploy');
            return deployCommands(clientDiscord, entrees);
        },

        // ─── Commandes personnalisées, serveur par serveur ───────────────────
        //
        // Sur l'ADAPTATEUR et non sur `api`, comme `enregistrerCommandes` : ce
        // n'est pas un appel REST générique, c'est l'enregistrement d'une
        // commande auprès de la plateforme, et chacune le fait à sa façon.
        //
        // Les deux méthodes sont INERTES quand `capacites.interactions` est
        // faux : sur Fluxer, une commande personnalisée sera une commande
        // préfixée résolue en base par le parseur, il n'y a rien à déployer.
        // Elles rendent alors `true` — « il n'y a rien à faire » est un succès,
        // pas un échec, et le code métier n'a pas à tester la plateforme.

        /**
         * @param {string} guildeId
         * @param {{nom: string, description: string}} commande
         * @returns {Promise<boolean>} true si la commande est enregistrée
         */
        async deployerCommandeServeur(guildeId, { nom, description } = {}) {
            if (!adaptateur.capacites.interactions) return true;
            try {
                await clientDiscord.rest.post(
                    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildeId),
                    { body: { name: nom, description, type: TYPE_COMMANDE_TEXTE } },
                );
                return true;
            } catch (err) {
                console.error('[Quasar] Erreur déploiement commande personnalisée :', err?.message || err);
                return false;
            }
        },

        /**
         * @returns {Promise<boolean>} true si la commande n'est plus
         *   enregistrée — y compris quand elle ne l'était déjà pas.
         */
        async retirerCommandeServeur(guildeId, nom) {
            if (!adaptateur.capacites.interactions) return true;
            try {
                const route = Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildeId);
                const commandes = await clientDiscord.rest.get(route);
                const cible = commandes.find(c => c.name === nom);
                if (cible) {
                    await clientDiscord.rest.delete(
                        Routes.applicationGuildCommand(env.DISCORD_CLIENT_ID, guildeId, cible.id),
                    );
                }
                return true;
            } catch (err) {
                console.error('[Quasar] Erreur retrait commande personnalisée :', err?.message || err);
                return false;
            }
        },

        /**
         * Contexte neutre d'une commande PERSONNALISÉE.
         *
         * Les commandes personnalisées n'ont pas de descripteur : elles sont
         * définies en base, serveur par serveur, depuis `/cmd` ou le dashboard.
         * Le bootstrap les résout lui-même, après le registre, et a pourtant
         * besoin de répondre par la voie neutre — sans quoi `bot/index.js`
         * resterait le dernier endroit du bot à construire un corps de message
         * Discord à la main.
         *
         * ⚠️ Appelée depuis le dispatch NATIF de la plateforme (le
         * `interactionCreate` de `bot/index.js` côté Discord). Un adaptateur
         * dont la plateforme n'a pas d'interactions n'a pas à l'implémenter :
         * ses commandes personnalisées passeront par son propre parseur.
         *
         * @param {import('discord.js').ChatInputCommandInteraction} interaction
         * @param {string} nom  nom de la commande, tel qu'il est en base
         */
        contexteCommandePersonnalisee(interaction, nom) {
            const { creerContexteCommande } = require('./context');
            return creerContexteCommande(interaction, {
                adaptateur,
                // Descripteur minimal : une commande personnalisée ne porte
                // aucune option, et n'a donc rien à lire dans l'interaction.
                descripteur: { nom, description: nom, options: [] },
            });
        },

        /**
         * Contrôle d'accès d'une commande PERSONNALISÉE.
         *
         * La règle vit dans `bot/platform/accesCommandePersonnalisee.js`,
         * partagée par les deux adaptateurs : trois modes en base, un membre,
         * ses rôles. Rien n'y connaît de plateforme.
         *
         * Elle est exposée ICI parce que son appelant est le dispatch NATIF —
         * `bot/index.js` côté Discord, le parseur de cet adaptateur côté
         * Fluxer — et qu'un appelant natif n'a pas de contexte neutre sous la
         * main. Il a en revanche l'adaptateur.
         *
         * @param {object} ligne   ligne `custom_commands`
         * @param {object|null} membre  membre NORMALISÉ par cet adaptateur
         * @param {{roles?: Map|Set|object}} [options] rôles du serveur
         * @returns {null|{titre, cause, action}} `null` = accès accordé
         */
        verifierAccesCommandePersonnalisee(ligne, membre, options) {
            return verifierAccesCommandePersonnalisee(ligne, membre, options);
        },

        /**
         * Pose un panneau persistant, depuis un appelant qui n'a QUE
         * l'adaptateur sous la main — une route du dashboard, typiquement.
         *
         * Sur l'adaptateur et non sur `api`, pour la même raison que
         * `enregistrerCommandes` : ce n'est pas un appel REST générique, c'est
         * la pose d'un objet dont le ROUTAGE appartient à la plateforme.
         *
         * ⚠️ Délègue à la fonction interne que `ctx.poserPanneau` appelle déjà —
         * elle n'est pas réécrite. Un panneau posé par le dashboard doit être
         * STRICTEMENT le même que celui d'une commande : même corps, même
         * identifiant de composant, même persistance. Deux constructions
         * séparées produiraient un panneau qui s'affiche parfaitement et ne
         * répond jamais.
         *
         * @param {string} canalId
         * @param {string|object} contenuOuEmbed  chaîne, embed neutre, ou corps
         *   composé `{ contenu, embeds, fichiers }`
         * @param {Array} choix
         * @param {{panneau: string, guildeId?: string}} options
         * @returns {Promise<{canalId: string, messageId: string|null}>}
         */
        poserPanneau(canalId, contenuOuEmbed, choix, options) {
            return poserPanneau(adaptateur, canalId, contenuOuEmbed, choix, options);
        },

        /** @see bot/platform/discord/events.js pour la table et les payloads. */
        surEvenement(nomNeutre, handler, options) {
            return surEvenement(clientDiscord, adaptateur, nomNeutre, handler, options);
        },

        /** Charge bot/commands/ — descripteurs neutres exclusivement. */
        chargerCommandes(options) {
            return chargerCommandes({ ...options, adaptateur });
        },

        /** Charge bot/events/ — descripteurs neutres — et branche les handlers. */
        chargerEvenements(options) {
            return chargerEvenements({ ...options, adaptateur });
        },

        /** Charge bot/panneaux/ — les panneaux qui n'ont pas de commande. */
        chargerPanneaux(options) {
            return chargerPanneaux({ ...options, adaptateur });
        },

        // ─── Panneaux persistants ────────────────────────────────────────────
        //
        // Le routage des clics vivait dans le `interactionCreate` de
        // `bot/index.js`, par préfixes écrits en dur (`tv_`, `ticket_`,
        // `defer_`…). Ce registre l'a remplacé : un lot déclare son panneau, il
        // est routé, et aucun fichier partagé n'est touché. Le routage par
        // préfixes a été retiré à la consolidation — c'est désormais la SEULE
        // voie par laquelle un clic atteint du code métier.

        /**
         * Enregistre le handler des clics d'un panneau persistant.
         *
         * Appelé par `chargerCommandes` pour chaque entrée de la clé `panneaux`
         * d'un descripteur : une commande n'a pas à l'appeler elle-même. Le
         * vocabulaire des panneaux — déclaration, pose, routage — est documenté
         * en un seul endroit, `bot/platform/commands.js`.
         *
         * @param {string} panneau  le même nom que `ctx.choose({ panneau })`
         * @param {(ctx: object, cle: string) => Promise<void>} handler
         *   `ctx` est un contexte complet (repondre, prompt, choose, api, db) et
         *   l'interaction y arrive NON acquittée : le handler peut donc ouvrir
         *   un formulaire directement, et doit répondre dans les 3 secondes.
         * @param {string} [source]  d'où vient la déclaration, pour le message
         *   de collision. Facultatif : un appel direct n'a rien à déclarer.
         */
        surPanneau(panneau, handler, source = null) {
            if (typeof panneau !== 'string' || !panneau || panneau.includes(SEPARATEUR_PANNEAU)) {
                throw new Error(
                    `surPanneau : nom de panneau invalide « ${panneau} ». Attendu une chaîne non vide `
                    + `et sans « ${SEPARATEUR_PANNEAU} », qui sépare le panneau de la clé du choix.`
                );
            }
            if (panneaux.has(panneau)) {
                const dejaPris = sourcesPanneaux.get(panneau);
                throw new Error(
                    `Panneau « ${panneau} » déclaré deux fois`
                    + `${dejaPris && source ? ` : par ${dejaPris} et par ${source}` : ''}`
                    + '. Un panneau n\'appartient qu\'à une déclaration — ses clics ne peuvent pas '
                    + 'être routés deux fois.'
                );
            }
            panneaux.set(panneau, handler);
            if (source) sourcesPanneaux.set(panneau, source);
            return () => { panneaux.delete(panneau); sourcesPanneaux.delete(panneau); };
        },

        /**
         * Route un clic vers son panneau, s'il en a un.
         *
         * @returns {Promise<void>|null} `null` si aucun panneau neutre ne
         *   revendique ce customId — l'appelant poursuit alors vers les
         *   handlers historiques.
         */
        routerPanneau(interaction) {
            const customId = interaction?.customId;
            if (typeof customId !== 'string') return null;

            const separateur = customId.indexOf(SEPARATEUR_PANNEAU);
            if (separateur <= 0) return null;

            const panneau = customId.slice(0, separateur);
            const handler = panneaux.get(panneau);
            if (!handler) return null;

            const cle = customId.slice(separateur + 1);
            return handler(creerContextePanneau(interaction, { adaptateur, panneau, cle }), cle);
        },

        /** Exposé pour les tests et pour deploy-commands : descripteur -> builder. */
        construireSlashCommand,

        EVENEMENTS,
        NOMS_EVENEMENTS,
        SEPARATEUR_PANNEAU,
    };

    // Identité du bot dès qu'elle est connue. Posé ici et non dans `connecter`
    // pour couvrir aussi le cas d'un client déjà connecté passé en option.
    clientDiscord.once('clientReady', () => {
        adaptateur.moi.id = clientDiscord.user?.id ?? null;
        adaptateur.moi.nom = clientDiscord.user?.tag ?? null;
    });

    brancherDeploiementAInvitation(clientDiscord);

    return adaptateur;
}

/**
 * Redéploie les commandes slash sur un serveur qui vient d'inviter le bot.
 *
 * Correctif de la v4.10.0, et il n'a rien à faire dans un handler d'événement
 * métier : la procédure d'installation documentée lance le bot AVANT de
 * l'inviter, si bien que le cache est vide au démarrage et qu'aucune commande
 * n'est déployée. La personne invite le bot, le voit en ligne, ouvre un
 * dashboard qui fonctionne, et ne trouve AUCUNE commande sur son serveur.
 *
 * C'est du déploiement de slash commands, autrement dit une mécanique
 * strictement Discord : l'événement neutre `guildeRejointe` n'a pas à la
 * connaître, et un adaptateur Fluxer n'aura rien d'équivalent à faire. Elle vit
 * donc dans l'adaptateur, sur l'événement NATIF.
 *
 * Branché à la création de l'adaptateur, donc AVANT tout handler métier :
 * discord.js appelle ses écouteurs dans l'ordre d'inscription. Les deux restent
 * indépendants — un déploiement en échec n'empêche ni l'enregistrement du
 * serveur ni l'annulation d'une purge programmée, et réciproquement.
 *
 * Volontairement non fatal : le prochain démarrage rattrapera le déploiement,
 * alors qu'une exception ici emporterait le reste de l'arrivée.
 */
function brancherDeploiementAInvitation(clientDiscord) {
    // Un client réduit (doublure de test) n'a pas forcément d'émetteur
    // d'événements. Le vrai `Client` de discord.js en est un par construction :
    // ce garde ne masque donc rien en production, il évite seulement d'imposer
    // un `on()` à toutes les doublures du dépôt. Le branchement réel est couvert
    // par test/guild-create-deploy.test.js.
    if (typeof clientDiscord?.on !== 'function') return;

    clientDiscord.on('guildCreate', (guild) => {
        // Require différé : `deploy.js` charge le chargeur de commandes, et le
        // résoudre au sommet de ce fichier créerait un cycle. C'est aussi ce qui
        // rend la fonction remplaçable par les tests.
        Promise.resolve()
            .then(() => require('./deploy').deployCommandsForGuild(guild))
            .catch((err) => {
                console.error(
                    `[Quasar] Déploiement des commandes impossible sur ${guild?.name || guild?.id} :`,
                    err?.message || err,
                );
            });
    });
}

module.exports = creerAdaptateurDiscord;
module.exports.CAPACITES_DISCORD = CAPACITES_DISCORD;
module.exports.brancherDeploiementAInvitation = brancherDeploiementAInvitation;
module.exports.SEPARATEUR_PANNEAU = SEPARATEUR_PANNEAU;
