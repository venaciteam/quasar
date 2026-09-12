// ═══════════════════════════════════════════════════════════════
//  Chargement des panneaux autonomes — Discord
//
//  Symétrique de `chargerEvenements`, et pour la même raison : sans chargeur,
//  un descripteur posé dans `bot/panneaux/` n'est enregistré nulle part et ses
//  clics ne sont routés par personne — en silence.
//
//  Ne concerne QUE les panneaux sans commande. Ceux qu'une commande porte sont
//  enregistrés par `chargerCommandes`, depuis la clé `panneaux` du descripteur.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { estDescripteurPanneau } = require('../panneaux');

/**
 * Charge `bot/panneaux/` et enregistre chaque panneau.
 *
 * @param {object} options
 * @param {string}   options.dossier
 * @param {object}   options.adaptateur
 * @param {Function} [options.surErreur] (err, { panneau }) => void
 * @returns {Array<{nom: string, fichier: string, enregistre: boolean}>}
 */
function chargerPanneaux({ dossier, adaptateur, surErreur } = {}) {
    if (!dossier || !fs.existsSync(dossier)) return [];
    const charges = [];

    for (const fichier of fs.readdirSync(dossier).filter(f => f.endsWith('.js'))) {
        const mod = require(path.join(dossier, fichier));
        if (!estDescripteurPanneau(mod)) continue;

        // Un panneau qui exige une capacité absente n'est pas enregistré : même
        // mécanique que pour les événements, et le code métier ne teste jamais
        // le nom de la plateforme.
        if (mod.capaciteRequise && !adaptateur.capacites[mod.capaciteRequise]) {
            charges.push({ nom: mod.nom, fichier, enregistre: false });
            continue;
        }

        // Le filet est posé ICI, comme pour les événements : un clic sur un
        // panneau part d'un utilisateur, pas d'une commande, et un rejet non
        // capté partirait dans le filet global du processus sans dire de QUEL
        // panneau il vient.
        const handler = (ctx, cle) => Promise.resolve()
            .then(() => mod.executer(ctx, cle))
            .catch((err) => {
                if (surErreur) surErreur(err, { panneau: mod.nom, cle });
                else {
                    console.error(
                        `[Quasar] ⚠️  Panneau ${mod.nom} | ${err?.name || 'Error'}: ${err?.message || err}`
                    );
                    if (err?.stack) console.error(err.stack);
                }
            });

        adaptateur.surPanneau(mod.nom, handler, `le module ${fichier.replace(/\.js$/, '')}`);
        charges.push({ nom: mod.nom, fichier, enregistre: true });
    }

    return charges;
}

module.exports = { chargerPanneaux };
