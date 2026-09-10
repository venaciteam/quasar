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

const { creerClient } = require('./client');
const { creerCapacites } = require('../capabilities');
const { creerApi } = require('./api');
const { chargerCommandes, construireSlashCommand } = require('./commands');
const { surEvenement, chargerEvenements, EVENEMENTS, NOMS_EVENEMENTS } = require('./events');
const { creerContextePanneau } = require('./context');
const { BITS } = require('./permissions');

// Séparateur entre le préfixe d'un panneau neutre et la clé du choix. Les
// panneaux historiques utilisent `_` (`ticket_open`, `tv_lock`) : les deux jeux
// ne peuvent donc pas se confondre, et le routage neutre peut passer en premier
// sans risquer d'intercepter un bouton pas encore migré.
const SEPARATEUR_PANNEAU = ':';

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
});

/**
 * @param {object} [options]
 * @param {import('discord.js').Client} [options.client] client déjà instancié
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {object} adaptateur conforme au contrat de la DA §4
 */
function creerAdaptateurDiscord({ client = null, env = process.env } = {}) {
    const clientDiscord = client || creerClient();

    // Préfixe -> handler de panneau persistant. Vit sur l'adaptateur, donc pour
    // la durée du processus : un panneau posté avant un redémarrage redevient
    // routable dès que son lot s'est réenregistré au démarrage suivant.
    const panneaux = new Map();

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

        /** @see bot/platform/discord/events.js pour la table et les payloads. */
        surEvenement(nomNeutre, handler, options) {
            return surEvenement(clientDiscord, adaptateur, nomNeutre, handler, options);
        },

        /** Charge bot/commands/ dans les deux formats (neutre et historique). */
        chargerCommandes(options) {
            return chargerCommandes({ ...options, adaptateur });
        },

        /** Charge bot/events/ dans les deux formats et branche les handlers. */
        chargerEvenements(options) {
            return chargerEvenements({ ...options, adaptateur });
        },

        // ─── Panneaux persistants ────────────────────────────────────────────
        //
        // Le routage des clics vivait dans le `interactionCreate` de
        // `bot/index.js`, par préfixes écrits en dur. Les lots 4 et 5 auraient
        // donc dû modifier `bot/index.js`, qui leur est interdit. Ce registre
        // est la voie neutre : un lot déclare son panneau, il est routé, et
        // aucun fichier partagé n'est touché.

        /**
         * Enregistre le handler des clics d'un panneau persistant.
         *
         * @param {string} prefixe  le même que `ctx.choose({ identifiant })`
         * @param {(ctx: object, cle: string) => Promise<void>} handler
         *   `ctx` est un contexte complet (repondre, prompt, choose, api, db) et
         *   l'interaction y arrive NON acquittée : le handler peut donc ouvrir
         *   un formulaire directement, et doit répondre dans les 3 secondes.
         */
        surPanneau(prefixe, handler) {
            if (typeof prefixe !== 'string' || !prefixe || prefixe.includes(SEPARATEUR_PANNEAU)) {
                throw new Error(
                    `surPanneau : préfixe invalide « ${prefixe} ». Attendu une chaîne non vide `
                    + `et sans « ${SEPARATEUR_PANNEAU} », qui sépare le préfixe de la clé du choix.`
                );
            }
            if (panneaux.has(prefixe)) {
                throw new Error(`surPanneau : le préfixe « ${prefixe} » est déjà enregistré.`);
            }
            panneaux.set(prefixe, handler);
            return () => panneaux.delete(prefixe);
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

            const prefixe = customId.slice(0, separateur);
            const handler = panneaux.get(prefixe);
            if (!handler) return null;

            const cle = customId.slice(separateur + 1);
            return handler(creerContextePanneau(interaction, { adaptateur, prefixe, cle }), cle);
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

    return adaptateur;
}

module.exports = creerAdaptateurDiscord;
module.exports.CAPACITES_DISCORD = CAPACITES_DISCORD;
module.exports.SEPARATEUR_PANNEAU = SEPARATEUR_PANNEAU;
