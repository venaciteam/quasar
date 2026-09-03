// ═══════════════════════════════════════════════════════════════
//  Anti-raid sur les arrivées — LOT C
//
//  PLACEHOLDER. Ce routeur est monté sur `/api/guilds/:guildId/antiraid`
//  dès maintenant pour que le montage, l'ordre des middlewares et le garde-fou
//  de suspension soient figés une bonne fois : le lot qui livre ce module
//  remplace le contenu de ce fichier, sans toucher à api/index.js.
//
//  Il répond 501 plutôt que rien : un routeur vide laisserait la requête tomber
//  dans le service des fichiers statiques du dashboard, qui renverrait du HTML à
//  un appel d'API — le pire symptôme à diagnostiquer.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { requireAuth, requireGuildAdmin } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(requireAuth, requireGuildAdmin, (req, res) => {
    res.status(501).json({ error: 'Ce module n\'est pas encore disponible sur cette instance.' });
});

module.exports = router;
