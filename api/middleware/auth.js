const jwt = require('jsonwebtoken');

// Le repli était 'quasar-secret', écrit en clair dans un dépôt PUBLIC : toute
// instance démarrée sans JWT_SECRET signait ses sessions avec une valeur connue
// de tout le monde, et acceptait donc des jetons forgés — y compris ceux qui
// passent requireOwner, l'identifiant Discord de la propriétaire étant lui aussi
// public. Le repli est désormais aléatoire et propre à chaque démarrage : il
// n'ouvre rien, il rend seulement les sessions caduques au redémarrage.
// Le vrai garde est en amont, dans index.js (verifierConfig) : hors mode `site`,
// Quasar refuse de démarrer sans un JWT_SECRET valide, et cette ligne ne sert
// plus qu'aux contextes qui n'en passent pas par là, les tests en premier.
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

function generateToken(user) {
    return jwt.sign({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        guilds: user.guilds
        // Algorithme ÉPINGLÉ des deux côtés. Sans `algorithms` au verify,
        // jsonwebtoken se fie à l'en-tête du jeton, c'est-à-dire à une valeur
        // fournie par la personne qui le présente. C'est la classe de faille
        // « alg confusion » : elle ne s'exploite que sous certaines conditions,
        // mais l'épinglage coûte deux mots et ferme la question définitivement.
    }, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return null;
    }
}

// Le jeton n'est JAMAIS accepté dans la chaîne de requête. Une URL porteuse de
// session se transmet, se journalise chez le proxy et part dans l'en-tête
// `Referer` des ressources tierces chargées par la page.
//
// Une tolérance a existé, pour un seul appelant : le flux SSE de mise à jour,
// qu'`EventSource` ne sait pas consommer avec un en-tête `Authorization`. Elle a
// disparu avec le passage de cette route en POST, consommée par `fetch` et un
// lecteur de flux. Ne pas la réintroduire : `test/auth-query-token.test.js`
// balaye `api/` et échoue si `req.query.token` ou un middleware de ce genre
// réapparaît.

function requireAuth(req, res, next) {
    const token = req.cookies?.token
        || req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'Non authentifié' });
    }

    const user = verifyToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Token invalide' });
    }

    req.user = user;
    next();
}

function requireGuildAdmin(req, res, next) {
    const guildId = req.params.guildId;
    const guild = req.user.guilds?.find(g => g.id === guildId);

    if (!guild) {
        return res.status(403).json({ error: 'Accès refusé' });
    }

    // Permission ADMINISTRATOR = 0x8
    const isAdmin = (BigInt(guild.permissions) & BigInt(0x8)) === BigInt(0x8);
    if (!isAdmin) {
        return res.status(403).json({ error: 'Permissions insuffisantes' });
    }

    next();
}

function requireOwner(req, res, next) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId || req.user.id !== ownerId) {
        return res.status(403).json({ error: 'Réservé au propriétaire du bot' });
    }
    next();
}

module.exports = { generateToken, verifyToken, requireAuth, requireGuildAdmin, requireOwner };
