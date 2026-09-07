// Garde-fou : identification du client derrière les relais.
//
// Raison d'être : le limiteur de débit du relais de signalement ne vaut que par
// la clé qu'il compte. Une clé identique pour tout le monde ne le rend pas
// inefficace, elle le retourne — il devient un interrupteur global, qu'un seul
// envoi massif referme sur l'ensemble des personnes qui visitent le site. C'est
// pire que pas de limiteur du tout, et ça ne se voit dans aucun journal.
//
// Le piège concret : l'instance Venacity a DEUX relais chaînés, Cloudflare puis
// coolify-proxy (Traefik). Avec « trust proxy » figé à 1, Express ne retire
// qu'un maillon et rend l'adresse de bordure Cloudflare, la même pour la Terre
// entière. D'où TRUST_PROXY, réglable par l'exploitante ou l'exploitant.
process.env.QUASAR_DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resoudreTrustProxy, cleClient } = require('../api');

function avec(valeur, fn) {
    const avant = process.env.TRUST_PROXY;
    if (valeur === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = valeur;
    try { fn(); } finally {
        if (avant === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = avant;
    }
}

test('defaut ferme : sans declaration, aucun relais n est cru', () => {
    avec(undefined, () => assert.equal(resoudreTrustProxy(), false));
    avec('', () => assert.equal(resoudreTrustProxy(), false));
    avec('   ', () => assert.equal(resoudreTrustProxy(), false));
});

test('un nombre de sauts est rendu tel quel', () => {
    avec('1', () => assert.equal(resoudreTrustProxy(), 1));
    avec('2', () => assert.equal(resoudreTrustProxy(), 2));
    avec('0', () => assert.equal(resoudreTrustProxy(), 0));
});

test('les booleens et les listes d adresses restent utilisables', () => {
    avec('true', () => assert.equal(resoudreTrustProxy(), true));
    avec('false', () => assert.equal(resoudreTrustProxy(), false));
    avec('10.0.0.0/8, 172.16.0.0/12', () => assert.equal(resoudreTrustProxy(), '10.0.0.0/8, 172.16.0.0/12'));
});

test('une valeur negative ou absurde ne devient pas un nombre de sauts', () => {
    // Passer -1 a Express jetterait ; on retombe sur la branche « liste
    // d adresses », que proxy-addr rejettera explicitement au montage plutot
    // que de faire silencieusement confiance a tout le monde.
    avec('-1', () => assert.equal(resoudreTrustProxy(), '-1'));
});

test('sans relais declare, CF-Connecting-IP est ignore', () => {
    // Sinon n importe qui inventerait cet en-tete pour repartir de zero a chaque
    // requete, et le limiteur ne compterait plus jamais deux fois la meme
    // personne.
    avec(undefined, () => {
        const req = { headers: { 'cf-connecting-ip': '203.0.113.9' }, ip: '198.51.100.1' };
        assert.equal(cleClient(req), '198.51.100.1');
    });
});

test('avec un relais declare, CF-Connecting-IP prime sur req.ip', () => {
    avec('2', () => {
        const req = { headers: { 'cf-connecting-ip': '203.0.113.9' }, ip: '198.51.100.1' };
        assert.equal(cleClient(req), '203.0.113.9');
    });
});

test('deux clients distincts derriere le meme relais ne partagent pas leur compteur', () => {
    avec('2', () => {
        const a = cleClient({ headers: { 'cf-connecting-ip': '203.0.113.1' }, ip: '198.51.100.1' });
        const b = cleClient({ headers: { 'cf-connecting-ip': '203.0.113.2' }, ip: '198.51.100.1' });
        assert.notEqual(a, b);
    });
});

test('la cle ne vaut jamais undefined, meme sans adresse exploitable', () => {
    // Une cle undefined ferait tomber tout le monde dans le meme seau : c est
    // exactement la panne que ce fichier existe pour empecher.
    avec('2', () => {
        assert.equal(cleClient({ headers: {}, ip: undefined, socket: {} }), 'inconnue');
    });
});
