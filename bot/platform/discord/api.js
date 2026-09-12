// ═══════════════════════════════════════════════════════════════
//  Client REST normalisé — Discord
//
//  Implémente le vocabulaire unique de la DA §4.3. Le code métier n'appelle
//  que ces méthodes ; il n'a jamais à savoir si l'information vient du cache de
//  discord.js ou d'un appel HTTP.
//
//  Deux principes d'implémentation :
//
//   • Les LECTURES passent par les objets discord.js quand ils existent
//     (`guild.members.fetch`), parce qu'ils portent les permissions calculées
//     et la hiérarchie des rôles, que la réponse REST brute n'a pas.
//   • Les ÉCRITURES passent par REST, pour maîtriser exactement le corps
//     envoyé — en particulier la sérialisation des bitfields.
//
//  ⚠️ Bitfields : `allow`, `deny` et les permissions d'un salon sont des
//  entiers 64 bits SÉRIALISÉS EN CHAÎNE. Un `number` JavaScript en tronque les
//  bits hauts sans rien dire. Tout ce qui sort d'ici est passé par
//  `serialiserBitfield`.
// ═══════════════════════════════════════════════════════════════

const { Routes } = require('discord.js');
const { serialiserBitfield, estPermissionCanonique, exigerPermissionCanonique } = require('../permissions');
const { bitfield, BITS, aPermission } = require('./permissions');
const { CODES_NEUTRES, codeNeutre } = require('../erreurs');
const { marquerErreur, marquerErreursApi } = require('./erreurs');
const { exigerTypeCanalCanonique } = require('../channels');
const { TYPES: TYPES_CANAL_DISCORD } = require('./channels');
const { rendreContenu } = require('./render');
const { normaliserMembre, normaliserRole, normaliserCanal, normaliserGuilde } = require('./context');
const { normaliserMessage } = require('./events');

// Discord refuse la suppression groupée des messages de plus de 14 jours, et
// rejette le LOT ENTIER si un seul dépasse (erreur 50034). On filtre donc en
// amont, exactement comme le fera l'adaptateur Fluxer.
const AGE_MAX_SUPPRESSION_LOT_MS = 14 * 24 * 60 * 60 * 1000;
const TAILLE_LOT_SUPPRESSION = 100;

// Époque des snowflakes Discord (2015-01-01). Fluxer utilise le même format :
// l'âge d'un message se lit dans son identifiant, sans aucun appel réseau.
const EPOQUE_SNOWFLAKE = 1420070400000n;

// Permission exigée du BOT pour chaque action de sanction. C'est la moitié
// « permission » de `verifierMembreSanctionnable` ; l'autre moitié est la
// hiérarchie des rôles.
const PERMISSION_PAR_SANCTION = Object.freeze({
    timeout: 'MODERATE_MEMBERS',
    kick: 'KICK_MEMBERS',
    ban: 'BAN_MEMBERS',
});

const SANCTIONS = Object.freeze(Object.keys(PERMISSION_PAR_SANCTION));

// Codes neutres qui valent « la ressource n'existe pas », et pour lesquels un
// lecteur rend `null` plutôt que de lever. TOUT le reste — panne réseau,
// permission manquante — remonte : rendre `null` sur une coupure ferait croire
// que la ressource a disparu, et le balayeur de bannissements temporaires en
// déduirait qu'il peut OUBLIER une échéance.
const ABSENCES = Object.freeze([CODES_NEUTRES.introuvable, CODES_NEUTRES.guilde_inconnue]);

/**
 * Rend `null` si l'erreur signifie « ça n'existe pas », relance sinon.
 * @param {string[]} [absences] codes neutres à traiter comme une absence
 */
function absenceOuLeve(err, absences = ABSENCES) {
    if (absences.includes(codeNeutre(marquerErreur(err)))) return null;
    throw err;
}

/** Horodatage d'émission porté par un snowflake. */
function dateDuSnowflake(id) {
    return Number((BigInt(id) >> 22n) + EPOQUE_SNOWFLAKE);
}

/**
 * Corps REST d'un message, à partir d'un contenu ou d'un embed neutre.
 *
 * `rendreContenu` produit des structures discord.js (EmbedBuilder,
 * `files: [{ attachment, name }]`). L'API REST brute attend du JSON et
 * `files: [{ name, data }]` : la conversion est ici, et seulement ici.
 */
function corpsMessage(contenu) {
    const rendu = rendreContenu(contenu);
    if (rendu.embeds) rendu.embeds = rendu.embeds.map(e => (typeof e?.toJSON === 'function' ? e.toJSON() : e));
    if (rendu.files) {
        rendu.files = rendu.files.map(f => ({ name: f.name, data: f.attachment, contentType: f.contentType }));
    }
    return rendu;
}

/**
 * Résout une valeur de permission vers un BigInt.
 * Accepte un nom canonique, un tableau de noms, un BigInt, un entier ou une
 * chaîne de bitfield déjà sérialisée — les cinq formes qui circulent entre le
 * code métier, la base et l'API.
 */
function resoudreBits(valeur) {
    if (valeur === null || valeur === undefined) return 0n;
    if (Array.isArray(valeur)) return bitfield(valeur);
    if (typeof valeur === 'string') return estPermissionCanonique(valeur) ? bitfield(valeur) : BigInt(valeur);
    return BigInt(valeur);
}

/**
 * Overwrites neutres -> forme REST.
 * `{ id, type: 'role'|'membre', autorise: [...], refuse: [...] }`
 */
function normaliserOverwrites(liste) {
    if (!Array.isArray(liste)) return undefined;
    return liste.map(o => ({
        id: o.id,
        type: o.type === 'role' ? 0 : o.type === 'membre' ? 1 : o.type,
        allow: serialiserBitfield(resoudreBits(o.autorise ?? o.allow)),
        deny: serialiserBitfield(resoudreBits(o.refuse ?? o.deny)),
    }));
}

/** Emoji neutre -> segment d'URL attendu par l'API des réactions. */
function encoderEmoji(emoji) {
    // `<:nom:id>` et `<a:nom:id>` sont les formes écrites dans un message ;
    // l'API des réactions attend « nom:id ».
    const personnalise = /^<a?:([^:]+):(\d+)>$/.exec(String(emoji));
    const brut = personnalise ? `${personnalise[1]}:${personnalise[2]}` : String(emoji);
    return encodeURIComponent(brut);
}

/**
 * Deltas de permission d'un overwrite unitaire.
 * `{ CONNECT: false, VIEW_CHANNEL: true, SEND_MESSAGES: null }`
 *   true  -> autorisée
 *   false -> refusée
 *   null  -> héritée (le bit est retiré des deux masques)
 * @returns {{allow: bigint, deny: bigint}} les masques après application
 */
function appliquerDeltas(allow, deny, deltas) {
    for (const [nom, valeur] of Object.entries(deltas || {})) {
        exigerPermissionCanonique(nom);
        const bit = BITS[nom];
        // Le bit est d'abord retiré des DEUX masques : sans ça, passer une
        // permission de « refusée » à « autorisée » la laisserait dans `deny`,
        // et Discord fait primer le refus.
        allow &= ~bit;
        deny &= ~bit;
        if (valeur === true) allow |= bit;
        else if (valeur === false) deny |= bit;
    }
    return { allow, deny };
}

/**
 * @param {import('discord.js').Client} client
 * @returns {object} client REST normalisé (DA §4.3)
 */
function creerApi(client) {
    const rest = () => client.rest;
    const motif = (raison) => (raison ? { reason: String(raison).slice(0, 512) } : {});

    /** Guilde discord.js, depuis le cache ou par un appel. */
    async function guildeDiscord(guildeId) {
        return client.guilds.cache.get(guildeId) || client.guilds.fetch(guildeId);
    }

    async function membreDiscord(guildeId, membreId) {
        const guilde = await guildeDiscord(guildeId);
        return guilde.members.cache.get(membreId) || guilde.members.fetch(membreId);
    }

    /**
     * Overwrite courant d'une cible, en BigInt.
     *
     * Le cache est privilégié quand il est chaud (le cas nominal d'un salon que
     * le bot vient de créer), la lecture REST sert de repli. Rendre `null` pour
     * « pas d'overwrite » se distingue de `{allow: 0n, deny: 0n}`, qui signifie
     * « overwrite présent mais vide » — et seul le premier oblige à connaître le
     * type de la cible.
     */
    async function lireOverwrite(canalId, cibleId) {
        const cache = client.channels.cache.get(canalId)?.permissionOverwrites?.cache?.get(cibleId);
        if (cache) {
            return { type: cache.type === 'role' ? 0 : cache.type === 'member' ? 1 : cache.type,
                allow: BigInt(cache.allow?.bitfield ?? 0), deny: BigInt(cache.deny?.bitfield ?? 0) };
        }
        try {
            const canal = await rest().get(Routes.channel(canalId));
            const trouve = (canal.permission_overwrites || []).find(o => o.id === cibleId);
            if (!trouve) return null;
            return { type: trouve.type, allow: BigInt(trouve.allow), deny: BigInt(trouve.deny) };
        } catch {
            return null;
        }
    }

    // `marquerErreursApi` enveloppe TOUTES les méthodes ci-dessous : chaque
    // rejet ressort avec `err.codeNeutre`, sans que `err.code` natif soit
    // touché. C'est ce qui permet au code métier de raisonner sur 'permission'
    // ou 'guilde_inconnue' au lieu de 50013 et 10004 — des numéros Discord qui
    // ne voudront rien dire sur Fluxer.
    return marquerErreursApi({
        // ─── Messages ────────────────────────────────────────────────────────

        /** @returns {Promise<object>} le message posté, NORMALISÉ (cf. events.js) */
        async envoyerMessage(canalId, contenu) {
            // Normalisé, et pas rendu brut : l'appelant s'en sert pour stocker
            // un identifiant de panneau en base, et une réponse REST en
            // snake_case l'obligerait à connaître la forme de l'API Discord.
            return normaliserMessage(await rest().post(Routes.channelMessages(canalId), { body: corpsMessage(contenu) }));
        },

        async modifierMessage(canalId, messageId, contenu) {
            return normaliserMessage(await rest().patch(Routes.channelMessage(canalId, messageId), { body: corpsMessage(contenu) }));
        },

        /**
         * @returns {Promise<object|null>} `null` si le message ou son salon
         *   n'existe plus. Même règle que les autres lecteurs : une panne LÈVE.
         *
         * Le message rendu porte ses `reactions` (avec `parMoi`), que l'API
         * inclut dans sa réponse : c'est ce qui permet de ne reposer que les
         * emojis manquants d'un panneau au lieu de tous les reposer.
         */
        async obtenirMessage(canalId, messageId) {
            try {
                return normaliserMessage(await rest().get(Routes.channelMessage(canalId, messageId)));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /**
         * Historique d'un salon, du plus récent au plus ancien.
         * @param {object} [options] { limite = 50, avant, apres } — identifiants
         *   de message, jamais des dates : c'est la pagination de l'API.
         */
        async listerMessages(canalId, { limite = 50, avant, apres } = {}) {
            const query = new URLSearchParams({ limit: String(Math.min(limite, 100)) });
            if (avant) query.set('before', avant);
            if (apres) query.set('after', apres);
            const messages = await rest().get(Routes.channelMessages(canalId), { query });
            return messages.map(normaliserMessage);
        },

        async supprimerMessage(canalId, messageId, raison) {
            return rest().delete(Routes.channelMessage(canalId, messageId), motif(raison));
        },

        /**
         * Suppression groupée.
         *
         * Les messages de plus de 14 jours sont ÉCARTÉS, pas rejetés : c'est la
         * seule façon d'obtenir un résultat partiel plutôt qu'une erreur 50034
         * sur le lot ENTIER.
         *
         * @returns {Promise<{supprimes: number, ignores: number}>}
         *   `supprimes` ne compte que les lots que l'API a réellement acceptés.
         *   L'API ne rend aucun corps sur un 204 : le seul fait vérifiable est
         *   qu'elle n'a pas refusé. Un lot en échec n'est donc PAS compté, et
         *   l'erreur remonte à l'appelant — `bot/utils/errors.js` sait déjà
         *   traduire 50034 et 50013, et annoncer « 40 messages supprimés » après
         *   un refus serait pire qu'un message d'erreur.
         */
        async supprimerMessagesEnLot(canalId, ids, raison) {
            const limite = Date.now() - AGE_MAX_SUPPRESSION_LOT_MS;
            const uniques = [...new Set(ids)];
            const eligibles = uniques.filter(id => dateDuSnowflake(id) > limite);
            let supprimes = 0;

            for (let debut = 0; debut < eligibles.length; debut += TAILLE_LOT_SUPPRESSION) {
                const lot = eligibles.slice(debut, debut + TAILLE_LOT_SUPPRESSION);
                // L'API refuse un lot d'un seul élément : elle exige entre 2 et
                // 100. Le reliquat part donc en suppression unitaire.
                if (lot.length === 1) {
                    await rest().delete(Routes.channelMessage(canalId, lot[0]), motif(raison));
                } else {
                    await rest().post(Routes.channelBulkDelete(canalId), { body: { messages: lot }, ...motif(raison) });
                }
                supprimes += lot.length;
            }
            return { supprimes, ignores: uniques.length - eligibles.length };
        },

        async ajouterReaction(canalId, messageId, emoji) {
            return rest().put(
                Routes.channelMessageOwnReaction(canalId, messageId, encoderEmoji(emoji))
            );
        },

        /**
         * Retire une réaction. Sans `utilisateurId`, retire CELLE DU BOT.
         *
         * Le cas courant est l'inverse : les panneaux de rôles retirent la
         * réaction de la personne pour garder le panneau propre et faire office
         * d'accusé de réception. Cette opération demande MANAGE_MESSAGES et
         * échoue sans elle — comportement historique conservé, l'appelant
         * décide s'il l'ignore.
         */
        async retirerReaction(canalId, messageId, emoji, utilisateurId = null) {
            const code = encoderEmoji(emoji);
            return utilisateurId
                ? rest().delete(Routes.channelMessageUserReaction(canalId, messageId, code, utilisateurId))
                : rest().delete(Routes.channelMessageOwnReaction(canalId, messageId, code));
        },

        // ─── Membres ─────────────────────────────────────────────────────────

        /**
         * @returns {Promise<object|null>} `null` UNIQUEMENT si le membre ou le
         *   serveur n'existe pas (cas courant d'une sanction expirée : la
         *   personne est partie entre la lecture en base et l'appel). Une panne
         *   réseau ou une permission manquante LÈVENT : les confondre avec une
         *   absence ferait conclure « la personne n'est plus là » à chaque
         *   coupure.
         */
        async obtenirMembre(guildeId, membreId) {
            try {
                return normaliserMembre(await membreDiscord(guildeId, membreId));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /**
         * Le bot peut-il appliquer cette sanction à ce membre ?
         *
         * Équivalent neutre de `member.moderatable / kickable / bannable`, que
         * les pré-contrôles de `applyPunishments` utilisaient et que la voie
         * neutre avait perdus. Les deux causes sont SÉPARÉES parce qu'elles
         * n'appellent pas la même correction : remonter le rôle du bot, ou lui
         * cocher une permission. Un message unique « permission manquante »
         * envoie chercher au mauvais endroit une fois sur deux.
         *
         * Le propriétaire du serveur et le bot lui-même ressortent en
         * « hierarchie » : Discord place l'un au-dessus de tout, et l'autre ne
         * peut pas se sanctionner. C'est exact, et c'est une seconde ligne
         * derrière `ctx.moi` / `guilde.proprietaireId`.
         *
         * @param {string} guildeId
         * @param {string} membreId
         * @param {'timeout'|'kick'|'ban'} action
         * @returns {Promise<null|'hierarchie'|'permission'>} `null` = rien ne
         *   s'y oppose. Rend aussi `null` quand la réponse est INDÉTERMINABLE
         *   (membre illisible, identité du bot hors cache) : inventer un refus
         *   empêcherait une sanction légitime, alors qu'en laissant passer c'est
         *   la plateforme qui tranchera — et son erreur sera traduite.
         */
        async verifierMembreSanctionnable(guildeId, membreId, action) {
            const permission = PERMISSION_PAR_SANCTION[action];
            if (!permission) {
                throw new Error(
                    `verifierMembreSanctionnable : action « ${action} » inconnue. `
                    + `Valeurs acceptées : ${SANCTIONS.join(', ')}.`
                );
            }

            let membre;
            try {
                membre = await membreDiscord(guildeId, membreId);
            } catch {
                // Ni membre parti, ni API injoignable ne sont des refus
                // STRUCTURELS : dans les deux cas la sanction elle-même
                // échouera, avec un code neutre exact. Ce pré-contrôle ne sert
                // qu'à dire « inutile d'essayer », jamais à inventer un motif.
                return null;
            }

            // `manageable` porte la hiérarchie SEULE (et les deux cas absolus :
            // propriétaire, bot lui-même). Il lève si l'identité du bot n'est pas
            // en cache — un état transitoire, pas un refus.
            try {
                if (!membre.manageable) return 'hierarchie';
            } catch {
                return null;
            }

            const moi = membre.guild?.members?.me;
            if (!moi) return null;
            return aPermission(moi.permissions, permission) ? null : 'permission';
        },

        /**
         * @param {object} patch  { roles?, pseudo?, muet?, sourd?, canalVocalId?, timeoutJusqua? }
         *   `timeoutJusqua` accepte une Date, un timestamp ou null (levée).
         * @returns {Promise<object>} le membre après modification, normalisé.
         *   ⚠️ La réponse REST ne porte PAS les permissions calculées : `estAdmin`
         *   y vaut donc toujours false, et `aPermission` toujours false. Pour un
         *   contrôle de droits, passer par `obtenirMembre`, qui lit l'objet
         *   complet.
         */
        async modifierMembre(guildeId, membreId, patch = {}, raison) {
            const body = {};
            if (patch.roles !== undefined) body.roles = patch.roles;
            if (patch.pseudo !== undefined) body.nick = patch.pseudo;
            if (patch.muet !== undefined) body.mute = Boolean(patch.muet);
            if (patch.sourd !== undefined) body.deaf = Boolean(patch.sourd);
            if (patch.canalVocalId !== undefined) body.channel_id = patch.canalVocalId;
            if (patch.timeoutJusqua !== undefined) {
                body.communication_disabled_until = patch.timeoutJusqua === null
                    ? null
                    : new Date(patch.timeoutJusqua).toISOString();
            }
            return normaliserMembre(await rest().patch(Routes.guildMember(guildeId, membreId), { body, ...motif(raison) }));
        },

        async ajouterRole(guildeId, membreId, roleId, raison) {
            return rest().put(Routes.guildMemberRole(guildeId, membreId, roleId), motif(raison));
        },

        async retirerRole(guildeId, membreId, roleId, raison) {
            return rest().delete(Routes.guildMemberRole(guildeId, membreId, roleId), motif(raison));
        },

        /** kick */
        async exclureMembre(guildeId, membreId, raison) {
            return rest().delete(Routes.guildMember(guildeId, membreId), motif(raison));
        },

        async bannirMembre(guildeId, membreId, raison, { supprimerMessagesSecondes = 0 } = {}) {
            return rest().put(Routes.guildBan(guildeId, membreId), {
                body: { delete_message_seconds: supprimerMessagesSecondes },
                ...motif(raison),
            });
        },

        async debannirMembre(guildeId, membreId, raison) {
            return rest().delete(Routes.guildBan(guildeId, membreId), motif(raison));
        },

        /**
         * Timeout de communication natif.
         * @param {Date|number|null} expireLe  null lève le timeout
         */
        async appliquerTimeout(guildeId, membreId, expireLe, raison) {
            return normaliserMembre(await rest().patch(Routes.guildMember(guildeId, membreId), {
                body: { communication_disabled_until: expireLe === null ? null : new Date(expireLe).toISOString() },
                ...motif(raison),
            }));
        },

        // ─── Rôles ───────────────────────────────────────────────────────────

        /**
         * Le bot peut-il attribuer ce rôle ?
         *
         * Hors table §4.3 de la DA, mais indispensable au contrat neutre : six
         * entrées de configuration posent la question, et sans elle chacune
         * devrait lire la hiérarchie des rôles de la plateforme — donc connaître
         * la plateforme. La logique reste celle de bot/utils/assignableRole.js,
         * inchangée.
         *
         * @returns {Promise<null|'missing'|'everyone'|'managed'|'hierarchy'>}
         */
        async verifierRoleAttribuable(guildeId, roleId) {
            const { checkAssignableRole } = require('../../utils/assignableRole');
            let guilde;
            try {
                guilde = await guildeDiscord(guildeId);
            } catch {
                return 'missing';
            }
            const role = guilde.roles.cache.get(roleId) || await guilde.roles.fetch(roleId).catch(() => null);
            return checkAssignableRole(guilde, role);
        },

        // ─── Salons et guildes ───────────────────────────────────────────────

        /**
         * @param {object} spec { nom, type, parentId?, sujet?, permissions?, position?, limiteUtilisateurs? }
         *   `type` est un nom canonique (platform/channels.js), jamais un entier
         *   de plateforme.
         */
        /** @returns {Promise<object>} le salon créé, NORMALISÉ */
        async creerCanal(guildeId, spec = {}, raison) {
            const body = { name: spec.nom, type: TYPES_CANAL_DISCORD[exigerTypeCanalCanonique(spec.type)] };
            if (spec.parentId !== undefined) body.parent_id = spec.parentId;
            if (spec.sujet !== undefined) body.topic = spec.sujet;
            if (spec.position !== undefined) body.position = spec.position;
            if (spec.limiteUtilisateurs !== undefined) body.user_limit = spec.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(spec.permissions);
            if (overwrites) body.permission_overwrites = overwrites;
            // Normalisé : le salon créé part directement en base (tickets,
            // TempVoice), et l'appelant ne doit pas avoir à lire `guild_id`.
            return normaliserCanal(await rest().post(Routes.guildChannels(guildeId), { body, ...motif(raison) }));
        },

        /**
         * ⚠️ `permissions` REMPLACE l'intégralité des overwrites du salon —
         * c'est la sémantique de `permission_overwrites` dans l'API, et elle
         * n'est presque jamais celle qu'on veut. Pour modifier UNE cible sans
         * toucher aux autres (verrouiller un salon temporaire, autoriser une
         * personne), utilisez `definirOverwrite`. Ne passez `permissions` ici
         * que si vous réécrivez sciemment tout le jeu.
         */
        async modifierCanal(canalId, patch = {}, raison) {
            const body = {};
            if (patch.nom !== undefined) body.name = patch.nom;
            if (patch.sujet !== undefined) body.topic = patch.sujet;
            if (patch.parentId !== undefined) body.parent_id = patch.parentId;
            if (patch.position !== undefined) body.position = patch.position;
            if (patch.limiteUtilisateurs !== undefined) body.user_limit = patch.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(patch.permissions);
            if (overwrites) body.permission_overwrites = overwrites;
            return normaliserCanal(await rest().patch(Routes.channel(canalId), { body, ...motif(raison) }));
        },

        /**
         * Modifie l'overwrite d'UNE cible, sans toucher aux autres.
         *
         * C'est l'équivalent neutre de `channel.permissionOverwrites.edit()`, et
         * la seule primitive à utiliser pour un verrouillage ou une autorisation
         * ponctuelle. Elle lit l'overwrite existant, applique les deltas et
         * réécrit cette entrée seule : sans elle, un `modifierCanal({permissions})`
         * effacerait les droits de toutes les autres cibles — le propriétaire
         * d'un salon temporaire perdrait les siens à chaque verrouillage.
         *
         * @param {string} canalId
         * @param {string} cibleId  identifiant de rôle ou de membre
         * @param {Record<string, true|false|null>} deltas  nom canonique -> autorisée / refusée / héritée
         * @param {{type?: 'role'|'membre', raison?: string}} [options]
         *   `type` est déduit de l'overwrite existant s'il y en a un ; il est
         *   obligatoire pour en créer un nouveau, l'API ne le devine pas.
         */
        async definirOverwrite(canalId, cibleId, deltas, { type, raison } = {}) {
            const actuel = await lireOverwrite(canalId, cibleId);
            const typeCible = type !== undefined
                ? (type === 'role' ? 0 : type === 'membre' ? 1 : type)
                : actuel?.type;

            if (typeCible === undefined || typeCible === null) {
                throw new Error(
                    `definirOverwrite : aucun overwrite existant pour ${cibleId} sur le salon ${canalId}, `
                    + 'et « type » n\'est pas précisé. Passez { type: \'role\' } ou { type: \'membre\' }.'
                );
            }

            const { allow, deny } = appliquerDeltas(actuel?.allow ?? 0n, actuel?.deny ?? 0n, deltas);

            return rest().put(Routes.channelPermission(canalId, cibleId), {
                body: {
                    type: typeCible,
                    allow: serialiserBitfield(allow),
                    deny: serialiserBitfield(deny),
                },
                ...motif(raison),
            });
        },

        /** Retire complètement l'overwrite d'une cible (retour à l'héritage). */
        async supprimerOverwrite(canalId, cibleId, raison) {
            return rest().delete(Routes.channelPermission(canalId, cibleId), motif(raison));
        },

        async supprimerCanal(canalId, raison) {
            return rest().delete(Routes.channel(canalId), motif(raison));
        },

        /** @returns {Promise<string>} identifiant du salon privé */
        async ouvrirMessagePrive(utilisateurId) {
            const canal = await rest().post(Routes.userChannels(), { body: { recipient_id: utilisateurId } });
            return canal.id;
        },

        /**
         * @returns {Promise<object|null>} `null` UNIQUEMENT si le bot n'est plus
         *   sur ce serveur (code neutre 'guilde_inconnue').
         *
         * ⚠️ Une panne réseau LÈVE, et c'est le point le plus important de cette
         *   méthode. Le balayage des bannissements temporaires en déduit s'il
         *   doit OUBLIER une échéance : confondre « bot retiré » et « API
         *   injoignable » transformerait un bannissement temporaire en
         *   bannissement définitif, silencieusement, à la première coupure.
         */
        async obtenirGuilde(guildeId) {
            try {
                return normaliserGuilde(await guildeDiscord(guildeId));
            } catch (err) {
                return absenceOuLeve(err, [CODES_NEUTRES.guilde_inconnue]);
            }
        },

        /** @returns {Promise<object|null>} `null` si le salon n'existe plus ; lève sur une panne. */
        async obtenirCanal(canalId) {
            try {
                return normaliserCanal(client.channels.cache.get(canalId) || await client.channels.fetch(canalId));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },

        /** @returns {Promise<object|null>} `null` si le rôle n'existe plus ; lève sur une panne. */
        async obtenirRole(guildeId, roleId) {
            try {
                const guilde = await guildeDiscord(guildeId);
                // `roles.fetch` rend `null` pour un rôle inconnu au lieu de lever.
                return normaliserRole(guilde.roles.cache.get(roleId) || await guilde.roles.fetch(roleId));
            } catch (err) {
                return absenceOuLeve(err);
            }
        },
    });
}

module.exports = {
    creerApi,
    appliquerDeltas,
    absenceOuLeve,
    PERMISSION_PAR_SANCTION,
    SANCTIONS,
    normaliserOverwrites,
    resoudreBits,
    encoderEmoji,
    corpsMessage,
    dateDuSnowflake,
    AGE_MAX_SUPPRESSION_LOT_MS,
};
