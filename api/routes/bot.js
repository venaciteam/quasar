const express = require('express');
const { fournisseur, valeur } = require('./auth');
const router = express.Router();

// URL d'invitation OAuth2 du bot.
//
// Permission: Administrator (8) — couvre tous les modules sans avoir à revenir
// ajuster les permissions au fur et à mesure que l'utilisateur active des
// fonctionnalités. Le code est ouvert, l'utilisateur peut vérifier ce qu'on
// fait avec.
//
// Le fournisseur vient de `routes/auth.js`, où il est déjà écrit une fois : les
// deux plateformes exposent le même `authorize` avec les mêmes paramètres pour
// le scope `bot`, seules l'adresse et la liste des scopes changent. Le corps de
// la réponse garde ses noms d'origine (`url`, `clientId`, `permissions`) —
// c'est le contrat que le dashboard consomme.
router.get('/invite', (req, res) => {
    const f = fournisseur();
    const clientId = valeur(f.clientId, process.env);
    if (!clientId) {
        return res.status(503).json({ error: `Identifiant d'application ${f.libelle} non configuré` });
    }

    const params = new URLSearchParams({
        client_id: clientId,
        permissions: '8',
        scope: f.scopesBot
    });

    res.json({
        url: `${valeur(f.autorisation, process.env)}?${params}`,
        clientId,
        permissions: '8'
    });
});

module.exports = router;
