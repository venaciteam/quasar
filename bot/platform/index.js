// ═══════════════════════════════════════════════════════════════
//  Sélection de la plateforme au démarrage
//
//  Point d'entrée unique de la couche d'abstraction. Rien au-dessus de
//  `bot/platform/` ne sait sur quelle plateforme il tourne : une commande
//  reçoit un contexte, appelle des méthodes neutres, retourne. C'est
//  l'adaptateur qui traduit.
//
//  Le défaut est volontairement `discord` : l'absence de QUASAR_PLATFORM doit
//  laisser fonctionner à l'identique toutes les installations existantes, y
//  compris auto-hébergées, sans toucher à leur .env.
// ═══════════════════════════════════════════════════════════════

const PLATFORMS = {
    discord: () => require('./discord'),
    fluxer: () => require('./fluxer'),
};

const PLATEFORME_PAR_DEFAUT = 'discord';

/**
 * Nom de la plateforme demandée, SANS charger son adaptateur.
 *
 * Cette séparation n'est pas un détail : le garde de configuration d'index.js
 * doit savoir quelles variables exiger AVANT de charger quoi que ce soit. En
 * mode `fluxer`, charger l'adaptateur d'abord ferait échouer le démarrage sur
 * un module manquant ou sur une connexion refusée, là où la vraie cause est un
 * FLUXER_TOKEN absent — et c'est ce message-là qu'on doit lire.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {'discord'|'fluxer'}
 * @throws {Error} si la valeur est renseignée mais inconnue
 */
function resolvePlatformName(env = process.env) {
    const brut = env.QUASAR_PLATFORM;
    const nom = (typeof brut === 'string' ? brut.trim() : '').toLowerCase() || PLATEFORME_PAR_DEFAUT;
    if (!(nom in PLATFORMS)) {
        throw new Error(
            `QUASAR_PLATFORM invalide : "${nom}". Valeurs acceptées : ${Object.keys(PLATFORMS).join(', ')}.`
        );
    }
    return nom;
}

/**
 * Charge et instancie l'adaptateur de la plateforme demandée.
 *
 * Contrairement à `resolveMode()` d'index.js, qui replie en bruit sur son mode
 * par défaut, une plateforme inconnue LÈVE. La différence est assumée : un mode
 * mal orthographié dégrade la vitrine, une plateforme mal orthographiée ferait
 * démarrer un bot Discord là où on attendait un bot Fluxer — deux jeux de
 * données, deux publics, et personne pour s'en apercevoir.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [options] transmis tel quel à la fabrique de l'adaptateur
 * @returns {object} adaptateur conforme au contrat de la DA §4
 */
function resolvePlatform(env = process.env, options = {}) {
    const nom = resolvePlatformName(env);
    return chargerAdaptateur(nom)(options);
}

/**
 * Résout la fabrique d'un adaptateur.
 *
 * L'adaptateur Fluxer n'est livré qu'au lot 6. Tant qu'il manque, un
 * `MODULE_NOT_FOUND` brut désignerait un chemin de fichier et laisserait croire
 * à une installation cassée : on le traduit. Le test porte sur le module
 * DIRECTEMENT visé — une dépendance manquante à l'intérieur d'un adaptateur
 * existant doit remonter telle quelle, sinon on masquerait un vrai défaut.
 */
function chargerAdaptateur(nom) {
    const charger = PLATFORMS[nom];
    try {
        require.resolve(`./${nom}`);
    } catch (err) {
        if (err?.code === 'MODULE_NOT_FOUND') {
            throw new Error(
                `L'adaptateur « ${nom} » n'est pas encore livré dans cette version de Quasar `
                + `(bot/platform/${nom}/ absent). Démarrez avec QUASAR_PLATFORM=${PLATEFORME_PAR_DEFAUT}.`
            );
        }
        throw err;
    }
    return charger();
}

module.exports = {
    resolvePlatform,
    resolvePlatformName,
    chargerAdaptateur,
    PLATFORMS,
    PLATEFORME_PAR_DEFAUT,
};
