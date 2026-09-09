const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
// Service requis en bloc, volontairement pas déstructuré : la route appelle
// `updater.runUpdate(...)` au moment de la requête. C'est ce qui permet à un test
// de remplacer cette seule fonction pour vérifier la garde d'autorisation sans
// déclencher une vraie mise à jour — hors conteneur, elle fait un `git pull` puis
// un `process.exit(0)` qui emporterait le processus de test avec elle.
const updater = require('../services/updater');

const router = express.Router();

// ═══ GET /api/version ═══
// Reste accessible à tout compte authentifié : la barre latérale du dashboard
// affiche la version courante pour tout le monde, et ces valeurs sont déjà
// publiques (dépôt AGPL-3.0, releases GitHub ouvertes).
//
// `force=true` est en revanche réservé au propriétaire. Il court-circuite le
// cache de 12 h et déclenche un appel sortant vers l'API GitHub à chaque
// requête : ouvert à tout compte, il offrait un amplificateur gratuit capable
// d'épuiser le quota d'appels anonymes de l'instance, donc d'aveugler la
// vérification des mises à jour pour tout le monde. Sans le forçage, la réponse
// vient du cache : la valeur affichée reste juste, simplement moins fraîche.
router.get('/version', requireAuth, async (req, res) => {
    try {
        const estProprietaire = !!process.env.BOT_OWNER_ID && req.user.id === process.env.BOT_OWNER_ID;
        const force = req.query.force === 'true' && estProprietaire;
        const result = await updater.checkVersion(force);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Impossible de vérifier la version' });
    }
});

// ═══ POST /api/update — flux de journal au format SSE ═══
// Deux gardes, pour deux failles distinctes :
//
//  1. `requireOwner`. `runUpdate` reconstruit l'image et recrée le conteneur :
//     plusieurs minutes de coupure du bot sur TOUS les serveurs, répétable en
//     boucle, avec les journaux de build renvoyés à l'appelant. Sur l'instance
//     publique, `/auth/login` délivre un jeton à n'importe quel compte Discord
//     sans qu'il partage le moindre serveur avec le bot : sans cette garde, la
//     coupure était à la portée du premier venu. Elle est sans effet sur
//     l'instance Venacity (ni docker.sock ni /host-app montés, `getEnvironment()`
//     répond ready:false), mais bien réelle pour qui auto-héberge avec le
//     docker-compose.yml officiel du dépôt, qui monte les deux.
//
//  2. POST et non plus GET. En GET, un simple préchargement de lien — navigateur,
//     aperçu de message, robot d'indexation — suffisait à lancer la mise à jour.
//     Corollaire assumé : `EventSource` ne sait faire que du GET et ne pose aucun
//     en-tête, le front lit donc ce flux avec fetch + ReadableStream. Le format
//     des événements, lui, ne change pas.
router.post('/update', requireAuth, requireOwner, (req, res) => {
    if (updater.isUpdating()) {
        return res.status(409).json({ error: 'Une mise à jour est déjà en cours' });
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // désactive le buffering nginx/proxy
    });
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    function sendEvent(type, message) {
        if (closed) return;
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    }

    updater.runUpdate((type, message) => {
        sendEvent(type, message);

        // Fermer le stream SSE après done/fail
        if (type === 'done' || type === 'fail') {
            setTimeout(() => {
                if (!closed) res.end();
            }, 500);
        }
    });
});

// Toute autre méthode sur /api/update est refusée explicitement. 405 plutôt que
// 404 : le chemin existe, c'est la méthode qui est interdite, et le refus doit
// rester lisible pour qui débogue. Surtout, cette route garantit qu'un GET
// n'aboutira jamais à une mise à jour, même si un routeur monté plus loin venait
// à réutiliser le même chemin.
router.all('/update', (req, res) => {
    res.set('Allow', 'POST');
    res.status(405).json({ error: 'Méthode non autorisée : la mise à jour se déclenche en POST.' });
});

module.exports = router;
