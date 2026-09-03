<!--
  Journal des nouveautés de Quasar — RÔLE DU FICHIER.

  La page /nouveautes lit le fichier data/nouveautes.json du volume persistant,
  alimenté à chaud par l'API admin (POST /api/admin/nouveautes, cf. la skill
  quasar-nouveautes). Ce fichier-ci ne sert QUE de seed : il initialise
  l'historique au premier boot sur un volume neuf. Une fois le JSON créé, il
  n'est plus jamais relu — éditer ce fichier ne publie donc RIEN sur une
  instance déjà déployée.

  Convention d'un bloc (pattern Maât / Prisma, parsé par api/services/nouveautes.js) :

    ## 🌌 Quasar — vX.Y.Z        <- en-tête de carte (la version)
    ### Titre humain             <- sous-titre mis en avant
    > *JJ mois AAAA*             <- date, en citation italique
    **✨ Nouveautés** / **🔧 Améliorations** / **🐛 Corrections**
    - un changement par puce, côté personne qui utilise Quasar d'abord

  Règles de copy : vouvoiement, écriture inclusive, émetteur en « je » (jamais
  « nous », « on » ni « l'équipe »), « soutien » jamais « don ».

  Blocs ordonnés du plus récent au plus ancien. Tout ce qui précède le premier
  « ## » est ignoré.
-->

## 🌌 Quasar — v4.5.0

### Une vitrine entièrement repensée

> *3 septembre 2026*

**✨ Nouveautés**

- Nouvelle page d'accueil, épurée : deux façons d'utiliser Quasar présentées côte à côte — l'instance publique, ou l'hébergement chez vous — au lieu d'une longue page à faire défiler.
- Quatre pages produit s'ajoutent, accessibles depuis le menu « … » : l'éthique du service, un mot de la créatrice, ce journal des nouveautés, et la page de soutien.
- La commande d'installation se copie désormais en un clic depuis la carte « Chez vous ».

**🔧 Améliorations**

- La vitrine adopte le chrome standard du design system Venacity : en-tête flottant, menu « … » et bascule de thème identiques à ceux de Maât et Prisma.
- Toute la vitrine passe au vouvoiement, pour s'aligner sur le reste de l'écosystème.
