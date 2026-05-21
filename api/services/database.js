const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'quasar.db');

// --- Intervalle de checkpoint WAL (5 minutes) ---
const CHECKPOINT_INTERVAL = 5 * 60 * 1000;

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
        CREATE TABLE IF NOT EXISTS embeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (guild_id) REFERENCES guilds(guild_id)
        );

        -- Commandes custom
        CREATE TABLE IF NOT EXISTS custom_commands (
            guild_id TEXT NOT NULL,
            name TEXT NOT NULL,
            response TEXT,
            embed_id INTEGER,
            allowed_roles TEXT DEFAULT '[]',
            allowed_channels TEXT DEFAULT '[]',
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
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            opened_at TEXT DEFAULT (datetime('now')),
            closed_at TEXT,
            closed_by TEXT,
            close_reason TEXT,
            transcript TEXT,
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

        -- Indexes pour les performances
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

module.exports = { getDb };
