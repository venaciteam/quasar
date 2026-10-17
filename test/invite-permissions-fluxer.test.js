// Garde-fou : le lien d'invitation « moindre privilège » du README, côté Fluxer.
//
// Le compagnon d'invite-permissions.test.js, qui tient le masque Discord. Celui-ci
// existe pour une raison précise : les deux plateformes n'attribuent PAS les mêmes
// bits aux mêmes noms, et un masque recopié d'un côté à l'autre serait faux sans
// que rien ne le dise — une personne qui suit le conseil du moindre privilège
// obtiendrait un bot amputé, sans message d'erreur à lire.
//
// La source d'autorité est `bot/platform/fluxer/permissions.js`, dont la table est
// tirée de `permissions.mdx` et vérifiée exhaustive à son chargement. Le README
// n'a donc jamais à porter un nombre calculé à la main.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { BITS } = require('../bot/platform/fluxer/permissions');

// Le jeu minimal, nom canonique par nom canonique, avec l'usage qui le justifie.
// Une permission sans usage identifiable n'a rien à faire dans un lien
// d'invitation : c'est ce principe qui a fait retirer MANAGE_GUILD de cette
// liste, nécessaire sur Discord pour l'AutoMod et le mode panique à échéance,
// dont ni l'un ni l'autre n'existe sur Fluxer.
const MINIMALES = {
    VIEW_CHANNEL: 'voir les salons où répondre, et y lire les commandes préfixées',
    SEND_MESSAGES: 'répondre, poser les panneaux et les messages de bienvenue',
    ADD_REACTIONS: 'poser les réactions des panneaux — l\'interface elle-même',
    MANAGE_MESSAGES: '!clear, et retirer la réaction d\'une autre personne',
    EMBED_LINKS: 'la quasi-totalité des réponses sont des embeds',
    ATTACH_FILES: 'remettre le transcript d\'un ticket à sa fermeture',
    READ_MESSAGE_HISTORY: '!clear et la constitution des transcripts',
    MANAGE_CHANNELS: 'tickets et salons vocaux temporaires',
    MOVE_MEMBERS: 'déplacer la personne dans son salon vocal temporaire',
    MANAGE_ROLES: 'autoroles, panneaux de rôles, rôles vocaux',
    KICK_MEMBERS: '!kick et les expulsions automatiques',
    BAN_MEMBERS: '!ban et la levée des bannissements temporaires',
    MODERATE_MEMBERS: 'toutes les exclusions temporaires',
};

function masque() {
    let total = 0n;
    for (const nom of Object.keys(MINIMALES)) {
        assert.equal(typeof BITS[nom], 'bigint', `${nom} n'existe pas dans la table Fluxer`);
        total |= BITS[nom];
    }
    return total;
}

function liensFluxerDuReadme() {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    return [...readme.matchAll(/api\.fluxer\.app\/v1\/oauth2\/authorize\?[^\s`)]*/g)].map(m => m[0]);
}

test('le README propose un lien d\'invitation Fluxer, et il ne demande que le scope bot', () => {
    // `applications.commands` n'existe pas au registre de scopes de Fluxer, et un
    // scope inconnu fait rejeter toute la demande d'autorisation : le lien serait
    // mort. C'est aussi ce que déclare api/routes/auth.js (`scopesBot: 'bot'`).
    const liens = liensFluxerDuReadme();
    assert.ok(liens.length >= 2,
        `le README doit proposer le lien Administrateur et le lien minimal : ${liens.length} trouvé(s)`);
    for (const lien of liens) {
        assert.ok(lien.includes('scope=bot'), `lien sans scope bot : ${lien}`);
        assert.ok(!lien.includes('applications.commands'),
            `scope inconnu de Fluxer dans le README : ${lien}`);
    }
});

test('le masque minimal du README correspond aux bits que Fluxer définit', () => {
    const attendu = String(masque());
    const masques = liensFluxerDuReadme()
        .map(lien => (/permissions=(\d+)/.exec(lien) || [])[1])
        .filter(Boolean);

    assert.ok(masques.includes('8'),
        'le lien Administrateur (permissions=8) a disparu du README');
    assert.ok(masques.includes(attendu),
        `masque minimal du README obsolète. Attendu ${attendu} pour : ${Object.keys(MINIMALES).join(', ')}`
        + ` — trouvé ${masques.join(', ')}`);
});

test('le masque Fluxer diffère du masque Discord, et c\'est voulu', () => {
    // MANAGE_GUILD est la différence, et elle est justifiée : sans AutoMod ni
    // pause d'invitations à échéance, Fluxer n'a rien à en faire. Si les deux
    // masques devenaient identiques, c'est qu'une liste a été recopiée.
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const discord = (/discord\.com[^\s`]*permissions=(\d+)/.exec(readme) || [])[1];
    assert.ok(discord, 'le lien d\'invitation Discord a disparu du README');
    assert.notEqual(discord, String(masque()),
        'les deux masques sont identiques : MANAGE_GUILD a été ajoutée côté Fluxer sans usage');
    assert.equal(BigInt(discord) & ~BITS.MANAGE_GUILD, masque(),
        'les deux jeux minimaux ne diffèrent plus par la seule MANAGE_GUILD : '
        + 'une permission a été ajoutée ou retirée d\'un seul côté');
});

test('chaque permission du masque Fluxer est justifiée par un usage', () => {
    for (const [nom, raison] of Object.entries(MINIMALES)) {
        assert.ok(raison && raison.length > 8, `${nom} n'a pas de justification lisible`);
    }
});
