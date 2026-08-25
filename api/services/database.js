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

module.exports = { getDb, CUSTOM_CMD_ACCESS_MODES, CUSTOM_CMD_ACCESS_DEFAULT, effectiveAccessMode };
