// ═══════════════════════════════════════════════════════════════
//  Journal de conservation LCEN
//
//  Spécification commune : documentation-vnct/VNCT-Conservation-LCEN-DA.md,
//  section « Quasar ». FINALITÉ UNIQUE : obligation légale (LCEN art. 6, V ;
//  décrets n° 2021-1362 et n° 2026-920). Le service ÉCRIT le journal et le
//  PURGE, rien d'autre : aucune route ne le lit, aucun log ne reprend ses
//  lignes, aucune statistique ni aucune modération ne s'en nourrit. L'extraction
//  passe uniquement par scripts/legal-export.js, lancé à la main dans le
//  conteneur sur réquisition d'une autorité habilitée.
//
//  Ce qui est consigné : chaque création, modification ou suppression, par une
//  personne, d'un contenu que le robot publie ensuite dans Discord — embeds,
//  commandes personnalisées, messages de bienvenue et de départ, messages
//  programmés, panneaux de rôles, textes des tickets, nom de salon vocal
//  temporaire. Qu'elle passe par le dashboard ou par une commande du robot.
//
//  Ce qui ne l'est pas : les consultations, les réglages techniques (salons,
//  rôles, interrupteurs), la modération, les traitements automatiques (purge
//  d'un serveur quitté, expiration des préférences vocales).
// ═══════════════════════════════════════════════════════════════

const net = require('net');

/** Durée de conservation, à compter de chaque opération (décret 2021-1362, art. 5). */
const LEGAL_RETENTION_DAYS = 365;
const LEGAL_RETENTION_MS = LEGAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const OPERATIONS = new Set(['create', 'update', 'delete', 'delete_cascade']);

// ── Qui agit, et par quelle connexion ───────────────────────────

/**
 * Adresse IP de l'auteur : `CF-Connecting-IP` UNIQUEMENT, s'il porte une IPv4
 * ou une IPv6 valide. Sinon null.
 *
 * Ne JAMAIS retomber sur `req.ip` ni sur `X-Forwarded-For` : derrière
 * Cloudflare puis Traefik, ils portent une adresse Cloudflare ou une valeur
 * fournie par le client (cf. TRUST_PROXY dans api/index.js). Les ports 80 et
 * 443 de Petra n'acceptent que Cloudflare : l'en-tête n'y est pas falsifiable.
 * Sur une instance auto-hébergée sans Cloudflare, le champ reste vide : mieux
 * vaut une absence qu'une adresse fausse. Une valeur multiple est refusée.
 */
function connectionIp(req) {
    const raw = req?.headers?.['cf-connecting-ip'];
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return net.isIP(value) !== 0 ? value : null;
}

/**
 * Protocole : schéma annoncé par Cloudflare dans `CF-Visitor`
 * (`{"scheme":"https"}`), seul. Pas de repli sur `req.protocol`, qui lit
 * `X-Forwarded-Proto`. La version HTTP n'est pas enregistrée : Node ne voit que
 * celle du dernier saut (Traefik → Node), qui ne dit rien du visiteur.
 */
function connectionProtocol(req) {
    const raw = req?.headers?.['cf-visitor'];
    if (typeof raw !== 'string' || raw.length > 256) return null;
    let scheme;
    try {
        scheme = JSON.parse(raw)?.scheme;
    } catch {
        return null;
    }
    return scheme === 'http' || scheme === 'https' ? scheme : null;
}

/** Auteur d'une écriture faite depuis le dashboard : admin connecté + connexion. */
function fromRequest(req) {
    return {
        ip: connectionIp(req),
        protocol: connectionProtocol(req),
        authorId: req?.user?.id || null,
    };
}

/**
 * Auteur d'une écriture faite par une commande ou un bouton du robot. Quasar ne
 * voit pas la connexion des membres (elle s'arrête chez Discord) : ip et
 * protocol restent vides, le décret ne visant que ce qui est collecté (art. 8).
 */
function fromInteraction(interaction) {
    return { ip: null, protocol: null, authorId: interaction?.user?.id || null };
}

/**
 * Suppression faite pour le compte de l'auteur sans qu'il agisse lui-même
 * (effacement art. 17 exécuté par un admin) : `delete_cascade`, sans connexion.
 */
function onBehalfOf(authorId) {
    return { ip: null, protocol: null, authorId: authorId || null };
}

// ── Écriture ────────────────────────────────────────────────────

function journalTimestamp(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Écrit UNE ligne. À appeler dans la transaction de l'opération quand il y en a
 * une : l'opération et sa ligne réussissent ou échouent ensemble.
 */
function record(db, who, { contentId, contentType, operation }) {
    if (!OPERATIONS.has(operation)) throw new Error(`Opération de journal inconnue : ${operation}`);
    if (!contentId || !contentType) throw new Error('Journal LCEN : contentId et contentType requis');
    db.prepare(`
        INSERT INTO legal_journal (content_id, content_type, operation, occurred_at, ip, protocol, author_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        String(contentId), contentType, operation, journalTimestamp(Date.now()),
        who?.ip ?? null, who?.protocol ?? null, who?.authorId ?? null
    );
}

/**
 * Nature de l'opération entre deux états publiés d'un contenu (null = absent).
 * Renvoie null si rien de publié n'a changé : une sauvegarde qui ne touche
 * qu'à un salon, un rôle ou un interrupteur n'est pas une contribution.
 */
function operationBetween(before, after) {
    if (!before && !after) return null;
    if (!before) return 'create';
    if (!after) return 'delete';
    return JSON.stringify(before) === JSON.stringify(after) ? null : 'update';
}

/**
 * Compare l'état publié avant et après, et écrit une ligne s'il a changé.
 * `deleteAs` : 'delete_cascade' pour une suppression faite pour le compte de
 * l'auteur. Renvoie l'opération écrite, ou null.
 */
function recordChange(db, who, { contentId, contentType, before, after, deleteAs = 'delete' }) {
    let operation = operationBetween(before, after);
    if (!operation) return null;
    if (operation === 'delete') operation = deleteAs;
    record(db, who, { contentId, contentType, operation });
    return operation;
}

/**
 * Exécute `mutate` et écrit la ligne correspondante dans une même transaction :
 * état publié avant, écriture, état publié après. Renvoie le résultat de `mutate`.
 */
function withJournal(db, who, { contentId, contentType, snapshot, deleteAs }, mutate) {
    return db.transaction(() => {
        const before = snapshot();
        const result = mutate();
        recordChange(db, who, { contentId, contentType, before, after: snapshot(), deleteAs });
        return result;
    })();
}

// ── États publiés de chaque type de contenu ─────────────────────
//
// Seuls les champs que le robot publie entrent dans l'état comparé. Une
// fonction renvoie null quand le contenu n'existe pas ou ne porte aucun texte
// de l'admin (un panneau de tickets resté sur les textes par défaut de Quasar
// n'est pas un contenu de tiers). Ces fonctions lisent les tables de contenu,
// JAMAIS legal_journal.
//
// Identifiants (content_id) : toujours préfixés par le serveur Discord, pour que
// l'export puisse filtrer par serveur (--guild-id) sans colonne de plus.

const has = (v) => v !== null && v !== undefined && v !== '';

const snapshots = {
    /** content_id `<guild>:<id>` */
    embed(db, id) {
        if (id === null || id === undefined) return null;
        const row = db.prepare(`SELECT data, mention_roles, mention_users, mention_everyone, mention_here
            FROM embeds WHERE id = ?`).get(id);
        return row ? { ...row } : null;
    },

    /** content_id `<guild>:<nom>` — le nom est publié (c'est la commande slash). */
    customCommand(db, guildId, name) {
        const row = db.prepare('SELECT name, response, embed_id FROM custom_commands WHERE guild_id = ? AND name = ?')
            .get(guildId, name);
        return row ? { ...row } : null;
    },

    /** content_id `<guild>` ; kind = 'welcome' | 'leave' */
    welcome(db, guildId, kind) {
        const row = db.prepare(`SELECT ${kind}_message AS message, ${kind}_embed AS embed
            FROM welcome_config WHERE guild_id = ?`).get(guildId);
        if (!row || (!has(row.message) && !has(row.embed))) return null;
        return { message: row.message ?? null, embed: row.embed ?? null };
    },

    /** content_id `<guild>:<id>` */
    scheduled(db, id) {
        const row = db.prepare(`SELECT content_type, content_text, embed_id,
            mention_roles, mention_users, mention_everyone, mention_here
            FROM scheduled_messages WHERE id = ?`).get(id);
        return row ? { ...row } : null;
    },

    /** content_id `<guild>:<id>` — titre et entrées (emoji, rôle, description). */
    reactionPanel(db, id) {
        const panel = db.prepare('SELECT title FROM reaction_panels WHERE id = ?').get(id);
        if (!panel) return null;
        const entries = db.prepare('SELECT emoji, role_id, description FROM reaction_roles WHERE panel_id = ? ORDER BY emoji')
            .all(id).map(e => [e.emoji, e.role_id, e.description ?? null]);
        return { title: panel.title ?? null, entries };
    },

    /** content_id `<guild>` — message d'accueil des tickets et textes du panneau. */
    ticketTexts(db, guildId) {
        const row = db.prepare('SELECT welcome_message, panel_title, panel_description FROM ticket_config WHERE guild_id = ?')
            .get(guildId);
        if (!row || (!has(row.welcome_message) && !has(row.panel_title) && !has(row.panel_description))) return null;
        return { ...row };
    },

    /** content_id `<guild>:<catégorie>:<membre>` — nom choisi par le membre. */
    tempvoiceName(db, guildId, userId, categoryId) {
        const row = db.prepare(`SELECT channel_name FROM tempvoice_preferences
            WHERE guild_id = ? AND user_id = ? AND category_id = ?`).get(guildId, userId, categoryId ?? '');
        return row && has(row.channel_name) ? { channel_name: row.channel_name } : null;
    },
};

/**
 * Options de withJournal pour le nom de salon vocal choisi par un membre
 * (`/voice name`, bouton « Renommer », réinitialisation des préférences).
 * La limite de places, réglage technique, n'entre pas dans l'état comparé.
 */
function tempvoiceName(db, guildId, userId, categoryId) {
    return {
        contentId: `${guildId}:${categoryId ?? ''}:${userId}`,
        contentType: 'tempvoice_name',
        snapshot: () => snapshots.tempvoiceName(db, guildId, userId, categoryId),
    };
}

// ── Purge ───────────────────────────────────────────────────────

/** Supprime les lignes de plus de 365 jours. Renvoie le nombre de lignes retirées. */
function purgeLegalJournal(db, nowMs = Date.now()) {
    return db.prepare('DELETE FROM legal_journal WHERE occurred_at < ?')
        .run(journalTimestamp(nowMs - LEGAL_RETENTION_MS)).changes;
}

let purgeHandle = null;

/** Purge au démarrage, puis toutes les 24 heures. */
function start(getDb) {
    if (purgeHandle) return;
    const run = () => {
        try {
            purgeLegalJournal(getDb());
        } catch (err) {
            // Le message seul : rien du journal ne doit sortir dans les logs.
            console.error('[Quasar] Purge du journal de conservation impossible :', err.message);
        }
    };
    run();
    purgeHandle = setInterval(run, PURGE_INTERVAL_MS);
    if (purgeHandle.unref) purgeHandle.unref();
}

function stop() {
    if (purgeHandle) clearInterval(purgeHandle);
    purgeHandle = null;
}

module.exports = {
    LEGAL_RETENTION_DAYS,
    connectionIp,
    connectionProtocol,
    fromRequest,
    fromInteraction,
    onBehalfOf,
    record,
    recordChange,
    withJournal,
    operationBetween,
    snapshots,
    tempvoiceName,
    purgeLegalJournal,
    start,
    stop,
};
