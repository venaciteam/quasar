#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   Quasar — Configuration et démarrage
#
#   Lancé par install.sh, ou directement : ./setup.sh
#   Il pose les questions, écrit le .env, construit l'image, démarre le
#   conteneur, puis contrôle que tout répond vraiment.
#
#   Sans terminal (CI, conteneur sans TTY) ou avec --non-interactive, la
#   configuration est lue dans l'environnement : ./setup.sh --help en donne la
#   liste. C'est aussi ce qui rend ce script testable de bout en bout.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Entrée standard ─────────────────────────────────────────────
# Le chemin d'installation recommandé est « curl … | bash ». L'entrée standard
# y est le texte du script, déjà consommé quand les questions arrivent : « read »
# renvoie 1 sans rien lire et « set -e » sort aussitôt, en silence. C'est ce qui
# faisait qu'une installation s'arrêtait sur « 📝 Configuration du bot » sans
# fichier .env, sans conteneur et sans le moindre message.
# Reproduction : bash -c 'set -e; read -sp "Jeton : " V < /dev/null; echo suite'
# n'affiche jamais « suite » et sort en 1.
# Ce script-ci est lu depuis un FICHIER : rebrancher son entrée sur le terminal
# ne lui fait rien perdre de son propre texte, contrairement à install.sh.
# Le mode non interactif est repéré AVANT ce rebranchement : demander le
# terminal alors que personne n'est devant, c'est une installation automatisée
# qui attend une frappe jusqu'à la fin des temps.
NON_INTERACTIF_DEMANDE=0
if [ "${QUASAR_NONINTERACTIVE:-0}" = "1" ]; then NON_INTERACTIF_DEMANDE=1; fi
for _argument in "$@"; do
    case "$_argument" in
        -y|--yes|--non-interactive) NON_INTERACTIF_DEMANDE=1 ;;
    esac
done

if [ "$NON_INTERACTIF_DEMANDE" -eq 0 ] && [ ! -t 0 ] \
   && [ -e /dev/tty ] && (exec 3</dev/tty) 2>/dev/null; then
    exec < /dev/tty
fi

INTERACTIF=1
if [ ! -t 0 ] || [ "$NON_INTERACTIF_DEMANDE" -eq 1 ]; then INTERACTIF=0; fi

# ── Emplacement ─────────────────────────────────────────────────
# docker compose lit le docker-compose.yml du répertoire courant : le script
# doit travailler dans le dépôt, même appelé par un chemin absolu depuis ailleurs.
RACINE=$(cd "$(dirname "$0")" && pwd)
cd "$RACINE" || exit 1

# ── Couleurs ────────────────────────────────────────────────────
# Voir install.sh pour le détail : NO_COLOR, sortie non-terminal et TERM=dumb
# désactivent la couleur, et tput n'est pas utilisé (absent des systèmes minimaux).
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    C_TITRE=$'\033[1;36m'; C_OK=$'\033[0;32m'; C_ERR=$'\033[0;31m'
    C_AVERT=$'\033[1;33m'; C_DOUX=$'\033[0;90m'; C_QUESTION=$'\033[1;35m'
    C_FIN=$'\033[0m'
    COULEUR=1
else
    C_TITRE=''; C_OK=''; C_ERR=''; C_AVERT=''; C_DOUX=''; C_QUESTION=''
    C_FIN=''
    COULEUR=0
fi

titre()  { printf '\n%s  %s%s\n\n' "$C_TITRE" "$1" "$C_FIN"; }
info()   { printf '   %s\n' "$1"; }
doux()   { printf '   %s%s%s\n' "$C_DOUX" "$1" "$C_FIN"; }
ok()     { printf '   %s✅ %s%s\n' "$C_OK" "$1" "$C_FIN"; }
avert()  { printf '   %s⚠️  %s%s\n' "$C_AVERT" "$1" "$C_FIN"; }
erreur() { printf '\n%s❌ %s%s\n' "$C_ERR" "$1" "$C_FIN" >&2; }

# Élague les espaces de bord : un jeton copié depuis le Developer Portal arrive
# régulièrement avec une espace finale, et Discord refuse alors la connexion
# sans que rien ne le laisse deviner.
elaguer() { printf '%s' "${1:-}" | awk '{ gsub(/^[ \t]+|[ \t]+$/, ""); print }'; }

# ── Options ─────────────────────────────────────────────────────
RECONFIGURER=0

aide() {
    cat <<'AIDE'
  Quasar — configuration et démarrage

  Utilisation : ./setup.sh [options]

  Options :
    -y, --non-interactive   Ne rien demander. La configuration vient alors
                            entièrement de l'environnement.
    --reconfigure           Régénérer le .env d'une installation existante
                            (l'ancien est sauvegardé à côté).
    -h, --help              Afficher cette aide.

  Variables lues dans l'environnement (toute variable déjà posée n'est pas
  demandée) :
    DISCORD_TOKEN           Jeton du bot. Obligatoire.
    DISCORD_CLIENT_ID       Identifiant de l'application. Obligatoire.
    DISCORD_CLIENT_SECRET   Secret OAuth2 de l'application. Obligatoire.
    BOT_OWNER_ID            Votre identifiant Discord. Optionnel.
    PORT                    Port du dashboard. Défaut : 3000.
    BIND_ADDRESS            127.0.0.1 (défaut, accès local seul) ou 0.0.0.0
                            pour ouvrir le dashboard au réseau.
    CALLBACK_URL            Adresse de retour OAuth2. Déduite du port et de
                            BIND_ADDRESS si elle n'est pas fournie.
    JWT_SECRET              Clé de signature des sessions. Générée si absente.
    QUASAR_MODE             bot (défaut), site ou public.
    DOCKER_GID              Groupe propriétaire du socket Docker. Détecté seul.

  Réglages avancés :
    QUASAR_SKIP_TOKEN_CHECK=1   Ne pas contrôler le jeton auprès de Discord.
    QUASAR_HEALTH_TIMEOUT=90    Secondes d'attente du dashboard au démarrage.
    NO_COLOR=1                  Sortie sans couleur.

  Exemple d'installation sans aucune question :
    DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \
      ./setup.sh --non-interactive
AIDE
}

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes|--non-interactive) INTERACTIF=0 ;;
        --reconfigure) RECONFIGURER=1 ;;
        -h|--help) aide; exit 0 ;;
        *) erreur "Option inconnue : $1"; info "Voir ./setup.sh --help"; exit 1 ;;
    esac
    shift
done

printf '%s\n' ""
printf '%s  🌌  Quasar — Installation%s\n' "$C_TITRE" "$C_FIN"
printf '%s  ════════════════════════%s\n' "$C_TITRE" "$C_FIN"

# ── Dialogue ────────────────────────────────────────────────────
REPONSE=""
REPONSE_CHOIX=1

# Appelée quand l'entrée standard se ferme au milieu des questions. Le cas
# n'est pas rare : tube sans terminal, session SSH coupée, exécution par un
# outil d'automatisation. Sortir sans rien dire serait le pire des choix, c'est
# exactement le défaut que ce script corrige.
entree_perdue() {
    erreur "Je n'ai plus rien à lire sur l'entrée standard : impossible de poser mes questions."
    printf '\n'
    info "Deux façons de continuer :"
    info "  1. Relancer depuis un terminal :"
    info "       cd \"$RACINE\" && ./setup.sh"
    info "  2. Fournir la configuration par l'environnement, sans aucune question :"
    info "       DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \\"
    info "         ./setup.sh --non-interactive"
    printf '\n'
    info "La liste complète des variables : ./setup.sh --help"
    exit 1
}

lire_ligne() { # $1 question, $2 valeur par défaut → REPONSE
    local invite=$1 defaut=${2:-} saisie=""
    if [ -n "$defaut" ]; then
        printf '   %s%s%s %s[%s]%s : ' "$C_QUESTION" "$invite" "$C_FIN" "$C_DOUX" "$defaut" "$C_FIN"
    else
        printf '   %s%s%s : ' "$C_QUESTION" "$invite" "$C_FIN"
    fi
    if ! IFS= read -r saisie; then printf '\n'; entree_perdue; fi
    REPONSE=$(elaguer "$saisie")
    if [ -z "$REPONSE" ]; then REPONSE=$defaut; fi
}

lire_secret() { # $1 question → REPONSE (jamais réaffichée)
    local saisie=""
    printf '   %s%s%s : ' "$C_QUESTION" "$1" "$C_FIN"
    if ! IFS= read -rs saisie; then printf '\n'; entree_perdue; fi
    printf '\n'
    REPONSE=$(elaguer "$saisie")
}

# Menu de choix. Numéroté PARTOUT, flèches en surcouche seulement quand le
# terminal s'y prête : la navigation aux flèches réclame un mode brut et des
# séquences ANSI, et se dégrade très mal sur une console série, dans un tmux au
# TERM exotique ou derrière un SSH capricieux — c'est-à-dire précisément là où
# Quasar s'installe. Le numéro, lui, marche toujours, et reste accepté même en
# mode flèches.
_menu_numerote() { # $1 question, puis options → REPONSE_CHOIX
    local question=$1; shift
    local total=$# i=1 saisie=""
    printf '   %s%s%s\n' "$C_QUESTION" "$question" "$C_FIN"
    local opt
    for opt in "$@"; do
        printf '     %s%s)%s %s\n' "$C_TITRE" "$i" "$C_FIN" "$opt"
        i=$((i + 1))
    done
    while :; do
        printf '   Votre choix %s[1]%s : ' "$C_DOUX" "$C_FIN"
        if ! IFS= read -r saisie; then printf '\n'; entree_perdue; fi
        saisie=$(elaguer "$saisie")
        if [ -z "$saisie" ]; then saisie=1; fi
        case "$saisie" in
            *[!0-9]*) ;;
            *)
                if [ "$saisie" -ge 1 ] && [ "$saisie" -le "$total" ]; then
                    REPONSE_CHOIX=$saisie
                    return 0
                fi
                ;;
        esac
        avert "Répondez par un nombre entre 1 et ${total}."
    done
}

_menu_fleches() { # $1 question, puis options → REPONSE_CHOIX
    local question=$1; shift
    local total=$# sel=1 i touche suite premier=1 opt
    printf '   %s%s%s\n' "$C_QUESTION" "$question" "$C_FIN"
    printf '   %s↑ ↓ pour choisir, Entrée pour valider, ou tapez le numéro%s\n' "$C_DOUX" "$C_FIN"
    while :; do
        if [ "$premier" -eq 1 ]; then premier=0; else printf '\033[%dA' "$total"; fi
        i=1
        for opt in "$@"; do
            printf '\033[2K'
            if [ "$i" -eq "$sel" ]; then
                printf '     %s❯ %s%s\n' "$C_OK" "$opt" "$C_FIN"
            else
                printf '       %s\n' "$opt"
            fi
            i=$((i + 1))
        done
        touche=""
        if ! IFS= read -rsn1 touche; then printf '\n'; entree_perdue; fi
        case "$touche" in
            $'\033')
                # Une flèche arrive en trois octets : ESC [ A. Le délai borne
                # l'attente d'un ESC seul (touche Échap), qui ne doit pas figer.
                suite=""
                IFS= read -rsn2 -t 1 suite || true
                case "$suite" in
                    '[A') sel=$(( sel > 1 ? sel - 1 : total )) ;;
                    '[B') sel=$(( sel < total ? sel + 1 : 1 )) ;;
                esac
                ;;
            [1-9])
                if [ "$touche" -le "$total" ]; then sel=$touche; break; fi
                ;;
            '') break ;;
        esac
    done
    REPONSE_CHOIX=$sel
}

choisir() {
    if [ "$INTERACTIF" -eq 1 ] && [ "$COULEUR" -eq 1 ] && [ -t 0 ] \
       && [ "${QUASAR_MENU_SIMPLE:-0}" != "1" ]; then
        _menu_fleches "$@"
    else
        _menu_numerote "$@"
    fi
}

# ── Docker ──────────────────────────────────────────────────────
titre "🔍  Contrôle de l'environnement"

if ! command -v docker >/dev/null 2>&1; then
    erreur "Docker n'est pas installé."
    info "Installation : curl -fsSL https://get.docker.com | sh"
    info "Documentation : https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    erreur "Le greffon Docker Compose v2 est absent."
    info "Debian, Ubuntu : sudo apt install docker-compose-plugin"
    info "L'ancien « docker-compose » (avec un tiret) ne convient pas."
    exit 1
fi

# Le démon, pas seulement la commande : « docker » installé mais inutilisable
# faute d'appartenir au groupe docker est le premier échec d'une machine neuve,
# et son message d'origine (permission denied on /var/run/docker.sock) ne dit
# pas quoi faire.
if ! docker info >/dev/null 2>&1; then
    erreur "Docker est installé mais ne répond pas."
    info "Si le démon est arrêté   : sudo systemctl start docker"
    info "Si les droits manquent   : sudo usermod -aG docker \$USER"
    info "                           puis fermez et rouvrez votre session (ou : newgrp docker)"
    info "Pour voir le message brut : docker info"
    exit 1
fi

ok "Docker et Docker Compose répondent"

# ── Valeurs déjà présentes dans l'environnement ─────────────────
DISCORD_TOKEN=$(elaguer "${DISCORD_TOKEN:-}")
DISCORD_CLIENT_ID=$(elaguer "${DISCORD_CLIENT_ID:-}")
DISCORD_CLIENT_SECRET=$(elaguer "${DISCORD_CLIENT_SECRET:-}")
BOT_OWNER_ID=$(elaguer "${BOT_OWNER_ID:-}")
PORT=$(elaguer "${PORT:-}")
BIND_ADDRESS=$(elaguer "${BIND_ADDRESS:-}")
CALLBACK_URL=$(elaguer "${CALLBACK_URL:-}")
JWT_SECRET=${JWT_SECRET:-}
QUASAR_MODE=$(elaguer "${QUASAR_MODE:-}")
DOCKER_GID=$(elaguer "${DOCKER_GID:-}")

NOM_DU_BOT=""

# ── Contrôles de forme ──────────────────────────────────────────
# Un identifiant Discord est un « snowflake » : 17 à 20 chiffres. Le contrôle
# évite surtout la confusion classique entre identifiant et nom d'utilisateur.
identifiant_valide() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    local n=${#1}
    if [ "$n" -ge 17 ] && [ "$n" -le 20 ]; then return 0; fi
    return 1
}

port_valide() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    if [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; then return 0; fi
    return 1
}

# ── Contrôle du jeton auprès de Discord ─────────────────────────
# Un jeton faux est le premier mode d'échec du projet, et il coûtait jusqu'ici
# plusieurs minutes de construction d'image sur un Raspberry Pi avant de se
# manifester par un TokenInvalid en boucle. Discord répond en quelques centaines
# de millisecondes ; autant demander avant de construire quoi que ce soit.
# Codes de retour : 0 = jeton accepté, 1 = refusé par Discord, 2 = indéterminé
# (curl absent, réseau coupé). L'indéterminé n'arrête JAMAIS l'installation.
verifier_jeton() {
    local jeton=$1 corps code
    if [ "${QUASAR_SKIP_TOKEN_CHECK:-0}" = "1" ]; then return 2; fi
    if ! command -v curl >/dev/null 2>&1; then return 2; fi

    corps=$(mktemp 2>/dev/null || printf '%s' "/tmp/quasar-jeton.$$")
    # Le jeton passe par la configuration de curl sur son entrée, jamais par la
    # ligne de commande : les arguments d'un processus sont lisibles par tout le
    # monde sur la machine (ps). L'entrée est rebranchée ici pour cette commande
    # seulement, le terminal des questions n'est pas perdu.
    code=$(curl --config - -sS -m 10 -o "$corps" -w '%{http_code}' <<CONFIG || printf '000'
url = "https://discord.com/api/v10/users/@me"
header = "Authorization: Bot ${jeton}"
header = "User-Agent: quasar-setup (https://github.com/venaciteam/quasar)"
CONFIG
)
    case "$code" in
        200)
            # Pas de jq sur une machine neuve : le JSON est découpé, la valeur
            # d'un champ est le 4e élément entre guillemets de sa ligne.
            NOM_DU_BOT=$(tr ',{}' '\n\n\n' < "$corps" | grep '"username"' | head -1 | cut -d'"' -f4 || true)
            rm -f "$corps"
            return 0
            ;;
        401|403)
            rm -f "$corps"
            return 1
            ;;
        *)
            rm -f "$corps"
            return 2
            ;;
    esac
}

annoncer_jeton() { # $1 = code de retour de verifier_jeton
    case "$1" in
        0)
            if [ -n "$NOM_DU_BOT" ]; then
                ok "Connecté en tant que ${NOM_DU_BOT}"
            else
                ok "Jeton accepté par Discord"
            fi
            ;;
        2)
            doux "Jeton non vérifié (Discord injoignable ou contrôle désactivé) : je continue."
            ;;
    esac
}

# ── Détection d'une session distante ────────────────────────────
# Sur un Raspberry Pi installé en SSH, « http://localhost:3000 » ouvert depuis
# le portable ne mène nulle part : localhost y désigne le portable. C'est
# l'échec de première installation le plus probable, et il est silencieux.
EST_DISTANT=0
if [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_TTY:-}" ] || [ -n "${SSH_CLIENT:-}" ]; then
    EST_DISTANT=1
fi

adresse_de_la_machine() {
    local adresse=""
    # SSH_CONNECTION contient « IP_client port_client IP_serveur port_serveur » :
    # la 3e valeur est l'adresse par laquelle la personne joint DÉJÀ cette
    # machine. Aucune heuristique ne fera mieux.
    if [ -n "${SSH_CONNECTION:-}" ]; then
        adresse=$(printf '%s' "$SSH_CONNECTION" | awk '{ print $3 }')
    fi
    if [ -z "$adresse" ] && command -v hostname >/dev/null 2>&1; then
        adresse=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)
    fi
    if [ -z "$adresse" ] && command -v ip >/dev/null 2>&1; then
        adresse=$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' | head -1 || true)
    fi
    if [ -z "$adresse" ] && command -v ipconfig >/dev/null 2>&1; then
        adresse=$(ipconfig getifaddr en0 2>/dev/null || true)
    fi
    printf '%s' "$adresse"
}

# ── Génération du secret de session ─────────────────────────────
generer_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
        return 0
    fi
    # openssl manque sur bien des systèmes minimaux. /dev/urandom et od, eux,
    # sont là partout, busybox compris.
    if [ -r /dev/urandom ]; then
        LC_ALL=C od -An -tx1 -N32 < /dev/urandom | tr -d ' \n'
        printf '\n'
        return 0
    fi
    return 1
}

# ── Lecture d'un .env existant ──────────────────────────────────
# Sans « source » ni « eval » : un .env contenant une substitution de commande
# serait exécuté. Les valeurs sont lues comme du texte, point.
lire_valeur_env() { # $1 clé, $2 fichier
    local ligne cle
    while IFS= read -r ligne || [ -n "$ligne" ]; do
        case "$ligne" in
            "$1"=*) cle=${ligne#*=}; printf '%s' "$cle"; return 0 ;;
        esac
    done < "$2"
    return 1
}

# ═══════════════════════════════════════════════════════════════
#   Configuration
# ═══════════════════════════════════════════════════════════════
CONFIG_ECRITE=0

if [ -f .env ] && [ "$RECONFIGURER" -eq 0 ]; then
    titre "📝  Configuration"
    ok "Fichier .env existant conservé"
    doux "Pour le régénérer : ./setup.sh --reconfigure"

    PORT=$(lire_valeur_env PORT .env || true)
    if ! port_valide "$PORT"; then PORT=3000; fi
    BIND_ADDRESS=$(lire_valeur_env BIND_ADDRESS .env || true)
    if [ -z "$BIND_ADDRESS" ]; then BIND_ADDRESS=127.0.0.1; fi
    DISCORD_CLIENT_ID=$(lire_valeur_env DISCORD_CLIENT_ID .env || true)
    CALLBACK_URL=$(lire_valeur_env CALLBACK_URL .env || true)
    QUASAR_MODE=$(lire_valeur_env QUASAR_MODE .env || true)

    # Depuis la v4.9.0, Quasar refuse de démarrer si une variable vitale manque
    # ou est restée sur sa valeur d'exemple. Le dire ici évite de construire une
    # image pour la voir refuser de démarrer ensuite.
    MANQUANTES=""
    for cle in DISCORD_TOKEN DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET CALLBACK_URL JWT_SECRET; do
        valeur=$(lire_valeur_env "$cle" .env || true)
        case "$valeur" in
            ''|your_bot_token_here|your_client_id_here|your_client_secret_here|change_this_to_a_random_string|quasar-secret)
                MANQUANTES="${MANQUANTES} ${cle}" ;;
        esac
    done
    if [ -n "$MANQUANTES" ]; then
        avert "Ce .env est incomplet :${MANQUANTES}"
        info "Quasar refuse de démarrer sans ces variables, et il vous dira laquelle"
        info "dans ses journaux. Renseignez-les dans ${RACINE}/.env, ou relancez"
        info "avec ./setup.sh --reconfigure pour reprendre la configuration."
    fi
else
    titre "📝  Configuration du bot"

    if [ "$INTERACTIF" -eq 0 ]; then
        # Mode non interactif : rien n'est demandé, tout vient de l'environnement.
        # Le refus doit nommer ce qui manque, jamais se contenter d'échouer.
        ABSENTES=""
        [ -n "$DISCORD_TOKEN" ] || ABSENTES="${ABSENTES} DISCORD_TOKEN"
        [ -n "$DISCORD_CLIENT_ID" ] || ABSENTES="${ABSENTES} DISCORD_CLIENT_ID"
        [ -n "$DISCORD_CLIENT_SECRET" ] || ABSENTES="${ABSENTES} DISCORD_CLIENT_SECRET"
        if [ -n "$ABSENTES" ]; then
            if [ -t 0 ]; then
                erreur "Mode non interactif : ces variables doivent être fournies :${ABSENTES}"
                info "Voir ./setup.sh --help pour la liste complète."
                exit 1
            fi
            erreur "Aucun terminal disponible, et la configuration est incomplète :${ABSENTES}"
            printf '\n'
            info "Je ne peux poser aucune question ici (pas de terminal : intégration"
            info "continue, conteneur sans TTY, tâche planifiée…)."
            printf '\n'
            info "Deux façons de continuer :"
            info "  1. Relancer depuis un terminal :"
            info "       cd \"$RACINE\" && ./setup.sh"
            info "  2. Fournir la configuration par l'environnement :"
            info "       DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… \\"
            info "         ./setup.sh --non-interactive"
            printf '\n'
            info "La liste complète des variables : ./setup.sh --help"
            exit 1
        fi
        doux "Mode non interactif : la configuration est lue dans l'environnement."
    fi

    # ── Jeton ───────────────────────────────────────────────────
    if [ -n "$DISCORD_TOKEN" ]; then
        doux "DISCORD_TOKEN repris de l'environnement."
        verdict=0; verifier_jeton "$DISCORD_TOKEN" || verdict=$?
        if [ "$verdict" -eq 1 ]; then
            erreur "Discord refuse ce jeton (DISCORD_TOKEN)."
            info "Developer Portal → votre application → Bot → Reset Token."
            exit 1
        fi
        annoncer_jeton "$verdict"
    else
        info ""
        doux "Le jeton se trouve dans le Developer Portal → votre application → Bot."
        doux "Il ne s'affiche qu'une fois : « Reset Token » en fabrique un nouveau."
        while :; do
            lire_secret "Jeton du bot Discord"
            DISCORD_TOKEN=$REPONSE
            if [ -z "$DISCORD_TOKEN" ]; then
                avert "Le jeton est obligatoire : sans lui, Quasar ne peut pas se connecter."
                continue
            fi
            verdict=0; verifier_jeton "$DISCORD_TOKEN" || verdict=$?
            if [ "$verdict" -eq 1 ]; then
                avert "Discord refuse ce jeton. Vérifiez qu'il s'agit bien du jeton du BOT,"
                info "et non du « Client Secret » de l'application, puis recommencez."
                continue
            fi
            annoncer_jeton "$verdict"
            break
        done
    fi

    # ── Identifiant et secret de l'application ──────────────────
    if [ -n "$DISCORD_CLIENT_ID" ]; then
        doux "DISCORD_CLIENT_ID repris de l'environnement."
    else
        doux "Developer Portal → votre application → OAuth2 → Client ID."
        while :; do
            lire_ligne "Identifiant de l'application (Client ID)"
            DISCORD_CLIENT_ID=$REPONSE
            if identifiant_valide "$DISCORD_CLIENT_ID"; then break; fi
            avert "Un Client ID est une suite de 17 à 20 chiffres."
        done
    fi

    if [ -n "$DISCORD_CLIENT_SECRET" ]; then
        doux "DISCORD_CLIENT_SECRET repris de l'environnement."
    else
        doux "Developer Portal → votre application → OAuth2 → Client Secret."
        while :; do
            lire_secret "Secret de l'application (Client Secret)"
            DISCORD_CLIENT_SECRET=$REPONSE
            if [ -n "$DISCORD_CLIENT_SECRET" ]; then break; fi
            avert "Le secret est obligatoire : sans lui, la connexion au dashboard échoue."
        done
    fi

    # ── Port ────────────────────────────────────────────────────
    if [ -n "$PORT" ]; then
        if ! port_valide "$PORT"; then
            erreur "PORT invalide : « $PORT »."
            exit 1
        fi
        doux "PORT repris de l'environnement : $PORT"
    elif [ "$INTERACTIF" -eq 0 ]; then
        PORT=3000
    else
        while :; do
            lire_ligne "Port du dashboard" "3000"
            PORT=$REPONSE
            if port_valide "$PORT"; then break; fi
            avert "Un port est un nombre entre 1 et 65535."
        done
    fi

    # ── Accès depuis le réseau ──────────────────────────────────
    # Le dashboard donne accès à toute la configuration du bot et aux données
    # des serveurs : il n'écoute que sur la machine hôte, et ce défaut fermé
    # n'est pas négociable. Il est en revanche proposé, expliqué, quand la
    # session est distante — sans quoi la personne se retrouve avec une adresse
    # qui ne mène nulle part depuis sa machine.
    ADRESSE_MACHINE=$(adresse_de_la_machine)
    if [ -n "$BIND_ADDRESS" ]; then
        doux "BIND_ADDRESS repris de l'environnement : $BIND_ADDRESS"
    elif [ "$EST_DISTANT" -eq 1 ] && [ "$INTERACTIF" -eq 1 ]; then
        printf '\n'
        info "Vous installez Quasar à distance, par SSH."
        info "Par défaut, le dashboard n'écoute que sur cette machine : l'adresse"
        info "http://localhost:${PORT} ouverte depuis votre ordinateur désignerait"
        info "VOTRE ordinateur, pas celui-ci, et n'afficherait rien."
        printf '\n'
        if [ -n "$ADRESSE_MACHINE" ]; then
            OPTION_OUVRIR="Ouvrir le dashboard au réseau local (http://${ADRESSE_MACHINE}:${PORT})"
        else
            OPTION_OUVRIR="Ouvrir le dashboard au réseau local"
        fi
        choisir "Comment souhaitez-vous joindre le dashboard ?" \
            "Le garder privé et passer par un tunnel SSH (recommandé)" \
            "$OPTION_OUVRIR"
        if [ "$REPONSE_CHOIX" -eq 2 ]; then
            BIND_ADDRESS="0.0.0.0"
            printf '\n'
            avert "Le dashboard sera joignable par tout votre réseau local."
            info "Il n'y a ni HTTPS ni filtrage devant : réservez cela à un réseau"
            info "de confiance, ou placez un reverse proxy devant."
        else
            BIND_ADDRESS="127.0.0.1"
        fi
    else
        BIND_ADDRESS="127.0.0.1"
    fi

    # ── Adresse de retour OAuth2 ────────────────────────────────
    if [ "$BIND_ADDRESS" = "0.0.0.0" ] && [ -n "$ADRESSE_MACHINE" ]; then
        HOTE_PUBLIC="$ADRESSE_MACHINE"
    else
        HOTE_PUBLIC="localhost"
    fi
    CALLBACK_DEFAUT="http://${HOTE_PUBLIC}:${PORT}/callback"
    if [ -n "$CALLBACK_URL" ]; then
        doux "CALLBACK_URL repris de l'environnement : $CALLBACK_URL"
    elif [ "$INTERACTIF" -eq 0 ]; then
        CALLBACK_URL="$CALLBACK_DEFAUT"
    else
        printf '\n'
        doux "Adresse de retour de la connexion Discord. Gardez la valeur proposée,"
        doux "sauf si Quasar vit derrière un nom de domaine ou un reverse proxy."
        lire_ligne "Adresse de retour OAuth2" "$CALLBACK_DEFAUT"
        CALLBACK_URL=$REPONSE
    fi

    # ── Propriétaire de l'instance ──────────────────────────────
    if [ -n "$BOT_OWNER_ID" ]; then
        doux "BOT_OWNER_ID repris de l'environnement."
    elif [ "$INTERACTIF" -eq 1 ]; then
        printf '\n'
        doux "Votre identifiant Discord ouvre les fonctions qui portent sur l'instance"
        doux "entière : statut du bot, suspension d'un serveur, compteur de serveurs."
        doux "Pour le trouver : Discord → Paramètres → Avancés → Mode développeur,"
        doux "puis clic droit sur votre profil → Copier l'identifiant."
        while :; do
            lire_ligne "Votre identifiant Discord (facultatif, Entrée pour passer)"
            BOT_OWNER_ID=$REPONSE
            if [ -z "$BOT_OWNER_ID" ] || identifiant_valide "$BOT_OWNER_ID"; then break; fi
            avert "Un identifiant Discord est une suite de 17 à 20 chiffres."
            info "Ce n'est pas le nom d'utilisateur : il faut le Mode développeur pour le copier."
        done
    fi

    # ── Secret de session ───────────────────────────────────────
    if [ -n "$JWT_SECRET" ]; then
        doux "JWT_SECRET repris de l'environnement."
    else
        if ! JWT_SECRET=$(generer_secret); then
            erreur "Impossible de fabriquer une clé aléatoire : ni openssl ni /dev/urandom."
            info "Je préfère m'arrêter plutôt que de signer vos sessions avec une valeur devinable."
            info "Fournissez-la vous-même, par exemple :"
            info "  JWT_SECRET=\$(openssl rand -hex 32) ./setup.sh"
            exit 1
        fi
    fi

    CONFIG_ECRITE=1
fi

# ── Groupe du socket Docker ─────────────────────────────────────
# Le socket Docker de l'hôte est monté dans le conteneur pour que le bouton
# « Mettre à jour » du dashboard puisse reconstruire l'image. Encore faut-il que
# le processus node ait le droit de le lire : il lui faut le GID du groupe
# propriétaire du socket, qui vaut 998, 999, 990… selon la machine, jamais la
# valeur d'exemple du Dockerfile. Sans cette détection, la mise à jour échoue en
# « permission denied » au milieu du flux, après que la personne a cliqué.
detecter_docker_gid() {
    local gid=""
    if command -v getent >/dev/null 2>&1; then
        gid=$(getent group docker 2>/dev/null | cut -d: -f3 || true)
    fi
    # getent manque sur macOS et sur bien des images minimales : /etc/group se
    # lit très bien à la main.
    if [ -z "$gid" ] && [ -r /etc/group ]; then
        gid=$(awk -F: '$1 == "docker" { print $3; exit }' /etc/group || true)
    fi
    # Dernier recours, et en réalité la source d'autorité : le socket lui-même.
    if [ -z "$gid" ] && [ -S /var/run/docker.sock ]; then
        gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || true)
    fi
    case "$gid" in
        ''|*[!0-9]*) gid="" ;;
    esac
    # GID 0 : le groupe root existe déjà dans l'image, et la personne n'a de
    # toute façon pas besoin d'un groupe pour lire un socket qu'elle possède.
    if [ "$gid" = "0" ]; then gid=""; fi
    printf '%s' "$gid"
}

if [ -n "$DOCKER_GID" ]; then
    doux "DOCKER_GID repris de l'environnement : $DOCKER_GID"
else
    DOCKER_GID=$(detecter_docker_gid)
fi

# ── Écriture du .env ────────────────────────────────────────────
# Le .env est écrit ligne à ligne à partir de .env.example, jamais par « sed » :
#   • « sed -i » sans suffixe est une syntaxe GNU, qui échoue sur macOS et BSD —
#     l'installation assistée y était donc impossible ;
#   • une valeur contenant « | » cassait le motif, et « & » y désigne la chaîne
#     trouvée : le .env se corrompait en silence, sans que rien ne le signale.
# Partir du fichier d'exemple plutôt que d'écrire un .env minimal conserve ses
# 240 lignes de commentaires, qui expliquent chaque réglage laissé de côté ici
# (modes, relais de confiance, conservation des données, supervision). Une
# variable ajoutée au fichier d'exemple suit automatiquement, sans toucher à ce
# script. Les valeurs, elles, ne passent par aucun interpréteur : printf les
# écrit telles quelles.
valeur_pilotee() { # $1 clé → écrit la valeur, ou rend 1 si la clé est étrangère
    case "$1" in
        DISCORD_TOKEN)         printf '%s' "$DISCORD_TOKEN" ;;
        DISCORD_CLIENT_ID)     printf '%s' "$DISCORD_CLIENT_ID" ;;
        DISCORD_CLIENT_SECRET) printf '%s' "$DISCORD_CLIENT_SECRET" ;;
        CALLBACK_URL)          printf '%s' "$CALLBACK_URL" ;;
        JWT_SECRET)            printf '%s' "$JWT_SECRET" ;;
        BOT_OWNER_ID)          printf '%s' "$BOT_OWNER_ID" ;;
        PORT)                  printf '%s' "$PORT" ;;
        BIND_ADDRESS)          printf '%s' "$BIND_ADDRESS" ;;
        DOCKER_GID)            printf '%s' "$DOCKER_GID" ;;
        QUASAR_MODE)           printf '%s' "$QUASAR_MODE" ;;
        *) return 1 ;;
    esac
}

# Les clés dont la valeur est vide n'ont rien à faire dans le fichier si elles
# n'y figuraient pas déjà : QUASAR_MODE et DOCKER_GID sont facultatifs.
cle_facultative() {
    case "$1" in
        QUASAR_MODE|DOCKER_GID) return 0 ;;
        *) return 1 ;;
    esac
}

cle_de_ligne() { # rend la clé d'une ligne « CLE=valeur », rien pour les autres
    local ligne=$1 cle
    case "$ligne" in
        [A-Za-z_]*=*) cle=${ligne%%=*} ;;
        *) return 0 ;;
    esac
    case "$cle" in
        *[!A-Za-z0-9_]*) return 0 ;;
    esac
    printf '%s' "$cle"
}

ecrire_env() {
    local ancien_umask temporaire ligne cle valeur vues=""
    # Le .env contient un jeton de bot et un secret de session : il ne doit pas
    # naître lisible par tout le monde, ne serait-ce qu'une fraction de seconde.
    ancien_umask=$(umask)
    umask 077
    temporaire="${RACINE}/.env.nouveau.$$"
    : > "$temporaire"

    if [ -f .env.example ]; then
        while IFS= read -r ligne || [ -n "$ligne" ]; do
            cle=$(cle_de_ligne "$ligne")
            if [ -n "$cle" ] && valeur=$(valeur_pilotee "$cle"); then
                valeur=$(printf '%s' "$valeur" | tr -d '\r\n')
                if [ -z "$valeur" ] && cle_facultative "$cle"; then
                    printf '%s\n' "$ligne" >> "$temporaire"
                else
                    printf '%s=%s\n' "$cle" "$valeur" >> "$temporaire"
                fi
                vues="${vues} ${cle}"
            else
                printf '%s\n' "$ligne" >> "$temporaire"
            fi
        done < .env.example
    else
        avert ".env.example est introuvable : j'écris un .env minimal."
        printf '# Configuration de Quasar — voir .env.example du dépôt pour le détail.\n' >> "$temporaire"
    fi

    # Les clés que le fichier d'exemple ne contient pas (DOCKER_GID en premier)
    # sont ajoutées à la fin, avec de quoi comprendre à quoi elles servent.
    local complement=""
    for cle in DISCORD_TOKEN DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET CALLBACK_URL \
               JWT_SECRET BOT_OWNER_ID PORT BIND_ADDRESS DOCKER_GID QUASAR_MODE; do
        case " $vues " in
            *" $cle "*) continue ;;
        esac
        valeur=$(valeur_pilotee "$cle")
        valeur=$(printf '%s' "$valeur" | tr -d '\r\n')
        if [ -z "$valeur" ] && cle_facultative "$cle"; then continue; fi
        complement="${complement}${cle}=${valeur}"$'\n'
    done
    if [ -n "$complement" ]; then
        {
            printf '\n'
            printf '# ═══════════════════════════════════\n'
            printf '#   Ajouté par setup.sh\n'
            printf '# ═══════════════════════════════════\n'
            printf '# DOCKER_GID : groupe propriétaire du socket Docker sur CETTE machine.\n'
            printf '# docker-compose.yml le passe à la construction de l'"'"'image pour que la\n'
            printf '# mise à jour depuis le dashboard ait le droit de parler à Docker.\n'
            printf '%s' "$complement"
        } >> "$temporaire"
    fi

    if [ -f .env ]; then
        local sauvegarde
        sauvegarde=".env.$(date +%Y%m%d%H%M%S).bak"
        mv .env "$sauvegarde"
        doux "Ancien fichier .env sauvegardé sous ${sauvegarde}"
    fi
    mv "$temporaire" .env
    chmod 600 .env 2>/dev/null || true
    umask "$ancien_umask"
}

if [ "$CONFIG_ECRITE" -eq 1 ]; then
    ecrire_env
    printf '\n'
    ok "Fichier .env créé"
    if [ -n "$DOCKER_GID" ]; then
        doux "Groupe docker détecté (GID ${DOCKER_GID}) : la mise à jour depuis le dashboard fonctionnera."
    else
        doux "Groupe docker non détecté : la valeur par défaut du Dockerfile est conservée."
    fi
fi

# ── Volume et image ─────────────────────────────────────────────
titre "🔨  Construction de l'image"

# Le volume est déclaré « external » dans docker-compose.yml : compose ne le
# crée pas lui-même, il exige qu'il existe.
if docker volume inspect quasar-data >/dev/null 2>&1; then
    ok "Volume quasar-data existant"
else
    docker volume create quasar-data >/dev/null
    ok "Volume quasar-data créé"
fi

info "Quelques minutes sur un Raspberry Pi : les modules natifs se compilent."
printf '\n'
# DOCKER_GID est exporté ici ET écrit dans le .env : compose lit les deux, mais
# seul le .env survit à cette session — c'est lui que relira la reconstruction
# lancée depuis le dashboard (api/services/updater.js), qui n'exporte rien.
if [ -n "$DOCKER_GID" ]; then
    DOCKER_GID="$DOCKER_GID" docker compose build
else
    docker compose build
fi

# ── Invitation ──────────────────────────────────────────────────
# AVANT le démarrage, et non après : les commandes slash sont déployées sur les
# serveurs présents dans le cache au moment où le bot se connecte. Un bot invité
# après coup n'a donc aucune commande tant qu'il n'a pas redémarré.
if [ -z "$DISCORD_CLIENT_ID" ] && [ -f .env ]; then
    DISCORD_CLIENT_ID=$(lire_valeur_env DISCORD_CLIENT_ID .env || true)
fi
LIEN_INVITATION=""
if [ -n "$DISCORD_CLIENT_ID" ]; then
    LIEN_INVITATION="https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=8&scope=bot+applications.commands"
    titre "🤝  Invitation du bot"
    info "Ouvrez ce lien pour ajouter le bot à votre serveur :"
    printf '\n'
    printf '   %s%s%s\n' "$C_TITRE" "$LIEN_INVITATION" "$C_FIN"
    printf '\n'
    doux "Permissions demandées : Administrateur (8), scopes bot et applications.commands."
    doux "Invitez le bot MAINTENANT : ses commandes slash sont déployées sur les"
    doux "serveurs qu'il connaît en se connectant."
    if [ "$INTERACTIF" -eq 1 ]; then
        printf '\n'
        printf '   %sAppuyez sur Entrée quand c'"'"'est fait (ou pour passer)%s ' "$C_QUESTION" "$C_FIN"
        # Cette pause est un confort, pas une question : une entrée close ici ne
        # doit pas interrompre une installation par ailleurs complète.
        # Sans nom de variable : la frappe n'a pas à être conservée.
        IFS= read -r || true
        printf '\n'
    fi
fi

# ── Démarrage ───────────────────────────────────────────────────
titre "🚀  Démarrage de Quasar"
docker compose up -d

# ── Vérification ────────────────────────────────────────────────
titre "🩺  Vérification"

etat_conteneur() {
    docker inspect --format '{{.State.Status}}' quasar 2>/dev/null || printf 'absent'
}

relayer_journaux() {
    # Depuis la v4.9.0, Quasar refuse de démarrer quand une variable vitale
    # manque ou est restée sur sa valeur d'exemple, et il dit laquelle, avec le
    # symptôme qu'elle provoque. Ce message est écrit pour être lu : il est
    # recopié tel quel plutôt que résumé en « ça n'a pas marché ».
    printf '\n'
    printf '   %s─── journaux de Quasar ───%s\n' "$C_DOUX" "$C_FIN"
    docker logs --tail 40 quasar 2>&1 | sed 's/^/   /' || true
    printf '   %s──────────────────────────%s\n' "$C_DOUX" "$C_FIN"
    printf '\n'
}

ETAT=$(etat_conteneur)
if [ "$ETAT" != "running" ]; then
    erreur "Le conteneur ne tourne pas (état : ${ETAT})."
    relayer_journaux
    info "Le message ci-dessus dit précisément ce qui manque : Quasar préfère"
    info "refuser de démarrer plutôt que tourner sans protection."
    info "Corrigez ${RACINE}/.env, puis relancez : docker compose up -d"
    exit 1
fi
ok "Conteneur démarré"

# Attente du dashboard. La borne est généreuse : sur un Raspberry Pi, le premier
# démarrage charge les commandes, ouvre la base et se connecte à Discord.
ATTENTE=${QUASAR_HEALTH_TIMEOUT:-90}
case "$ATTENTE" in
    ''|*[!0-9]*) ATTENTE=90 ;;
esac

DASHBOARD_OK=0
if command -v curl >/dev/null 2>&1; then
    ECOULE=0
    while [ "$ECOULE" -lt "$ATTENTE" ]; do
        if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
            DASHBOARD_OK=1
            break
        fi
        ETAT=$(etat_conteneur)
        if [ "$ETAT" != "running" ]; then
            erreur "Le conteneur s'est arrêté pendant le démarrage (état : ${ETAT})."
            relayer_journaux
            info "Corrigez ${RACINE}/.env, puis relancez : docker compose up -d"
            exit 1
        fi
        sleep 2
        ECOULE=$((ECOULE + 2))
    done
    if [ "$DASHBOARD_OK" -eq 1 ]; then
        ok "Le dashboard répond sur le port ${PORT}"
    else
        avert "Le dashboard n'a pas répondu en ${ATTENTE} s, mais le conteneur tourne."
        info "Suivez son démarrage : docker logs -f quasar"
    fi
else
    doux "curl est absent : je ne peux pas interroger le dashboard moi-même."
    info "Pour vérifier : docker logs -f quasar"
fi

# Bot connecté : la ligne est écrite par bot/index.js au moment où Discord
# accepte la connexion. Son absence signale un jeton refusé, cas que le contrôle
# d'avant construction rend désormais rare.
if [ "${QUASAR_MODE:-bot}" != "site" ]; then
    LIGNE_CONNEXION=$(docker logs quasar 2>&1 | grep 'Connecté en tant que' | tail -1 || true)
    if [ -n "$LIGNE_CONNEXION" ]; then
        ok "Bot ${LIGNE_CONNEXION#*Connecté en tant que }"
    elif [ "$DASHBOARD_OK" -eq 1 ]; then
        doux "Connexion à Discord pas encore confirmée dans les journaux : docker logs -f quasar"
    fi
fi

# ── Récapitulatif ───────────────────────────────────────────────
if [ -z "${ADRESSE_MACHINE:-}" ]; then ADRESSE_MACHINE=$(adresse_de_la_machine); fi
if [ "$BIND_ADDRESS" = "0.0.0.0" ] && [ -n "$ADRESSE_MACHINE" ]; then
    URL_DASHBOARD="http://${ADRESSE_MACHINE}:${PORT}"
else
    URL_DASHBOARD="http://localhost:${PORT}"
fi

printf '\n'
printf '%s   ═══════════════════════════════════%s\n' "$C_OK" "$C_FIN"
printf '%s     ✅  Quasar est en ligne%s\n' "$C_OK" "$C_FIN"
printf '%s   ═══════════════════════════════════%s\n' "$C_OK" "$C_FIN"
printf '\n'
printf '   Dashboard : %s%s%s\n' "$C_TITRE" "$URL_DASHBOARD" "$C_FIN"
printf '   Journaux  : %sdocker logs -f quasar%s\n' "$C_TITRE" "$C_FIN"
printf '   Arrêt     : %sdocker compose stop%s\n' "$C_TITRE" "$C_FIN"
printf '\n'

if [ "$BIND_ADDRESS" != "0.0.0.0" ] && [ "$EST_DISTANT" -eq 1 ]; then
    info "Le dashboard n'écoute que sur cette machine. Depuis votre ordinateur,"
    info "ouvrez un tunnel puis rendez-vous sur http://localhost:${PORT} :"
    if [ -n "$ADRESSE_MACHINE" ]; then
        printf '   %sssh -L %s:localhost:%s %s@%s%s\n' "$C_TITRE" "$PORT" "$PORT" "${USER:-utilisateur}" "$ADRESSE_MACHINE" "$C_FIN"
    else
        printf '   %sssh -L %s:localhost:%s utilisateur@ip-du-serveur%s\n' "$C_TITRE" "$PORT" "$PORT" "$C_FIN"
    fi
    printf '\n'
fi

if [ -n "${CALLBACK_URL:-}" ]; then
    info "À déclarer une fois dans le Developer Portal → OAuth2 → Redirects,"
    info "sinon la connexion au dashboard sera refusée :"
    printf '   %s%s%s\n' "$C_TITRE" "$CALLBACK_URL" "$C_FIN"
    printf '\n'
fi

if [ -n "$LIEN_INVITATION" ]; then
    info "Lien d'invitation du bot, si ce n'est pas déjà fait :"
    printf '   %s%s%s\n' "$C_TITRE" "$LIEN_INVITATION" "$C_FIN"
    printf '\n'
fi

doux "Configuration : ${RACINE}/.env — la modifier demande un redémarrage :"
doux "  docker compose up -d --force-recreate"
printf '\n'
