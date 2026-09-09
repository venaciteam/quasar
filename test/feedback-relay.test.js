// Garde-fou du relais de signalement — /api/feedback.
//
// Cette route est publique, non authentifiée, montée dans les trois modes, et
// elle publie dans un salon Discord. Deux failles y vivaient ensemble :
//
//  1. relayRaw() empilait les chunks d'un multipart sans aucun plafond. Un
//     unique POST de 2 Go tuait le processus par OOM — donc aussi le bot
//     Discord, qui tourne dans le même processus.
//  2. Le corps était relayé BRUT vers le webhook dès qu'il contenait
//     payload_json : n'importe qui pouvait écrire ce qu'il voulait dans le
//     salon, mentions @everyone comprises, en boucle et depuis n'importe où.
//
// Ces tests figent le contrat corrigé : corps borné, enveloppe Discord
// reconstruite champ par champ côté serveur, mentions neutralisées, débit
// limité par IP.
//
// QUASAR_DB_PATH doit être posé AVANT le require de la chaîne base de données.
process.env.QUASAR_DB_PATH = ':memory:';
// Lues au montage de la route : à poser avant createApi().
process.env.FEEDBACK_WEBHOOK_URL = 'https://discord.invalid/api/webhooks/test';
process.env.REPORT_RELAY_URL = 'https://sema.invalid';
// Le limiteur compte par client, et l'identification du client depend du nombre
// de relais declares (voir test/trust-proxy.test.js). Sans TRUST_PROXY, Quasar
// suppose a raison qu'aucun relais n'est devant lui : toutes les requetes de ce
// fichier viendraient de 127.0.0.1 et se videraient le meme quota. On se place
// donc dans la configuration « un relais devant », qui est celle que les tests
// simulent avec X-Forwarded-For et CF-Connecting-IP.
process.env.TRUST_PROXY = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApi } = require('../api');

// Mode `bot` : ni vitrine, ni polling du design system, donc aucun appel
// sortant hors de ceux que ce test provoque lui-même.
const app = createApi({}, 'bot');
let server;
let base;

// Interception de fetch : rien ne doit sortir vers le vrai webhook, et c'est
// ICI que se lit ce que Quasar envoie réellement à Discord.
const realFetch = global.fetch;
let sent = [];

before(async () => {
    global.fetch = async (url, options = {}) => {
        sent.push({ url: String(url), options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
            text: async () => '',
        };
    };
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    global.fetch = realFetch;
    server.close();
});

beforeEach(() => { sent = []; });

/**
 * POST brut. `ip` alimente X-Forwarded-For : le limiteur de débit compte par
 * adresse, chaque test a donc besoin de la sienne pour ne pas consommer le
 * quota des autres. C'est aussi la contre-épreuve du réglage `trust proxy`.
 */
function post(path, { ip, contentType, body }) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const req = http.request(`${base}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Content-Length': payload.length,
                'X-Forwarded-For': ip,
                // Derriere Cloudflare c'est cet en-tete qui porte l'adresse
                // reelle, et c'est donc lui que le limiteur regarde en premier
                // des qu'un relais est declare.
                'CF-Connecting-IP': ip,
            },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        // Le 413 coupe la requête en plein envoi : l'erreur d'écriture qui suit
        // arrive APRÈS la réponse et ne doit pas faire échouer le test.
        let answered = false;
        req.on('response', () => { answered = true; });
        req.on('error', (err) => { if (!answered) reject(err); });
        req.end(payload);
    });
}

const BOUNDARY = 'vnctboundary';

/** Assemble un multipart/form-data à partir de parties déclarées. */
function multipart(parts) {
    const chunks = [];
    for (const part of parts) {
        let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if (part.filename) head += `; filename="${part.filename}"`;
        head += '\r\n';
        if (part.type) head += `Content-Type: ${part.type}\r\n`;
        chunks.push(Buffer.from(`${head}\r\n`));
        chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
}

const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

// Embed tel que le produit réellement le design system VNCT en repli Discord.
function dsEmbed() {
    return {
        title: '🐛 Signaler un bug — Quasar',
        color: 0xF04050,
        timestamp: new Date().toISOString(),
        footer: { text: 'Quasar v4.7.1 | VNCT Design System v2.5.0' },
        fields: [
            { name: '📝 Description', value: 'Le bouton ne répond plus.', inline: false },
            { name: '🌐 URL', value: 'https://quasar.vena.city/dashboard', inline: true },
        ],
    };
}

test('un corps au-delà du plafond est refusé en 413, sans tuer le processus', async () => {
    // 11 Mo : le plafond est à 10. Le corps n'est jamais entièrement mis en
    // mémoire — c'est tout l'objet du correctif.
    const body = Buffer.alloc(11 * 1024 * 1024, 0x61);
    const res = await post('/api/feedback', { ip: '203.0.113.1', contentType: MULTIPART_TYPE, body });
    assert.equal(res.status, 413);
    assert.equal(sent.length, 0, 'rien ne doit partir vers le webhook ni vers Sema');
});

test('un payload_json fourni par l\'appelant n\'est jamais relayé tel quel', async () => {
    // L'attaque exacte du signalement : @everyone + allowed_mentions permissif.
    const hostile = JSON.stringify({
        content: '@everyone offre exceptionnelle : https://exemple.invalid',
        allowed_mentions: { parse: ['everyone'] },
        username: 'Venacity',
        embeds: [dsEmbed()],
    });
    const body = multipart([
        { name: 'payload_json', data: hostile },
        { name: 'file1', filename: 'screenshot-0.png', type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
    ]);
    const res = await post('/api/feedback', { ip: '203.0.113.2', contentType: MULTIPART_TYPE, body });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
});

test('le chemin JSON refuse toute clé hors embeds', async () => {
    const res = await post('/api/feedback', {
        ip: '203.0.113.3',
        contentType: 'application/json',
        body: JSON.stringify({ content: '@everyone', embeds: [dsEmbed()] }),
    });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
});

test('un embed malformé est refusé en 400', async () => {
    const cases = [
        { embeds: 'pas un tableau' },
        { embeds: [] },
        { embeds: [{ fields: 'pas un tableau' }] },
        { embeds: [{ title: 42 }] },
        { embeds: [{ footer: { text: 12 } }] },
        { embeds: [{ color: 'rouge' }] },
        { embeds: [{}] },
    ];
    let ip = 10;
    for (const payload of cases) {
        const res = await post('/api/feedback', {
            ip: `203.0.113.${ip++}`,
            contentType: 'application/json',
            body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400, `attendu 400 pour ${JSON.stringify(payload)}`);
    }
    assert.equal(sent.length, 0);
});

test('le chemin JSON nominal part avec allowed_mentions vide', async () => {
    const res = await post('/api/feedback', {
        ip: '203.0.113.4',
        contentType: 'application/json',
        body: JSON.stringify({ embeds: [dsEmbed()] }),
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, process.env.FEEDBACK_WEBHOOK_URL);

    const payload = JSON.parse(sent[0].options.body);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].title, dsEmbed().title);
    assert.equal(payload.embeds[0].fields.length, 2);
});

test('le texte reçu est borné aux limites de l\'API Discord', async () => {
    const res = await post('/api/feedback', {
        ip: '203.0.113.5',
        contentType: 'application/json',
        body: JSON.stringify({
            // Volontairement sous les 100 ko d'express.json(), qui borne déjà
            // ce chemin-là : c'est le découpage de Discord que l'on teste ici.
            embeds: [{
                title: 'T'.repeat(5000),
                description: 'D'.repeat(9000),
                fields: Array.from({ length: 40 }, () => ({ name: 'n', value: 'v'.repeat(2000) })),
            }],
        }),
    });
    assert.equal(res.status, 200);
    const embed = JSON.parse(sent[0].options.body).embeds[0];
    assert.equal(embed.title.length, 256);
    assert.equal(embed.description.length, 4096);
    assert.equal(embed.fields.length, 25);
    assert.equal(embed.fields[0].value.length, 1024);
});

test('le repli Discord avec captures repart d\'un payload_json reconstruit', async () => {
    const body = multipart([
        { name: 'payload_json', data: JSON.stringify({ embeds: [dsEmbed()] }) },
        { name: 'file1', filename: '../../evil.svg', type: 'image/png', data: Buffer.from('capture-1') },
        { name: 'file2', filename: 'note.txt', type: 'text/plain', data: Buffer.from('pas une capture') },
    ]);
    const res = await post('/api/feedback', { ip: '203.0.113.6', contentType: MULTIPART_TYPE, body });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, process.env.FEEDBACK_WEBHOOK_URL);

    const form = sent[0].options.body;
    assert.ok(form instanceof FormData, 'le corps doit être un FormData reconstruit');
    const payload = JSON.parse(form.get('payload_json'));
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(payload.content, undefined);
    // La capture survit, renommée côté serveur ; le fichier non-image est écarté.
    assert.equal(form.get('file1').name, 'screenshot-0.png');
    assert.equal(form.get('file2'), null);
    assert.deepEqual(payload.embeds[0].image, { url: 'attachment://screenshot-0.png' });
});

test('le contrat Sema à plat continue de partir vers Sema, intact', async () => {
    // Contre-épreuve : le durcissement du chemin Discord ne doit pas toucher au
    // chemin nominal, celui qu'emprunte le formulaire du dashboard.
    const body = multipart([
        { name: 'type', data: 'bug' },
        { name: 'service', data: 'Quasar' },
        { name: 'description', data: 'Le bouton ne répond plus.' },
        { name: 'screenshots', filename: 'capture.png', type: 'image/png', data: Buffer.from('capture') },
    ]);
    const res = await post('/api/feedback', { ip: '203.0.113.7', contentType: MULTIPART_TYPE, body });
    assert.equal(res.status, 201);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://sema.invalid/api/public/report');
    assert.ok(Buffer.isBuffer(sent[0].options.body));
    assert.equal(sent[0].options.body.length, body.length);
});

test('le limiteur de débit coupe le flood, par adresse', async () => {
    const flood = { ip: '203.0.113.99', contentType: 'application/json', body: JSON.stringify({ embeds: [dsEmbed()] }) };
    for (let i = 0; i < 5; i++) {
        const res = await post('/api/feedback', flood);
        assert.equal(res.status, 200, `envoi ${i + 1} sur 5 dans le quota`);
    }
    const blocked = await post('/api/feedback', flood);
    assert.equal(blocked.status, 429);
    assert.equal(sent.length, 5, 'la requête refusée ne part pas vers Discord');

    // Une autre adresse n'est pas emportée : sans `trust proxy`, toutes les
    // requêtes partageraient l'IP du proxy et le limiteur serait un
    // interrupteur global.
    const other = await post('/api/feedback', { ...flood, ip: '203.0.113.100' });
    assert.equal(other.status, 200);
});
