// ═══════════════════════════════════════════════════════════════
//  Types de salon canoniques
//
//  La DA (§2.3) classe `ChannelType` parmi les correspondances mécaniques mais
//  n'en publie pas la table : elle est écrite ici, restreinte aux quatre types
//  que Quasar manipule réellement (texte, vocal, catégorie, conférence). Une
//  table exhaustive de l'API Discord serait du bruit, et chaque entrée non
//  utilisée serait une entrée à vérifier côté Fluxer sans raison.
//
//  Comme pour les permissions, l'adaptateur traduit ; le code métier ne
//  manipule que ces noms.
// ═══════════════════════════════════════════════════════════════

const TYPES_CANAL = Object.freeze(['texte', 'vocal', 'categorie', 'conference']);

const ENSEMBLE_TYPES_CANAL = new Set(TYPES_CANAL);

function estTypeCanalCanonique(nom) {
    return typeof nom === 'string' && ENSEMBLE_TYPES_CANAL.has(nom);
}

function exigerTypeCanalCanonique(nom) {
    if (!estTypeCanalCanonique(nom)) {
        throw new Error(`Type de salon inconnu : "${nom}". Valeurs acceptées : ${TYPES_CANAL.join(', ')}.`);
    }
    return nom;
}

module.exports = { TYPES_CANAL, estTypeCanalCanonique, exigerTypeCanalCanonique };
