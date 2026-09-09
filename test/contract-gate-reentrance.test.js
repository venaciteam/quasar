// Garde-fou : un seul portail d'acceptation du contrat à la fois.
//
// Régression signalée en preview : « j'ai dû cliquer deux fois sur accepter ».
// `checkContractGate()` construisait et empilait un calque à CHAQUE appel, sans
// jamais tester l'identifiant qu'elle pose pourtant. Tant qu'il n'y avait qu'un
// seul appelant — le démarrage du dashboard — le défaut restait invisible.
// L'ajout d'un second appelant l'a réveillé : le helper API rouvre le portail
// quand le serveur répond 403 « contrat non accepté », si bien que plusieurs
// requêtes parties en parallèle peuvent le demander en même temps. Autant de
// calques superposés, et une acceptation à cliquer par calque, chacun
// réapparaissant sous le précédent.
//
// Le module est du script navigateur : il est chargé ici dans un bac à sable
// avec un document minimal, ce qui suffit à observer le nombre de calques créés.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Document minimal : uniquement ce que contractGate.js touche réellement. */
function creerBacASable() {
    const creesDansLeCorps = [];

    const creerElement = () => {
        const el = {
            id: '', className: '', innerHTML: '', textContent: '', style: {},
            children: [],
            setAttribute() {},
            addEventListener() {},
            appendChild(enfant) { this.children.push(enfant); return enfant; },
            prepend(enfant) { this.children.unshift(enfant); return enfant; },
            remove() {
                const i = creesDansLeCorps.indexOf(this);
                if (i !== -1) creesDansLeCorps.splice(i, 1);
            },
            querySelector() { return creerElement(); },
            querySelectorAll() { return []; },
            focus() {},
        };
        return el;
    };

    const body = creerElement();
    body.appendChild = (enfant) => { creesDansLeCorps.push(enfant); return enfant; };
    body.prepend = (enfant) => { creesDansLeCorps.unshift(enfant); return enfant; };

    const document = {
        body,
        head: creerElement(),
        createElement: creerElement,
        getElementById: (id) => creesDansLeCorps.find((e) => e.id === id) || null,
        querySelector: () => null,
        addEventListener() {},
    };

    const sandbox = {
        document,
        window: { location: { href: '' } },
        localStorage: { getItem: () => 'jeton-de-test', removeItem() {} },
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        clearTimeout,
        // Le portail interroge /api/contract/status au chargement. On ne répond
        // jamais : le portail reste donc ouvert, ce qui est exactement l'état
        // qu'on veut observer.
        fetch: () => new Promise(() => {}),
    };
    sandbox.window.document = document;
    sandbox.globalThis = sandbox;

    const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'contractGate.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return { sandbox, creesDansLeCorps };
}

test('deux appels concurrents ne créent qu\'un seul portail', () => {
    const { sandbox, creesDansLeCorps } = creerBacASable();

    const a = sandbox.window.checkContractGate();
    const b = sandbox.window.checkContractGate();
    const c = sandbox.window.checkContractGate();

    assert.equal(a, b, 'les appels concurrents doivent partager la même promesse');
    assert.equal(b, c);

    const calques = creesDansLeCorps.filter((e) => e.id === 'contract-gate-overlay');
    assert.equal(calques.length, 1,
        `un seul calque attendu, ${calques.length} créés : c'est un clic « J'accepte » par calque`);
});

test('checkContractGate est bien exposé et rend une promesse', () => {
    const { sandbox } = creerBacASable();
    assert.equal(typeof sandbox.window.checkContractGate, 'function');
    // `instanceof Promise` ne traverse pas les contextes : la promesse est
    // fabriquée dans le bac à sable, avec son propre Promise. On teste donc le
    // contrat observable, pas l'identité de la classe.
    assert.equal(typeof sandbox.window.checkContractGate().then, 'function');
});
