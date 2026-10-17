const { definirEvenement } = require('../platform/events');
const { embed } = require('../platform/embed');
const { sendLog } = require('../utils/logger');
// Nom et boutons du panneau : importés, jamais recopiés. Le contrat veut le
// même mot à la déclaration (`panneaux` de /tempvoice), à la pose (ici) et au
// routage ; trois littéraux finiraient par diverger, et un panneau posé que
// personne ne route ne produit aucune erreur.
const { PANNEAU, BOUTONS_PANNEAU } = require('../interactions/tempvoice');

// Rate limit : 1 création par utilisateur toutes les 10 secondes
const tempvoiceCooldowns = new Map();
const COOLDOWN_MS = 10_000;

// Nettoyage périodique des cooldowns expirés (évite fuite mémoire sur Pi)
setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of tempvoiceCooldowns) {
        if (now - ts > COOLDOWN_MS) tempvoiceCooldowns.delete(key);
    }
}, 60_000).unref(); // ne doit pas retenir le processus (convention projet : tous les timers de fond sont unref)

// Track TempVoice channel IDs for channelCreate/Delete filtering
const tempvoiceChannelIds = new Set();
let tempvoiceCreating = false; // Flag: a TempVoice creation is in progress

module.exports = definirEvenement({
    nom: 'etatVocalModifie',

    /**
     * @param {object} ctx   contexte d'événement neutre (api, db, poserPanneau)
     * @param {object} avant état vocal AVANT (cf. platform/discord/events.js)
     * @param {object} apres état vocal APRÈS
     */
    async executer(ctx, avant, apres) {
        const db = ctx.db;
        const guildeId = apres.guildeId;
        const membre = apres.membre;
        if (!membre || membre.estBot) return;

        // Portée d'écriture des journaux : « où écrire, avec quel client REST ».
        // Un événement n'a personne à qui répondre, il n'a qu'un serveur et une
        // api — c'est exactement ce que `sendLog` attend sur la voie neutre.
        const portee = { guildeId, api: ctx.api };

        const oldChannelId = avant.canalId;
        const newChannelId = apres.canalId;

        // Si le channel n'a pas changé (mute/unmute/etc.), on ignore
        if (oldChannelId === newChannelId) return;

        // ═══════════════════════════════════════
        //  LOGS VOCAUX
        // ═══════════════════════════════════════

        // Skip les logs si c'est un mouvement TempVoice
        const isTriggerNew = newChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1').get(guildeId, newChannelId); }
            catch { return false; }
        })();
        const isTriggerOld = oldChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1').get(guildeId, oldChannelId); }
            catch { return false; }
        })();
        const isLeavingTemp = oldChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(oldChannelId); }
            catch { return false; }
        })();
        const isJoiningTemp = newChannelId && (() => {
            try { return !!db.prepare('SELECT 1 FROM tempvoice_active WHERE channel_id = ?').get(newChannelId); }
            catch { return false; }
        })();
        const isTempVoiceMove = isTriggerNew || isTriggerOld || (isLeavingTemp && isJoiningTemp);

        if (!isTempVoiceMove) {
            if (!oldChannelId && newChannelId) {
                await sendLog(portee, 'voice_join', embed({
                    titre: '🔊 Rejoint un vocal',
                    couleur: 0x2ecc71,
                    champs: [
                        { nom: 'Membre', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
                        { nom: 'Salon', valeur: `<#${newChannelId}>`, enLigne: true },
                    ],
                    horodatage: true,
                }));
            } else if (oldChannelId && !newChannelId) {
                // Skip si c'est un TempVoice qui va être supprimé (dernier membre parti).
                // `null` = le salon n'existe plus, `[]` = il est vide : les deux
                // valent « il va disparaître », comme le `!oldChannel ||
                // members.size === 0` d'avant migration.
                //
                // La liste n'est lue que si le salon quitté EST un temporaire :
                // ailleurs le résultat ne change rien, et la voie neutre n'a pas
                // le cache de salons que la lecture d'origine consultait.
                let willBeDeleted = false;
                if (isLeavingTemp) {
                    const restants = await ctx.api.listerMembresVocal(oldChannelId);
                    willBeDeleted = restants === null || restants.length === 0;
                }
                if (!willBeDeleted) {
                    await sendLog(portee, 'voice_leave', embed({
                        titre: '🔇 Quitte un vocal',
                        couleur: 0xe74c3c,
                        champs: [
                            { nom: 'Membre', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
                            { nom: 'Salon', valeur: `<#${oldChannelId}>`, enLigne: true },
                        ],
                        horodatage: true,
                    }));
                }
            } else if (oldChannelId && newChannelId) {
                await sendLog(portee, 'voice_move', embed({
                    titre: '🔄 Change de vocal',
                    couleur: 0x3498db,
                    champs: [
                        { nom: 'Membre', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
                        { nom: 'Avant', valeur: `<#${oldChannelId}>`, enLigne: true },
                        { nom: 'Après', valeur: `<#${newChannelId}>`, enLigne: true },
                    ],
                    horodatage: true,
                }));
            }
        }

        // ═══════════════════════════════════════
        //  VOICE ROLES
        // ═══════════════════════════════════════

        try {
            db.prepare('SELECT 1 FROM voice_roles LIMIT 1').get();

            if (oldChannelId) {
                const voiceRole = db.prepare('SELECT role_id FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                    .get(guildeId, oldChannelId);
                if (voiceRole) {
                    try { await ctx.api.retirerRole(guildeId, membre.id, voiceRole.role_id); } catch (e) {
                        console.error('[Quasar] Erreur retrait rôle vocal:', e.message);
                    }
                }
            }

            if (newChannelId) {
                const voiceRole = db.prepare('SELECT role_id FROM voice_roles WHERE guild_id = ? AND channel_id = ?')
                    .get(guildeId, newChannelId);
                if (voiceRole) {
                    try { await ctx.api.ajouterRole(guildeId, membre.id, voiceRole.role_id); } catch (e) {
                        console.error('[Quasar] Erreur ajout rôle vocal:', e.message);
                    }
                }
            }
        } catch {
            // Table voice_roles pas encore créée, on ignore
        }

        // ═══════════════════════════════════════
        //  TEMPVOICE — Création (multi-trigger)
        // ═══════════════════════════════════════

        if (newChannelId) {
            try {
                const trigger = db.prepare('SELECT * FROM tempvoice_triggers WHERE guild_id = ? AND channel_id = ? AND enabled = 1')
                    .get(guildeId, newChannelId);

                if (trigger) {
                    const categoryId = trigger.category_id || '';

                    // Vérifier que l'utilisateur n'a pas déjà un vocal actif dans cette catégorie
                    const existing = db.prepare('SELECT channel_id FROM tempvoice_active WHERE guild_id = ? AND owner_id = ? AND category_id = ?')
                        .get(guildeId, membre.id, categoryId);

                    if (existing) {
                        const existingChannel = await ctx.api.obtenirCanal(existing.channel_id);
                        if (existingChannel) {
                            // Member may have disconnected
                            try { await ctx.api.modifierMembre(guildeId, membre.id, { canalVocalId: existingChannel.id }); } catch {}
                            return;
                        } else {
                            db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(existing.channel_id);
                        }
                    }

                    // Rate limit check
                    const cooldownKey = `${guildeId}-${membre.id}`;
                    const lastCreate = tempvoiceCooldowns.get(cooldownKey);
                    if (lastCreate && Date.now() - lastCreate < COOLDOWN_MS) {
                        // Member may have already left
                        try { await ctx.api.modifierMembre(guildeId, membre.id, { canalVocalId: null }, 'Création trop rapide'); } catch {}
                        return;
                    }
                    tempvoiceCooldowns.set(cooldownKey, Date.now());

                    const triggerCanal = await ctx.api.obtenirCanal(newChannelId);
                    await createTempVoice(ctx, portee, membre, triggerCanal, categoryId, db);
                }
            } catch (e) {
                console.error('[Quasar] Erreur TempVoice création:', e);
            }
        }

        // ═══════════════════════════════════════
        //  TEMPVOICE — Suppression (salon vidé)
        // ═══════════════════════════════════════

        if (oldChannelId) {
            try {
                const isTemp = db.prepare('SELECT * FROM tempvoice_active WHERE channel_id = ?')
                    .get(oldChannelId);

                if (isTemp) {
                    // Relu ICI et non repris du test de journalisation : des
                    // attentes séparent les deux, et quelqu'un a pu rejoindre
                    // entre-temps. C'était déjà deux lectures avant migration.
                    // `null` (salon disparu) et une liste non vide mènent tous
                    // deux au même « on ne supprime pas », comme le
                    // `oldChannel && members.size === 0` d'origine.
                    const restants = await ctx.api.listerMembresVocal(oldChannelId);
                    const oldChannel = restants && restants.length === 0
                        ? await ctx.api.obtenirCanal(oldChannelId)
                        : null;
                    if (oldChannel) {
                        const channelName = oldChannel.nom;
                        await ctx.api.supprimerCanal(oldChannelId).catch(() => {});
                        db.prepare('DELETE FROM tempvoice_active WHERE channel_id = ?').run(oldChannelId);
                        // Keep in Set briefly so channelDelete can filter it
                        setTimeout(() => tempvoiceChannelIds.delete(oldChannelId), 5000);
                        console.log(`[Quasar] TempVoice supprimé: ${oldChannelId}`);

                        // Log unique suppression
                        const owner = await ctx.api.obtenirMembre(guildeId, isTemp.owner_id).catch(() => null);
                        const ownerLabel = owner ? `${owner.mention} (${owner.etiquette})` : isTemp.owner_id;
                        sendLog(portee, 'tempvoice_delete', embed({
                            titre: '🎧 Vocal temporaire supprimé',
                            couleur: 0xe74c3c,
                            champs: [
                                { nom: 'Salon', valeur: `${channelName}`, enLigne: true },
                                { nom: 'Dernier membre', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
                                { nom: 'Créé par', valeur: ownerLabel, enLigne: true },
                            ],
                            horodatage: true,
                        })).catch(() => {});
                    }
                }
            } catch (e) {
                console.error('[Quasar] Erreur TempVoice suppression:', e);
            }
        }
    },
});

/**
 * Crée le salon temporaire, y installe son propriétaire et pose son panneau.
 *
 * @param {object} ctx           contexte d'événement neutre
 * @param {object} portee        { guildeId, api } pour les journaux
 * @param {object} membre        membre normalisé, propriétaire du futur salon
 * @param {object} triggerCanal  salon d'accueil rejoint, normalisé
 * @param {string} categoryId    catégorie du trigger, '' si aucune
 */
async function createTempVoice(ctx, portee, membre, triggerCanal, categoryId, db) {
    const guildeId = portee.guildeId;

    // Charger les préférences pour cette catégorie
    const prefs = db.prepare('SELECT * FROM tempvoice_preferences WHERE guild_id = ? AND user_id = ? AND category_id = ?')
        .get(guildeId, membre.id, categoryId);

    const channelName = prefs?.channel_name || `🎧 Salon de ${membre.nom}`;
    const userLimit = prefs?.user_limit || 0;

    // Créer le vocal dans la même catégorie (hérite des permissions)
    tempvoiceCreating = true;
    const channel = await ctx.api.creerCanal(guildeId, {
        nom: channelName,
        type: 'vocal',
        parentId: triggerCanal?.parentId ?? null,
        limiteUtilisateurs: userLimit,
    });

    // Track + reset flag
    tempvoiceChannelIds.add(channel.id);
    tempvoiceCreating = false;

    // Ajouter les permissions owner APRÈS la création (ne casse pas la sync catégorie).
    //
    // ⚠️ Overwrite UNITAIRE, et c'est capital : `modifierCanal({ permissions })`
    // remplacerait le jeu ENTIER du salon. `definirOverwrite` lit l'entrée
    // existante, applique les deltas et ne réécrit que celle-là — les
    // overwrites hérités de la catégorie restent intacts, exactement comme le
    // faisait `permissionOverwrites.edit`.
    await ctx.api.definirOverwrite(channel.id, membre.id, {
        MANAGE_CHANNELS: true,
        MOVE_MEMBERS: true,
        MUTE_MEMBERS: true,
        DEAFEN_MEMBERS: true,
    }, { type: 'membre' });

    // Déplacer l'utilisateur
    await ctx.api.modifierMembre(guildeId, membre.id, { canalVocalId: channel.id });
    db.prepare('INSERT INTO tempvoice_active (channel_id, guild_id, owner_id, category_id) VALUES (?, ?, ?, ?)')
        .run(channel.id, guildeId, membre.id, categoryId);

    console.log(`[Quasar] TempVoice créé: "${channelName}" pour ${membre.etiquette} (catégorie: ${categoryId || 'aucune'})`);

    // Log unique TempVoice
    sendLog(portee, 'tempvoice_create', embed({
        titre: '🎧 Vocal temporaire créé',
        couleur: 0xc86e8e,
        champs: [
            { nom: 'Créé par', valeur: `${membre.mention} (${membre.etiquette})`, enLigne: true },
            { nom: 'Salon', valeur: `<#${channel.id}>`, enLigne: true },
        ],
        horodatage: true,
    })).catch(() => {});

    // Message de bienvenue avec boutons.
    //
    // `poserPanneau` et non `ctx.choose` : un événement ne répond à personne, et
    // c'est le salon qui décide de la destination. Le panneau est PERSISTANT —
    // il survit à un redémarrage, ses clics sont routés par `surPanneau` vers le
    // handler déclaré dans `panneaux` de /tempvoice.
    try {
        await ctx.poserPanneau(
            channel.id,
            embed({
                titre: `🎧 C'est votre salon, ${membre.nom} !`,
                description:
                    'Personnalisez-le avec les boutons ci-dessous ou les commandes `/voice`.\n\n'
                    + 'Vos préférences (nom, limite) seront **mémorisées** pour cette catégorie. ✨',
                couleur: 0xc86e8e,
                pied: { texte: 'Ce salon sera supprimé quand tout le monde sera parti.' },
            }),
            BOUTONS_PANNEAU,
            { panneau: PANNEAU },
        );
    } catch (e) {
        console.error('[Quasar] Erreur envoi panneau TempVoice:', e.message || e);
    }
}

// Exports annexes attachés APRÈS l'affectation de module.exports — les poser
// avant serait les perdre (l'affectation remplace l'objet entier). C'est le
// bug qui a silencieusement vidé ces exports jusqu'à la v4.7.0 : bot/index.js
// les lisait `undefined` et le rechargement des salons TempVoice au boot
// échouait à chaque démarrage. Même motif que messageCreate.js, et la
// migration au contrat neutre ne change rien à la règle : `definirEvenement`
// rend un objet, qui remplace lui aussi `module.exports`.
module.exports.tempvoiceChannelIds = tempvoiceChannelIds;
module.exports.isTempVoiceCreating = () => tempvoiceCreating;
module.exports.PANNEAU = PANNEAU;
module.exports.BOUTONS_PANNEAU = BOUTONS_PANNEAU;
