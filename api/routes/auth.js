const express = require('express');
const { generateToken } = require('../middleware/auth');
const router = express.Router();

const DISCORD_API = 'https://discord.com/api/v10';

// Redirect vers Discord OAuth2
router.get('/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: process.env.CALLBACK_URL,
        response_type: 'code',
        scope: 'identify guilds'
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Callback OAuth2
router.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // Échanger le code contre un token
        const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.CALLBACK_URL
            })
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            // Tracé, et pas seulement redirigé : sans cette ligne, l'échec de
            // l'échange était totalement muet côté serveur — l'utilisatrice
            // atterrissait sur la page d'accueil et les logs ne montraient rien.
            // `tokenData.error` porte la raison de Discord (invalid_grant,
            // invalid_client…) et ne contient aucun secret.
            console.error('[Quasar] Échange du code OAuth2 refusé par Discord :',
                tokenData.error || 'réponse sans access_token', tokenData.error_description || '');
            return res.redirect('/?error=token_failed');
        }

        // Récupérer l'utilisateur
        const userRes = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();

        // Récupérer les guilds de l'utilisateur
        const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const guilds = await guildsRes.json();

        // Discord ne répond pas toujours un tableau : une limite de débit (429)
        // ou un jeton révoqué entre-temps donne un objet d'erreur. Sans cette
        // garde, le `.map()` ci-dessous lève, et l'utilisatrice se retrouve sur
        // `/?error=auth_failed` — un message qui désigne l'authentification
        // alors que celle-ci a parfaitement réussi.
        if (!Array.isArray(guilds)) {
            console.error('[Quasar] Réponse inattendue de /users/@me/guilds :',
                guilds && guilds.message ? guilds.message : 'format non reconnu');
            return res.redirect('/?error=guilds_failed');
        }

        // Générer JWT
        const jwt = generateToken({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            guilds: guilds.map(g => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                permissions: g.permissions
            }))
        });

        // Cookie sécurisé + redirect
        // Passer le token via URL pour stockage en localStorage (évite les problèmes de cookie avec Cloudflare)
        res.redirect(`/dashboard/app.html?token=${jwt}`);
    } catch (error) {
        console.error('[Quasar] Erreur OAuth2:', error);
        res.redirect('/?error=auth_failed');
    }
});

// Déconnexion
router.get('/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/');
});

// Info utilisateur connecté
router.get('/me', (req, res) => {
    const token = req.cookies?.token
        || req.headers.authorization?.replace('Bearer ', '')
        || req.query.token;

    // 401 et non 200 sur un échec. Deux raisons : un 401 n'est jamais mis en
    // cache par défaut, là où un 200 l'est dès qu'un intermédiaire applique son
    // heuristique ; et un échec d'authentification devient visible dans l'onglet
    // réseau au lieu de se confondre avec une réponse normale. Le corps
    // `{ authenticated: false }` est conservé : les appelants qui le lisent
    // (dashboard/index.html) continuent de fonctionner à l'identique, et
    // `app.js` intercepte déjà les 401.
    if (!token) return res.status(401).json({ authenticated: false });

    const { verifyToken } = require('../middleware/auth');
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ authenticated: false });

    res.json({ authenticated: true, user });
});

module.exports = router;
