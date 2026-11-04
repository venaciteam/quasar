// ═══════════════════════════════════════════════════════════════
//  Compteur public de l'instance — nombre de serveurs Discord
//
//  Alimente la ligne « L'instance de Venacity est présente sur N serveurs » de
//  la vitrine. Montée UNIQUEMENT en mode `public` (cf. createApi) : c'est le
//  seul mode où une vitrine ET un robot tournent dans le même processus. En
//  `site`, il n'y a pas de robot à compter ; en `bot` (auto-hébergement), il
//  n'y a pas de vitrine à alimenter — la route y répond 404 comme n'importe
//  quelle adresse inconnue.
//
//  Ce n'est PAS une télémétrie, et ça ne doit jamais le devenir : le nombre
//  est lu dans le processus qui le sert, sur la seule instance qui l'affiche.
//  Aucune instance auto-hébergée n'envoie rien à personne (heartbeat retiré en
//  v3.3.0, promesse de la politique de confidentialité). Ne jamais agréger ici
//  un chiffre venu d'ailleurs.
//
//  Source : le cache du client discord.js, pas la table `guilds`. Le cache est
//  tenu par Discord lui-même (GUILD_CREATE / GUILD_DELETE) et dit où le robot
//  est présent À L'INSTANT. La table, elle, contient une ligne technique
//  (`__quasar_instance_id`) et garde un serveur quitté jusqu'à sa purge : elle
//  surcompterait.
//
//  Sortie volontairement minimale : un entier, rien d'autre. Ni nom, ni
//  identifiant, ni date — un total anonyme, qui n'est pas une donnée
//  personnelle.
// ═══════════════════════════════════════════════════════════════

const express = require('express');

// Durée de vie du chiffre, côté serveur ET côté navigateur. Cinq minutes : le
// nombre de serveurs bouge à l'échelle de la journée, et la vitrine n'a pas à
// relire le cache du robot à chaque visite.
const TTL_S = 300;

/**
 * Fabrique et non routeur unique : chaque application a son propre cache,
 * ce qui garde les tests indépendants les uns des autres.
 */
function createPublicStatsRouter() {
    const router = express.Router();
    let snapshot = null; // { servers, at }

    router.get('/public/stats', (req, res) => {
        const now = Date.now();

        if (!snapshot || now - snapshot.at >= TTL_S * 1000) {
            const client = req.app.get('discordClient');
            // Robot pas encore connecté (démarrage, reconnexion) : le cache est
            // vide ou partiel. Répondre 0 serait faux ; 503 laisse la vitrine
            // masquer la ligne. L'échec n'est pas mis en cache, et mountNoStore
            // a déjà interdit sa mise en cache côté navigateur.
            if (!client || typeof client.isReady !== 'function' || !client.isReady()) {
                return res.status(503).json({ error: 'Compteur indisponible pour le moment.' });
            }
            snapshot = { servers: client.guilds.cache.size, at: now };
        }

        // Réponse identique pour tout le monde : elle remplace le no-store posé
        // par mountNoStore sur /api, qui ne vaut que pour les réponses liées à
        // une session.
        res.set('Cache-Control', `public, max-age=${TTL_S}`);
        res.json({ servers: snapshot.servers });
    });

    return router;
}

module.exports = createPublicStatsRouter;
