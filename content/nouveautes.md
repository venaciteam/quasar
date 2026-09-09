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

## 🌌 Quasar — v4.9.0
### Quasar refuse de démarrer mal configuré, et s'arrête proprement
> *9 septembre 2026*

**✨ Nouveautés**
- Quasar vérifie sa configuration au démarrage. S'il manque une variable essentielle, ou si l'une est restée sur sa valeur d'exemple, il refuse de se lancer et vous dit lesquelles, avec le symptôme que chacune provoque. Jusqu'ici il démarrait à moitié : le bot était en ligne mais la connexion au dashboard échouait sans explication.
- L'arrêt est désormais ordonné : Quasar ferme le serveur web, puis ses boucles, puis le lien avec Discord, puis sa base. Si vous hébergez Quasar vous-même, pensez à laisser au conteneur le temps de finir — le fichier `docker-compose.yml` fourni le fait déjà.

**🔧 Améliorations**
- Le bouton de mise à jour est réservé à la personne qui possède l'instance. Il était accessible à tout compte connecté au dashboard.
- L'acceptation du contrat de sous-traitance est désormais vérifiée par le serveur et plus seulement par votre navigateur. Sans acceptation, la configuration d'un serveur n'est plus accessible. Les demandes d'effacement de données restent possibles en toutes circonstances : une obligation légale ne se suspend pas.
- Une session expirée vous ramène à la connexion au lieu d'afficher une erreur incompréhensible au moment d'enregistrer.

**🐛 Corrections**
- Un rappel programmé sur un serveur réglé sur un autre fuseau horaire que celui de Paris repartait à la mauvaise heure dès son premier envoi. Le fuseau que vous avez choisi est maintenant respecté à chaque fois.
- Un redéploiement au mauvais moment pouvait renvoyer une seconde fois un rappel programmé, mentions comprises, ou une notification de violation de données déjà reçue. Ces envois sont désormais marqués avant d'être faits.
- Un bannissement temporaire pouvait devenir définitif si le bot redémarrait juste avant l'échéance.
- Une configuration de journalisation illisible empêchait les messages de bienvenue et les rôles automatiques de fonctionner, sans aucun rapport apparent avec la cause.
- Le mode panique d'un serveur pouvait rester actif indéfiniment si le bot redémarrait au mauvais moment.

## 🌌 Quasar — v4.8.0
### Le dashboard et le formulaire de signalement sont durcis
> *7 septembre 2026*

**🔧 Améliorations**
- Le formulaire de signalement est désormais limité en débit, et le message publié dans Discord est reconstruit par Quasar champ par champ. Ce qui part de la page ne décide plus seul de ce qui s'affiche dans le salon, mentions comprises.
- Les réglages de bienvenue et de départ, ainsi que la création d'une commande personnalisée, sont vérifiés au moment de l'enregistrement. Une valeur refusée vous est signalée tout de suite, avec la raison, au lieu d'échouer plus tard sans explication.
- Le lien « Lire le texte intégral » du contrat de sous-traitance ouvre la copie embarquée dans Quasar, à jour, plutôt qu'une page publique qui n'est pas encore en ligne.
- Si vous hébergez Quasar vous-même : une nouvelle variable `TRUST_PROXY` indique combien de relais sont placés devant votre instance. Sans elle, la limitation de débit du formulaire de signalement compte toutes les visites sous une seule adresse. Elle est documentée dans le fichier d'exemple de configuration, et Quasar vous le rappelle au démarrage si elle manque.

**🐛 Corrections**
- Les textes venus de Discord — motif d'une sanction, nom d'un rôle ou d'un salon, emoji d'un panneau de rôles, nom d'un embed — sont désormais échappés partout dans le dashboard. Certains pouvaient jusqu'ici exécuter du code dans le navigateur des personnes qui administrent le serveur.
- Un envoi volumineux vers le formulaire de signalement ne peut plus faire tomber le bot.
- Une requête mal formée n'est plus présentée comme une panne de Quasar et ne déclenche plus d'alerte technique pour rien.
- Le jeton de session n'est plus accepté dans l'adresse d'une page : un lien porteur d'une session ne peut plus être fabriqué.

## 🌌 Quasar — v4.7.1
### Se connecter au dashboard fonctionne de nouveau
> *7 septembre 2026*

**🔧 Améliorations**
- Votre jeton de session ne reste plus dans le cache de votre navigateur après la connexion. Par précaution, toutes les sessions ouvertes ont été fermées : une reconnexion est nécessaire.
- Si vous hébergez Quasar vous-même : les réponses d'authentification interdisent désormais explicitement toute mise en cache, y compris par un service placé devant le bot. La panne décrite ci-dessous pouvait donc vous toucher aussi.

**🐛 Corrections**
- Se connecter au dashboard était impossible depuis un navigateur ayant consulté le site peu avant : l'autorisation Discord aboutissait, puis le dashboard renvoyait aussitôt vers l'accueil, sans un mot d'explication. Corrigé.
- Quand Discord limite temporairement le nombre de requêtes, l'échec était présenté comme un problème d'authentification alors que la connexion avait réussi. Le cas est maintenant reconnu et signalé pour ce qu'il est.

## 🌌 Quasar — v4.7.0
### Le bot ne s'arrête plus sur une erreur du dashboard
> *5 septembre 2026*

**✨ Nouveautés**
- Si vous hébergez Quasar vous-même : votre instance peut désormais vous prévenir sur Discord quand une erreur technique survient, avec le détail de ce qui a échoué et son code d'incident. L'option est facultative et se règle avec la variable `INCIDENT_WEBHOOK_URL`, documentée dans le fichier d'exemple de configuration.

**🔧 Améliorations**
- Les messages d'erreur portent maintenant un code court, du type `QSR-7F3A`. En le transmettant à l'équipe du serveur ou à la personne qui héberge l'instance, elle retrouve directement ce qui s'est passé, sans avoir à vous faire raconter la scène.
- Les messages de bienvenue et de départ proposés par défaut ont été réécrits. Si vous avez personnalisé les vôtres, rien ne change pour vous.

**🐛 Corrections**
- Une erreur inattendue dans le dashboard n'arrête plus le bot. Jusqu'ici, une seule anomalie sur une page de configuration pouvait le déconnecter de tous les serveurs à la fois, sans prévenir. Elle reste désormais contenue à la page concernée, qui affiche un message d'erreur, pendant que le bot continue de tourner.
- Le passage au vouvoiement annoncé dans la version précédente avait laissé de côté une trentaine de formulations dans les messages du bot, dont certaines mélangeaient les deux registres dans une même phrase. Elles sont corrigées.

## 🌌 Quasar — v4.6.2
### Un rôle impossible à attribuer vous le dit tout de suite
> *5 septembre 2026*

**🔧 Améliorations**
- Quasar vous vouvoie désormais partout : réponses du bot, messages d'erreur, descriptions des commandes et dashboard.

**🐛 Corrections**
- Certains rôles ne peuvent pas être attribués par un bot : ceux gérés par une intégration (abonnement Twitch, boost du serveur, autre bot), et ceux placés au-dessus de Quasar dans la liste des rôles du serveur. Ils s'enregistraient sans rien signaler, puis n'étaient jamais attribués. Ils sont maintenant refusés au moment où vous les configurez, avec l'explication et la marche à suivre.
- Cette vérification couvre les rôles automatiques, les rôles vocaux et les panneaux de rôles par réaction, aussi bien depuis les commandes que depuis le dashboard.
- Le dashboard annonçait « Autorole ajouté » même lorsque l'ajout venait d'être refusé.
- Le salon associé à un rôle vocal est vérifié : un salon supprimé, ou un salon qui n'est pas vocal, n'est plus accepté.

## 🌌 Quasar — v4.6.1
### Les rôles automatiques s'appliquent enfin partout
> *5 septembre 2026*

**🐛 Corrections**
- Les rôles attribués automatiquement à l'arrivée d'un nouveau membre ne fonctionnaient que sur les serveurs ayant configuré un message de bienvenue. Ils s'appliquent désormais sur tous les serveurs. **Si vous aviez configuré des rôles automatiques sans message de bienvenue, ils étaient inactifs et deviennent effectifs : vérifiez leur liste dans la page « Reaction Roles » du dashboard avant de recevoir un nouveau membre.**
- Le journal « Membre rejoint » restait muet dans les mêmes conditions, même lorsque la case était cochée. Il s'envoie maintenant dès que vous l'activez.
- Supprimer le salon d'accueil d'un serveur faisait disparaître ses rôles automatiques au passage. Les deux réglages sont désormais indépendants.

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
