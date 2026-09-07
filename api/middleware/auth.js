const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'quasar-secret';

function generateToken(user) {
    return jwt.sign({
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        guilds: user.guilds
    }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// Le jeton dans la chaîne de requête est réservé à UN seul cas : le flux SSE de
// mise à jour. `EventSource` est la seule API du navigateur qui ne sache pas poser
// d'en-tête `Authorization`, donc la route concernée opte explicitement pour cette
// tolérance via `allowTokenInQuery`. Partout ailleurs elle est refusée : accepter
// `?token=` sur toutes les routes permettait de fabriquer des URL porteuses de
// session, et faisait fuiter le jeton dans les journaux du proxy comme dans
// l'en-tête `Referer` des ressources tierces chargées par la page.
function allowTokenInQuery(req, res, next) {
    if (req.query.token && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${req.query.token}`;
    }
    next();
}

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

module.exports = { generateToken, verifyToken, requireAuth, requireGuildAdmin, requireOwner, allowTokenInQuery };
