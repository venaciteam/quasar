const express = require('express');
const router = express.Router();

// URL d'invitation Discord OAuth2
// Permission: Administrator (8) — couvre tous les modules sans avoir à revenir
// ajuster les permissions au fur et à mesure que l'utilisateur active des
// fonctionnalités. Le code est ouvert, l'utilisateur peut vérifier ce qu'on
// fait avec.
router.get('/invite', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
        return res.status(503).json({ error: 'DISCORD_CLIENT_ID non configuré' });
    }

    const params = new URLSearchParams({
        client_id: clientId,
        permissions: '8',
        scope: 'bot applications.commands'
    });

    res.json({
        url: `https://discord.com/oauth2/authorize?${params}`,
        clientId,
        permissions: '8'
    });
});

module.exports = router;
