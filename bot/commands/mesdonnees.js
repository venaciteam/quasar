const { definirCommande } = require('../platform/commands');
const { embed } = require('../platform/embed');
const { construireEmbedErreur } = require('../utils/errors');

// Couleur d'accent, alignée sur /signaler pour l'unité visuelle des commandes
// « transparence / droits » ouvertes à tous.
const ACCENT_COLOR = 0xDE3163;

// Délai légal de réponse : un mois (art. 12.3 RGPD). On l'exprime en 30 jours,
// cohérent avec `due_at = requested_at + 1 mois` de la table erasure_requests.
const ERASURE_DELAY_DAYS = 30;

// Interlocuteurs pour l'exercice des droits. L'équipe du serveur est la
// responsable de traitement (elle décide) ; Venacity, sous-traitant qui héberge
// l'instance, se contente de router la demande et d'exécuter la décision.
const VENACITY_CONTACT = 'contact@vena.city';
// Site légal public de Venacity (où sont publiés le contrat de sous-traitance et
// la politique de confidentialité). Domaine réel de l'instance ; le chemin exact
// de la politique est référencé en toutes lettres plutôt qu'en lien profond, pour
// ne pas pointer vers une URL qui ne serait pas encore publiée (cf. sous-lot G).
const VENACITY_LEGAL_SITE = 'strata.vena.city';

// Nom du panneau persistant porté par cette commande. Le MÊME mot aux trois
// endroits du contrat : déclaration (`panneaux`), pose (`ctx.choose({ panneau })`)
// et routage du clic. Il remplace le préfixe `mesdonnees_` que `bot/index.js`
// portait en dur — fichier interdit aux lots parallèles.
const PANNEAU = 'mesdonnees';
const CHOIX_EFFACEMENT = 'erase';

// Cette commande est ouverte à TOUS les membres, pas seulement aux administrateurs :
// l'information des personnes concernées (art. 14 RGPD) et l'exercice de leurs droits
// n'ont de sens que si chacun, y compris un membre ordinaire, peut savoir ce que
// Quasar traite le concernant. C'est le même parti pris que /signaler.
module.exports = definirCommande({
    nom: 'mes-donnees',
    description: 'Voir les données que Quasar traite vous concernant et exercer vos droits',
    accesParDefaut: true,
    // Aucune écriture de serveur : la commande lit la base et répond.
    permissionsBot: [],

    // Le panneau est PERSISTANT et non éphémère, alors même que le message qui le
    // porte l'est : ses clics doivent rester routés après un redémarrage du bot,
    // exactement comme le faisait le routage par préfixe de `bot/index.js`. Un
    // panneau éphémère mourrait avec son collecteur, et le bouton deviendrait
    // muet à la première mise à jour — sur un parcours d'exercice de droits.
    panneaux: {
        [PANNEAU]: async (ctx, cle) => {
            // Le routage nous envoie tout le panneau : on ignore proprement ce qui
            // ne nous concerne pas, comme le faisait le filtre sur `mesdonnees_erase`.
            if (cle !== CHOIX_EFFACEMENT) return;
            return deposerDemandeEffacement(ctx);
        },
    },

    async executer(ctx) {
        // Hors serveur (message privé) : sans guilde, impossible de savoir de quel
        // traitement on parle. On le dit clairement plutôt que de renvoyer un vide.
        if (!ctx.guildeId) {
            return ctx.repondre(construireEmbedErreur({
                title: 'À utiliser sur un serveur',
                cause: 'Quasar traite des données par serveur : en message privé, il n\'y a pas de serveur auquel les rattacher.',
                action: 'Lancez /mes-donnees depuis un salon du serveur qui vous concerne.',
            }), { ephemere: true, sensible: true });
        }

        const guildId = ctx.guildeId;
        const userId = ctx.auteur.id;
        const db = ctx.db;

        // ── Comptes réels lus en base ─────────────────────────────────────────
        // Dégradation gracieuse : si une table venait à manquer (premier boot),
        // on renvoie 0 plutôt que de faire échouer toute la commande.
        const sanctions = lectureSure(db, `
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS actives
            FROM sanctions
            WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { total: 0, actives: 0 };

        const ticketsCount = (lectureSure(db, `
            SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { n: 0 }).n;

        const prefsCount = (lectureSure(db, `
            SELECT COUNT(*) AS n FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]) || { n: 0 }).n;

        // ── Construction de l'embed (ton accessible, non juridique) ───────────
        const champs = [];

        // 1. Identifiants Discord — cette catégorie s'applique toujours : dès que
        //    tu es concerné par quoi que ce soit, c'est via ton identifiant.
        champs.push({
            nom: '🪪 Votre identifiant Discord',
            valeur:
                'Quasar vous reconnaît par votre identifiant technique Discord, uniquement là où vous êtes concerné·e ' +
                '(une sanction, un ticket, une préférence). Il ne stocke ni votre nom réel, ni votre e-mail, ni votre mot de passe.',
        });

        // 2. Sanctions — on donne le nombre, jamais le détail (potentiellement
        //    sensible) : pour en connaître la teneur, on renvoie vers l'admin.
        champs.push({
            nom: '⚖️ Sanctions de modération vous concernant',
            valeur: sanctions.total > 0
                ? `**${sanctions.total}** sanction(s) enregistrée(s) vous concernant ici` +
                  (sanctions.actives > 0 ? `, dont **${sanctions.actives}** encore active(s).` : ' (aucune active actuellement).') +
                  '\nPour en connaître le détail, adressez-vous à l\'équipe d\'administration du serveur.'
                : 'Aucune sanction enregistrée vous concernant sur ce serveur.',
        });

        // 3. Tickets ouverts à ton nom — on rappelle que le contenu des échanges
        //    n'est jamais conservé par Quasar (seules les métadonnées le sont).
        champs.push({
            nom: '🎫 Tickets que vous avez ouverts',
            valeur: ticketsCount > 0
                ? `**${ticketsCount}** ticket(s) ouvert(s) à votre nom sur ce serveur. ` +
                  'Le contenu des conversations n\'est jamais conservé par Quasar, seulement le fait qu\'un ticket a existé.'
                : 'Aucun ticket ouvert à votre nom sur ce serveur.',
        });

        // 4. Préférences de salons vocaux temporaires — n'existent que si tu as
        //    déjà personnalisé un salon ; on n'affiche la catégorie que si c'est le cas.
        if (prefsCount > 0) {
            champs.push({
                nom: '🔊 Préférences de salons vocaux temporaires',
                valeur:
                    'Vos préférences de salon vocal temporaire (nom du salon, limite de membres) sont mémorisées ' +
                    'pour vous les réappliquer automatiquement la prochaine fois.',
            });
        }

        // 5. Exercice des droits — fidèle au partage des rôles : l'admin décide,
        //    Venacity route et exécute.
        champs.push({
            nom: '✅ Comment exercer vos droits',
            valeur:
                'Vous pouvez demander à accéder à ces données, à les corriger ou à les supprimer.\n' +
                '• **En premier lieu, l\'équipe d\'administration de ce serveur** : elle est responsable de vos données ici, ' +
                'c\'est elle qui prend les décisions.\n' +
                `• **Venacity** (${VENACITY_CONTACT}) héberge Quasar en tant que sous-traitant : elle transmet votre demande ` +
                'à l\'équipe du serveur et exécute sa décision, sans se substituer à elle.\n' +
                `Plus de détails dans la politique de confidentialité publique de Venacity (${VENACITY_LEGAL_SITE}).`,
        });

        // `sensible` n'existe pas sur `ctx.choose` : l'éphémère de Discord est
        // réellement privé, donc rien ne change ici, mais c'est un manque du
        // contrat pour une plateforme sans éphémère natif (voir compte-rendu).
        await ctx.choose(
            embed({
                titre: '🔒 Les données que Quasar traite vous concernant',
                couleur: ACCENT_COLOR,
                description:
                    `Voici les catégories de données que Quasar traite à votre sujet **sur le serveur ${ctx.guilde.nom}**. ` +
                    'Ces informations ne sont visibles que par vous.',
                champs,
                pied: { texte: 'Vous pouvez aussi déposer une demande de suppression directement ci-dessous.' },
            }),
            [{
                cle: CHOIX_EFFACEMENT,
                libelle: 'Demander la suppression de mes données',
                emoji: '🗑️',
                style: 'danger',
            }],
            // Les coordonnées rendues ne sont PAS stockées dans `interaction_panels` :
            // ce panneau est éphémère et propre à une personne, une ligne par appel
            // ferait grossir la table sans que rien ne la relise jamais. Le handler
            // reconstruit tout depuis le contexte du clic.
            { persistant: true, panneau: PANNEAU, ephemere: true },
        );
    },
});

/**
 * Dépose une demande de suppression (droit à l'effacement, art. 17) déclenchée par
 * le bouton de /mes-donnees.
 *
 * La demande est enregistrée dans `erasure_requests` (source='command') puis routée
 * à l'équipe d'administration du serveur, qui dispose d'un mois pour se prononcer.
 * Idempotence : si une demande 'pending' de la même personne existe déjà sur ce
 * serveur, on ne la duplique pas — on informe qu'elle est déjà en cours.
 */
async function deposerDemandeEffacement(ctx) {
    // Un clic hors serveur ne devrait pas arriver (le message est éphémère et lié à
    // un serveur), mais on se protège : sans guilde, aucune demande rattachable.
    if (!ctx.guildeId) {
        return ctx.repondre(construireEmbedErreur({
            title: 'À utiliser sur un serveur',
            cause: 'Une demande de suppression se rattache à un serveur précis, indisponible en message privé.',
            action: 'Relancez /mes-donnees depuis le serveur concerné.',
        }), { ephemere: true, sensible: true });
    }

    const guildId = ctx.guildeId;
    const subjectId = ctx.auteur.id;
    const db = ctx.db;

    // La clé étrangère erasure_requests.guild_id → guilds(guild_id) est active
    // (PRAGMA foreign_keys = ON). On garantit la présence de la ligne du serveur,
    // comme le fait le handler `ready`, pour qu'un serveur tout juste rejoint ne
    // fasse pas échouer l'insertion.
    db.prepare('INSERT OR IGNORE INTO guilds (guild_id, name) VALUES (?, ?)')
        .run(guildId, ctx.guilde?.nom ?? null);

    // Idempotence raisonnable : une seule demande en cours par personne et par serveur.
    const existante = db.prepare(`
        SELECT id, requested_at FROM erasure_requests
        WHERE guild_id = ? AND subject_id = ? AND status = 'pending'
        ORDER BY requested_at DESC LIMIT 1
    `).get(guildId, subjectId);

    if (existante) {
        return ctx.repondre(embed({
            titre: '📨 Demande déjà en cours',
            couleur: ACCENT_COLOR,
            description:
                'Une demande de suppression vous concernant est **déjà en attente de traitement** sur ce serveur. ' +
                'Inutile d\'en déposer une nouvelle : l\'équipe d\'administration du serveur en a été informée ' +
                'et dispose d\'un mois pour y répondre.\n\n' +
                `Pour un suivi ou une précision, vous pouvez contacter l\'équipe du serveur ou Venacity (${VENACITY_CONTACT}).`,
        }), { ephemere: true, sensible: true });
    }

    // Horodatage en secondes (unixepoch), cohérent avec le reste du lot 2.
    const maintenant = Math.floor(Date.now() / 1000);
    const echeance = maintenant + ERASURE_DELAY_DAYS * 24 * 60 * 60;

    db.prepare(`
        INSERT INTO erasure_requests
            (guild_id, subject_id, category, details, requested_at, due_at, status, source)
        VALUES (?, ?, 'mixed', ?, ?, ?, 'pending', 'command')
    `).run(guildId, subjectId, 'Demande déposée via /mes-donnees', maintenant, echeance);

    return ctx.repondre(embed({
        titre: '✅ Demande de suppression transmise',
        couleur: ACCENT_COLOR,
        description:
            'Votre demande de suppression a été **transmise à l\'équipe d\'administration de ce serveur**, ' +
            'qui est responsable de vos données et décide des suites à donner. ' +
            'Elle dispose d\'**un mois** pour y répondre.\n\n' +
            `Venacity (${VENACITY_CONTACT}), qui héberge Quasar, a acheminé votre demande et exécutera la décision de l\'équipe. ` +
            'Certaines données peuvent devoir être conservées (par exemple une sanction encore active) ; ' +
            'le cas échéant, l\'équipe du serveur vous le fera savoir.',
        pied: { texte: 'Vous pouvez fermer ce message : votre demande est enregistrée.' },
    }), { ephemere: true, sensible: true });
}

/**
 * Lit une seule ligne sans jamais faire échouer la commande : une table absente au
 * tout premier boot renvoie une exception, qu'on absorbe en renvoyant null.
 */
function lectureSure(db, sql, params) {
    try {
        return db.prepare(sql).get(...params);
    } catch (err) {
        console.error('[Quasar] /mes-donnees — lecture ignorée :', err.message);
        return null;
    }
}
