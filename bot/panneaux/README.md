Panneaux persistants qui n'appartiennent à aucune commande — ceux des modules
configurés depuis le dashboard, comme l'arbitrage des sanctions (`defer`).

Un fichier par panneau, au format `definirPanneau({ nom, executer(ctx, cle) })`
de `bot/platform/panneaux.js`. Les panneaux portés par une commande se déclarent
dans la clé `panneaux` de son descripteur, pas ici.
