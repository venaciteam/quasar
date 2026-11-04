// ═══════════════════════════════════════════════════════════════
//  Table de correspondance des types de salon — Fluxer
//
//  Source : `fluxer_docs/src/content/docs/http-api/channels.mdx`, table
//  « Channel types », et `guild-channels.mdx`, table « Guild channel types »
//  qui énumère « exactly the values Create guild channel accepts in type ».
//
//    0   GUILD_TEXT      | 1   DM        | 2   GUILD_VOICE
//    3   GROUP_DM        | 4   GUILD_CATEGORY
//    998 GUILD_LINK      | 999 DM_PERSONAL_NOTES
//
//  ⚠️ DEUX MANQUES, et ils ne sont pas du même ordre :
//
//   • `conference` (salon de conférence, ChannelType.GuildStageVoice côté
//     Discord) N'EXISTE PAS sur Fluxer. Le vocabulaire neutre le déclare
//     pourtant (bot/platform/channels.js, contrat figé). On le déclare donc ici
//     à `null` — « connu du vocabulaire, absent de la plateforme » — plutôt que
//     de le replier sur `vocal`, qui créerait un salon vocal ordinaire là où on
//     demandait une conférence, sans un mot.
//
//   • Fluxer n'a AUCUN type de fil. `channels.mdx` n'en déclare pas, et
//     `fluxer_gateway/src/utils/event_atoms.erl` ne dispatche aucun THREAD_*.
//     C'est ce qui fixe la capacité `fils` (cf. index.js).
//
//  `GUILD_LINK` (998) n'a pas de nom canonique : Quasar ne manipule pas de
//  salon-lien, et lui en inventer un obligerait à le porter aussi côté Discord.
// ═══════════════════════════════════════════════════════════════

const { TYPES_CANAL } = require('../channels');

// Nom canonique -> type Fluxer. `null` = le vocabulaire le connaît, la
// plateforme ne l'a pas.
const TYPES = Object.freeze({
    texte: 0,
    vocal: 2,
    categorie: 4,
    conference: null,
});

// Vérifiée exhaustive au chargement : un type ajouté au vocabulaire neutre sans
// être DÉCLARÉ ici doit faire échouer le démarrage. On teste la présence de la
// clé, pas sa valeur — `conference: null` est une déclaration délibérée, une
// clé absente est un oubli.
const manquants = TYPES_CANAL.filter(nom => !(nom in TYPES));
if (manquants.length > 0) {
    throw new Error(
        `Table des types de salon Fluxer incomplète : ${manquants.join(', ')}. `
        + 'Ajoutez la correspondance dans bot/platform/fluxer/channels.js.'
    );
}

/** Types que Quasar sait nommer ET que Fluxer sait créer. */
const TYPES_SUPPORTES = Object.freeze(
    Object.entries(TYPES).filter(([, type]) => type !== null).map(([nom]) => nom)
);

// Sens inverse. Un type que Quasar ne manipule pas (DM, groupe, lien, notes)
// rend `null` : le code métier voit « type inconnu de mon vocabulaire », ce qui
// est exact et testable.
const NOMS_PAR_TYPE = Object.freeze(
    Object.fromEntries(
        Object.entries(TYPES).filter(([, type]) => type !== null).map(([nom, type]) => [type, nom])
    )
);

/**
 * @param {string[]|string} noms
 * @returns {number[]}
 * @throws si un nom désigne un type que Fluxer n'a pas
 */
function versTypesFluxer(noms) {
    return (Array.isArray(noms) ? noms : [noms]).map((nom) => {
        if (!(nom in TYPES)) throw new Error(`Type de salon inconnu côté Fluxer : "${nom}".`);
        const type = TYPES[nom];
        if (type === null) {
            throw new Error(
                `Fluxer n'a pas de salon « ${nom} » : sa table « Channel types » `
                + `(http-api/channels.mdx) ne déclare que ${TYPES_SUPPORTES.join(', ')}. `
                + 'Le code métier doit tester une capacité ou choisir un autre type.'
            );
        }
        return type;
    });
}

/** @returns {string|null} nom canonique, ou null si hors vocabulaire de Quasar */
function versNomCanonique(type) {
    return NOMS_PAR_TYPE[type] ?? null;
}

module.exports = { TYPES, TYPES_SUPPORTES, NOMS_PAR_TYPE, versTypesFluxer, versNomCanonique };
