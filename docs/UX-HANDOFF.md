# 🌌 Quasar — Hand-off améliorations UX

> Document de passation préparé en session « recherche & réflexion ».
> Objectif : permettre d'implémenter au propre, dans une session dédiée, les pistes
> d'amélioration UX validées — sans avoir à re-faire l'analyse.
>
> Les **bugs / incohérences rapides** (versions, faute FR, double-script auth, wording
> self-hosted, self-XSS) sont suivis séparément dans les **issues GitHub #1 à #5** et ne
> sont pas repris ici.

---

## Vue d'ensemble & priorisation

| # | Chantier | Impact | Effort | Priorité |
|---|----------|--------|--------|----------|
| 1 | Toggle d'activation des modules depuis la Vue d'ensemble | 🟢 Élevé | 🟢 Faible | **P0** |
| 2 | Généraliser le preview live + insertion de variables | 🟢 Élevé | 🟡 Moyen | **P0** |
| 3 | Garde-fou « modifications non enregistrées » | 🟡 Moyen | 🟢 Faible | **P1** |
| 4 | Résolution des IDs → pseudo/avatar dans les logs | 🟡 Moyen | 🟡 Moyen | **P1** |
| 5 | Onboarding guidé (checklist post-install) | 🟡 Moyen | 🟡 Moyen | **P1** |
| 6 | Panneau Musique interactif (now playing + queue + contrôles) | 🟢 Élevé | 🔴 Élevé | **P2** |
| 7 | Backup / restore de la config | 🟡 Moyen | 🟡 Moyen | **P2** |
| 8 | Stats / analytics légères | 🟡 Moyen | 🔴 Élevé | **P3** |
| 9 | Internationalisation (FR / EN) | 🟢 Élevé | 🔴 Élevé | **P3** |

**Ordre d'attaque conseillé pour une première session :** 1 → 2 → 3 (gros gain, faible/moyen
effort, peu de risque), puis 4 et 5. Garder 6, 7, 8, 9 pour des sessions ultérieures.

---

## 1. Toggle d'activation des modules depuis la Vue d'ensemble — **P0**

### Pourquoi
Aujourd'hui les cartes de la Vue d'ensemble affichent un badge `Actif / Inactif`, mais on ne
peut **pas** activer/désactiver un module depuis là : il faut entrer dans chaque page. Pire,
l'état affiché est **déduit** de la présence de données en base, pas piloté explicitement.

### État actuel du code
- `dashboard/js/app.js:589` `loadOverview()` → rend les `module-card` (clic = navigation).
- `api/routes/guilds.js:28` `GET /:guildId/modules` → calcule `enabled` en comptant les lignes
  des tables liées (sanctions, panels, embeds…). **Ne lit pas** un flag explicite pour la
  plupart des modules.
- `api/routes/guilds.js:68` `PUT /:guildId/modules/:moduleName` → **existe déjà** et écrit un flag
  `enabled` dans la table `modules` (upsert). Il n'est simplement **pas câblé** côté front, et le
  GET ne le relit pas.

### Le point subtil à régler
Il faut **réconcilier** « état déduit » et « état explicite ». Deux options :

- **A (rapide, recommandée pour démarrer) :** garder la détection auto comme valeur par défaut,
  mais laisser un override explicite dans la table `modules`. Le GET renvoie
  `enabled = override ?? détectionAuto`. Un toggle OFF explicite doit aussi **désactiver le
  comportement côté bot** (sinon le module reste actif fonctionnellement).
- **B (plus propre, plus long) :** migrer vers un flag explicite par module comme source de
  vérité unique, avec valeur initiale = détection auto au premier chargement.

> ⚠️ Un toggle qui change juste le badge sans gater le comportement du bot serait trompeur.
> Vérifier où chaque module est consommé côté `bot/` (events / commandes) et y ajouter le
> check `enabled`. Commencer par les modules à effet de bord visible (welcome, tickets,
> tempvoice, reactionroles).

### Étapes
1. Ajouter un `<label class="toggle">` (composant déjà stylé, cf. `welcome.js`) dans chaque
   `module-card` de `loadOverview()`, sans déclencher la navigation au clic sur le toggle
   (`event.stopPropagation()`).
2. `onchange` → `API.put('/api/guilds/${id}/modules/${key}', { enabled })` + toast.
3. Faire relire le flag par `GET /:guildId/modules` (option A ou B).
4. Câbler le check `enabled` dans les handlers `bot/` concernés.

---

## 2. Généraliser le preview live + insertion de variables — **P0**

### Pourquoi
L'embed builder (`embeds.js`) a un superbe aperçu temps réel. Mais **Welcome/Leave**, **Rappels**
et **Commandes custom** — qui construisent eux aussi des messages/embeds avec variables
(`{user}`, `{server}`, `{membercount}`…) — n'ont **aucun aperçu**, et il faut **mémoriser** les
variables. C'est le frein n°1 à la prise en main.

### État actuel du code
- `dashboard/js/pages/embeds.js:86` `parseDiscordMd()` + `:100` `updatePreview()` → logique de
  rendu réutilisable, mais **locale à la page embeds**.
- `dashboard/js/pages/welcome.js` → construit titre/desc/couleur/thumbnail **sans** preview.
- `dashboard/js/pages/scheduled.js`, `customcmds.js` → même schéma, sans preview.

### Étapes
1. **Extraire** `parseDiscordMd` + le template de rendu d'aperçu dans un util partagé
   (ex : `dashboard/js/discordPreview.js`), chargé avant les pages dans `app.html`.
   ⚠️ En profiter pour **échapper le HTML en entrée** (cf. issue #5) une bonne fois pour toutes.
2. Réutiliser cet aperçu dans `welcome.js`, `scheduled.js`, `customcmds.js`.
3. Ajouter une **barre de variables** : petits boutons (`{user}`, `{server}`, `{membercount}`…)
   qui insèrent le token à la position du curseur dans le `<textarea>` ciblé
   (`selectionStart/selectionEnd`). Brancher un `oninput` sur les champs pour rafraîchir l'aperçu.
4. Pour l'aperçu Welcome/Leave : substituer des **valeurs d'exemple** aux variables
   (`{user}` → mention factice, `{membercount}` → ex. `42`) pour un rendu réaliste.

---

## 3. Garde-fou « modifications non enregistrées » — **P1**

### Pourquoi
Les formulaires ne sauvent qu'au clic sur « Enregistrer ». Changer de page (sidebar / retour
mobile) **perd silencieusement** les modifs. Frustrant.

### État actuel du code
- Navigation centralisée dans `dashboard/js/app.js:349` `loadPage()`.
- Les pages utilisent des boutons « Enregistrer » explicites (pas d'autosave).

### Étapes
1. Maintenir un état `dirty` (un module config a changé depuis le dernier load/save). Le plus
   simple : marquer `dirty = true` sur le premier `input`/`change` d'un champ de config, le
   remettre à `false` après un save réussi.
2. Dans `loadPage()`, si `dirty` et qu'on change de page → `confirm()` (ou mieux, une petite
   modale du design system) « Modifications non enregistrées, continuer ? ».
3. Bonus : indicateur visuel (point/pastille sur le bouton « Enregistrer ») quand `dirty`.
4. Bonus : `window.onbeforeunload` si `dirty` pour la fermeture d'onglet.

---

## 4. Résolution des IDs → pseudo / avatar — **P1**

### Pourquoi
L'historique des sanctions affiche des **ID Discord bruts** (`moderation.js:144`,
`<code>${s.user_id}</code>`) au lieu de pseudo + avatar. Illisible.

### État actuel du code
- `api/routes/guilds.js` expose déjà `/:guildId/channels`, `/roles`, `/emojis` via le cache du
  client Discord — **mais pas de résolveur de membres/users.**
- `bot/` a accès à `guild.members.cache` et au client Discord (`req.app.get('discordClient')`).

### Étapes
1. Ajouter un endpoint de résolution, ex. `GET /:guildId/members/resolve?ids=a,b,c` qui renvoie
   `{ id, username, avatar }` (cache d'abord, `fetch` en fallback, gérer les membres partis).
2. Dans `moderation.js` (`loadSanctions`), résoudre les `user_id` (et `moderator_id` si affiché)
   en pseudo + avatar.
3. Mutualiser : un petit composant « pastille membre » (avatar + nom) réutilisable partout où on
   affiche un ID (tickets, logs…).
4. Penser au cache front (Map id→user) pour éviter de re-résoudre en boucle.

---

## 5. Onboarding guidé — checklist post-install — **P1**

### Pourquoi
Le premier setup est aujourd'hui un « débrouille-toi dans les modules ». Une checklist guide
l'utilisateur et augmente le taux de configuration réussie.

### État actuel du code
- `dashboard/js/app.js:589` `loadOverview()` est l'emplacement naturel.
- Données déjà disponibles : `GET /:guildId/modules` (état des modules), `/api/presence` (owner),
  `/api/version`.

### Étapes
1. En tête de Vue d'ensemble, afficher une carte « Prise en main » avec une checklist calculée :
   - ✅ Bot en ligne (implicite si on est ici)
   - ☐ Channel de logs défini ? (modération)
   - ☐ Message de bienvenue configuré ?
   - ☐ Au moins un module activé ?
2. Chaque item = lien direct vers la page concernée.
3. Masquer la carte quand tout est coché (ou bouton « ne plus afficher », stocké en localStorage
   ou en `guilds.settings`).

---

## 6. Panneau Musique interactif — **P2** (gros chantier, fort effet « wow »)

### Pourquoi
Tout se pilote au dashboard… sauf la musique : la page actuelle (`app.js:637` `loadMusic`) n'est
qu'une **liste de commandes en lecture seule**. C'est l'incohérence la plus visible, et un vrai
panneau « Now Playing » serait le différenciant n°1 du produit.

### État actuel du code
- Moteur audio : `bot/modules/music/player.js`, `queue.js`, `resolver.js` (@discordjs/voice).
- **Aucune route API musique** n'existe encore.
- Précédent utile : l'auto-update utilise déjà **SSE** (`api/routes/update.js`) → réutilisable
  pour pousser l'état de lecture en temps réel.

### Étapes (incrémental)
1. **Exposer l'état** : que `bot/modules/music` tienne un état par guild (piste courante,
   position, queue, statut) accessible depuis l'API.
2. **Route API** `api/routes/music.js` :
   - `GET /:guildId/music/state` (now playing + queue)
   - `POST /:guildId/music/{pause|resume|skip|stop}`
   - `PUT /:guildId/music/volume`
   - éventuellement réordonner / retirer de la queue.
3. **Front** : remplacer `loadMusic()` par un vrai panneau (pochette, titre, barre de
   progression, boutons, liste de queue). Rafraîchir via **SSE** (idéal) ou polling léger.
4. **Garde-fous** : n'autoriser les contrôles que si l'admin est dans le bon vocal / le bot joue ;
   gérer le cas « rien en lecture ».

---

## 7. Backup / restore de la config — **P2**

### Pourquoi
Rassurant pour du self-hosted, et facilite la migration entre machines. Déjà listé dans les
*Ideas* de la `ROADMAP.md`.

### État actuel du code
- Tout est en **SQLite** (`api/services/database.js`), pas de dépendance externe → export simple.

### Étapes
1. `GET /:guildId/backup` → exporte en JSON les tables de config du guild (modules, welcome,
   embeds, custom_commands, reaction_panels, tickets, scheduled_messages, settings…).
2. `POST /:guildId/restore` → réimporte (avec validation + idéalement un mode « dry-run » ou un
   diff avant écrasement).
3. Front : page « Système » → boutons Exporter (download `.json`) / Importer (upload + confirm).
4. Penser au **versionnage du format** d'export (champ `schemaVersion`) pour les migrations.

---

## 8. Stats / analytics légères — **P3**

### Pourquoi
Donne une **raison de revenir** sur le dashboard (messages, joins/leaves, sanctions dans le
temps). La Vue d'ensemble est l'emplacement parfait.

### Points d'attention
- Nécessite de **stocker des compteurs/événements** (nouvelle(s) table(s), agrégation par
  jour/semaine). Surveiller l'empreinte disque sur Raspberry Pi → privilégier des agrégats, pas
  un log d'événements brut illimité (rotation / rétention).
- Réutiliser les events déjà écoutés côté `bot/events/` (guildMemberAdd/Remove, messages…).
- Front : quelques sparklines / chiffres clés, sans librairie lourde (cohérent avec le parti pris
  « vanilla, pas de framework »).

---

## 9. Internationalisation FR / EN — **P3**

### Pourquoi
Tout est en **français codé en dur** (front + réponses bot). Un support EN multiplierait
l'audience d'un projet open-source.

### Points d'attention
- Gros chantier transverse : extraire **toutes** les chaînes (dashboard + commandes/réponses bot)
  vers un dictionnaire + helper `t(key)`.
- Choisir la locale : préférence navigateur, réglage dashboard, et/ou locale Discord par serveur.
- À faire **après** avoir stabilisé l'UX (sinon on traduit des écrans qui vont bouger).

---

## Notes transverses

- **Composants réutilisables à créer** qui reviennent dans plusieurs chantiers : aperçu Discord
  partagé (#2), pastille « membre » avatar+nom (#4), garde-fou dirty-state (#3). Les factoriser
  tôt évite la duplication.
- **Cohérence du parti pris technique** : HTML/CSS/JS vanilla, pas de framework, SQLite local,
  léger pour Raspberry Pi. Toutes les propositions ci-dessus respectent ce cadre — éviter
  d'introduire un build/bundler ou une grosse dépendance front.
- **Sécurité** : profiter du chantier #2 pour traiter l'échappement HTML (issue #5) de façon
  centralisée, et appliquer le même réflexe partout où du contenu utilisateur arrive dans
  `innerHTML`.
