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

## 🌌 Quasar — v4.6.0

### La modération automatique, en quatre protections

> *5 septembre 2026*

**✨ Nouveautés**

- Une page « Modération auto » rejoint le dashboard. Elle rassemble quatre protections sous quatre onglets, et chacune se règle indépendamment des autres.
- **AutoMod Discord** — mots interdits, liens, spam et mentions massives se configurent depuis Quasar, mais c'est Discord lui-même qui applique les règles : les messages concernés sont bloqués avant même d'apparaître dans le salon.
- **Escalade** — vous fixez des paliers d'avertissements et la sanction qui accompagne chacun. Ces paliers remplacent les anciennes sanctions automatiques, et vos réglages existants sont repris tels quels : vous n'avez rien à ressaisir.
- **Anti-raid** — Quasar repère les vagues d'arrivées inhabituelles, peut exiger un âge de compte minimum, et dispose d'un mode panique qui met les invitations en pause puis se lève tout seul.
- **Salon piège et arbitrage** — un salon où seuls les comptes automatisés écrivent, si bien qu'y poster suffit à se signaler ; et un salon d'arbitrage où votre équipe de modération tranche elle-même, au lieu de laisser la sanction tomber automatiquement.
- Au premier accès au dashboard après une mise à jour, un pop-up vous présente désormais les nouveautés que vous avez manquées. L'entrée « Nouveautés » de la barre latérale le rouvre à tout moment.

> Rien ne s'active tout seul : les quatre protections arrivent désactivées. Rien ne change sur vos serveurs tant que vous ne les avez pas activées vous-même.
>
> Ces quatre protections de modération automatique sont livrées **en bêta** : elles fonctionnent, mais elles sont encore en cours de test. Le reste de la version 4.6.0, pop-up des nouveautés compris, n'est pas concerné. Activez-les progressivement, en commençant par le mode « alerte seule » que chaque onglet propose, et vérifiez leur effet avant d'y associer une sanction. Vos retours sont les bienvenus : depuis le dashboard, le drapeau en bas à droite de l'écran permet de me signaler un bug ou de proposer une amélioration.

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
