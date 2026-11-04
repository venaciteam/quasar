#!/usr/bin/env node
// scripts/legal-export.js — Extraction du journal de conservation LCEN.
//
// SEULE voie d'accès au journal (VNCT-Conservation-LCEN-DA.md, « Communication
// aux autorités ») : à lancer à la main dans le conteneur, uniquement pour
// répondre à une réquisition d'une autorité judiciaire ou administrative
// légalement habilitée. L'exploitante consigne chaque réquisition dans son
// registre, hors du service.
//
//   docker exec <conteneur> node scripts/legal-export.js --guild-id <serveur>
//   docker exec <conteneur> node scripts/legal-export.js --content-id <id>
//   docker exec <conteneur> node scripts/legal-export.js --author-id <id Discord>
//   docker exec <conteneur> node scripts/legal-export.js --from 2026-11-01 --to 2026-11-30
//
// Les filtres se combinent (ET). Au moins un est obligatoire : pas d'export
// intégral par mégarde. --guild-id retient les contenus d'un serveur Discord
// (leur content_id commence par son identifiant). --from et --to sont
// inclusifs, en UTC ; une date seule (AAAA-MM-JJ) vaut le début du jour pour
// --from et la fin du jour pour --to.
// Sortie : JSON sur la sortie standard. Erreurs : sortie d'erreur, code 2.
//
// Le script ouvre la base en LECTURE SEULE et n'importe pas
// api/services/database.js (qui crée le schéma, migre et écrirait dans la
// base). Le chemin suit la même règle que database.js.

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.QUASAR_DB_PATH || path.join(__dirname, '..', 'data', 'quasar.db');
const SNOWFLAKE = /^\d{17,20}$/;

const USAGE =
    'Usage : node scripts/legal-export.js [--guild-id <id>] [--content-id <id>] [--author-id <id>] ' +
    '[--from <date>] [--to <date>]  (au moins un filtre)';

function fail(message) {
    process.stderr.write(`${message}\n${USAGE}\n`);
    process.exit(2);
}

function parseArgs(argv) {
    const known = {
        '--guild-id': 'guildId', '--content-id': 'contentId', '--author-id': 'authorId', '--from': 'from', '--to': 'to',
    };
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const key = known[argv[i]];
        if (!key) fail(`Argument inconnu : ${argv[i]}`);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) fail(`Valeur manquante pour ${argv[i]}`);
        out[key] = value;
        i++;
    }
    return out;
}

// Normalise une date vers le format du journal (ISO 8601 UTC à la seconde).
function toJournalTimestamp(raw, endOfDay) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const ms = Date.parse(dateOnly ? `${raw}T${endOfDay ? '23:59:59' : '00:00:00'}Z` : raw);
    if (Number.isNaN(ms)) fail(`Date invalide : ${raw}`);
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const args = parseArgs(process.argv.slice(2));
if (!args.guildId && !args.contentId && !args.authorId && !args.from && !args.to) fail('Aucun filtre fourni.');
// Chiffres seuls : la valeur entre dans un LIKE, aucun joker ne doit passer.
if (args.guildId && !SNOWFLAKE.test(args.guildId)) fail(`Identifiant de serveur invalide : ${args.guildId}`);

const where = [];
const params = [];
if (args.guildId) { where.push('(content_id = ? OR content_id LIKE ?)'); params.push(args.guildId, `${args.guildId}:%`); }
if (args.contentId) { where.push('content_id = ?'); params.push(args.contentId); }
if (args.authorId) { where.push('author_id = ?'); params.push(args.authorId); }
if (args.from) { where.push('occurred_at >= ?'); params.push(toJournalTimestamp(args.from, false)); }
if (args.to) { where.push('occurred_at <= ?'); params.push(toJournalTimestamp(args.to, true)); }

let db;
try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
    fail(`Base illisible (${DB_PATH}) : ${e.message}`);
}

let entries;
try {
    entries = db.prepare(`
        SELECT id, content_id, content_type, operation, occurred_at, ip, protocol, author_id
        FROM legal_journal
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at ASC, id ASC
    `).all(...params);
} catch (e) {
    fail(`Lecture du journal impossible : ${e.message}`);
} finally {
    db.close();
}

process.stdout.write(JSON.stringify({
    service: 'quasar',
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    filters: {
        guild_id: args.guildId ?? null,
        content_id: args.contentId ?? null,
        author_id: args.authorId ?? null,
        from: args.from ? toJournalTimestamp(args.from, false) : null,
        to: args.to ? toJournalTimestamp(args.to, true) : null,
    },
    count: entries.length,
    entries,
}, null, 2) + '\n');
