const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { resolveVariables, buildEmbed } = require('../utils/welcomeMessage');
const { sendLog } = require('../utils/logger');
const { handleMemberJoin } = require('../modules/antiraid');

// Taille de l'avatar en vignette de journal. Plus petite que celle de l'embed
// d'accueil : c'est une ligne de journal, pas une carte de bienvenue.
const TAILLE_AVATAR_LOG = 64;

module.exports = definirEvenement({
    nom: 'membreRejoint',

    async executer(ctx, membre, guilde) {
        // Portée d'écriture, construite une fois et transmise à tout ce qui
        // écrit sans avoir personne à qui répondre : l'anti-raid et le journal.
        // `guilde` y entre entière — `membreCount` et `nom` y sont lus.
        const portee = { guildeId: guilde?.id ?? null, guilde, api: ctx.api, moi: ctx.moi };

        // ─── Anti-raid, AVANT tout le reste ───
        //
        // L'ordre est délibéré. Poser un autorôle de bienvenue à un compte qu'on
        // s'apprête à expulser est absurde : le rôle serait accordé puis emporté
        // par l'expulsion, avec deux appels d'API inutiles au moment précis où le
        // serveur est sous pression. Et souhaiter la bienvenue à une vague de
        // comptes de raid transformerait le salon d'accueil en amplificateur du
        // raid — c'est du reste ce qu'un raid cherche.
        //
        // `handleMemberJoin` ne lève JAMAIS et sort immédiatement quand le module
        // est désactivé (lecture d'un cache mémoire, aucune requête). Le message
        // de bienvenue, le log `member_join` et les autorôles restent donc
        // strictement inchangés sur un serveur qui n'a pas activé l'anti-raid.
        const verdict = await handleMemberJoin(membre, portee);
        // Seule sortie anticipée : la personne n'est plus sur le serveur. Il n'y
        // a plus personne à accueillir, ni à qui donner un rôle — et la sanction,
        // elle, a déjà été journalisée par le module.
        if (verdict.removed) return;

        const db = ctx.db;

        // ─── Log « membre rejoint » ───
        //
        // Inconditionnel, comme le log de départ dans `membreParti`. Son seul
        // gardien légitime est la case « 📥 Membre rejoint » du dashboard, que
        // `sendLog` consulte déjà via `isLogEnabled` — laquelle laisse ce type
        // désactivé par défaut. Il dépendait auparavant de `welcome_config` : un
        // serveur qui cochait la case sans configurer de message d'accueil ne
        // recevait jamais ce log, sans aucun moyen de comprendre pourquoi.
        await sendLog(portee, 'member_join', embed({
            titre: '📥 Membre rejoint',
            couleur: 0x2ecc71,
            vignette: membre.avatar(TAILLE_AVATAR_LOG),
            champs: [
                { nom: 'Membre', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
                // Date de création du COMPTE, pas de l'arrivée : c'est le repère
                // qui permet de reconnaître un compte jetable d'un coup d'œil.
                { nom: 'Compte créé', valeur: `<t:${Math.floor(membre.compteCreeLe / 1000)}:R>`, enLigne: true },
                { nom: 'Membres', valeur: `${guilde.membreCount}`, enLigne: true },
            ],
            horodatage: true,
        }));

        // ─── Message de bienvenue ───
        //
        // Seul comportement réellement piloté par `welcome_config`. Ce bloc `if`
        // remplace deux `return` qui court-circuitaient aussi le log et les
        // autorôles ci-dessous — y compris celui sur `!channel`, qui faisait
        // silencieusement disparaître les autorôles d'un serveur pourtant bien
        // configuré dès la suppression de son salon d'accueil.
        const config = db.prepare('SELECT * FROM welcome_config WHERE guild_id = ?').get(guilde.id);
        if (config && config.welcome_enabled && config.welcome_channel) {
            const apercu = buildEmbed(config.welcome_embed, membre, guilde);
            const contenu = config.welcome_message ? resolveVariables(config.welcome_message, membre, guilde) : null;

            try {
                // Plus de lecture de cache avant l'envoi : le client REST
                // normalisé n'en tient pas. Un salon supprimé produit donc une
                // erreur, attrapée ici — là où l'ancien code renonçait sans un
                // mot. Même arbitrage que la voie neutre de `sendLog`.
                if (apercu) {
                    await ctx.api.envoyerMessage(config.welcome_channel, { contenu: contenu || undefined, embeds: [apercu] });
                } else if (contenu) {
                    await ctx.api.envoyerMessage(config.welcome_channel, contenu);
                }
            } catch (e) {
                console.error('[Quasar] Erreur message welcome:', e.message);
            }
        }

        // ─── Autoroles ───
        //
        // Configurés sur la page « Reaction Roles » du dashboard, qui n'a aucun
        // lien d'interface avec le message de bienvenue — et `/autorole add`
        // promet une attribution « à chaque nouveau membre », sans réserve. Les
        // faire dépendre de `welcome_config` revenait à ignorer un réglage que
        // l'interface affiche pourtant comme actif.
        const autoroles = db.prepare('SELECT role_id FROM autoroles WHERE guild_id = ?').all(guilde.id);
        for (const ar of autoroles) {
            try {
                await ctx.api.ajouterRole(guilde.id, membre.id, ar.role_id);
            } catch (e) {
                console.error('[Quasar] Erreur autorole:', e.message);
            }
        }
    },
});
