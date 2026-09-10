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

const { Routes, ChannelType } = require('discord.js');
const { serialiserBitfield, estPermissionCanonique } = require('../permissions');
const { bitfield } = require('./permissions');
const { exigerTypeCanalCanonique } = require('../channels');
const { rendreContenu } = require('./render');
const { normaliserMembre, normaliserRole, normaliserCanal, normaliserGuilde } = require('./context');

// Discord refuse la suppression groupée des messages de plus de 14 jours, et
// rejette le LOT ENTIER si un seul dépasse (erreur 50034). On filtre donc en
// amont, exactement comme le fera l'adaptateur Fluxer.
const AGE_MAX_SUPPRESSION_LOT_MS = 14 * 24 * 60 * 60 * 1000;
const TAILLE_LOT_SUPPRESSION = 100;

// Époque des snowflakes Discord (2015-01-01). Fluxer utilise le même format :
// l'âge d'un message se lit dans son identifiant, sans aucun appel réseau.
const EPOQUE_SNOWFLAKE = 1420070400000n;

const TYPE_CANAL_VERS_DISCORD = Object.freeze({
    texte: ChannelType.GuildText,
    vocal: ChannelType.GuildVoice,
    categorie: ChannelType.GuildCategory,
    conference: ChannelType.GuildStageVoice,
});

/** Horodatage d'émission porté par un snowflake. */
function dateDuSnowflake(id) {
    return Number((BigInt(id) >> 22n) + EPOQUE_SNOWFLAKE);
}

/** Corps REST d'un message, à partir d'un contenu ou d'un embed neutre. */
function corpsMessage(contenu) {
    const rendu = rendreContenu(contenu);
    if (rendu.embeds) rendu.embeds = rendu.embeds.map(e => (typeof e?.toJSON === 'function' ? e.toJSON() : e));
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

    return {
        // ─── Messages ────────────────────────────────────────────────────────

        async envoyerMessage(canalId, contenu) {
            return rest().post(Routes.channelMessages(canalId), { body: corpsMessage(contenu) });
        },

        async modifierMessage(canalId, messageId, contenu) {
            return rest().patch(Routes.channelMessage(canalId, messageId), { body: corpsMessage(contenu) });
        },

        async supprimerMessage(canalId, messageId, raison) {
            return rest().delete(Routes.channelMessage(canalId, messageId), motif(raison));
        },

        /**
         * @returns {Promise<number>} nombre de messages effectivement supprimés.
         *   Les messages de plus de 14 jours sont ÉCARTÉS, pas rejetés : c'est
         *   la seule façon d'obtenir un résultat partiel plutôt qu'une erreur
         *   50034 sur le lot entier.
         */
        async supprimerMessagesEnLot(canalId, ids, raison) {
            const limite = Date.now() - AGE_MAX_SUPPRESSION_LOT_MS;
            const eligibles = [...new Set(ids)].filter(id => dateDuSnowflake(id) > limite);
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
            return supprimes;
        },

        async ajouterReaction(canalId, messageId, emoji) {
            return rest().put(
                Routes.channelMessageOwnReaction(canalId, messageId, encoderEmoji(emoji))
            );
        },

        // ─── Membres ─────────────────────────────────────────────────────────

        async obtenirMembre(guildeId, membreId) {
            try {
                return normaliserMembre(await membreDiscord(guildeId, membreId));
            } catch {
                // Membre parti entre la lecture en base et l'appel : ce n'est pas
                // une panne, c'est le cas courant d'une sanction expirée.
                return null;
            }
        },

        /**
         * @param {object} patch  { roles?, pseudo?, muet?, sourd?, canalVocalId?, timeoutJusqua? }
         *   `timeoutJusqua` accepte une Date, un timestamp ou null (levée).
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
            return rest().patch(Routes.guildMember(guildeId, membreId), { body, ...motif(raison) });
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
            return rest().patch(Routes.guildMember(guildeId, membreId), {
                body: { communication_disabled_until: expireLe === null ? null : new Date(expireLe).toISOString() },
                ...motif(raison),
            });
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
        async creerCanal(guildeId, spec = {}, raison) {
            const body = { name: spec.nom, type: TYPE_CANAL_VERS_DISCORD[exigerTypeCanalCanonique(spec.type)] };
            if (spec.parentId !== undefined) body.parent_id = spec.parentId;
            if (spec.sujet !== undefined) body.topic = spec.sujet;
            if (spec.position !== undefined) body.position = spec.position;
            if (spec.limiteUtilisateurs !== undefined) body.user_limit = spec.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(spec.permissions);
            if (overwrites) body.permission_overwrites = overwrites;
            return rest().post(Routes.guildChannels(guildeId), { body, ...motif(raison) });
        },

        async modifierCanal(canalId, patch = {}, raison) {
            const body = {};
            if (patch.nom !== undefined) body.name = patch.nom;
            if (patch.sujet !== undefined) body.topic = patch.sujet;
            if (patch.parentId !== undefined) body.parent_id = patch.parentId;
            if (patch.position !== undefined) body.position = patch.position;
            if (patch.limiteUtilisateurs !== undefined) body.user_limit = patch.limiteUtilisateurs;
            const overwrites = normaliserOverwrites(patch.permissions);
            if (overwrites) body.permission_overwrites = overwrites;
            return rest().patch(Routes.channel(canalId), { body, ...motif(raison) });
        },

        async supprimerCanal(canalId, raison) {
            return rest().delete(Routes.channel(canalId), motif(raison));
        },

        /** @returns {Promise<string>} identifiant du salon privé */
        async ouvrirMessagePrive(utilisateurId) {
            const canal = await rest().post(Routes.userChannels(), { body: { recipient_id: utilisateurId } });
            return canal.id;
        },

        async obtenirGuilde(guildeId) {
            try {
                return normaliserGuilde(await guildeDiscord(guildeId));
            } catch {
                return null;
            }
        },

        async obtenirCanal(canalId) {
            try {
                return normaliserCanal(client.channels.cache.get(canalId) || await client.channels.fetch(canalId));
            } catch {
                return null;
            }
        },

        async obtenirRole(guildeId, roleId) {
            try {
                const guilde = await guildeDiscord(guildeId);
                return normaliserRole(guilde.roles.cache.get(roleId) || await guilde.roles.fetch(roleId));
            } catch {
                return null;
            }
        },
    };
}

module.exports = {
    creerApi,
    normaliserOverwrites,
    resoudreBits,
    encoderEmoji,
    corpsMessage,
    dateDuSnowflake,
    TYPE_CANAL_VERS_DISCORD,
    AGE_MAX_SUPPRESSION_LOT_MS,
};
