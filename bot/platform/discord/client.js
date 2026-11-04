// ═══════════════════════════════════════════════════════════════
//  Instanciation du client discord.js
//
//  Extrait tel quel de `createBot()` : intents et partials sont le contrat de
//  ce que Quasar reçoit de la passerelle. Toute modification ici change ce que
//  seize handlers d'événements voient arriver — ou ne voient plus.
// ═══════════════════════════════════════════════════════════════

const { Client, GatewayIntentBits, Partials } = require('discord.js');

const INTENTS = Object.freeze([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    // AutoMod natif de Discord. Ces deux intents ne sont PAS privilégiés
    // (seuls GuildMembers, GuildPresences et MessageContent le sont) : rien
    // à activer dans le portail développeur, aucune demande d'approbation.
    //  - Configuration : tient à jour le cache des règles quand elles sont
    //    modifiées ailleurs que depuis Quasar.
    //  - Execution : indispensable pour recevoir AUTO_MODERATION_ACTION_EXECUTION,
    //    l'événement qui permet d'historiser et de journaliser les
    //    déclenchements (cf. bot/events/autoModerationActionExecution.js).
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution,
]);

// Sans ces partials, une réaction posée sur un message antérieur au démarrage
// (donc hors cache) n'est jamais dispatchée : les panneaux de reaction roles
// cessent de fonctionner après chaque redéploiement.
const PARTIALS = Object.freeze([
    Partials.Message,
    Partials.Reaction,
]);

/** @returns {import('discord.js').Client} */
function creerClient() {
    return new Client({ intents: [...INTENTS], partials: [...PARTIALS] });
}

module.exports = { creerClient, INTENTS, PARTIALS };
