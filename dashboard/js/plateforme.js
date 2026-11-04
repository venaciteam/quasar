// ═══════════════════════════════════════════════════════════════
//  La plateforme active, vue depuis le dashboard
//
//  Le dashboard ne doit JAMAIS proposer une fonctionnalité que la plateforme
//  n'a pas. Une case à cocher qui ne fait rien est pire que son absence : on
//  cherche longtemps pourquoi « ça ne marche pas », et sur une protection de
//  modération, on croit être protégé.
//
//  Tout vient de `GET /api/plateforme`, appelée UNE fois par chargement de page.
//  Le front ne devine rien : ni le nom, ni le préfixe, ni ce qui est possible.
//
//  ⚠️ Comme côté bot, on teste une CAPACITÉ, jamais un nom de plateforme. Le
//  jour où Fluxer livre les interactions, un booléen bascule côté adaptateur et
//  tout le dashboard en bénéficie. Seule exception, et c'en est une vraie : la
//  MARQUE de la page de connexion (« Se connecter avec Discord », le logo). Ce
//  n'est pas une fonctionnalité, c'est un nom propre.
// ═══════════════════════════════════════════════════════════════

(function () {
    // Valeurs de repli, utilisées tant que la réponse n'est pas arrivée et si
    // elle n'arrive jamais. Volontairement celles de Discord : le dashboard
    // tourne sur Discord en production, et une instance auto-hébergée qui
    // n'aurait pas encore la route ne doit pas se retrouver amputée.
    const REPLI = Object.freeze({
        nom: 'discord',
        capacites: Object.freeze({
            interactions: true,
            ephemere: true,
            automod: true,
            audioBot: true,
            timeout: true,
            bulkDelete: true,
            fils: true,
            pauseInvitations: true,
        }),
        prefixe: null,
    });

    let etat = REPLI;
    let promesse = null;

    /**
     * Charge la description de la plateforme. Idempotent : les appels suivants
     * rendent la même promesse, il n'y a qu'une requête par page.
     * @returns {Promise<object>}
     */
    function charger() {
        if (promesse) return promesse;
        promesse = fetch('/api/plateforme')
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                // Une réponse sans capacités n'est pas une réponse : on garde le
                // repli plutôt que de tout masquer sur un corps mal formé.
                if (d && d.capacites) etat = { nom: d.nom, capacites: d.capacites, prefixe: d.prefixe };
                return etat;
            })
            .catch(() => etat);
        return promesse;
    }

    /** La plateforme sait-elle faire ça ? */
    function a(capacite) {
        return Boolean(etat.capacites[capacite]);
    }

    /**
     * Nom d'une commande, tel qu'on l'écrit à la personne.
     *
     * `/warn` là où la plateforme a des commandes d'application, `!warn` là où
     * elle n'en a pas. Le préfixe vient du serveur (COMMAND_PREFIX), il n'est
     * jamais supposé.
     *
     * @param {string} nom  nom de la commande, SANS préfixe ni barre oblique
     */
    function commande(nom) {
        return `${a('interactions') ? '/' : (etat.prefixe || '!')}${nom}`;
    }

    /**
     * Réécrit les commandes d'un texte déjà rédigé avec des barres obliques.
     *
     * Sert aux blocs d'aide, dont les libellés sont écrits une fois pour toutes
     * (« /warn @membre [raison] »). Sur une plateforme à commandes
     * d'application, la chaîne ressort à l'identique — au caractère près, c'est
     * la condition de non-régression côté Discord.
     */
    function reecrireCommandes(texte) {
        if (a('interactions') || typeof texte !== 'string') return texte;
        const prefixe = etat.prefixe || '!';
        // Uniquement une barre oblique en tête de mot, suivie d'une lettre : ni
        // les dates, ni les fractions, ni les chemins ne sont touchés.
        return texte.replace(/(^|[\s(])\/([a-z])/g, `$1${prefixe}$2`);
    }

    /** Nom propre de la plateforme, pour la marque et rien d'autre. */
    function libelle() {
        return etat.nom === 'fluxer' ? 'Fluxer' : 'Discord';
    }

    /**
     * URL de l'icône d'un serveur, ou `null` quand elle n'est pas affichable.
     *
     * Le CDN d'avatars et d'icônes est propre à Discord, et la politique de
     * sécurité de contenu du dashboard ne l'autorise que lui. Ailleurs, on rend
     * `null` et l'appelant retombe sur l'initiale du serveur — une image cassée
     * serait pire qu'une pastille.
     */
    function iconeServeur(guildId, hash, taille) {
        if (etat.nom !== 'discord' || !hash) return null;
        return `https://cdn.discordapp.com/icons/${guildId}/${hash}.png?size=${taille}`;
    }

    /** Avatar d'une personne, même règle que `iconeServeur`. */
    function avatarPersonne(userId, hash, taille) {
        if (etat.nom !== 'discord') return null;
        return hash
            ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=${taille}`
            : 'https://cdn.discordapp.com/embed/avatars/0.png';
    }

    window.QuasarPlateforme = {
        charger,
        a,
        commande,
        reecrireCommandes,
        libelle,
        iconeServeur,
        avatarPersonne,
        get nom() { return etat.nom; },
        get capacites() { return etat.capacites; },
        get prefixe() { return etat.prefixe; },
        REPLI,
    };
})();
