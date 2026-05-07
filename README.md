# 🌌 Quasar — Bot Discord Self-Hosted

> Toutes les fonctionnalités premium d'un bot Discord — modération, tickets, musique, reaction roles, embeds, TempVoice et dashboard web. 100% self-hosted, open source, 0 abonnement.

![Quasar Dashboard Preview](dashboard/img/preview.png)

---

## ✨ Features

| Module | Description |
|--------|-------------|
| 🛡️ **Modération** | Warn, mute, kick, ban, clear, logs automatiques, sanctions auto |
| 👋 **Welcome / Leave** | Messages de bienvenue et départ avec embed + avatar |
| 🎭 **Reaction Roles** | Panels avec emojis, mode unique ou multiple, toggle au clic |
| ✅ **Autoroles** | Rôles attribués automatiquement à l'arrivée |
| 🔊 **Rôles vocaux** | Rôle donné en vocal, retiré à la déconnexion |
| 📝 **Embeds Custom** | Créer, sauvegarder et envoyer des embeds personnalisés |
| ⚡ **Commandes Custom** | Commandes personnalisées avec texte ou embed |
| 🎫 **Tickets** | Système de tickets avec transcripts, panel personnalisable |
| 🎵 **Musique** | Play depuis YouTube, Spotify, Apple Music, Deezer et + |
| 🔊 **TempVoice** | Salons vocaux temporaires avec boutons interactifs |
| 🌐 **Dashboard Web** | Tout configurer depuis un navigateur — thème clair/sombre |
| ⬆ **Auto-update** | Mise à jour en un clic depuis le dashboard avec logs temps réel |

---

## 🚀 Quick Start

### Prérequis
- [Docker](https://docs.docker.com/get-docker/) installé
- Une application bot Discord ([Developer Portal](https://discord.com/developers/applications))

### Installation en une commande

```bash
curl -sSL https://raw.githubusercontent.com/venaciteam/quasar-discord/main/install.sh | bash
```

Ou manuellement :

```bash
git clone https://github.com/venaciteam/quasar-discord.git
cd quasar-discord
./setup.sh
```

Le script te guide : il demande tes identifiants Discord, crée le `.env`, le volume Docker, build et lance le bot. C'est tout.

### Installation manuelle

<details>
<summary>Voir les étapes manuelles</summary>

#### 1. Cloner le repo

```bash
git clone https://github.com/venaciteam/quasar-discord.git
cd quasar-discord
```

#### 2. Configurer

```bash
cp .env.example .env
```

Édite le fichier `.env` avec tes informations :

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Token du bot (onglet Bot du Developer Portal) |
| `DISCORD_CLIENT_ID` | Client ID (onglet OAuth2) |
| `DISCORD_CLIENT_SECRET` | Client Secret (onglet OAuth2) |
| `CALLBACK_URL` | URL de callback OAuth2 — utilise l'IP locale du serveur (ex: `http://192.168.1.100:3000/callback`) |
| `JWT_SECRET` | Chaîne aléatoire pour signer les JWT (génère avec `openssl rand -hex 32`) |
| `PORT` | Port du dashboard (défaut: `3000`) |
| `BOT_OWNER_ID` | Ton ID Discord — active les fonctions admin dans le dashboard (gestion du statut du bot). Pour le trouver : active le mode développeur dans Discord → clic droit sur ton profil → Copier l'identifiant |
| `FEEDBACK_WEBHOOK_URL` | Webhook Discord pour recevoir les bugs/suggestions (optionnel) |

> **💡 Accès réseau local** — Utilise l'IP de ta machine (ex: `http://192.168.1.100:3000/callback`) pour accéder au dashboard depuis n'importe quel appareil sur ton réseau. L'IP locale est affichée dans les logs au démarrage du bot. N'oublie pas d'ajouter cette URL dans le Developer Portal (OAuth2 → Redirects). Pour un accès distant via Internet, utilise un reverse proxy HTTPS (Cloudflare Tunnel, Nginx, Caddy…).

#### 3. Configurer le bot Discord

Sur le [Developer Portal](https://discord.com/developers/applications) :

**Onglet Bot** — Active les 3 Privileged Gateway Intents :
- ✅ Presence Intent
- ✅ Server Members Intent
- ✅ Message Content Intent

**Onglet OAuth2 → Redirects** — Ajoute ton callback URL (la même que dans `.env`, ex: `http://192.168.1.100:3000/callback`).

#### 4. Créer le volume et lancer

```bash
docker volume create quasar-data
docker compose up -d
```

Le bot est en ligne. L'adresse du dashboard (locale + réseau) s'affiche dans les logs : `docker logs quasar`.

</details>

### Configurer le bot Discord

Sur le [Developer Portal](https://discord.com/developers/applications) :

**Onglet Bot** — Active les 3 Privileged Gateway Intents :
- ✅ Presence Intent
- ✅ Server Members Intent
- ✅ Message Content Intent

**Onglet OAuth2 → Redirects** — Ajoute ton callback URL (la même que dans `.env`, ex: `http://192.168.1.100:3000/callback`).

### Inviter le bot

Sur le Developer Portal → **OAuth2 → URL Generator** :
- Scopes : `bot` + `applications.commands`
- Permissions : `Administrator`
- Copie l'URL et ouvre-la pour inviter le bot sur ton serveur

---

## 🍓 Raspberry Pi

Quasar tourne confortablement sur un **Raspberry Pi 4** (2 Go minimum). La stack est légère : Node.js + SQLite, pas de base de données externe.

```bash
curl -sSL https://raw.githubusercontent.com/venaciteam/quasar-discord/main/install.sh | bash
```

> **Note :** Le build initial peut prendre quelques minutes sur Pi (compilation des modules natifs comme `better-sqlite3` et `sodium-native`).

---

## 🔧 Commandes

<details>
<summary>Voir toutes les commandes (32)</summary>

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

### Musique
| Commande | Description |
|----------|-------------|
| `/play [lien ou recherche]` | Jouer une musique |
| `/pause` `/resume` `/skip` `/stop` | Contrôles de lecture |
| `/queue` `/np` | File d'attente et piste en cours |
| `/disconnect` | Déconnecter du vocal |
| `/music setchannel/removechannel/status` | Config du salon musique |

### Utilitaire
| Commande | Description |
|----------|-------------|
| `/ping` | Latence du bot |

</details>

---

## ⬆ Mise à jour

Quasar vérifie automatiquement les nouvelles versions sur GitHub. Quand une mise à jour est disponible, un bandeau apparaît dans le dashboard. Clique sur "Mettre à jour" pour lancer le processus avec un terminal temps réel. En cas d'échec, un rollback automatique restaure la version précédente.

Le système supporte les deux modes de déploiement :
- **Docker** : git pull + rebuild image + restart container
- **Natif** : git pull + npm ci + restart process

---

## 🏗️ Stack

- **Node.js 22** + **discord.js v14**
- **Express** (API + dashboard)
- **SQLite** via better-sqlite3 (données persistées en volume Docker)
- **yt-dlp** + **ffmpeg** (musique)
- **Odesli API** (conversion de liens musicaux cross-plateforme)
- HTML/CSS/JS vanilla (dashboard — pas de framework)

---

## 📂 Structure du projet

```
quasar-discord/
├── index.js              # Point d'entrée
├── setup.sh              # Script d'installation
├── bot/
│   ├── commands/         # Commandes slash (32)
│   ├── events/           # Event handlers Discord
│   ├── interactions/     # Button/select handlers
│   ├── modules/          # Modules complexes (musique)
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
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── data/                 # Volume Docker (SQLite)
```

---

## 📝 Licence

MIT — fais-en ce que tu veux.

---

*Créé par [Venacity](https://vena.city)*
