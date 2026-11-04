// ═══════════════════════════════════════════════════════════════
//  GET /api/plateforme — ce que la plateforme active sait faire
//
//  Le dashboard doit masquer ce qui n'existe pas. Sans cette route, il lui
//  faudrait le deviner : soit en testant le nom de la plateforme — ce que la
//  règle du chantier interdit partout ailleurs, et qui n'a pas de raison d'être
//  vrai côté navigateur seulement — soit en appelant chaque module pour voir
//  lequel répond 404, ce qui affiche une page avant de la retirer.
//
//  Trois champs, et pas un de plus :
//   • `nom`       — pour la marque de la page de connexion, jamais pour décider
//                   d'un comportement ;
//   • `capacites` — la table §4.2 de la DA, telle que l'adaptateur la déclare ;
//   • `prefixe`   — ce qui précède un nom de commande dans l'aide affichée,
//                   `null` quand la plateforme a des commandes d'application.
//
//  ⚠️ Volontairement SANS authentification, comme `/api/bot/invite` : la page de
//  connexion en a besoin AVANT d'avoir un jeton, pour afficher le bon bouton.
//  Ce qu'elle expose est public par nature — le nom d'une plateforme et la liste
//  des fonctionnalités d'un logiciel libre.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const plateforme = require('../services/plateforme');

const router = express.Router();

router.get('/plateforme', (req, res) => {
    res.json(plateforme.description(plateforme.adaptateur(req)));
});

module.exports = router;
