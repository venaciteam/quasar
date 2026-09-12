# 🌌 Quasar — Bot Discord et Fluxer, auto-hébergé

> Toutes les fonctionnalités premium d'un bot de communauté — modération, tickets, reaction roles, embeds, TempVoice et dashboard web. Une seule base de code, qui tourne sur **Discord** ou sur **Fluxer**. 100% self-hosted, open source, 0 abonnement.

![Quasar Dashboard Preview](dashboard/img/preview.png)

---

## ✨ Features

| Module | Description |
|--------|-------------|
| 🛡️ **Modération** | Warn, mute, kick, ban, clear, historique des sanctions, logs automatiques |
| 🤖 **Modération auto** — *bêta* | AutoMod de Discord piloté depuis le dashboard, escalade par avertissements, anti-raid, salon piège et arbitrage. Tout arrive désactivé |
| 👋 **Welcome / Leave** | Messages de bienvenue et départ avec embed + avatar |
| 🎭 **Reaction Roles** | Panels avec emojis, mode unique ou multiple, toggle au clic |
| ✅ **Autoroles** | Rôles attribués automatiquement à l'arrivée |
| 🔊 **Rôles vocaux** | Rôle donné en vocal, retiré à la déconnexion |
| 📝 **Embeds Custom** | Créer, sauvegarder et envoyer des embeds personnalisés |
| ⚡ **Commandes Custom** | Commandes personnalisées avec texte ou embed |
| 🎫 **Tickets** | Système de tickets, panel personnalisable — transcript envoyé dans Discord à la fermeture, jamais stocké en base |
| 🔊 **TempVoice** | Salons vocaux temporaires avec boutons interactifs |
| 🌐 **Dashboard Web** | Tout configurer depuis un navigateur — thème clair/sombre |
| ⬆ **Auto-update** | Mise à jour en un clic depuis le dashboard avec logs temps réel |
| ⚖️ **Droits des personnes** | `/mes-donnees`, demandes de suppression routées à l'administrateur, notification de violation de données, contrat de sous-traitance sur instance publique |

---

## 🛰️ Une base de code, deux plateformes

Quasar est **un seul programme** et **un déploiement par plateforme**. La variable `QUASAR_PLATFORM` vaut `discord` (par défaut) ou `fluxer` : elle décide de la plateforme à laquelle ce processus se connecte, des secrets qu'il exige et de la forme que prennent les commandes. Aucune fonctionnalité n'est écrite deux fois — la logique de modération, de tickets ou de conservation des données ne sait même pas sur quelle plateforme elle s'exécute, c'est une couche d'adaptation (`bot/platform/`) qui traduit. Tenir les deux plateformes demande donc **deux installations** : deux dossiers, deux bases de données, aucune donnée partagée. Ce cloisonnement est une exigence de conformité, pas une commodité technique. Sur une même machine, la seconde installation doit changer le nom du conteneur, le volume et le port dans son `docker-compose.yml`, sinon elle prend la place de la première.

Une installation qui existait avant la v5.0.0 n'a **rien** à changer : sans `QUASAR_PLATFORM`, Quasar est un bot Discord, exactement comme avant.

### Ce qui change pour la personne qui administre

| | Discord | Fluxer |
|---|---|---|
| **Commandes** | `/warn @membre raison` | `!warn @membre raison`, préfixe réglable par `COMMAND_PREFIX` |
| **Panneaux et menus** | Boutons et menus déroulants | L'embed liste ses actions, une réaction par action — le bot pose les réactions lui-même |
| **Formulaires** (ouvrir un ticket, écrire un embed) | Une fenêtre de saisie | Un dialogue : une question, une réponse, `annuler` pour interrompre |
| **Réponse visible de vous seul** | Oui, réponse éphémère | Non : ce qui est sensible part en message privé, le reste s'auto-supprime au bout de 15 s |
| **Modération automatique (AutoMod)** | Oui, les règles natives de Discord pilotées depuis le dashboard | **Absente** : Fluxer n'a aucun automod, et l'onglet disparaît du dashboard |
| **Mode panique anti-raid** | Met les invitations en pause avec une échéance qui se lève seule | **Indisponible** : Fluxer sait fermer ses invitations, mais rien ne les rouvre à échéance |
| **Fils de discussion** | Oui | **Non** exposés par l'API à ce jour |
| **Exclusion temporaire** (`mute`) | Timeout natif | Timeout natif également, plafonné à 365,25 jours |
| **Suppression de messages en lot** (`clear`) | Les messages de plus de 14 jours sont écartés | Aucune borne d'âge |
| **Musique** | Coupée depuis la v3.2.0 | Coupée, et non portable : la voix de Fluxer passe par LiveKit, sans protocole de signalisation publié |

Tout le reste est identique : modération, tickets, reaction roles, autoroles, rôles vocaux, salons vocaux temporaires, embeds, commandes personnalisées, anti-raid, salon piège, arbitrage des sanctions, dashboard, et l'intégralité des parcours de droits des personnes.

> ⚠️ **Statut de la plateforme Fluxer, dit franchement.** L'adaptateur Fluxer est **livré et testé en doublures** — sa passerelle, son client REST, ses commandes préfixées et ses panneaux à réactions sont couverts par la suite de tests. Il **n'a pas encore été éprouvé contre une instance réelle** : la connexion à la passerelle publique a été vérifiée, pas l'exécution des commandes sur un vrai serveur. Si vous montez un bot Fluxer aujourd'hui, vous êtes en avance sur la recette. Côté Discord, en revanche, ce chantier est à comportement constant : c'est un critère de sortie, pas un souhait.

---

## 🚀 Quick Start

### Prérequis
- [Docker](https://docs.docker.com/get-docker/) installé
- **Sur Discord** : une application bot ([Developer Portal](https://discord.com/developers/applications))
- **Sur Fluxer** : une application, créée depuis les réglages de votre compte Fluxer, catégorie « Developer » → « Applications »

### Installation en une commande

```bash
curl -sSL https://raw.githubusercontent.com/venaciteam/quasar/main/install.sh | bash
```

Ou en clonant vous-même :

```bash
git clone https://github.com/venaciteam/quasar.git
cd quasar
./setup.sh
```

Le script vous guide de bout en bout. **Sa première question est la plateforme** — Discord ou Fluxer —, et tout ce qui suit en découle : il ne vous demandera jamais un jeton Discord pour un bot Fluxer, ni l'inverse. Ensuite, il vous demande les identifiants de l'application en expliquant où les trouver, **vérifie votre jeton auprès de la plateforme avant de construire quoi que ce soit** (inutile d'attendre plusieurs minutes de compilation pour découvrir une faute de frappe), écrit le `.env`, détecte le groupe Docker de votre machine, vous donne le lien d'invitation du bot — celui de la bonne plateforme —, démarre, puis contrôle que le dashboard répond et que le bot est bien connecté.

<details>
<summary>Le parcours, question par question</summary>

| Question | Discord | Fluxer |
|---|---|---|
| Plateforme | — | — |
| Instance | *(non posée)* | `fluxer.app`, ou une instance auto-hébergée (et alors : base REST, passerelle, proxy média) |
| Jeton du bot | Developer Portal → votre application → Bot | Réglages du compte → « Applications » → votre application → « Secrets & tokens » → « Bot token » |
| Identifiant de l'application | OAuth2 → Client ID | « Application ID », proposé par défaut car le jeton le contient |
| Secret de l'application | OAuth2 → Client Secret | « Secrets & tokens » → « Client secret » |
| Préfixe des commandes | *(non posée)* | `!` par défaut |
| Port du dashboard | `3000` par défaut | idem |
| Accès réseau au dashboard | posée seulement si vous installez par SSH | idem |
| Adresse de retour OAuth2 | `http://localhost:3000/callback` | même chemin, même valeur par défaut |
| Votre identifiant de propriétaire | facultatif | facultatif |

Le **mode** de fonctionnement (`QUASAR_MODE` : `bot`, `site`, `public`) n'est pas demandé et reste réglable dans le `.env` : c'est une décision indépendante de la plateforme, et `bot` est le bon choix pour toute installation auto-hébergée.

</details>

Il installe la **dernière version publiée**, pas l'état courant du dépôt : deux personnes qui installent le même jour obtiennent le même code.

<details>
<summary>Options du script</summary>

| Option | Effet |
|---|---|
| `--dev` | Installer l'état courant de la branche `main` au lieu de la dernière version publiée |
| `-y`, `--non-interactive` | Ne rien demander : toute la configuration vient de l'environnement |
| `--reconfigure` | Régénérer le `.env` d'une installation existante (l'ancien est sauvegardé à côté) |
| `--help` | La liste complète des variables lues dans l'environnement |

Installation sans aucune question, pour un déploiement automatisé :

```bash
DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… ./setup.sh --non-interactive
```

```bash
QUASAR_PLATFORM=fluxer FLUXER_TOKEN=… FLUXER_CLIENT_ID=… FLUXER_CLIENT_SECRET=… \
  ./setup.sh --non-interactive
```

Toute variable déjà présente dans votre environnement n'est pas redemandée. Les variables de l'autre plateforme, elles, sont **écartées et annoncées** : un `.env` ne porte jamais les secrets des deux à la fois.

</details>

> **Vous installez à distance, en SSH ?** Le dashboard n'écoute que sur la machine qui l'héberge : ouvrir `http://localhost:3000` depuis votre ordinateur ne donnerait rien. Le script détecte ce cas, vous l'explique, et vous propose d'ouvrir l'accès au réseau local. Il ne le fait jamais sans votre accord, et affiche à la fin l'adresse réellement joignable.

### Installation manuelle

<details>
<summary>Voir les étapes manuelles</summary>

#### 1. Cloner le repo

```bash
git clone https://github.com/venaciteam/quasar.git
cd quasar
```

#### 2. Configurer

```bash
cp .env.example .env
```

Édite le fichier `.env` avec tes informations :

| Variable | Description |
|----------|-------------|
| `QUASAR_PLATFORM` | `discord` (défaut) ou `fluxer`. Décide de la plateforme de ce déploiement, et donc des trois variables obligatoires ci-dessous. Une valeur inconnue **fait échouer le démarrage** : Quasar ne devine jamais sa plateforme |
| `DISCORD_TOKEN` | *Sur Discord* — Token du bot (onglet Bot du Developer Portal) |
| `DISCORD_CLIENT_ID` | *Sur Discord* — Client ID (onglet OAuth2) |
| `DISCORD_CLIENT_SECRET` | *Sur Discord* — Client Secret (onglet OAuth2) |
| `FLUXER_TOKEN` | *Sur Fluxer* — Jeton du bot (« Secrets & tokens » → « Bot token »). Sa forme est `<identifiant de l'application>.<secret>` ; une régénération met fin à toutes les sessions en cours |
| `FLUXER_CLIENT_ID` | *Sur Fluxer* — « Application ID » de votre application |
| `FLUXER_CLIENT_SECRET` | *Sur Fluxer* — « Client secret » de la même fiche |
| `FLUXER_API_BASE` | *Sur Fluxer, optionnel* — Base REST **versionnée**. Vide : `https://api.fluxer.app/v1`. À renseigner pour viser une instance Fluxer auto-hébergée |
| `FLUXER_GATEWAY_URL` | *Sur Fluxer, optionnel* — Passerelle. Vide : `wss://gateway.fluxer.app/?v=1`. Le paramètre `v` doit valoir `1`, toute autre valeur ferme la connexion avant le premier message |
| `FLUXER_MEDIA_BASE` | *Sur Fluxer, optionnel* — Proxy média, d'où viennent les avatars des embeds. Vide : `https://media.fluxer.app`. Une valeur fausse ne casse rien, elle rend seulement les avatars introuvables |
| `COMMAND_PREFIX` | *Sur Fluxer, optionnel* — Préfixe des commandes texte. Vide : `!`. Sans objet sur Discord, où les commandes sont des `/` |
| `CALLBACK_URL` | URL de callback OAuth2 — `http://localhost:3000/callback` par défaut. Le chemin `/callback` est le même sur les deux plateformes. Si tu ouvres le dashboard au réseau, mets l'IP du serveur (ex: `http://192.168.1.100:3000/callback`) |
| `JWT_SECRET` | Clé de signature des sessions du dashboard. **Vide dans `.env.example`**, à générer avec `openssl rand -hex 32` — Quasar refuse de démarrer tant qu'elle est absente, laissée sur une valeur d'exemple ou plus courte que 32 caractères |
| `PORT` | Port du dashboard (défaut: `3000`) |
| `BIND_ADDRESS` | **Exposition du dashboard en Docker** — `127.0.0.1` (défaut) = accessible seulement depuis la machine hôte, `0.0.0.0` = ouvert au réseau |
| `DASHBOARD_HOST` | Équivalent hors Docker (lancement direct par `node index.js`). Ne pas y toucher en conteneur : le Dockerfile le force à `0.0.0.0` |
| `BOT_OWNER_ID` | Ton identifiant sur la plateforme active — active les fonctions admin dans le dashboard (gestion du statut du bot). Sur Discord : active le mode développeur → clic droit sur ton profil → Copier l'identifiant. Sur Fluxer : Réglages → « Advanced » → « Enable developer mode », puis clic droit sur ton profil → « Copy user ID » |
| `INSTANCE_OPERATOR_NAME` | Qui héberge cette instance — affiché dans le badge de version, sur toutes les pages du dashboard (optionnel) |
| `INSTANCE_LEGAL_URL` | Lien vers tes mentions légales (optionnel) — affiché au même endroit |
| `CONTRACT_PUBLIC_URL` | Lien vers ton contrat de sous-traitance, **utilisé uniquement en `QUASAR_MODE=public`**. Vide : le contrat de l'instance Venacity |
| `INSTANCE_SOURCE_URL` | Code source de ta version — **requis par l'AGPL si tu as modifié Quasar et que ton dashboard est accessible à d'autres** |
| `ABUSE_REPORT_URL` | Où reçois-tu les signalements d'abus (`/signaler abus`). **Vide par défaut** : sans ça, aucun signalement d'abus ne quitte ton instance |
| `INSTANCE_ABUSE_CONTACT` | Contact affiché pour signaler un abus quand `ABUSE_REPORT_URL` est vide (e-mail ou URL) |
| `REPORT_RELAY_URL` | Où partent les bugs du logiciel (`/signaler bug`). Défaut : `https://sema.vena.city` |
| `INCIDENT_WEBHOOK_URL` | Webhook Discord où ton instance annonce ses propres incidents techniques (erreur inattendue, promesse rejetée). **Vide par défaut** : les incidents restent alors dans les journaux |
| `GUILD_PURGE_GRACE_DAYS` | Délai avant suppression des données d'un serveur quitté (défaut : `7` jours, `0` = immédiat) |
| `QUASAR_ADMIN_API_KEY` | Clé d'administration du journal des nouveautés (`/api/admin/nouveautes`). **Vide par défaut** : sans elle, ces routes répondent 503 et rien ne peut être publié |
| `STRIPE_LINK_ONCE_2` &nbsp;·&nbsp; `_5` &nbsp;·&nbsp; `_CUSTOM` | Liens de paiement ponctuels de la page `/soutenir`. Chacun est optionnel : un lien absent masque son bouton |
| `STRIPE_LINK_MONTHLY_2` &nbsp;·&nbsp; `_5` &nbsp;·&nbsp; `_10` | Idem pour les soutiens mensuels. Si **aucun** lien n'est défini, `/soutenir` bascule d'elle-même en mode « bientôt » |

> **Quasar contrôle sa configuration au démarrage** — Cinq variables sont vérifiées avant toute connexion : les trois de la plateforme active (`DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` — ou `FLUXER_TOKEN`, `FLUXER_CLIENT_ID`, `FLUXER_CLIENT_SECRET`), plus `CALLBACK_URL` et `JWT_SECRET`. Présence, valeur d'exemple laissée en place, et longueur minimale pour le secret de signature. **Les deux jeux de secrets ne se mélangent pas** : en `QUASAR_PLATFORM=fluxer`, l'absence de `DISCORD_TOKEN` n'est pas une erreur, et réciproquement — un déploiement n'a aucune raison de porter les secrets de la plateforme qu'il ne sert pas. Toutes celles qui manquent sont annoncées **d'un seul coup**, avec ce que chacune rend possible — une seule relance suffit à corriger le fichier `.env`. En `QUASAR_MODE=site` (vitrine seule), aucune n'est exigée : ce mode ne démarre ni bot, ni API métier, ni base.
>
> Le refus de démarrer est délibéré. Sans `JWT_SECRET`, les sessions du dashboard étaient signées avec une valeur écrite dans ce dépôt public, et n'importe qui pouvait forger un jeton d'administration.

> **🔒 Le dashboard est fermé par défaut** — Il n'écoute que sur la machine qui l'héberge. C'est volontaire : le dashboard donne accès à toute la configuration du bot et aux données de tes serveurs (sanctions, tickets, configs). Tant que tu n'y touches pas, personne d'autre sur ton réseau ne peut l'atteindre.
>
> **Pour l'ouvrir au réseau local**, en connaissance de cause :
> 1. `BIND_ADDRESS=0.0.0.0` dans le `.env` (ou `DASHBOARD_HOST=0.0.0.0` si tu lances sans Docker)
> 2. `CALLBACK_URL=http://<ip-de-ton-serveur>:3000/callback` — l'IP est affichée dans les logs au démarrage
> 3. Ajoute cette même URL dans ton application — Developer Portal (OAuth2 → Redirects) sur Discord, « Application information » → « Redirect URIs » sur Fluxer
>
> **Pour un accès depuis Internet**, ne publie jamais le port directement : passe par un reverse proxy HTTPS (Cloudflare Tunnel, Nginx, Caddy…) et laisse `BIND_ADDRESS=127.0.0.1` — le proxy tourne sur la même machine et atteint le dashboard en local.

#### 3. Configurer l'application

Voir [Configurer le bot Discord](#configurer-le-bot-discord) ou [Configurer le bot Fluxer](#configurer-le-bot-fluxer) juste après ce bloc — intents à activer côté Discord, réglages à laisser tranquilles des deux côtés.

#### 4. Créer le volume et lancer

```bash
docker volume create quasar-data
docker compose up -d
```

Le bot est en ligne. L'adresse du dashboard (locale + réseau) s'affiche dans les logs : `docker logs quasar`.

</details>

### Configurer le bot Discord

Sur le [Developer Portal](https://discord.com/developers/applications) :

**Onglet Bot — à activer.** Les 3 Privileged Gateway Intents. Quasar les demande tous les trois au démarrage : s'il en manque un, Discord refuse la connexion et le bot ne démarre pas.
- ✅ Presence Intent
- ✅ Server Members Intent
- ✅ Message Content Intent

> Quasar demande aussi deux intents liés à l'AutoMod de Discord (`AutoModerationConfiguration` et `AutoModerationExecution`). Ils ne sont **pas** privilégiés : ils n'apparaissent nulle part dans le Developer Portal, et il n'y a rien à activer ni à faire approuver.

**Onglet Installation.** Garde **Guild Install**, décoche **User Install** : Quasar est un bot de serveur. Mets *Install Link* sur **None** — l'invitation se fait avec l'URL de la section suivante.

**Onglet Bot — à désactiver.** Dans cet ordre, après l'onglet Installation :
- ❌ **Public Bot** — sauf si tu veux que n'importe qui puisse inviter ton bot sur son serveur
- ❌ **Requires OAuth2 Code Grant** — activé, l'invitation du bot échoue

> [!tip]
> Si Discord refuse de décocher *Public Bot* avec le message *« Private application cannot have a default authorization link »*, c'est que *Install Link* n'est pas encore sur **None** : il faut passer par l'onglet Installation d'abord, enregistrer, puis revenir. La mention *« Verified apps must be public »* ne concerne que les applications vérifiées par Discord.

**Onglet OAuth2 → Redirects.** Ajoute ton callback URL, identique au caractère près à `CALLBACK_URL` dans ton `.env` (ex: `http://localhost:3000/callback`). Discord rejette la connexion à la moindre différence, slash final compris.

> [!warning]
> **Ne remplis jamais « Interactions Endpoint URL »** (onglet General Information). Ce champ bascule Discord en mode HTTP : il cesse d'envoyer les interactions par la passerelle, et **plus aucune commande slash ne répond** — alors que le bot semble connecté et que rien n'apparaît dans les logs. Quasar écoute la passerelle, ce champ doit rester vide.

### Configurer le bot Fluxer

Dans Fluxer, ouvrez les **réglages de votre compte** → catégorie « Developer » → **« Applications »**, puis votre application. Tout se règle depuis cette fiche.

**« Secrets & tokens » — ce que Quasar demande.** « Bot token » va dans `FLUXER_TOKEN`, « Client secret » dans `FLUXER_CLIENT_SECRET`, et l'« Application ID » affiché en tête de fiche dans `FLUXER_CLIENT_ID`. Les deux valeurs secrètes ne s'affichent qu'une fois : « Regenerate » en fabrique une nouvelle, et invalide l'ancienne — un jeton régénéré met fin à toutes les sessions du bot en cours.

**« Application information » → « Redirect URIs ».** Ajoutez votre `CALLBACK_URL`, identique au caractère près. Sans cette déclaration, la connexion au dashboard est refusée par Fluxer, et le refus n'apparaît pas dans les journaux de Quasar. Une application accepte jusqu'à dix adresses.

**À désactiver :**
- ❌ **« Public bot »** — sauf si vous voulez que n'importe qui puisse inviter votre bot sur son serveur
- ❌ **« Require OAuth2 code grant »** — activée, elle fait refuser le lien d'invitation, qui ne demande que le scope `bot` et ne présente donc aucun code d'autorisation

**Rien à activer côté passerelle.** Fluxer n'a pas d'intents : sa demande d'identification n'accepte que le jeton et les propriétés du client. Il n'y a donc aucun réglage privilégié à faire approuver, contrairement à Discord — et rien qui puisse manquer au démarrage.

> [!warning]
> **Fluxer n'a pas de commandes d'application.** Toutes les commandes de Quasar y sont des messages préfixés, dérivées du même registre que les `/` de Discord : `!help` répond, `/help` non. Le préfixe se règle par `COMMAND_PREFIX`. Le bot a donc besoin de **lire les messages** de vos salons pour reconnaître ses commandes — c'est le prix de l'absence d'interactions, et il disparaîtra le jour où Fluxer les livrera.

### Inviter le bot

Sur le Developer Portal → **OAuth2 → URL Generator** :
- Scopes : `bot` + `applications.commands`
- Permissions : `Administrator`
- Copiez l'URL et ouvrez-la pour inviter le bot sur votre serveur

Vous n'avez normalement pas à faire ça vous-même : **le script d'installation compose et affiche ce lien**, au bon moment, juste avant de démarrer le bot. Le dashboard le génère également.

> **Invitez le bot AVANT de démarrer, ou après — mais sachez pourquoi.** Les commandes slash sont déployées serveur par serveur. Elles arrivent désormais dès que le bot rejoint un serveur, donc l'ordre n'a plus d'importance. Ce n'était pas le cas avant la v4.10.0 : un bot lancé avant d'être invité restait sans aucune commande jusqu'au redémarrage suivant, ce qui ressemblait à s'y méprendre à un problème d'intents.

> **Pourquoi Administrator** : ça évite de revenir ajuster les permissions à chaque module activé. Si vous préférez le principe du moindre privilège, la liste complète est ci-dessous — avec un lien d'invitation tout prêt.
>
> **Le socle, sans lequel le bot ne peut rien faire du tout :**
>
> - **Voir les salons** et **Envoyer des messages** — sans elles, aucun message de bienvenue, aucun panneau de tickets, aucune réponse ;
> - **Intégrer des liens** — la quasi-totalité des réponses de Quasar sont des embeds ; sans cette permission elles n'apparaissent pas ;
> - **Joindre des fichiers** — le transcript d'un ticket est remis en pièce jointe à la fermeture. Sans elle, Quasar **refuse de fermer le ticket** plutôt que de perdre la conversation ;
> - **Lire l'historique des messages** — nécessaire à `/clear` et à la constitution des transcripts ;
> - **Ajouter des réactions** — le bot pose lui-même les réactions des panneaux de rôles.
>
> **Les permissions par module :**
>
> - **Gérer les salons** — tickets et salons vocaux temporaires ;
> - **Déplacer des membres** — TempVoice déplace la personne dans le salon qu'il vient de créer pour elle. Sans cette permission, le salon est créé et elle reste dans le salon d'accueil, sans explication ;
> - **Gérer les rôles** — autoroles, reaction roles, rôles vocaux ;
> - **Gérer les messages** — `/clear` ;
> - **Expulser des membres** — `/kick` et les expulsions automatiques ;
> - **Bannir des membres** — `/ban`, mais aussi vérifier quels bannissements sont encore en vigueur avant de purger d'anciennes sanctions, et lever un bannissement temporaire à son échéance ;
> - **Modérer les membres** — toutes les exclusions temporaires : `/mute`, l'escalade par avertissements, l'anti-raid, et celles posées par une règle AutoMod ;
> - **Gérer le serveur** — tout ce qui touche à l'AutoMod de Discord, **y compris la simple lecture de vos règles**, et la mise en pause des invitations du mode panique anti-raid.
>
> **Lien d'invitation avec exactement ces permissions**, en remplaçant l'identifiant par le vôtre :
>
> ```
> https://discord.com/api/oauth2/authorize?client_id=VOTRE_CLIENT_ID&permissions=1099796966518&scope=bot%20applications.commands
> ```
>
> Les deux dernières de la liste par module sont les plus faciles à oublier, et ce sont celles qui rendent la modération automatique inopérante. Sans **Gérer le serveur**, l'onglet AutoMod du dashboard refuse d'afficher quoi que ce soit — il vous dit au moins laquelle activer —, et le mode panique de l'anti-raid échoue sans rien dire ailleurs que dans les journaux du bot. Sans **Modérer les membres**, aucune exclusion temporaire n'est possible : ni `/mute`, ni un palier d'escalade, ni une règle AutoMod qui exclut.

#### Sur Fluxer

Le lien est composé et affiché par le script d'installation, comme sur Discord, et le dashboard le génère aussi. Il ne demande que le scope **`bot`** : `applications.commands` n'existe pas au registre des scopes de Fluxer, et un scope inconnu fait rejeter toute la demande d'autorisation.

```
https://api.fluxer.app/v1/oauth2/authorize?client_id=VOTRE_APPLICATION_ID&permissions=8&scope=bot
```

`permissions=8`, c'est **Administrateur** : le même raccourci que côté Discord, et pour la même raison — ne pas avoir à revenir ajuster les permissions à chaque module activé.

Si vous préférez le moindre privilège, voici le jeu minimal, avec les **noms canoniques de Fluxer** tels que sa documentation les publie :

| Permission Fluxer | À quoi elle sert dans Quasar |
|---|---|
| `VIEW_CHANNEL` | voir les salons où répondre, et y reconnaître les commandes préfixées |
| `SEND_MESSAGES` | répondre, poser les panneaux et les messages de bienvenue |
| `ADD_REACTIONS` | poser les réactions des panneaux — c'est l'interface, ici, pas un ornement |
| `MANAGE_MESSAGES` | `!clear`, et retirer la réaction d'une autre personne sur un panneau |
| `EMBED_LINKS` | la quasi-totalité des réponses de Quasar sont des embeds |
| `ATTACH_FILES` | remettre le transcript d'un ticket à sa fermeture |
| `READ_MESSAGE_HISTORY` | `!clear` et la constitution des transcripts |
| `MANAGE_CHANNELS` | tickets et salons vocaux temporaires |
| `MOVE_MEMBERS` | déplacer la personne dans le salon vocal qui vient d'être créé pour elle |
| `MANAGE_ROLES` | autoroles, panneaux de rôles, rôles vocaux |
| `KICK_MEMBERS` | `!kick` et les expulsions automatiques |
| `BAN_MEMBERS` | `!ban`, et la levée d'un bannissement temporaire à son échéance |
| `MODERATE_MEMBERS` | toutes les exclusions temporaires : `!mute`, l'escalade par avertissements, l'anti-raid |

`MANAGE_GUILD` ne figure pas dans cette liste, alors qu'elle est nécessaire sur Discord : elle n'y sert qu'à l'AutoMod et au mode panique à échéance, dont aucun n'existe sur Fluxer.

**Lien d'invitation avec exactement ces permissions**, en remplaçant l'identifiant par le vôtre :

```
https://api.fluxer.app/v1/oauth2/authorize?client_id=VOTRE_APPLICATION_ID&permissions=1099796966486&scope=bot
```

> **`ADD_REACTIONS` est la permission à ne pas oublier sur Fluxer.** Sans elle, un panneau de tickets ou de rôles s'affiche mais reste sans réaction : rien n'est cliquable, et il n'y a aucun message d'erreur à lire. C'est l'équivalent exact d'un bouton qui n'apparaîtrait pas.

---

## 🍓 Raspberry Pi

Quasar tourne confortablement sur un **Raspberry Pi 4** (2 Go minimum). La stack est légère : Node.js + SQLite, pas de base de données externe.

```bash
curl -sSL https://raw.githubusercontent.com/venaciteam/quasar/main/install.sh | bash
```

> **Note :** Le build initial peut prendre quelques minutes sur Pi (compilation du module natif `better-sqlite3`).

Deux choses valent d'être sues avant de se lancer sur un Pi :

- **Vous installez presque toujours en SSH.** Le dashboard écoute par défaut sur la seule machine qui l'héberge, donc `http://localhost:3000` depuis votre ordinateur ne donnera rien. Le script détecte la session distante et vous propose d'ouvrir l'accès au réseau local ; si vous refusez, il vous affiche la commande de tunnel `ssh -L` à utiliser.
- **Le jeton est vérifié avant la compilation.** Sur un Pi, construire l'image prend plusieurs minutes : découvrir une faute de frappe dans le jeton à la fin de ce délai était particulièrement décourageant. Le script interroge d'abord la plateforme choisie — Discord ou Fluxer — et vous confirme le nom du bot.

---

## 🔧 Commandes

<details>
<summary>Voir toutes les commandes (26 déployées)</summary>

> **Sur Fluxer, les mêmes commandes s'écrivent avec un préfixe** : `!warn @membre raison` au lieu de `/warn`, `!ticket close` au lieu de `/ticket close`. Les sous-commandes et les options sont identiques, et se remplissent dans l'ordre où elles sont listées ici ; la forme `option:valeur` est acceptée aussi. `!help` dérive sa liste du même registre que les commandes `/`, il n'y a donc rien à tenir à jour de ce côté. Le préfixe se règle par `COMMAND_PREFIX`.

### Modération
| Commande | Description |
|----------|-------------|
| `/warn @membre [raison]` | Avertir un membre |
| `/warns @membre` | Voir les warns |
| `/unwarn [id]` | Retirer un warn |
| `/mute @membre [durée] [raison]` | Timeout (10m, 2h, 1d) |
| `/unmute @membre` | Retirer le timeout |
| `/kick @membre [raison]` | Expulser |
| `/ban @membre [raison]` | Bannir |
| `/unban [id]` | Débannir |
| `/clear [nombre] [@membre]` | Supprimer des messages |
| `/sanctions @membre` | Historique complet |
| `/log #channel` | Définir le channel de logs |
| `/unlog` | Retirer les logs |

### Welcome / Leave
| Commande | Description |
|----------|-------------|
| `/welcome channel/message/embed/test/off` | Configurer les messages de bienvenue |
| `/leave channel/message/embed/test/off` | Configurer les messages de départ |

### Rôles
| Commande | Description |
|----------|-------------|
| `/autorole add/remove/list` | Rôles automatiques à l'arrivée |
| `/reactionrole create/add/remove/delete/list` | Panels de reaction roles |
| `/voicerole set/remove/list` | Rôles vocaux |

### TempVoice
| Commande | Description |
|----------|-------------|
| `/tempvoice setup [catégorie]` | Configurer les salons vocaux temporaires |

### Tickets
| Commande | Description |
|----------|-------------|
| `/ticket setup` | Configurer le système de tickets |
| `/ticket close [raison]` | Fermer un ticket |
| `/ticket add @membre` | Ajouter un membre au ticket |
| `/ticket remove @membre` | Retirer un membre du ticket |
| `/ticket config` | Personnaliser le panel |

### Embeds & Commandes
| Commande | Description |
|----------|-------------|
| `/embed create/send/edit/preview/list/delete` | Embeds personnalisés |
| `/cmd create/edit/delete/list` | Commandes personnalisées |

### Utilitaire
| Commande | Description |
|----------|-------------|
| `/help` | Aide, liste des commandes et moyens de signalement |
| `/ping` | Latence du bot |

### Signalement et données personnelles — accessible à tous les membres
| Commande | Description |
|----------|-------------|
| `/signaler bug` | Quasar dysfonctionne — part chez qui développe le bot |
| `/signaler abus` | Le bot est utilisé de façon abusive — reste chez l'hébergeur de l'instance |
| `/mes-donnees` | Voir les données que Quasar traite te concernant sur ce serveur, et demander leur suppression |

</details>

---

## 🤖 Modération automatique — *bêta*

Une page « Modération auto » du dashboard, quatre onglets, quatre protections indépendantes. Elles sont **livrées en bêta** et **arrivent toutes désactivées** : une instance qui se met à jour ne se réveille pas en sanctionnant. Chaque onglet propose un mode « alerte seule », sans aucune sanction associée — c'est par là qu'il faut commencer.

Le détail des réglages se fait dans le dashboard, qui les explique au fil de l'eau. Voici seulement ce qu'il faut savoir avant de s'y mettre.

| Protection | Ce qu'elle fait |
|---|---|
| **AutoMod Discord** | Crée et gère les règles de l'AutoMod **natif de Discord** : mots interdits, liens, spam, mentions en masse, filtre de profil |
| **Escalade par avertissements** | Des paliers configurables — à N avertissements, telle sanction |
| **Anti-raid** | Détecte les vagues d'arrivées (N arrivées en X secondes), peut exiger un âge de compte minimum, et dispose d'un mode panique |
| **Salon piège et arbitrage** | Un salon où quiconque écrit est traité comme un compte automatisé, et un salon où l'équipe tranche au lieu de laisser la sanction tomber |

**Quasar ne lit pas tes messages pour autant.** L'onglet AutoMod pilote les règles de Discord, il n'embarque aucun moteur de scan : c'est Discord qui filtre, en amont du bot, et les messages bloqués n'arrivent même pas jusqu'à Quasar. Ce qui remonte, c'est le déclenchement — journalisé dans le salon de logs et rangé dans l'historique des sanctions (`/sanctions`), au même titre qu'une sanction manuelle. Quasar n'ajoute jamais de sanction par-dessus celle de Discord : ce serait punir deux fois le même message.

**L'escalade remplace les anciennes sanctions automatiques.** La cascade « mute à 3, kick à 5, ban à 8 » du module Modération n'existe plus ; les paliers la remplacent, avec des sanctions composables (`delete, tempmute 20m`) et jusqu'à dix paliers par serveur. **Tes réglages existants sont repris automatiquement au premier démarrage**, actifs, à l'identique — tu n'as rien à ressaisir. Un seul palier s'applique par avertissement : le plus haut atteint.

Le comptage des avertissements reste borné par la durée de conservation du serveur (voir plus bas) : un avertissement trop ancien pour être conservé ne peut plus déclencher de sanction.

**Le mode panique met les invitations en pause** via l'action d'incident native de Discord, qui porte sa propre échéance. Il se lève tout seul, même si le bot redémarre entre-temps, et il ne touche à aucune permission de salon. Si les invitations étaient déjà en pause avant son déclenchement, la levée ne les rouvre pas.

**Le salon piège exempte d'office** l'équipe de modération, l'administration, la personne propriétaire du serveur, les bots et les webhooks — sans case à cocher. Sans ça, la première personne qui va tester son propre piège se ferait sanctionner par son propre outil.

---

## 🏷️ Versionner une release

Une seule commande : `npm version <x.y.z> --no-git-tag-version`. Elle écrit le champ `version` de `package.json` **et** celui de `package-lock.json` — les deux doivent coïncider, sinon `npm ci` refuse de s'exécuter au déploiement. Éditer `package.json` à la main est le piège à éviter.

Les pages du dashboard portent un marqueur `__VERSION__` au lieu d'un numéro figé. Il est remplacé au moment où le fichier est servi ([`api/services/assetVersion.js`](api/services/assetVersion.js)), ce qui couvre d'un coup :

- le cache-busting `?v=` de toutes les feuilles de style et de tous les scripts ;
- la version affichée et envoyée avec les signalements ;
- le nom du cache du service worker.

Avant, il fallait tenir 24 références à la main à chaque release. Un oubli ne cassait rien de visible au déploiement : Cloudflare continuait simplement à servir l'ancien CSS aux utilisateurs, ce qui se diagnostique mal.

---

## 🚚 Passer en v5.0.0

La v5.0.0 fait passer Quasar au bot multiplateforme. Côté Discord, le comportement observable est inchangé — c'était le critère de sortie du chantier. Trois points demandent quand même votre attention à la mise à jour, parce que les panneaux à boutons passent désormais par un routage unifié et que **les identifiants des anciens panneaux ne sont plus reconnus**.

| | Ce qu'il faut faire |
|---|---|
| **Tickets — action requise** | Relancez `/ticket setup` sur chaque serveur : le panneau public déjà posé ne répond plus. Dans les tickets déjà ouverts, le bouton « Fermer le ticket » est inerte — `/ticket close` fait exactement la même chose |
| **Salons vocaux temporaires — rien à faire** | Un panneau vit dans son salon et meurt avec lui. Seuls les salons occupés à l'instant de la mise à jour sont concernés : `/voice`, ou quitter et recréer le salon |
| **Arbitrage des sanctions — à traiter à la main** | Les cas en attente au moment de la mise à jour ne sont plus cliquables. **Aucune sanction n'a été appliquée**, mais ces cas restent ouverts : tranchez-les depuis le dashboard ou à la main |

Trois améliorations visibles, au passage : l'ouverture d'un ticket ne produit plus deux messages, trancher un cas d'arbitrage n'affiche plus de message éphémère parasite, et le panneau des salons vocaux temporaires retrouve sa disposition 4+3.

Un détail pour qui écrivait des embeds à la main : les **noms de couleurs** héritées de discord.js (`Red`, `Gold`…) ne sont plus acceptés. Un entier ou un `#rrggbb`, comme l'annonce déjà l'option « Couleur hex » de `/embed`.

---

## ⬆ Mise à jour

Quasar vérifie automatiquement les nouvelles versions sur GitHub. Quand une mise à jour est disponible, un bandeau apparaît dans le dashboard. Cliquez sur « Mettre à jour » pour lancer le processus, avec un terminal en temps réel. En cas d'échec, un rollback automatique restaure la version précédente.

Le système supporte les deux modes de déploiement :
- **Docker** : git pull + rebuild image + restart container
- **Natif** : git pull + npm ci + restart process

> [!WARNING]
> **Ce que la mise à jour en un clic vous coûte, et comment y renoncer**
>
> Pour se reconstruire elle-même, l'instance Docker monte deux choses que le `docker-compose.yml` fourni déclare : le **socket Docker de l'hôte** (`/var/run/docker.sock`) et le **code source en écriture** (`.:/host-app`).
>
> Il faut le dire franchement : l'accès en écriture au socket Docker équivaut à un accès root sur la machine hôte. Ce n'est pas un défaut, c'est le prix de la fonctionnalité — mais c'est un prix qui doit être choisi, pas subi. Concrètement, toute exécution de code à l'intérieur du conteneur devient une compromission de l'hôte, et le montage du code en écriture permet de modifier les sources qui seront reconstruites à la mise à jour suivante.
>
> **Vous n'en avez pas besoin** si vous mettez Quasar à jour à la main (`git pull` puis `docker compose up -d --build`), ce qui est parfaitement raisonnable. Dans ce cas, retirez les deux volumes de votre `docker-compose.yml` : l'updater détecte l'absence et répond proprement que la configuration est incomplète, sans rien casser d'autre. Le bouton reste affiché, il refuse simplement de s'exécuter.
>
> Pour information, l'instance publique de Venacity tourne **sans** ces montages.

> **Arrêt propre** — Sur `SIGTERM` (redéploiement Docker, `docker compose down`, systemd) comme sur `SIGINT` (Ctrl+C), Quasar draine dans l'ordre : serveur HTTP, boucles des modules, client Discord, puis base de données, avec un délai maximum de 15 secondes au-delà duquel il sort quand même. C'est ce qui évite qu'un redéploiement coupe une notification de violation de données entre l'envoi du message privé et son marquage en base — la personne concernée la recevrait alors une seconde fois. La mise à jour native emprunte ce même chemin, et suppose donc un superviseur qui relance le processus (`restart: always` en Docker, ou systemd).

> **Instances installées avant le renommage du dépôt** — le dépôt s'appelait `venaciteam/quasar-discord`. GitHub redirige les opérations `git` et les liens vers le nouveau nom : les instances existantes continuent de se mettre à jour sans rien faire. Pour aligner votre clone malgré tout : `git remote set-url origin https://github.com/venaciteam/quasar.git`.

---

## 🏗️ Stack

- **Node.js 22**
- **discord.js v14** — mais uniquement dans l'adaptateur Discord : plus aucun fichier de logique métier ne l'importe
- **Client Fluxer maison** — passerelle et REST écrits sur les `WebSocket` et `fetch` natifs de Node, **aucune dépendance ajoutée**
- **Express** (API + dashboard)
- **SQLite** via better-sqlite3 (données persistées en volume Docker)
- HTML/CSS/JS vanilla (dashboard — pas de framework)

---

## 📂 Structure du projet

```
quasar/
├── index.js              # Point d'entrée
├── setup.sh              # Script d'installation
├── bot/
│   ├── platform/         # LA couche d'adaptation : contrat neutre, registre de
│   │   ├── discord/      #   commandes, puis un dossier par plateforme. Rien
│   │   └── fluxer/       #   au-dessus ne sait sur laquelle il tourne
│   ├── commands/         # 26 descripteurs de commandes, aucun import de plateforme
│   ├── events/           # Handlers d'événements, au vocabulaire neutre
│   ├── interactions/     # Panneaux attachés à une commande
│   ├── panneaux/         # Panneaux sans commande (arbitrage des sanctions)
│   ├── modules/          # Modules à part entière : antiraid, defer (arbitrage),
│   │                     #   breach (violation de données), erasure (effacement),
│   │                     #   retention (conservation et purge), scheduler
│   └── utils/            # Utilitaires partagés
├── api/
│   ├── routes/           # Routes API REST
│   ├── middleware/        # Auth JWT
│   └── services/         # Database SQLite
├── dashboard/
│   ├── index.html        # Login page
│   ├── app.html          # Dashboard SPA
│   ├── js/               # Frontend logic
│   └── css/              # Styles
├── public/               # Vitrine publique du projet
│   └── partials/         # Chrome mutualisé (header, menu, scripts)
├── content/              # Seed du journal des nouveautés
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── LICENSE               # AGPL-3.0
├── NOTICE                # Noms et marques (non couverts par la licence)
└── data/                 # Volume Docker (SQLite + nouveautes.json)
```

> **Un module inerte reste dans le dépôt.** La lecture audio a été coupée en v3.2.0 : `bot/modules/music/` et trois fichiers de commandes sont toujours là, mais rien ne tournerait en l'état — les commandes ne sont plus déployées ([`bot/utils/disabledCommands.js`](bot/utils/disabledCommands.js)), `ffmpeg` et `yt-dlp` ne sont plus installés dans l'image, et les dépendances npm de lecture audio ne sont plus dans `package.json`. Pour la remettre sur ton fork, la marche à suivre est en commentaire dans `disabledCommands.js` et en tête du [`Dockerfile`](Dockerfile) ; les dépendances npm sont à réinstaller en plus.

Le dépôt contient à la fois le bot avec son dashboard, et la vitrine publique du projet (`public/`) — les deux vivaient auparavant dans deux dépôts séparés. Ce qu'un déploiement sert dépend de la variable `QUASAR_MODE` :

- `bot` (défaut) — bot + dashboard, le cas de l'auto-hébergement ;
- `site` — vitrine seule, sans bot ni base de données ;
- `public` — instance publique : bot, dashboard et vitrine.

Le mode décide de ce qui démarre et de ce qui est servi, rien de plus. Il est **indépendant de `QUASAR_PLATFORM`** : le mode dit quoi démarrer, la plateforme dit à quoi se connecter. Les deux se combinent librement. L'affichage de la carte « Sans rien installer » sur la vitrine relève d'une variable distincte, `PUBLIC_INSTANCE_OPEN` (défaut : `false`), qui ne change pas l'accessibilité du dashboard lui-même : quand elle est fermée, la carte est retirée du HTML servi et l'accueil n'affiche que l'autohébergement.

Pour un auto-hébergeur, rien ne change : sans cette variable, Quasar démarre en mode `bot`, et la vitrine n'est pas servie du tout.

### Les pages de la vitrine

| URL | Contenu |
|---|---|
| `/` | Accueil : les deux façons d'utiliser Quasar, l'argument « premium sans palier », les engagements sur la vie privée |
| `/ethique` | Ce que Quasar fait des données, et ce qu'il n'en fait pas — détaillé par mode d'hébergement |
| `/pourquoi` | Un mot de la créatrice, et l'origine du nom |
| `/nouveautes` | Le journal des mises à jour (voir ci-dessous) |
| `/soutenir` | Participer aux frais de l'instance publique |

Toutes partagent le chrome du design system Venacity — en-tête flottant, menu « … », bascule de thème — mutualisé dans `public/partials/`. Les liens légaux vivent dans ce menu : le pied de page a été retiré avec le chrome historique du design system.

### Le journal des nouveautés

La page `/nouveautes` lit `data/nouveautes.json`, sur le volume persistant. Le fichier est alimenté **à chaud** par une API d'administration : publier une note de version ne demande aucun redéploiement.

| Route | Effet |
|---|---|
| `GET /api/admin/nouveautes` | Liste les entrées, de la plus récente à la plus ancienne |
| `POST /api/admin/nouveautes` | Publie un bloc markdown. Corps : `{ "block": "## 🌌 Quasar — vX.Y.Z\n### Titre\n> *JJ mois AAAA*\n\n- …" }` |
| `DELETE /api/admin/nouveautes/:id` | Retire une entrée (l'`id` est renvoyé par les deux routes ci-dessus) |

L'authentification se fait par clé d'API, en en-tête `X-API-Key` (ou `Authorization: Bearer`). **Sans `QUASAR_ADMIN_API_KEY`, ces routes répondent 503** : rien n'est publiable par défaut.

Publier deux fois le même bloc ne crée pas de doublon : l'entrée est identifiée par le couple (date + version), donc re-poster une version corrigée le même jour remplace la précédente.

> **Le piège à connaître.** Le fichier `content/nouveautes.md` versionné dans le dépôt n'est qu'une **amorce** : il initialise l'historique au tout premier démarrage sur un volume neuf, et **n'est plus jamais relu ensuite**. Sur une instance déjà déployée, l'éditer ne publie strictement rien — seule la route `POST /api/admin/nouveautes` alimente le journal. Modifier le fichier en croyant publier, puis chercher pourquoi la page ne bouge pas, est l'erreur la plus coûteuse de cette partie.

Le même journal alimente le **pop-up des nouveautés** du dashboard : au premier accès suivant une mise à jour, il s'ouvre pour présenter ce qui a changé. L'entrée « Nouveautés » de la barre latérale le rouvre à volonté. La version déjà vue est mémorisée dans le navigateur (`localStorage`) et nulle part ailleurs — pas de table associant un identifiant Discord à un numéro de version pour un simple confort d'affichage. Contrepartie assumée : le pop-up réapparaît sur un autre navigateur.

---

## 🔐 Données et conservation

Quasar manipule des données personnelles : identifiants Discord, motifs de sanction, conversations de tickets. Voici ce qu'il en fait — et ce qu'il n'en fait pas.

### Qui est responsable de quoi

Si tu héberges Quasar, **tu es responsable des données** qu'il stocke sur ta machine. Venacity écrit le logiciel, elle n'a accès à rien : Quasar ne contacte aucun service tiers pour fonctionner, et la télémétrie a été retirée en v3.3.0.

Sur une instance ouverte à des serveurs tiers, chaque administrateur de serveur reste responsable des données de son propre serveur ; l'hébergeur de l'instance agit pour son compte.

### Le contrat de sous-traitance

Dès qu'une instance est ouverte à des serveurs tiers, l'article 28 du RGPD impose un **contrat écrit** entre l'hébergeur de l'instance (sous-traitant) et chaque administrateur qui y connecte son serveur (responsable de traitement). Quasar embarque le mécanisme : écran bloquant à la première connexion, case à cocher **jamais pré-cochée**, et enregistrement de qui a accepté quoi et quand — identifiant Discord, horodatage, version. Une nouvelle version du contrat redemande l'acceptation.

> ⚠️ **Ce mécanisme ne s'active qu'en `QUASAR_MODE=public`.** En auto-hébergement (`bot`, le défaut), aucun contrat n'est demandé : tu es seul opérateur de ton instance, tu n'as personne avec qui contracter.
>
> Si tu ouvres **ta propre** instance à des administrateurs tiers, tu as le même besoin juridique — mais avec **ton** contrat, pas celui de Venacity. Publie-le et pointe `CONTRACT_PUBLIC_URL` dessus, puis remplace le texte servi en repli (`dashboard/legal/contrat.html`) et les constantes de `api/services/contract.js`. Le contrat livré nomme explicitement Venacity comme sous-traitant : il ne vaut que pour son instance. La licence AGPL-3.0 te donne le droit de l'adapter.

### Notification d'une violation de données

L'article 33 du RGPD impose au sous-traitant de prévenir le responsable de traitement sans délai. Quasar fournit le canal : le propriétaire de l'instance (`BOT_OWNER_ID`) rédige librement le message depuis le dashboard — avec un aide-mémoire des mentions à ne pas oublier —, le **prévisualise**, puis **confirme explicitement** l'envoi. Rien ne part avant cette confirmation. Une notification peut être adressée **par étapes** : un premier message dès la connaissance de l'incident, des compléments ensuite.

La diffusion emprunte trois canaux, pour ne pas dépendre d'un seul point de défaillance : **message privé** aux administrateurs ; à défaut, un **avis neutre dans le salon de logs** — sans aucun détail de l'incident, il renvoie vers les messages privés et le dashboard ; et un **bandeau dans le dashboard**, qui ne dépend pas de Discord. Chaque envoi est journalisé, **y compris ceux qui échouent** : savoir qui n'a pas été prévenu fait partie de l'obligation.

### Demandes de suppression

Un membre peut demander l'effacement de ses données avec `/mes-donnees`. La demande n'est pas tranchée par l'hébergeur : elle est **routée à l'administrateur du serveur**, seul responsable de traitement et seul à pouvoir décider. Le traitement se fait **par catégorie** — une sanction encore en vigueur peut être conservée avec un refus motivé, une sanction expirée doit être effacée, le reste s'efface sans discussion. La décision et sa motivation sont conservées, et un rappel est émis avant l'échéance légale d'un mois.

Quand l'effacement porte sur la modération, il emporte aussi les traces laissées hors de l'historique des sanctions :

- les **cas d'arbitrage** qui nomment la personne sont effacés **sans condition**, y compris ceux encore en attente — ce n'est pas une sanction, seulement une proposition soumise à l'équipe. Le message reste affiché dans le salon d'arbitrage, mais ses boutons répondent « cas introuvable » ;
- les **bannissements temporaires échus** sont effacés, les **bannissements encore en cours sont conservés**.

Ce dernier point est un arbitrage explicite, pas un oubli. La ligne d'un bannissement temporaire est ce qui porte sa **levée automatique** : l'effacer transformerait un bannissement de sept jours en bannissement définitif, au détriment exact de la personne qui demande l'effacement. C'est la même logique que pour les bannissements déjà en vigueur, et l'article 17.3 du RGPD couvre cette conservation.

### Suspendre un serveur

Le propriétaire de l'instance peut **couper Quasar sur un serveur précis**, sans toucher aux autres. La suspension ne supprime aucune donnée et ne retire pas le bot du serveur : c'est un drapeau réversible. Elle permet de refuser un usage sans fermer le service pour tout le monde. Un compteur des serveurs connectés est affiché à côté, pour repérer un changement d'échelle.

### Ce qui est conservé, et combien de temps

| Donnée | Conservation |
|--------|--------------|
| Sanctions (membre, modérateur, motif) | **12 mois par défaut**, réglable par serveur dans le dashboard. Les bannissements encore en vigueur ne sont jamais supprimés |
| Conversations de tickets | **Jamais stockées.** Le transcript est envoyé en pièce jointe dans Discord à la fermeture, puis oublié |
| Configurations, embeds, rôles, rappels | Tant que le bot est sur le serveur |
| Préférences de salons vocaux temporaires | 90 jours après la dernière utilisation |
| Cas d'arbitrage (membre visé, motif, sanction proposée) | Tant que le bot est sur le serveur. **Le message incriminé n'est jamais copié en base** : la preuve est un lien vers Discord, affiché dans l'embed |
| Bannissements temporaires en attente de levée | Jusqu'à leur échéance, puis effacés par le balayage qui lève le bannissement |
| Règles AutoMod | Seul un **miroir** est gardé (identifiant, salon de logs, état). Les mots, expressions et actions vivent chez Discord, qui en est la source de vérité, et sont relus chez lui à chaque affichage |
| Toutes les données d'un serveur | **Supprimées 7 jours après le retrait du bot** (délai réglable). Réinviter le bot avant l'échéance annule la suppression |

La purge d'un serveur emporte bien tout ce que la modération automatique a écrit — règles, paliers d'escalade, anti-raid, salon piège, cas d'arbitrage, bannissements temporaires. Ce n'est pas une question de propreté : un cas d'arbitrage nomme la personne visée, le laisser derrière serait un manquement.

La durée de conservation des sanctions sert aussi de fenêtre à l'escalade par avertissements : un avertissement trop ancien pour être conservé ne compte plus dans le déclenchement du palier suivant. Un seul réglage commande les deux, pour éviter qu'une sanction supprimée continue à produire ses effets.

### Les transcripts de tickets

À la fermeture d'un ticket, le salon Discord est supprimé. Si Quasar gardait le transcript en base, sa base deviendrait la seule copie subsistante d'une conversation privée.

Le transcript est donc **remis dans Discord** — dans le salon de logs, ou en message privé au modérateur qui ferme — et **rien n'est écrit en base**. Si aucune des deux voies n'aboutit, la fermeture est refusée : mieux vaut un ticket qui reste ouvert qu'une conversation perdue.

### Garder le signalement accessible

`/signaler` est ouverte à tous les membres, sans permission particulière. Mais son accès dépend de la permission Discord **« Utiliser les commandes d'application »**, que l'administrateur du serveur contrôle — au niveau du rôle `@everyone`, du salon, ou dans Paramètres du serveur → Intégrations.

Autrement dit : **le canal de signalement peut être coupé par la personne même qu'on voudrait pouvoir signaler.** C'est une limite de la plateforme, pas quelque chose que le bot peut empêcher.

Sur Fluxer, la coupure prend une autre forme : `!signaler` est un message ordinaire, il n'existe donc aucune permission dédiée à retirer — mais un salon où le bot ne voit pas les messages, ou un membre à qui l'écriture est refusée, produit le même résultat. Le contournement ci-dessous vaut pour les deux plateformes.

Le contournement tient en une ligne, à mettre dans la **description de ton application** — sur le Developer Portal côté Discord (onglet General Information), dans la biographie du compte du bot côté Fluxer, qui tient lieu de description d'application. Elle s'affiche sur le profil du bot depuis n'importe quel serveur, et aucun administrateur ne peut la masquer :

```
Un problème avec ce bot, ou avec l'usage qui en est fait sur un serveur ?
Utilise /signaler, ou écris à <ton contact> si la commande n'est pas accessible.
```

Remplace `<ton contact>` par une adresse que tu relèves réellement. Sans ça, un membre dont le serveur a bloqué les commandes n'a plus aucun moyen de te joindre.

### Où partent les signalements

`/signaler` distingue deux cas, parce qu'ils ne concernent pas les mêmes personnes :

- **Bug du logiciel** → chez qui développe Quasar (`REPORT_RELAY_URL`, par défaut Venacity). Contenu transmis : ta description, le contact que tu indiques si tu en donnes un, la version du bot.
- **Abus d'usage** → chez l'hébergeur de l'instance (`ABUSE_REPORT_URL`). **Vide par défaut** : sans configuration explicite, aucun signalement d'abus ne quitte ton instance, et la commande oriente vers les administrateurs du serveur, vers toi, et vers Discord.

Un abus commis sur l'instance de quelqu'un d'autre ne remonte donc jamais chez Venacity — elle n'aurait aucun moyen d'agir dessus, et ça ne la regarde pas.

---

## 📝 Licence

**GNU Affero General Public License v3.0** (AGPL-3.0) — texte intégral dans [LICENSE](LICENSE).

Tu peux utiliser, modifier et redistribuer Quasar librement. En contrepartie, deux obligations :

- Si tu redistribues Quasar, modifié ou non, tu le fais sous la même licence, code source inclus.
- **Si tu héberges Quasar et que des personnes utilisent son dashboard à distance, tu dois leur proposer le code source de ta version** — y compris tes modifications. C'est la clause réseau (article 13), la différence entre l'AGPL et la GPL classique.

Concrètement, pour un auto-hébergeur : si ton dashboard n'est accessible qu'à toi sur ta machine, tu n'as rien à faire. Si tu l'ouvres à d'autres et que tu as modifié le code, publie ton dépôt et renseigne `INSTANCE_SOURCE_URL`. Le lien apparaît alors dans le **badge de version**, présent sur toutes les pages du dashboard, y compris avant connexion : il se lit sans avoir à cliquer où que ce soit, ce qu'exige l'article 13.

### Noms et logos

L'AGPL couvre le **code**, pas le **nom**. Les noms « Venacity » et « Quasar », ainsi que les logos associés, ne sont pas concédés par la licence — l'article 7(e) de l'AGPL-3.0 prévoit expressément cette réserve.

Tu peux dire que ton service fonctionne avec Quasar. Tu ne peux pas te présenter comme Venacity, ni laisser croire que ton instance est opérée par Venacity : le champ `INSTANCE_OPERATOR_NAME` existe précisément pour dire aux administrateurs de serveurs à qui ils confient les données de leurs membres.

Si tu publies une version modifiée, donne-lui ton propre nom. Détail dans [NOTICE](NOTICE).

> La seule instance opérée par Venacity est [quasar.vena.city](https://quasar.vena.city). Toute autre instance est opérée par un tiers, sous sa propre responsabilité.

---

*Créé par [Venacity](https://vena.city)*
