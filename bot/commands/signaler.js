const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { construireEmbedErreur, newIncidentCode } = require('../utils/errors');
const {
    getBugRelayUrl, getAbuseRelayUrl, getAbuseContact,
    getOperatorName, sendReport,
} = require('../utils/reportRouting');

const ACCENT_COLOR = 0xDE3163;

// Les deux formulaires ne diffèrent que par le libellé et l'exemple de leur
// premier champ : le reste — clés, longueurs, obligation — est commun, et le
// rester est ce qui garantit que `sendReport` reçoit toujours la même forme.
function champsFormulaire(libelle, exemple) {
    return [
        {
            cle: 'description',
            libelle,
            exemple,
            style: 'paragraphe',
            max: 1500,
            requis: true,
        },
        {
            cle: 'contact',
            libelle: 'Vous recontacter (facultatif)',
            exemple: 'Pseudo Discord, e-mail… laissez vide si vous préférez.',
            style: 'ligne',
            max: 200,
            requis: false,
        },
    ];
}

// Cette commande est ouverte à TOUS les membres, pas seulement aux administrateurs.
// Le dashboard n'est accessible qu'aux admins : sans elle, un membre ordinaire —
// justement celui qui subit un éventuel abus — n'a aucun moyen de signaler quoi que
// ce soit. Discord impose aux développeurs de fournir un canal de signalement portant
// sur l'application « or its use » : un canal réservé aux admins ne le fournit pas.
//
// `accesParDefaut: true` déclare cette ouverture au lieu de la laisser deviner :
// le registre refuse un descripteur muet sur son accès, précisément pour qu'on ne
// puisse pas confondre « ouverte exprès » et « oubli de migration ».
module.exports = definirCommande({
    nom: 'signaler',
    description: 'Signaler un bug de Quasar ou un usage abusif du bot',
    accesParDefaut: true,
    // Répondre suffit : aucune écriture de serveur, aucun salon à créer.
    permissionsBot: [],

    sousCommandes: [
        {
            nom: 'bug',
            description: 'Quasar fonctionne mal : commande en erreur, dashboard cassé…',
            async executer(ctx) {
                const reponses = await ctx.prompt(
                    champsFormulaire(
                        'Que s\'est-il passé ?',
                        'Décrivez le problème et ce que vous faisiez au moment où il est arrivé.',
                    ),
                    { titre: 'Signaler un bug de Quasar' },
                );
                // Formulaire fermé ou expiré : rien n'a été saisi, il n'y a rien à
                // transmettre et rien à afficher. L'adaptateur n'a pas acquitté.
                if (!reponses) return;
                return transmettreSignalement(ctx, { abus: false, ...reponses });
            },
        },
        {
            nom: 'abus',
            description: 'Le bot est utilisé de façon abusive sur ce serveur',
            async executer(ctx) {
                const relais = getAbuseRelayUrl();

                if (!relais) {
                    // Aucun relais configuré : cette instance ne collecte pas les signalements
                    // d'abus. On ne fait pas semblant — on oriente vers les interlocuteurs
                    // qui peuvent réellement agir.
                    return ctx.repondre(embedSansRelais(), { ephemere: true, sensible: true });
                }

                const reponses = await ctx.prompt(
                    champsFormulaire(
                        'Que se passe-t-il ?',
                        'Décris l\'usage abusif du bot sur ce serveur, aussi précisément que possible.',
                    ),
                    { titre: 'Signaler un usage abusif' },
                );
                if (!reponses) return;
                return transmettreSignalement(ctx, { abus: true, ...reponses });
            },
        },
    ],
});

/**
 * Orientation affichée quand l'instance ne reçoit pas les signalements d'abus.
 * Texte inchangé : il nomme trois interlocuteurs dans un ordre qui va du plus
 * proche au plus lointain, et cet ordre fait partie du message.
 */
function embedSansRelais() {
    const operateur = getOperatorName();
    const contact = getAbuseContact();

    return embed({
        titre: '🚨 Signaler un usage abusif',
        couleur: ACCENT_COLOR,
        description:
            'Cette instance de Quasar ne reçoit pas les signalements d\'abus : ' +
            'ils doivent aller aux personnes qui peuvent agir.',
        champs: [
            {
                nom: '1. L\'équipe de ce serveur',
                valeur: 'Pour un problème de modération ou de comportement, les administrateurs ' +
                        'du serveur sont responsables de ce qui s\'y passe.',
            },
            {
                nom: `2. ${operateur ? operateur : 'La personne ou l\'organisation qui héberge cette instance'}`,
                valeur: contact
                    ? contact
                    : 'Si le problème vient de l\'équipe du serveur elle-même, adressez-vous à ' +
                      'qui héberge ce bot. Aucun contact n\'a été renseigné sur cette instance.',
            },
            {
                nom: '3. Discord',
                valeur: 'Pour une violation des conditions d\'utilisation de Discord : ' +
                        '[formulaire de signalement Discord](https://support.discord.com/hc/fr/requests/new).',
            },
        ],
        pied: { texte: 'Pour un dysfonctionnement technique du bot, utilisez plutôt /signaler bug.' },
    });
}

/**
 * Transmet le formulaire au relais, puis rend compte.
 *
 * L'acquittement est DIFFÉRÉ avant le POST : un relais lent dépasse les trois
 * secondes accordées à une interaction, et sans cet appel la personne verrait
 * un échec alors que son signalement est parti. C'est le rôle exact du
 * `deferReply({ ephemeral: true })` de la version d'origine.
 */
async function transmettreSignalement(ctx, { abus, description, contact }) {
    await ctx.differer({ ephemere: true });

    const relais = abus ? getAbuseRelayUrl() : getBugRelayUrl();
    if (!relais) {
        return ctx.repondre(construireEmbedErreur({
            title: 'Signalement impossible',
            cause: 'Cette instance de Quasar n\'a pas de destination de signalement configurée.',
            action: 'Prévenez directement l\'équipe du serveur, ou la personne qui héberge ce bot.',
        }), { ephemere: true, sensible: true });
    }

    let version = '';
    try { version = require('../../package.json').version; } catch { /* sans importance */ }

    const resultat = await sendReport({
        relayUrl: relais,
        kind: abus ? 'abuse' : 'bug',
        description,
        contact: contact || null,
        guildId: ctx.guildeId ?? undefined,
        serviceVersion: version,
    });

    if (!resultat.ok) {
        // Le relais est injoignable ou refuse la soumission : on trace avec un code
        // pour que l'administrateur puisse relier le retour de l'utilisateur au log.
        const codeIncident = newIncidentCode();
        console.error(
            `[Quasar] ❌ ${codeIncident} | /signaler ${abus ? 'abus' : 'bug'} | ` +
            `relais=${relais} | ${resultat.status ? `HTTP ${resultat.status}` : resultat.error}`
        );
        return ctx.repondre(construireEmbedErreur({
            title: 'Signalement non transmis',
            cause: 'Le service qui reçoit les signalements n\'a pas répondu. Il est peut-être momentanément indisponible.',
            action: 'Réessayez dans quelques minutes. Si le problème persiste, prévenez directement l\'équipe du serveur.',
            code: codeIncident,
        }), { ephemere: true, sensible: true });
    }

    return ctx.repondre(embed({
        titre: '✅ Signalement transmis',
        couleur: ACCENT_COLOR,
        description: abus
            ? 'Votre signalement a été transmis à l\'équipe qui héberge cette instance de Quasar. ' +
              'Elle en prendra connaissance et décidera des suites.'
            : 'Merci — votre signalement a été transmis à l\'équipe qui développe Quasar.',
        pied: {
            texte: contact
                ? 'Le contact que vous avez indiqué a été joint au signalement.'
                : 'Aucun moyen de vous recontacter n\'a été transmis.',
        },
        horodatage: true,
    }), { ephemere: true, sensible: true });
}
