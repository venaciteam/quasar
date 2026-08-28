// ═══════════════════════════════════════════════════════════════
//  Conformité des commandes slash envoyées à Discord
//
//  Discord valide un lot de commandes en bloc : si UNE seule entrée est
//  refusée, c'est tout l'envoi qui échoue. Une commande personnalisée mal
//  nommée en base peut donc priver une guild de l'intégralité de ses
//  commandes. Ce module regroupe les règles à appliquer AVANT l'envoi, pour
//  qu'un enregistrement douteux soit écarté seul, et non au prix du reste.
//
//  Il est volontairement sans dépendance (ni base, ni discord.js) pour rester
//  utilisable des deux côtés : le bot et l'API du dashboard.
// ═══════════════════════════════════════════════════════════════

// Règle officielle pour un nom de commande CHAT_INPUT :
// 1 à 32 caractères, sans espace, et en minuscules là où la casse existe.
//
// La documentation Discord publie `^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$`,
// mais l'apostrophe qu'elle autorise est en réalité refusée par l'API
// (discord/discord-api-docs#7371, toujours ouvert). On retient donc la version
// sans apostrophe : ici, être plus strict que la documentation ne coûte qu'une
// commande écartée, alors que l'inverse ferait tomber tout le lot.
const CHAT_INPUT_NAME_PATTERN = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

const CHAT_INPUT_NAME_MAX = 32;
const CHAT_INPUT_DESCRIPTION_MAX = 100;

// Nombre maximum de commandes CHAT_INPUT qu'une application peut enregistrer
// sur une guild. Ce plafond est propre au type : USER et MESSAGE ont le leur
// (15 chacun) et ne consomment pas le même budget — d'où le comptage par type
// dans `countChatInputCommands()` plutôt qu'un simple `body.length`.
const GUILD_CHAT_INPUT_COMMANDS_MAX = 100;

// Type CHAT_INPUT dans l'API Discord. Un builder de commande slash omet le
// champ `type` dans son JSON : son absence vaut CHAT_INPUT.
const CHAT_INPUT_TYPE = 1;

// Taille maximale d'UNE commande, tous champs textuels confondus.
//
// Attention au périmètre, c'est un piège : ce plafond s'applique à chaque
// commande prise isolément — avec l'arbre de ses options, sous-commandes et
// choix — et NON à la somme des commandes envoyées dans un lot. Il n'existe pas
// de budget de caractères partagé qu'une commande personnalisée viendrait
// grignoter : chacune dispose de ses propres 8000.
//
// Concrètement, une commande personnalisée coûte au maximum 132 caractères
// (nom ≤ 32 + description ≤ 100), soit 1,65 % de son budget : elle ne peut pas
// approcher cette limite. Ce sont les commandes de fichiers, avec leurs options
// et leurs choix, qui pourraient un jour la franchir — d'où ce compteur, utilisé
// au démarrage pour prévenir avant que le lot ne devienne irrecevable.
const CHAT_INPUT_COMMAND_CHARACTERS_MAX = 8000;

/**
 * Longueur retenue pour un champ localisable : Discord ne compte que la plus
 * longue des variantes, valeur par défaut comprise.
 */
function longestFieldLength(defaultValue, localizations) {
    let max = String(defaultValue ?? '').length;
    if (localizations) {
        for (const variante of Object.values(localizations)) {
            max = Math.max(max, String(variante ?? '').length);
        }
    }
    return max;
}

/** Coût d'une option, de ses choix et de ses sous-options (récursif). */
function optionCharacterCost(option) {
    let cout = longestFieldLength(option.name, option.name_localizations)
        + longestFieldLength(option.description, option.description_localizations);

    for (const choix of option.choices || []) {
        cout += longestFieldLength(choix.name, choix.name_localizations)
            + String(choix.value ?? '').length;
    }
    for (const sousOption of option.options || []) {
        cout += optionCharacterCost(sousOption);
    }
    return cout;
}

/**
 * Coût en caractères d'une commande, tel que Discord le calcule : « combined
 * name, description, and value properties for each command, its options
 * (including subcommands and groups), and choices ».
 */
function commandCharacterCost(command) {
    let cout = longestFieldLength(command.name, command.name_localizations)
        + longestFieldLength(command.description, command.description_localizations);

    for (const option of command.options || []) {
        cout += optionCharacterCost(option);
    }
    return cout;
}

/** Nombre d'entrées de type CHAT_INPUT dans un corps de déploiement. */
function countChatInputCommands(commands) {
    return commands.filter(cmd => (cmd.type ?? CHAT_INPUT_TYPE) === CHAT_INPUT_TYPE).length;
}

/**
 * Vérifie qu'un nom est acceptable comme commande slash CHAT_INPUT.
 * Retourne { valid: true } ou { valid: false, reason } — la raison est écrite
 * pour être lue telle quelle dans les journaux ou renvoyée à un administrateur.
 */
function validateChatInputName(name) {
    if (typeof name !== 'string' || name.length === 0) {
        return { valid: false, reason: 'nom vide' };
    }
    if (name.length > CHAT_INPUT_NAME_MAX) {
        return { valid: false, reason: `nom trop long (${name.length} caractères, ${CHAT_INPUT_NAME_MAX} maximum)` };
    }
    if (name !== name.toLowerCase()) {
        return { valid: false, reason: 'le nom contient des majuscules' };
    }
    if (!CHAT_INPUT_NAME_PATTERN.test(name)) {
        return { valid: false, reason: 'caractères interdits (lettres, chiffres, « - » et « _ » uniquement, sans espace)' };
    }
    return { valid: true };
}

/**
 * Description affichée par Discord pour une commande personnalisée.
 *
 * Discord exige une description de 1 à 100 caractères. Une commande qui répond
 * par un embed n'a pas de texte : on retombe alors sur un libellé générique,
 * exactement comme le font les deux chemins de création (`/cmd create` et la
 * route POST du dashboard). Cette fonction reproduit leur logique pour que le
 * redéploiement au démarrage n'affiche pas une description différente de celle
 * posée à la création.
 */
function buildCustomCommandDescription({ name, response }) {
    const texte = typeof response === 'string' && response.trim().length > 0
        ? response
        : `Commande ${name}`;
    return texte.substring(0, CHAT_INPUT_DESCRIPTION_MAX);
}

module.exports = {
    CHAT_INPUT_NAME_PATTERN,
    CHAT_INPUT_NAME_MAX,
    CHAT_INPUT_DESCRIPTION_MAX,
    CHAT_INPUT_TYPE,
    CHAT_INPUT_COMMAND_CHARACTERS_MAX,
    GUILD_CHAT_INPUT_COMMANDS_MAX,
    countChatInputCommands,
    commandCharacterCost,
    validateChatInputName,
    buildCustomCommandDescription,
};
