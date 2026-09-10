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
const { surEvenement, EVENEMENTS, NOMS_EVENEMENTS } = require('./events');
const { BITS } = require('./permissions');

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
         * Délègue à `bot/utils/deploy-commands.js`, qui porte des règles
         * qu'aucune réécriture ne doit perdre : plafond de 100 commandes par
         * serveur, arbitrage stable des commandes personnalisées, journalisation
         * des rejets, et déploiement ciblé à l'invitation du bot. Le require est
         * différé pour éviter le cycle (deploy-commands charge ce chargeur).
         *
         * @param {import('./commands').EntreeCommande[]} entrees
         */
        async enregistrerCommandes(entrees) {
            const { deployCommands } = require('../../utils/deploy-commands');
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

        /** Exposé pour les tests et pour deploy-commands : descripteur -> builder. */
        construireSlashCommand,

        EVENEMENTS,
        NOMS_EVENEMENTS,
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
