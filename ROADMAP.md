# 🌌 Quasar — Roadmap

## v0.1.0 — Release publique ✅

- [x] Repo GitHub public
- [x] One-liner install : `curl -sSL https://raw.githubusercontent.com/venaciteam/quasar-discord/main/install.sh | bash`
- [x] Landing page avec compteur d'instances
- [x] Dashboard accessible sur le reseau local
- [ ] Tests sur Raspberry Pi 4
- [ ] Changelog / release notes

## v0.2.0 — Auto-update ✅

- [x] Endpoint `/api/version` — version locale (package.json) + derniere release GitHub
- [x] Check periodique (toutes les 12h ou au login dashboard)
- [x] Bandeau notification dans le dashboard quand une mise a jour est dispo
- [x] Bouton "Mettre a jour" avec log temps reel (SSE)
- [x] Rollback automatique si le build echoue
- [x] Page "Mise a jour" dans le dashboard (sidebar Systeme)
- [x] Support Docker (socket + host mount) et natif (git pull + npm ci)

## v0.2.1 — Gestion de la présence du bot

- [x] Endpoint API `/api/presence` (GET + PUT, owner only)
- [x] Configuration du statut (online, idle, dnd, invisible)
- [x] Configuration de l'activité (Playing, Streaming, Listening, Watching, Competing)
- [x] Application en temps réel sur le bot Discord

## v3.1.0 — Rappels programmés

- [x] Table SQLite `scheduled_messages` (récurrence once / daily / weekly / monthly)
- [x] Scheduler engine (tick 60s, DST-safe, recalcul next_run au boot)
- [x] Timezone configurable par serveur (colonne `guilds.timezone`, défaut Europe/Paris)
- [x] Endpoint API `/api/guilds/:guildId/scheduled` (CRUD + toggle)
- [x] Endpoint API `/api/guilds/:guildId/settings` (lecture/écriture TZ)
- [x] Page dashboard "Rappels" (sélecteur TZ francophone, builder texte/embed, mentions roles/users/everyone/here)

## Ideas

- [ ] Systeme de plugins (modules activables/desactivables)
- [ ] Backup/restore config depuis le dashboard
- [ ] Support Fluxer (quasar-fluxer)
