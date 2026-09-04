const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'quasar.db');

// --- Intervalle de checkpoint WAL (5 minutes) ---
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;

// Valeurs autorisées de custom_commands.access_mode. Définies ici, à côté du
// schéma, parce que trois consommateurs en ont besoin (le bot à l'exécution, la
// commande /cmd et l'API du dashboard) : les recopier ferait diverger la liste
// blanche de validation et le domaine réel de la colonne.
const CUSTOM_CMD_ACCESS_MODES = ['everyone', 'admins', 'role'];
const CUSTOM_CMD_ACCESS_DEFAULT = 'everyone';
// Mode réellement appliqué pour une valeur lue en base. Deux cas très
// différents, à ne pas confondre :
//   valeur absente ou vide → ligne antérieure à la migration : 'everyone',
//     le comportement historique, aucune régression.
//   valeur non reconnue    → donnée anormale (base éditée à la main, retour
//     arrière de version) : 'admins', le plus restrictif des trois. On ne lève
//     jamais une restriction sur une valeur qu'on ne comprend pas.
// Le bot (exécution) et l'API (affichage) partagent cette fonction pour ne pas
// pouvoir diverger ; le dashboard en reproduit la règle côté navigateur.
function effectiveAccessMode(stored) {
    if (stored === null || stored === undefined || stored === '') return CUSTOM_CMD_ACCESS_DEFAULT;
    return CUSTOM_CMD_ACCESS_MODES.includes(stored) ? stored : 'admins';
}

let db;
let checkpointTimer = null;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        // Autocheckpoint : flush le WAL tous les 100 pages (~400KB)
        db.pragma('wal_autocheckpoint = 100');
        initTables();
        migrateTempVoice();
        migrateTickets();
        migrateAtomToQuasar();
        migrateGuildsTimezone();
        migrateScheduledDays();
        migrateEmbedsMentions();
        migrateCustomCommandsAccess();
        migrateDropTranscripts();
        migrateLot2Compliance();
        migrateAutomodScope();
        migrateWarnEscalationTiers();
        migrateAutoSanctionsToTiers();

        // --- Checkpoint périodique (toutes les 5 min) ---
        checkpointTimer = setInterval(() => {
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
                console.log('[Quasar DB] Checkpoint WAL effectué');
            } catch (err) {
                console.error('[Quasar DB] Erreur checkpoint WAL :', err.message);
            }
        }, CHECKPOINT_INTERVAL);
        if (checkpointTimer.unref) checkpointTimer.unref();

        // --- Graceful shutdown ---
        const shutdown = (signal) => {
            console.log(`[Quasar DB] Signal ${signal} reçu, checkpoint final...`);
            try {
                if (checkpointTimer) clearInterval(checkpointTimer);
                if (db && db.open) {
                    db.pragma('wal_checkpoint(TRUNCATE)');
                    db.close();
                    console.log('[Quasar DB] Base fermée proprement.');
                }
            } catch (err) {
                console.error('[Quasar DB] Erreur lors du shutdown :', err.message);
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        console.log('[Quasar DB] Base initialisée :', DB_PATH);
        console.log('[Quasar DB] Checkpoint WAL programmé toutes les', CHECKPOINT_INTERVAL / 1000, 's');
    }
    return db;
}

function initTables() {
    db.exec(`
        -- Config générale par serveur
        CREATE TABLE IF NOT EXISTS guilds (
            guild_id TEXT PRIMARY KEY,
            name TEXT,
            settings TEXT DEFAULT '{}'
        );

        -- Modules activés/désactivés par serveur
        CREATE TABLE IF NOT EXISTS modules (
            guild_id TEXT NOT NULL,
            module_name TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            config TEXT DEFAULT '{}',
            PRIMARY KEY (guild_id, module_name),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Sanctions (modération)
        CREATE TABLE IF NOT EXISTS sanctions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            moderator_id TEXT NOT NULL,
            type TEXT NOT NULL,
            reason TEXT,
            duration TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            active INTEGER DEFAULT 1,
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Welcome / Leave config
        CREATE TABLE IF NOT EXISTS welcome_config (
            guild_id TEXT PRIMARY KEY,
            welcome_channel TEXT,
            welcome_message TEXT,
            welcome_embed TEXT,
            welcome_enabled INTEGER DEFAULT 0,
            leave_channel TEXT,
            leave_message TEXT,
            leave_embed TEXT,
            leave_enabled INTEGER DEFAULT 0,
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Autoroles
        CREATE TABLE IF NOT EXISTS autoroles (
            guild_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            PRIMARY KEY (guild_id, role_id),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Reaction role panels
        CREATE TABLE IF NOT EXISTS reaction_panels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            message_id TEXT,
            title TEXT,
            mode TEXT DEFAULT 'multiple',
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Reaction role entries
        CREATE TABLE IF NOT EXISTS reaction_roles (
            panel_id INTEGER NOT NULL,
            emoji TEXT NOT NULL,
            role_id TEXT NOT NULL,
            description TEXT,
            PRIMARY KEY (panel_id, emoji),
            FOREIGN KEY (panel_id) REFERENCES reaction_panels(id) ON DELETE CASCADE
        );

        -- Embeds sauvegardés
        -- data = JSON de l'embed lui-même (titre, description, couleur...).
        -- Les mentions vivent dans leurs propres colonnes : elles sont postées
        -- au-dessus de l'embed, elles n'en font pas partie.
        CREATE TABLE IF NOT EXISTS embeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            mention_roles TEXT NOT NULL DEFAULT '[]',
            mention_users TEXT NOT NULL DEFAULT '[]',
            mention_everyone INTEGER NOT NULL DEFAULT 0,
            mention_here INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Commandes custom
        --
        -- access_mode / access_role_id : qui a le droit de lancer la commande.
        --   'everyone' (défaut, comportement historique) | 'admins' | 'role'
        -- Ce contrôle est ce qui rend acceptable le fait que les commandes custom
        -- rejouent les mentions de leur embed (@everyone compris) : sans lui,
        -- n'importe quel membre pourrait déclencher un ping de masse à volonté.
        --
        -- allowed_roles / allowed_channels sont des colonnes historiques jamais
        -- lues ni écrites nulle part. Elles sont conservées telles quelles (les
        -- retirer imposerait une reconstruction de table pour zéro bénéfice) mais
        -- ne participent PAS au contrôle d'accès : une liste de rôles ne peut pas
        -- exprimer trois modes exclusifs (une liste vide serait ambiguë entre
        -- « tout le monde » et « personne »).
        CREATE TABLE IF NOT EXISTS custom_commands (
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            response TEXT,
            embed_id INTEGER,
            allowed_roles TEXT DEFAULT '[]',
            allowed_channels TEXT DEFAULT '[]',
            access_mode TEXT NOT NULL DEFAULT 'everyone',
            access_role_id TEXT,
            PRIMARY KEY (guild_id, name),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id),
            FOREIGN KEY (embed_id) REFERENCES embeds(id)
        );

        -- Musique config
        CREATE TABLE IF NOT EXISTS music_config (
            guild_id TEXT PRIMARY KEY,
            default_volume INTEGER DEFAULT 50,
            allowed_channels TEXT DEFAULT '[]',
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Tickets : configuration par serveur
        CREATE TABLE IF NOT EXISTS ticket_config (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT NOT NULL,
            category_id TEXT,
            staff_role_id TEXT NOT NULL,
            welcome_message TEXT,
            enabled INTEGER DEFAULT 1,
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Tickets : historique des tickets
        -- Volontairement sans colonne transcript : le contenu des conversations
        -- est remis à l'administrateur en pièce jointe dans Discord à la fermeture,
        -- jamais conservé ici (voir bot/utils/transcriptArchive.js).
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            opened_at TEXT DEFAULT (datetime('now')),
            closed_at TEXT,
            closed_by TEXT,
            close_reason TEXT,
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- TempVoice : triggers (plusieurs par guild, max 1 par catégorie)
        CREATE TABLE IF NOT EXISTS tempvoice_triggers (
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            category_id TEXT,
            enabled INTEGER DEFAULT 1,
            created_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (guild_id, channel_id)
        );

        -- TempVoice : préférences utilisateur par catégorie
        CREATE TABLE IF NOT EXISTS tempvoice_preferences (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            category_id TEXT NOT NULL DEFAULT '',
            channel_name TEXT,
            user_limit INTEGER,
            updated_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (guild_id, user_id, category_id)
        );

        -- TempVoice : salons actuellement actifs
        CREATE TABLE IF NOT EXISTS tempvoice_active (
            channel_id TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            category_id TEXT NOT NULL DEFAULT '',
            created_at INTEGER DEFAULT (unixepoch())
        );

        -- Présence du bot (config globale, une seule ligne)
        CREATE TABLE IF NOT EXISTS bot_presence (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            status TEXT NOT NULL DEFAULT 'online',
            activity_type INTEGER NOT NULL DEFAULT 3,
            activity_text TEXT NOT NULL DEFAULT 'atlas.vena.city'
        );

        -- Messages programmés / Rappels
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            content_text TEXT,
            embed_id INTEGER,
            mention_roles TEXT NOT NULL DEFAULT '[]',
            mention_users TEXT NOT NULL DEFAULT '[]',
            mention_everyone INTEGER NOT NULL DEFAULT 0,
            mention_here INTEGER NOT NULL DEFAULT 0,
            schedule_type TEXT NOT NULL,
            schedule_time TEXT NOT NULL,
            schedule_day INTEGER,
            schedule_days TEXT,
            schedule_date TEXT,
            next_run INTEGER,
            last_run INTEGER,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            created_by TEXT,
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id),
            FOREIGN KEY (embed_id) REFERENCES embeds(id)
        );

        -- Purges différées. Quand le bot est retiré d'un serveur, ses données ne
        -- servent plus à rien : elles sont supprimées après un délai de grâce, annulé
        -- s'il est réinvité entre-temps (retrait accidentel, migration de serveur).
        -- Pas de FOREIGN KEY vers guilds : cette ligne doit survivre à la purge de
        -- la guild elle-même le temps que la transaction se termine.
        CREATE TABLE IF NOT EXISTS pending_guild_purges (
            guild_id TEXT PRIMARY KEY,
            left_at INTEGER NOT NULL,
            purge_after INTEGER NOT NULL
        );

        -- Indexes pour les performances
        CREATE INDEX IF NOT EXISTS idx_pending_purges_due ON pending_guild_purges(purge_after);
        CREATE INDEX IF NOT EXISTS idx_sanctions_guild ON sanctions(guild_id);
        CREATE INDEX IF NOT EXISTS idx_sanctions_guild_user ON sanctions(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_embeds_guild ON embeds(guild_id);
        CREATE INDEX IF NOT EXISTS idx_reaction_panels_guild ON reaction_panels(guild_id);
        CREATE INDEX IF NOT EXISTS idx_custom_commands_guild ON custom_commands(guild_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild ON tickets(guild_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_guild_closed ON tickets(guild_id, closed_at);
        CREATE INDEX IF NOT EXISTS idx_tempvoice_active_guild ON tempvoice_active(guild_id);
        CREATE INDEX IF NOT EXISTS idx_tempvoice_prefs_updated ON tempvoice_preferences(updated_at);
        CREATE INDEX IF NOT EXISTS idx_scheduled_guild ON scheduled_messages(guild_id);
        CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_messages(enabled, next_run);

        -- =====================================================================
        -- Lot 2 : conformité RGPD (contrat de sous-traitance art. 28)
        -- Tables créées ici en CREATE TABLE IF NOT EXISTS (comme les tables
        -- ci-dessus) ; les seules colonnes ajoutées à une table existante
        -- (guilds.suspended*) passent par migrateLot2Compliance().
        -- =====================================================================

        -- Acceptation du contrat de sous-traitance (une ligne par admin et par version acceptée)
        CREATE TABLE IF NOT EXISTS contract_acceptances (
            admin_id TEXT NOT NULL,
            contract_version TEXT NOT NULL,
            accepted_at INTEGER NOT NULL,          -- unixepoch
            PRIMARY KEY (admin_id, contract_version)
        );

        -- Violations : un incident regroupe une notification initiale + ses compléments
        CREATE TABLE IF NOT EXISTS breach_incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,                            -- libellé interne court
            status TEXT NOT NULL DEFAULT 'open',   -- open | closed
            created_at INTEGER NOT NULL,
            created_by TEXT NOT NULL               -- Discord id du propriétaire (BOT_OWNER_ID)
        );

        -- Messages phasés rattachés à un incident (art. 33.4 : notification progressive)
        CREATE TABLE IF NOT EXISTS breach_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            incident_id INTEGER NOT NULL,
            phase INTEGER NOT NULL,                -- 1 = initiale, 2+ = compléments
            body TEXT NOT NULL,                    -- texte libre rédigé par l'opératrice
            created_at INTEGER NOT NULL,
            created_by TEXT NOT NULL,
            FOREIGN KEY (incident_id) REFERENCES breach_incidents(id) ON DELETE CASCADE
        );

        -- Traçabilité d'envoi : une ligne par destinataire et par message (art. 33.5)
        CREATE TABLE IF NOT EXISTS breach_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            guild_id TEXT NOT NULL,
            recipient_id TEXT,                     -- Discord id admin (DM) ; NULL si repli salon
            channel TEXT NOT NULL,                 -- 'dm' | 'guild_channel'
            status TEXT NOT NULL DEFAULT 'pending',-- pending | sent | failed
            attempts INTEGER NOT NULL DEFAULT 0,
            last_attempt_at INTEGER,
            delivered_at INTEGER,
            error TEXT,
            FOREIGN KEY (message_id) REFERENCES breach_messages(id) ON DELETE CASCADE
        );

        -- Prise de connaissance de la bannière dashboard (canal indépendant de Discord)
        CREATE TABLE IF NOT EXISTS breach_banner_ack (
            incident_id INTEGER NOT NULL,
            admin_id TEXT NOT NULL,
            ack_at INTEGER NOT NULL,
            PRIMARY KEY (incident_id, admin_id),
            FOREIGN KEY (incident_id) REFERENCES breach_incidents(id) ON DELETE CASCADE
        );

        -- Demandes d'exercice du droit à l'effacement, routées à l'admin responsable
        CREATE TABLE IF NOT EXISTS erasure_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,              -- Discord id de la personne concernée
            category TEXT NOT NULL,                -- active_sanction | expired_sanction | non_moderation | mixed
            details TEXT,                          -- précisions éventuelles de la demande
            requested_at INTEGER NOT NULL,
            due_at INTEGER NOT NULL,               -- requested_at + 1 mois (art. 12.3)
            status TEXT NOT NULL DEFAULT 'pending',-- pending | decided | executed | refused | no_response
            decision TEXT,                         -- erase | refuse
            decision_reason TEXT,                  -- motivation (obligatoire si refusé)
            decided_by TEXT,                       -- Discord id admin
            decided_at INTEGER,
            executed_at INTEGER,
            source TEXT NOT NULL DEFAULT 'manual', -- manual (contact@) | command (/mes-donnees)
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Indexes Lot 2
        CREATE INDEX IF NOT EXISTS idx_breach_msg_incident ON breach_messages(incident_id);
        CREATE INDEX IF NOT EXISTS idx_breach_deliv_status ON breach_deliveries(status);
        CREATE INDEX IF NOT EXISTS idx_breach_deliv_message ON breach_deliveries(message_id);
        CREATE INDEX IF NOT EXISTS idx_erasure_guild ON erasure_requests(guild_id);
        CREATE INDEX IF NOT EXISTS idx_erasure_status_due ON erasure_requests(status, due_at);

        -- =====================================================================
        -- Modération automatique
        --
        -- Portée par règle, pas réglage global (modèle « à la Dyno ») : chaque
        -- table de configuration ci-dessous porte les six mêmes colonnes de
        -- portée, listées dans SCOPE_COLUMNS et évaluées par
        -- bot/utils/scopeFilter.js — un seul endroit décide « cette règle
        -- s'applique-t-elle à cette cible ? », les quatre modules le consomment.
        --
        --   affected_roles / affected_channels   JSON array, vide = « tout »
        --   ignored_roles  / ignored_channels    JSON array, priorité sur affected_*
        --   log_channel                          NULL = repli sur le modlog global
        --   response_message                     NULL = message par défaut du module
        --
        -- AUCUNE de ces tables n'a de FOREIGN KEY vers guilds : la purge d'un
        -- serveur quitté (bot/modules/retention/purge.js) supprime la ligne
        -- la ligne "guilds" en dernier, et les clés étrangères sont actives (pragma
        -- foreign_keys = ON). Une FK ici ferait échouer toute la transaction de
        -- purge. Les tempvoice_* suivent déjà cette règle pour la même raison.
        -- Contrepartie : ces tables DOIVENT être ajoutées à GUILD_TABLES dans
        -- purge.js, sans quoi leurs lignes survivraient au départ du bot.
        -- =====================================================================

        -- Règles AutoMod natives de Discord, miroir côté Quasar.
        -- discord_rule_id est l'identifiant renvoyé par l'API Discord ; il peut
        -- être NULL (règle décrite ici mais pas encore poussée) et la règle peut
        -- avoir été supprimée côté Discord à notre insu — d'où discord_missing,
        -- posé par la synchronisation plutôt que de supprimer la configuration
        -- locale, qui reste réutilisable pour recréer la règle.
        CREATE TABLE IF NOT EXISTS automod_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            discord_rule_id TEXT,
            trigger_type TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 0,
            discord_missing INTEGER NOT NULL DEFAULT 0,
            last_synced_at INTEGER,
            affected_roles TEXT NOT NULL DEFAULT '[]',
            affected_channels TEXT NOT NULL DEFAULT '[]',
            ignored_roles TEXT NOT NULL DEFAULT '[]',
            ignored_channels TEXT NOT NULL DEFAULT '[]',
            log_channel TEXT,
            response_message TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Escalade par avertissements : au seuil "threshold" de warns actifs, applique la
        -- chaîne "punishments" (cf. bot/utils/punishments.js).
        --
        -- UNE LIGNE PAR PALIER, pas une par serveur. L'escalade historique de
        -- Quasar (modules.config.autoSanctions) en portait déjà trois — mute,
        -- kick, ban, chacun à son propre seuil. Une table à clé primaire
        -- guild_id n'en aurait gardé qu'un : migrer « mute à 3, kick à 5, ban
        -- à 8 » y aurait perdu deux paliers, c'est-à-dire une régression pour
        -- des serveurs qui s'en servent aujourd'hui. D'où id en clé et un
        -- index unique sur (guild_id, threshold) : deux paliers au même seuil
        -- seraient une ambiguïté, la base la refuse plutôt que de trancher au
        -- hasard. Voir migrateWarnEscalationTiers() pour la reprise des bases
        -- créées avec la forme mono-palier.
        CREATE TABLE IF NOT EXISTS warn_escalation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            threshold INTEGER NOT NULL DEFAULT 3,
            punishments TEXT NOT NULL DEFAULT '',
            affected_roles TEXT NOT NULL DEFAULT '[]',
            affected_channels TEXT NOT NULL DEFAULT '[]',
            ignored_roles TEXT NOT NULL DEFAULT '[]',
            ignored_channels TEXT NOT NULL DEFAULT '[]',
            log_channel TEXT,
            response_message TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Anti-raid sur les arrivées.
        -- Défauts volontairement inoffensifs : enabled = 0 ET punishments vide,
        -- c'est-à-dire « alerte seule ». Une instance qui se met à jour ne doit
        -- jamais se réveiller en expulsant ses arrivants sans qu'un
        -- administrateur l'ait demandé.
        CREATE TABLE IF NOT EXISTS antiraid_config (
            guild_id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            join_count INTEGER NOT NULL DEFAULT 10,
            join_window_seconds INTEGER NOT NULL DEFAULT 60,
            min_account_age_hours INTEGER NOT NULL DEFAULT 0,
            punishments TEXT NOT NULL DEFAULT '',
            panic_duration_seconds INTEGER NOT NULL DEFAULT 300,
            affected_roles TEXT NOT NULL DEFAULT '[]',
            affected_channels TEXT NOT NULL DEFAULT '[]',
            ignored_roles TEXT NOT NULL DEFAULT '[]',
            ignored_channels TEXT NOT NULL DEFAULT '[]',
            log_channel TEXT,
            response_message TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Honeypot : un salon piège, un seul par serveur (d'où guild_id en clé).
        CREATE TABLE IF NOT EXISTS honeypot_config (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT,
            enabled INTEGER NOT NULL DEFAULT 0,
            punishments TEXT NOT NULL DEFAULT '',
            affected_roles TEXT NOT NULL DEFAULT '[]',
            affected_channels TEXT NOT NULL DEFAULT '[]',
            ignored_roles TEXT NOT NULL DEFAULT '[]',
            ignored_channels TEXT NOT NULL DEFAULT '[]',
            log_channel TEXT,
            response_message TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Salon d'arbitrage : où poster les cas au lieu de punir directement.
        CREATE TABLE IF NOT EXISTS defer_config (
            guild_id TEXT PRIMARY KEY,
            channel_id TEXT,
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        );

        -- Cas soumis à arbitrage. message_id / channel_id désignent l'embed posté
        -- dans le salon d'arbitrage : c'est par eux qu'on retrouve le message à
        -- mettre à jour, y compris après un redémarrage du bot (aucun état n'est
        -- gardé en mémoire, l'identifiant du cas voyage dans le customId).
        -- Volontairement SANS colonne de contenu : la preuve éventuelle est
        -- affichée dans l'embed au moment du signalement, jamais conservée ici —
        -- même principe que les transcripts de tickets.
        CREATE TABLE IF NOT EXISTS defer_cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT,
            message_id TEXT,
            target_user_id TEXT NOT NULL,
            source TEXT NOT NULL,
            reason TEXT,
            proposed_punishments TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            resolved_by TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            resolved_at INTEGER
        );

        -- Bannissements temporaires en attente de levée. Discord n'a pas de ban
        -- à durée : sans cette table et le balayage de bot/utils/punishments.js,
        -- un "tempban" serait un ban définitif qui ment sur sa durée.
        CREATE TABLE IF NOT EXISTS temp_bans (
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            reason TEXT,
            source TEXT,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            PRIMARY KEY (guild_id, user_id)
        );

        -- Indexes modération automatique
        CREATE INDEX IF NOT EXISTS idx_automod_rules_guild ON automod_rules(guild_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_automod_rules_discord ON automod_rules(guild_id, discord_rule_id);
        CREATE INDEX IF NOT EXISTS idx_warn_escalation_guild ON warn_escalation(guild_id);
        -- Deux paliers au même seuil sur un même serveur : refusé en base, pas
        -- seulement dans le formulaire. L'API traduit la contrainte en refus lisible.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_warn_escalation_tier ON warn_escalation(guild_id, threshold);
        CREATE INDEX IF NOT EXISTS idx_defer_cases_guild_status ON defer_cases(guild_id, status);
        CREATE INDEX IF NOT EXISTS idx_defer_cases_message ON defer_cases(message_id);
        CREATE INDEX IF NOT EXISTS idx_temp_bans_due ON temp_bans(expires_at);
    `);
}

function migrateTempVoice() {
    // Drop old single-trigger table if it exists
    try {
        const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tempvoice_config'").get();
        if (old) {
            db.exec('DROP TABLE tempvoice_config');
            console.log('[Quasar] Migration: tempvoice_config → tempvoice_triggers');
        }
    } catch {}

    // Migrer tempvoice_active : ajouter category_id si manquant
    try {
        const cols = db.prepare("PRAGMA table_info(tempvoice_active)").all().map(c => c.name);
        if (!cols.includes('category_id')) {
            db.exec("ALTER TABLE tempvoice_active ADD COLUMN category_id TEXT NOT NULL DEFAULT ''");
            console.log('[Quasar] Migration: tempvoice_active + category_id');
        }
    } catch {}

    // Migrer tempvoice_preferences : ajouter category_id si manquant
    try {
        const cols = db.prepare("PRAGMA table_info(tempvoice_preferences)").all().map(c => c.name);
        if (!cols.includes('category_id')) {
            // Recréer la table avec la nouvelle PK
            db.exec(`
                CREATE TABLE IF NOT EXISTS tempvoice_preferences_new (
                    guild_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    category_id TEXT NOT NULL DEFAULT '',
                    channel_name TEXT,
                    user_limit INTEGER,
                    updated_at INTEGER DEFAULT (unixepoch()),
                    PRIMARY KEY (guild_id, user_id, category_id)
                );
                INSERT OR IGNORE INTO tempvoice_preferences_new (guild_id, user_id, category_id, channel_name, user_limit, updated_at)
                    SELECT guild_id, user_id, '', channel_name, user_limit, updated_at FROM tempvoice_preferences;
                DROP TABLE tempvoice_preferences;
                ALTER TABLE tempvoice_preferences_new RENAME TO tempvoice_preferences;
            `);
            console.log('[Quasar] Migration: tempvoice_preferences + category_id (PK)');
        }
    } catch {}

    // Purge des préférences > 90 jours
    try {
        const cutoff = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
        const result = db.prepare('DELETE FROM tempvoice_preferences WHERE updated_at < ?').run(cutoff);
        if (result.changes > 0) {
            console.log(`[Quasar] TempVoice: ${result.changes} préférence(s) expirée(s) supprimée(s)`);
        }
    } catch {}
}

// Migration : ajout de la colonne `schedule_days` à `scheduled_messages`
// (JSON array de jours pour les rappels weekly multi-jours).
// Migre aussi les rappels weekly existants : schedule_day → schedule_days = [schedule_day].
// Idempotente.
function migrateScheduledDays() {
    try {
        const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_messages'").get();
        if (!tbl) return; // table pas encore créée (cas d'un boot frais)
        const cols = db.pragma('table_info(scheduled_messages)').map(c => c.name);
        if (!cols.includes('schedule_days')) {
            db.exec('ALTER TABLE scheduled_messages ADD COLUMN schedule_days TEXT');
            console.log('[Quasar] Migration: scheduled_messages + schedule_days');
        }
        // Backfill : les weekly avec schedule_day non-NULL et schedule_days NULL → array du seul jour
        const result = db.prepare(`
            UPDATE scheduled_messages
            SET schedule_days = '[' || schedule_day || ']'
            WHERE schedule_type = 'weekly'
              AND schedule_days IS NULL
              AND schedule_day IS NOT NULL
        `).run();
        if (result.changes > 0) {
            console.log(`[Quasar] Migration: ${result.changes} rappel(s) weekly backfillé(s) (schedule_day → schedule_days)`);
        }
    } catch (e) {
        console.error('[Quasar] Erreur migration scheduled_days:', e.message);
    }
}

// Migration : ajout des colonnes de mention à `embeds`.
// Un embed personnalisé peut désormais pinger des rôles / utilisateurs /
// @everyone / @here à chaque envoi, exactement comme un rappel programmé.
// Les embeds existants héritent des valeurs par défaut (aucune mention), donc
// leur comportement ne change pas. Idempotente.
function migrateEmbedsMentions() {
    try {
        const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embeds'").get();
        if (!tbl) return; // table pas encore créée (cas d'un boot frais)
        const cols = db.pragma('table_info(embeds)').map(c => c.name);
        const columns = [
            ['mention_roles', "TEXT NOT NULL DEFAULT '[]'"],
            ['mention_users', "TEXT NOT NULL DEFAULT '[]'"],
            ['mention_everyone', 'INTEGER NOT NULL DEFAULT 0'],
            ['mention_here', 'INTEGER NOT NULL DEFAULT 0']
        ];
        for (const [name, definition] of columns) {
            if (cols.includes(name)) continue;
            db.exec(`ALTER TABLE embeds ADD COLUMN ${name} ${definition}`);
            console.log(`[Quasar] Migration: embeds + ${name}`);
        }
    } catch (e) {
        console.error('[Quasar] Erreur migration embeds mentions:', e.message);
    }
}

// Migration : ajout des colonnes de contrôle d'accès à `custom_commands`.
//
// Les commandes personnalisées appliquent désormais les mentions de leur embed
// (cf. bot/index.js). Pour que ça reste sûr, chaque commande porte un mode
// d'accès : 'everyone' | 'admins' | 'role'.
//
// 'everyone' est la valeur par défaut ET le comportement historique : toutes les
// commandes déjà en base se retrouvent dans ce mode, sans changement pour elles.
// Idempotente.
function migrateCustomCommandsAccess() {
    try {
        const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_commands'").get();
        if (!tbl) return; // table pas encore créée (cas d'un boot frais)
        const cols = db.pragma('table_info(custom_commands)').map(c => c.name);
        const columns = [
            ['access_mode', "TEXT NOT NULL DEFAULT 'everyone'"],
            ['access_role_id', 'TEXT']
        ];
        for (const [name, definition] of columns) {
            if (cols.includes(name)) continue;
            db.exec(`ALTER TABLE custom_commands ADD COLUMN ${name} ${definition}`);
            console.log(`[Quasar] Migration: custom_commands + ${name}`);
        }
        // Filet : une ligne dont le mode serait NULL ou vide (base bricolée à la
        // main, ALTER interrompu) retombe explicitement sur le comportement
        // historique plutôt que de rester dans un état indéfini.
        const fixed = db.prepare(
            "UPDATE custom_commands SET access_mode = 'everyone' WHERE access_mode IS NULL OR access_mode = ''"
        ).run();
        if (fixed.changes > 0) {
            console.log(`[Quasar] Migration: ${fixed.changes} commande(s) custom repassée(s) en accès 'everyone'`);
        }
    } catch (e) {
        console.error('[Quasar] Erreur migration custom_commands access:', e.message);
    }
}

// Migration : ajout de la colonne `timezone` à `guilds` (default 'Europe/Paris').
// Idempotente.
function migrateGuildsTimezone() {
    try {
        const cols = db.pragma('table_info(guilds)').map(c => c.name);
        if (!cols.includes('timezone')) {
            db.exec("ALTER TABLE guilds ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Paris'");
            console.log('[Quasar] Migration: guilds + timezone (default Europe/Paris)');
        }
    } catch (e) {
        console.error('[Quasar] Erreur migration guilds.timezone:', e.message);
    }
}

function migrateTickets() {
    try {
        const cols = db.pragma('table_info(ticket_config)').map(c => c.name);
        if (cols.length > 0 && !cols.includes('panel_title')) {
            db.exec('ALTER TABLE ticket_config ADD COLUMN panel_title TEXT');
            db.exec('ALTER TABLE ticket_config ADD COLUMN panel_description TEXT');
            console.log('[Quasar] Migration: ticket_config + panel_title, panel_description');
        }
    } catch {}
}

// --- Migration : suppression des transcripts de tickets (one-shot) ---
// Les transcripts stockés en base faisaient de Quasar le dernier détenteur de
// conversations privées, le salon Discord étant supprimé à la fermeture du ticket.
// Cette migration efface le contenu existant puis retire la colonne.
//
// Le VACUUM final n'est pas cosmétique : sans lui, SQLite libère les pages sans les
// réécrire et le texte des anciennes conversations reste lisible dans le fichier .db.
// Une donnée « supprimée » mais toujours récupérable n'est pas supprimée.
//
// Idempotente : trackée via _migrations.
function migrateDropTranscripts() {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`);

        const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('drop_ticket_transcripts_v1');
        if (already) return;

        const cols = db.pragma('table_info(tickets)').map(c => c.name);
        if (!cols.includes('transcript')) {
            // Base neuve : la colonne n'a jamais existé, rien à effacer.
            db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
                .run('drop_ticket_transcripts_v1', Date.now());
            return;
        }

        const withTranscript = db.prepare(
            "SELECT COUNT(*) AS c FROM tickets WHERE transcript IS NOT NULL AND transcript != ''"
        ).get().c;

        const apply = db.transaction(() => {
            db.prepare('UPDATE tickets SET transcript = NULL').run();
            db.exec('ALTER TABLE tickets DROP COLUMN transcript');
            db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
                .run('drop_ticket_transcripts_v1', Date.now());
        });
        apply();

        // Hors transaction : SQLite refuse VACUUM à l'intérieur d'une transaction.
        db.exec('VACUUM');

        console.log(
            `[Quasar] Migration drop_ticket_transcripts_v1 appliquée — ` +
            `${withTranscript} transcript(s) supprimé(s) définitivement de la base.`
        );
    } catch (err) {
        console.error('[Quasar] Erreur migration drop_ticket_transcripts_v1 :', err.message);
    }
}

// --- Migration rebranding Atom -> Quasar (v1, one-shot) ---
// Renomme les cles atom_* heritees dans la DB pour coherence post-rebranding.
// Idempotente : trackee via _migrations.
function migrateAtomToQuasar() {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`);

        const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('atom_to_quasar_v1');
        if (already) return;

        const apply = db.transaction(() => {
            // 1. Guild-id special : __atom_instance_id -> __quasar_instance_id
            const guildUpdate = db.prepare(
                "UPDATE guilds SET guild_id = '__quasar_instance_id' WHERE guild_id = '__atom_instance_id'"
            ).run();
            if (guildUpdate.changes > 0) {
                console.log('[Quasar] Migration atom->quasar: instance_id renomme');
            }

            // 2. enabledLogs : atom_* -> quasar_* dans modules.config (JSON) pour moderation
            const mods = db.prepare(
                "SELECT guild_id, module_name, config FROM modules WHERE module_name = 'moderation'"
            ).all();
            const updateMod = db.prepare(
                'UPDATE modules SET config = ? WHERE guild_id = ? AND module_name = ?'
            );
            let modsMigrated = 0;
            for (const mod of mods) {
                let cfg;
                try { cfg = JSON.parse(mod.config || '{}'); } catch { continue; }
                if (!cfg.enabledLogs || typeof cfg.enabledLogs !== 'object') continue;
                const newLogs = {};
                let changed = false;
                for (const [key, val] of Object.entries(cfg.enabledLogs)) {
                    if (key.startsWith('atom_')) {
                        newLogs['quasar_' + key.slice(5)] = val;
                        changed = true;
                    } else {
                        newLogs[key] = val;
                    }
                }
                if (changed) {
                    cfg.enabledLogs = newLogs;
                    updateMod.run(JSON.stringify(cfg), mod.guild_id, mod.module_name);
                    modsMigrated++;
                }
            }
            if (modsMigrated > 0) {
                console.log(`[Quasar] Migration atom->quasar: ${modsMigrated} config(s) de logs moderation mise(s) a jour`);
            }

            db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
                'atom_to_quasar_v1', Date.now()
            );
        });
        apply();
        console.log('[Quasar] Migration atom_to_quasar_v1 appliquee');
    } catch (err) {
        console.error('[Quasar] Erreur migration atom_to_quasar_v1 :', err.message);
    }
}

// --- Migration Lot 2 : conformité RGPD (v1, one-shot) ---
// Ajoute les colonnes de coupure ciblée à la table existante `guilds` :
//   - suspended        (INTEGER NOT NULL DEFAULT 0) : serveur suspendu ou non
//   - suspended_at     (INTEGER)                    : horodatage unixepoch de la suspension
//   - suspended_reason (TEXT)                        : motif libre de la suspension
//
// Les nouvelles TABLES du lot 2 sont créées dans initTables() en CREATE TABLE
// IF NOT EXISTS ; seules ces colonnes sur une table préexistante nécessitent un
// ALTER, d'où cette migration dédiée.
//
// Doublement idempotente : gardée par _migrations (clé lot2_compliance_v1, comme
// migrateAtomToQuasar/migrateDropTranscripts) ET vérification PRAGMA table_info
// avant chaque ADD COLUMN (comme migrateGuildsTimezone). Un ALTER n'est jamais
// rejoué, même si la ligne _migrations venait à manquer.
function migrateLot2Compliance() {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`);

        const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get('lot2_compliance_v1');
        if (already) return;

        const cols = db.pragma('table_info(guilds)').map(c => c.name);
        if (!cols.includes('suspended')) {
            db.exec('ALTER TABLE guilds ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
            console.log('[Quasar] Migration: guilds + suspended (default 0)');
        }
        if (!cols.includes('suspended_at')) {
            db.exec('ALTER TABLE guilds ADD COLUMN suspended_at INTEGER');
            console.log('[Quasar] Migration: guilds + suspended_at');
        }
        if (!cols.includes('suspended_reason')) {
            db.exec('ALTER TABLE guilds ADD COLUMN suspended_reason TEXT');
            console.log('[Quasar] Migration: guilds + suspended_reason');
        }

        db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
            .run('lot2_compliance_v1', Date.now());
        console.log('[Quasar] Migration lot2_compliance_v1 appliquée');
    } catch (err) {
        console.error('[Quasar] Erreur migration lot2_compliance_v1 :', err.message);
    }
}

// Colonnes de portée communes à toutes les tables de configuration de la
// modération automatique. Exportées parce que trois consommateurs s'appuient
// dessus : le schéma ci-dessus, la migration de rattrapage, et les routes d'API
// des quatre modules qui valident les champs reçus du dashboard. Les recopier
// ferait diverger la liste de validation du domaine réel des tables.
const SCOPE_COLUMNS = Object.freeze({
    affected_roles: "TEXT NOT NULL DEFAULT '[]'",
    affected_channels: "TEXT NOT NULL DEFAULT '[]'",
    ignored_roles: "TEXT NOT NULL DEFAULT '[]'",
    ignored_channels: "TEXT NOT NULL DEFAULT '[]'",
    log_channel: 'TEXT',
    response_message: 'TEXT',
});

// Tables de configuration portant ces colonnes.
const SCOPED_TABLES = Object.freeze([
    'automod_rules',
    'warn_escalation',
    'antiraid_config',
    'honeypot_config',
]);

// --- Migration : rattrapage des colonnes de portée ---
//
// Les tables de la modération automatique sont toutes créées en CREATE TABLE IF
// NOT EXISTS ci-dessus : une instance qui se met à jour les reçoit complètes, et
// cette migration ne fait rien. Elle existe pour le cas réel du déploiement
// intermédiaire — une preview de PR ayant créé une table avant qu'une colonne de
// portée ne lui soit ajoutée. Sans elle, `CREATE TABLE IF NOT EXISTS` verrait la
// table déjà là et laisserait un schéma amputé, avec des SELECT qui échouent au
// runtime sur une colonne inconnue.
//
// Volontairement NON gardée par _migrations : le coût est un PRAGMA par table au
// boot, et l'intérêt est justement de rattraper un état qu'une ligne
// _migrations aurait déclaré « déjà fait ».
function migrateAutomodScope() {
    for (const table of SCOPED_TABLES) {
        try {
            const cols = db.pragma(`table_info(${table})`).map(c => c.name);
            if (cols.length === 0) continue; // table absente : rien à rattraper
            for (const [name, definition] of Object.entries(SCOPE_COLUMNS)) {
                if (cols.includes(name)) continue;
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
                console.log(`[Quasar] Migration: ${table} + ${name}`);
            }
        } catch (err) {
            console.error(`[Quasar] Erreur migration portée ${table} :`, err.message);
        }
    }
}

// --- Migration : escalade des warns, du palier unique aux N paliers ---
//
// La première version de `warn_escalation` avait `guild_id` en clé primaire :
// un seul palier par serveur. L'escalade historique de Quasar en portait trois
// (mute / kick / ban), une base créée avec cette forme doit donc être reprise
// avant que le module ne puisse en enregistrer plusieurs.
//
// SQLite ne sait pas changer une clé primaire : la seule voie est le
// remplacement de table (rename → create → copy → drop). Les lignes existantes
// sont recopiées telles quelles et deviennent chacune le premier palier de leur
// serveur — aucune configuration n'est perdue.
//
// Gardée par la STRUCTURE avant tout (présence de la colonne `id`) plutôt que
// par _migrations seul : une base rattrapée à la main, ou reprise d'un
// déploiement intermédiaire, doit être réparée même si la ligne de suivi
// existe. La ligne _migrations est écrite pour la traçabilité et pour dire à la
// migration de données ci-dessous que le terrain est prêt.
function migrateWarnEscalationTiers() {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`);

        const cols = db.pragma('table_info(warn_escalation)').map(c => c.name);
        if (cols.length === 0) return;   // table absente : initTables la créera à la bonne forme
        if (cols.includes('id')) {
            // Déjà à la forme N paliers (base neuve, ou migration déjà passée).
            db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
                .run('warn_escalation_tiers_v1', Date.now());
            return;
        }

        // Colonnes réellement présentes dans l'ancienne table : une base issue
        // d'un déploiement intermédiaire peut ne pas avoir toutes les colonnes de
        // portée. On ne copie que ce qui existe, le reste prend son défaut.
        const carried = [
            'guild_id', 'enabled', 'threshold', 'punishments',
            'affected_roles', 'affected_channels', 'ignored_roles', 'ignored_channels',
            'log_channel', 'response_message', 'created_at', 'updated_at',
        ].filter(name => cols.includes(name));

        const apply = db.transaction(() => {
            db.exec('ALTER TABLE warn_escalation RENAME TO warn_escalation_legacy');
            db.exec(`
                CREATE TABLE warn_escalation (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    threshold INTEGER NOT NULL DEFAULT 3,
                    punishments TEXT NOT NULL DEFAULT '',
                    affected_roles TEXT NOT NULL DEFAULT '[]',
                    affected_channels TEXT NOT NULL DEFAULT '[]',
                    ignored_roles TEXT NOT NULL DEFAULT '[]',
                    ignored_channels TEXT NOT NULL DEFAULT '[]',
                    log_channel TEXT,
                    response_message TEXT,
                    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                )
            `);
            db.exec(
                `INSERT INTO warn_escalation (${carried.join(', ')}) ` +
                `SELECT ${carried.join(', ')} FROM warn_escalation_legacy`
            );
            db.exec('DROP TABLE warn_escalation_legacy');
            // Le DROP a emporté les index de l'ancienne table : on les repose.
            db.exec('CREATE INDEX IF NOT EXISTS idx_warn_escalation_guild ON warn_escalation(guild_id)');
            db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_warn_escalation_tier ON warn_escalation(guild_id, threshold)');
            db.prepare('INSERT OR REPLACE INTO _migrations (name, applied_at) VALUES (?, ?)')
                .run('warn_escalation_tiers_v1', Date.now());
        });
        apply();

        console.log('[Quasar] Migration warn_escalation_tiers_v1 appliquée — escalade des warns en N paliers.');
    } catch (err) {
        console.error('[Quasar] Erreur migration warn_escalation_tiers_v1 :', err.message);
    }
}

// --- Migration : escalade historique (modules.autoSanctions) → paliers ---
//
// Avant ce chantier, l'escalade vivait dans la configuration JSON du module
// « moderation » : muteAt / muteDuration / kickAt / banAt, appliqués par une
// cascade if/else if dans bot/commands/warn.js. Ce chemin est supprimé au
// profit de la table `warn_escalation` — un serveur qui avait réglé « mute à 3,
// kick à 5, ban à 8 » doit retrouver exactement ces trois paliers, actifs, sans
// rien faire.
//
// Les paliers migrés sont créés ACTIFS : ils l'étaient. C'est la seule exception
// à la règle « rien ne s'active tout seul » de ce chantier, et elle va dans le
// sens de la dégradation gracieuse — ne pas les activer changerait le
// comportement d'un serveur qui n'a rien demandé.
//
// Idempotente à deux niveaux : la ligne _migrations empêche le rejeu, et chaque
// serveur ayant déjà un palier dans le nouveau système est ignoré — une
// configuration créée depuis le dashboard n'est jamais écrasée.
function migrateAutoSanctionsToTiers() {
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`);

        const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?')
            .get('warn_escalation_from_autosanctions_v1');
        if (already) return;

        const cols = db.pragma('table_info(warn_escalation)').map(c => c.name);
        if (!cols.includes('id')) return;  // rebuild en échec : on ne migre pas dans une table inadaptée

        const rows = db.prepare(
            "SELECT guild_id, config FROM modules WHERE module_name = 'moderation'"
        ).all();

        const insert = db.prepare(`
            INSERT INTO warn_escalation (guild_id, enabled, threshold, punishments)
            VALUES (?, 1, ?, ?)
        `);
        const hasTier = db.prepare('SELECT 1 FROM warn_escalation WHERE guild_id = ? LIMIT 1');

        let guilds = 0;
        let tiers = 0;

        const apply = db.transaction(() => {
            for (const row of rows) {
                let config;
                try { config = JSON.parse(row.config || '{}'); } catch { continue; }
                const auto = config?.autoSanctions;
                if (!auto || typeof auto !== 'object') continue;
                if (hasTier.get(row.guild_id)) continue; // configuration déjà reprise en main

                // Un seuil n'a de sens qu'entier et strictement positif : l'ancien
                // formulaire écrivait null quand la case était vide.
                const seuil = (value) => {
                    const parsed = Number.parseInt(value, 10);
                    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
                };

                // Durée de mute stockée en MINUTES par l'ancien réglage, avec 60
                // pour défaut — la même valeur que la cascade appliquait.
                const muteMinutes = Number.parseInt(auto.muteDuration, 10);
                const muteDuration = Number.isInteger(muteMinutes) && muteMinutes > 0 ? muteMinutes : 60;

                // Ordre de gravité croissante. Il départage le cas où deux
                // réglages partagent le même seuil : la cascade d'origine testait
                // ban, puis kick, puis mute, et n'en appliquait qu'un — le plus
                // grave gagnait. Écrire les trois dans cet ordre reproduit ce
                // départage, la dernière écriture sur un seuil l'emportant.
                const candidates = [
                    [seuil(auto.muteAt), `tempmute ${formatMinutes(muteDuration)}`],
                    [seuil(auto.kickAt), 'kick'],
                    [seuil(auto.banAt), 'ban'],
                ];

                const byThreshold = new Map();
                for (const [threshold, punishments] of candidates) {
                    if (threshold === null) continue;
                    byThreshold.set(threshold, punishments);
                }
                if (byThreshold.size === 0) continue;

                for (const [threshold, punishments] of byThreshold) {
                    insert.run(row.guild_id, threshold, punishments);
                    tiers++;
                }
                guilds++;
            }

            db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
                .run('warn_escalation_from_autosanctions_v1', Date.now());
        });
        apply();

        if (tiers > 0) {
            console.log(
                `[Quasar] Migration warn_escalation_from_autosanctions_v1 appliquée — ` +
                `${tiers} palier(s) repris sur ${guilds} serveur(s).`
            );
        }
    } catch (err) {
        console.error('[Quasar] Erreur migration warn_escalation_from_autosanctions_v1 :', err.message);
    }
}

/**
 * Traduit des minutes en durée composable (« 60 » → « 1h »), la forme qu'attend
 * bot/utils/punishments.js. Volontairement local : la migration ne doit pas
 * dépendre du module du bot, qui charge discord.js — la base s'ouvre aussi
 * depuis des contextes qui n'ont pas besoin de lui.
 */
function formatMinutes(minutes) {
    const total = Math.max(1, Math.floor(minutes));
    const days = Math.floor(total / 1440);
    const hours = Math.floor((total % 1440) / 60);
    const rest = total % 60;
    return `${days ? `${days}d` : ''}${hours ? `${hours}h` : ''}${rest ? `${rest}m` : ''}` || '1m';
}

module.exports = {
    getDb,
    CUSTOM_CMD_ACCESS_MODES,
    CUSTOM_CMD_ACCESS_DEFAULT,
    effectiveAccessMode,
    SCOPE_COLUMNS,
    SCOPED_TABLES,
};
