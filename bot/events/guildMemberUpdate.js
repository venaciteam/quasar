const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');

// Taille de la vignette. Reprise telle quelle : le journal l'affiche en petit,
// et demander plus gros coûterait de la bande passante au CDN pour rien.
const TAILLE_VIGNETTE = 64;

module.exports = definirEvenement({
    nom: 'membreModifie',

    async executer(ctx, avant, apres, guilde) {
        if (apres.estBot) return;

        // Le serveur arrive en troisième argument du payload : le membre
        // normalisé ne le porte pas, et sans lui on ne saurait pas dans quel
        // journal écrire.
        const portee = { guildeId: guilde?.id ?? null, api: ctx.api };
        const identite = `${apres.mention} (${apres.etiquette})`;
        const vignette = apres.avatar(TAILLE_VIGNETTE);

        // Changement de pseudo
        if (avant.pseudo !== apres.pseudo) {
            await sendLog(portee, 'member_nick', embed({
                titre: '✏️ Changement de pseudo',
                couleur: 0x3498db,
                vignette,
                champs: [
                    { nom: 'Membre', valeur: identite, enLigne: true },
                    { nom: 'Avant', valeur: avant.pseudo || '*aucun*', enLigne: true },
                    { nom: 'Après', valeur: apres.pseudo || '*aucun*', enLigne: true },
                ],
                horodatage: true,
            }));
        }

        // Changement de rôles. `roles` est un tableau d'identifiants : la
        // mention se reconstruit, et l'ordre reste celui du payload.
        const ajoutes = apres.roles.filter(id => !avant.roles.includes(id));
        const retires = avant.roles.filter(id => !apres.roles.includes(id));

        if (ajoutes.length > 0) {
            await sendLog(portee, 'member_roles', embed({
                titre: '🎭 Rôle(s) ajouté(s)',
                couleur: 0x2ecc71,
                vignette,
                champs: [
                    { nom: 'Membre', valeur: identite, enLigne: true },
                    { nom: 'Rôle(s)', valeur: ajoutes.map(id => `<@&${id}>`).join(', '), enLigne: true },
                ],
                horodatage: true,
            }));
        }

        if (retires.length > 0) {
            await sendLog(portee, 'member_roles', embed({
                titre: '🎭 Rôle(s) retiré(s)',
                couleur: 0xe74c3c,
                vignette,
                champs: [
                    { nom: 'Membre', valeur: identite, enLigne: true },
                    { nom: 'Rôle(s)', valeur: retires.map(id => `<@&${id}>`).join(', '), enLigne: true },
                ],
                horodatage: true,
            }));
        }
    },
});
