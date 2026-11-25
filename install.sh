#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#   Quasar — Installation rapide
#
#     curl -sSL https://raw.githubusercontent.com/venaciteam/quasar/main/install.sh | bash
#
#   Ce script ne pose aucune question. Il contrôle les prérequis, récupère le
#   code de la dernière version publiée, puis passe la main à setup.sh — le
#   seul des deux à dialoguer.
#
#   POURQUOI CETTE SÉPARATION : le piège du tube.
#   Dans la commande ci-dessus, bash lit CE script sur son entrée standard.
#   Deux conséquences, vérifiées à la main avant d'écrire ces lignes :
#     • un « read » placé ici ne lirait pas la personne mais le texte du script,
#       ou ne lirait rien du tout puisque bash a déjà tout consommé ; sous
#       « set -e », le script sort alors en silence, sans .env ni conteneur ;
#     • rebrancher l'entrée sur le terminal en cours de route ferait perdre à
#       bash les lignes qu'il n'a pas encore lues.
#   D'où la règle : ici, jamais de « read ». Le terminal n'est rebranché qu'au
#   lancement de setup.sh, un AUTRE processus, lu depuis un fichier, dont
#   l'entrée standard ne sert donc qu'à ses questions. Le « exec » final
#   remplace ce shell : il n'a plus rien à lire ensuite, le tube peut mourir.
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

REPO_URL="https://github.com/venaciteam/quasar.git"
REPO_SLUG="venaciteam/quasar"
DOSSIER="quasar"
# Le dépôt s'est appelé quasar-discord : une installation d'alors vit encore
# dans ce dossier, il faut la mettre à jour plutôt que d'en cloner une seconde
# copie à côté (deux copies, deux conteneurs, une seule base montée).
DOSSIER_HISTORIQUE="quasar-discord"

# release = dernière version publiée (défaut) ; dev = état courant de main.
CANAL="release"

# Arguments à transmettre tels quels à setup.sh.
ARGS_SETUP=()

# ── Couleurs ────────────────────────────────────────────────────
# tput n'est volontairement pas utilisé : il manque sur les systèmes minimaux
# (busybox, images sans ncurses), et les quelques séquences employées ici sont
# comprises par tout ce qui affiche de la couleur. Trois conditions pour les
# activer, et pas une de moins : NO_COLOR non posé (https://no-color.org), la
# sortie est bien un terminal (sinon les séquences finiraient en clair dans le
# fichier de journal), et ce terminal n'est pas « dumb ».
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    C_TITRE=$'\033[1;36m'; C_OK=$'\033[0;32m'; C_ERR=$'\033[0;31m'
    C_AVERT=$'\033[1;33m'; C_DOUX=$'\033[0;90m'; C_FIN=$'\033[0m'
else
    C_TITRE=''; C_OK=''; C_ERR=''; C_AVERT=''; C_DOUX=''; C_FIN=''
fi

info()   { printf '   %s\n' "$1"; }
doux()   { printf '   %s%s%s\n' "$C_DOUX" "$1" "$C_FIN"; }
ok()     { printf '   %s✅ %s%s\n' "$C_OK" "$1" "$C_FIN"; }
avert()  { printf '   %s⚠️  %s%s\n' "$C_AVERT" "$1" "$C_FIN"; }
erreur() { printf '\n%s❌ %s%s\n' "$C_ERR" "$1" "$C_FIN" >&2; }

aide() {
    cat <<'AIDE'
  Quasar — installation rapide

  Utilisation :
    curl -sSL https://raw.githubusercontent.com/venaciteam/quasar/main/install.sh | bash
    ./install.sh [options]

  Options :
    --dev                Installer l'état courant de la branche main au lieu de
                         la dernière version publiée.
    --dir <chemin>       Dossier d'installation (défaut : quasar).
    -h, --help           Afficher cette aide.

  setup.sh prend le relais et pose les questions. La première est la plateforme
  du bot — Discord ou Fluxer : il ne demande ensuite que les identifiants de
  celle-là, jamais ceux de l'autre.

  Toute autre option est transmise à setup.sh, qui accepte notamment :
    --non-interactive    Ne rien demander : la configuration vient alors des
                         variables d'environnement (voir ./setup.sh --help).
    --reconfigure        Régénérer le fichier .env d'une installation existante.

  Avec le tube, les options se passent après « -s -- » :
    curl -sSL …/install.sh | bash -s -- --dev
AIDE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dev)  CANAL="dev" ;;
        --dir)
            if [ $# -lt 2 ]; then erreur "--dir attend un chemin."; exit 1; fi
            DOSSIER="$2"; shift ;;
        --dir=*) DOSSIER="${1#--dir=}" ;;
        -h|--help) aide; exit 0 ;;
        *) ARGS_SETUP+=("$1") ;;
    esac
    shift
done

printf '%s\n' ""
printf '%s  🌌  Quasar — Installation rapide%s\n' "$C_TITRE" "$C_FIN"
printf '%s  ═══════════════════════════════%s\n' "$C_TITRE" "$C_FIN"
printf '%s\n' ""

# ── Prérequis ───────────────────────────────────────────────────
# Contrôlés AVANT le clone : rien n'est plus décourageant que de télécharger le
# dépôt pour apprendre ensuite qu'il manque Docker. Les trois manques sont
# annoncés d'un coup, avec la commande qui les répare.
MANQUE=0

if ! command -v git >/dev/null 2>&1; then
    erreur "Git n'est pas installé."
    info "Debian, Ubuntu, Raspberry Pi OS : sudo apt install git"
    info "Fedora, CentOS               : sudo dnf install git"
    info "Arch                         : sudo pacman -S git"
    info "macOS                        : xcode-select --install"
    MANQUE=1
fi

if ! command -v docker >/dev/null 2>&1; then
    erreur "Docker n'est pas installé."
    info "Installation : curl -fsSL https://get.docker.com | sh"
    info "Puis, pour utiliser Docker sans sudo :"
    info "  sudo usermod -aG docker \$USER && newgrp docker"
    MANQUE=1
elif ! docker compose version >/dev/null 2>&1; then
    erreur "Le greffon Docker Compose v2 est absent."
    info "Quasar se lance avec « docker compose », qui ne répond pas ici."
    info "Debian, Ubuntu : sudo apt install docker-compose-plugin"
    info "Sinon, réinstallez Docker : curl -fsSL https://get.docker.com | sh"
    info "L'ancien « docker-compose » (avec un tiret) ne convient pas."
    MANQUE=1
fi

if [ "$MANQUE" -ne 0 ]; then
    printf '%s\n' ""
    info "Relancez cette commande une fois ces prérequis installés."
    exit 1
fi

ok "Git et Docker sont là"

# ── Version à installer ─────────────────────────────────────────
# Installer « main » revient à installer ce qui a été poussé cinq minutes plus
# tôt : deux personnes qui installent le même jour n'obtiennent pas le même
# code. La cible par défaut est donc la dernière version publiée. Aucune de ces
# étapes ne peut faire échouer l'installation : sans réseau vers l'API, le
# repli est le dépôt cloné, puis main.
derniere_version_publiee() {
    local url reponse
    url="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
    reponse=""
    if command -v curl >/dev/null 2>&1; then
        reponse=$(curl -fsSL -m 10 -H 'Accept: application/vnd.github+json' \
            -H 'User-Agent: quasar-install' "$url" 2>/dev/null || true)
    elif command -v wget >/dev/null 2>&1; then
        reponse=$(wget -qO- -T 10 --header='Accept: application/vnd.github+json' \
            --header='User-Agent: quasar-install' "$url" 2>/dev/null || true)
    fi
    [ -n "$reponse" ] || return 0
    # Pas de jq sur une machine neuve : le JSON est découpé sur les virgules,
    # et la valeur de tag_name est le 4e champ entre guillemets de sa ligne.
    printf '%s' "$reponse" | tr ',' '\n' | grep '"tag_name"' | head -1 | cut -d'"' -f4 || true
}

# Un nom de version sert ensuite d'argument à git : il ne doit contenir que ce
# qu'on attend d'une étiquette, jamais une option ni un chemin.
version_plausible() {
    case "$1" in
        ''|-*) return 1 ;;
        *[!A-Za-z0-9._+-]*) return 1 ;;
        *) return 0 ;;
    esac
}

VERSION=""
if [ "$CANAL" = "release" ]; then
    VERSION=$(derniere_version_publiee)
    if ! version_plausible "$VERSION"; then
        VERSION=""
    fi
fi

# ── Récupération du code ────────────────────────────────────────
if [ ! -d "$DOSSIER" ] && [ -d "$DOSSIER_HISTORIQUE" ]; then
    DOSSIER="$DOSSIER_HISTORIQUE"
    doux "Installation existante trouvée dans ${DOSSIER_HISTORIQUE}/ (ancien nom du dépôt)."
fi

if [ -d "$DOSSIER/.git" ]; then
    printf '%s\n' ""
    printf '%s  📦 Mise à jour de %s%s\n' "$C_TITRE" "$DOSSIER" "$C_FIN"
    cd "$DOSSIER" || exit 1

    git fetch --tags --prune origin || avert "Récupération impossible : le code local est conservé tel quel."

    if [ -z "$VERSION" ] && [ "$CANAL" = "release" ]; then
        VERSION=$(git describe --tags --abbrev=0 origin/main 2>/dev/null || true)
        version_plausible "$VERSION" || VERSION=""
    fi

    if [ "$CANAL" = "dev" ] || [ -z "$VERSION" ]; then
        CIBLE="origin/main"
    else
        CIBLE="refs/tags/${VERSION}"
    fi

    if ! git diff --quiet HEAD 2>/dev/null; then
        # Jamais d'écrasement silencieux : cette copie contient peut-être un
        # correctif local, et c'est le rôle de la personne d'en décider.
        avert "Des modifications locales sont présentes : le code n'est pas mis à jour."
        info "Pour les voir : git -C \"$PWD\" status"
    elif git symbolic-ref -q HEAD >/dev/null 2>&1; then
        # « --ff-only » et pas « pull » tout court : sur une copie qui a divergé,
        # un pull ordinaire fabrique un commit de fusion que personne n'a demandé.
        # Le refus est ici préférable, il est expliqué et il ne casse rien.
        if git merge --ff-only "$CIBLE" >/dev/null 2>&1; then
            ok "Code à jour"
        else
            avert "Mise à jour impossible sans fusion : le code local est conservé."
            info "Cette copie a divergé de $CIBLE. Pour vous aligner sans rien perdre :"
            info "  git -C \"$PWD\" stash && git -C \"$PWD\" merge --ff-only $CIBLE"
        fi
    else
        # HEAD détachée (installation faite par une version antérieure de ce
        # script) : elle est remise sur une branche, voir le commentaire du clone.
        git checkout -B main "$CIBLE" >/dev/null 2>&1 || avert "Impossible de repositionner la branche main."
        ok "Code à jour"
    fi
else
    printf '%s\n' ""
    if [ -n "$VERSION" ]; then
        printf '%s  📦 Téléchargement de Quasar %s%s\n' "$C_TITRE" "$VERSION" "$C_FIN"
    else
        printf '%s  📦 Téléchargement de Quasar%s\n' "$C_TITRE" "$C_FIN"
    fi
    printf '%s\n' ""

    git clone "$REPO_URL" "$DOSSIER"
    cd "$DOSSIER" || exit 1

    if [ -z "$VERSION" ] && [ "$CANAL" = "release" ]; then
        VERSION=$(git describe --tags --abbrev=0 2>/dev/null || true)
        version_plausible "$VERSION" || VERSION=""
    fi

    if [ -n "$VERSION" ] && git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null; then
        # « checkout -B main » et non « checkout <étiquette> » : une HEAD détachée
        # casserait la mise à jour depuis le dashboard, qui fait un
        # « git pull --ff-only origin main » (api/services/updater.js). La branche
        # main est donc posée SUR l'étiquette, et le suivi de origin/main rétabli.
        git checkout -B main "refs/tags/${VERSION}" >/dev/null 2>&1
        git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true
        ok "Quasar ${VERSION} téléchargé"
    else
        ok "Quasar téléchargé (branche main)"
    fi
fi

# ── Passage de relais ───────────────────────────────────────────
if [ ! -f setup.sh ]; then
    erreur "setup.sh est introuvable dans $PWD."
    info "Le téléchargement est probablement incomplet : supprimez le dossier et relancez."
    exit 1
fi
chmod +x setup.sh 2>/dev/null || true

# « exec » remplace ce shell : plus rien ne sera lu du tube après cette ligne.
# L'entrée est rebranchée sur le terminal quand il en existe un — sans quoi
# setup.sh recevrait une entrée déjà à EOF et ne pourrait poser aucune question.
# S'il n'y a aucun terminal (CI, conteneur sans TTY), setup.sh décide seul : il sait fonctionner sans, et sait l'expliquer si la configuration
# ne lui est pas fournie par l'environnement.
# ${ARGS_SETUP[@]+"${ARGS_SETUP[@]}"} : sous « set -u », bash 3.2 (celui de
# macOS) refuse "${tableau[@]}" quand le tableau est vide.
NON_INTERACTIF_DEMANDE=0
if [ "${QUASAR_NONINTERACTIVE:-0}" = "1" ]; then NON_INTERACTIF_DEMANDE=1; fi
# shellcheck disable=SC2068 # même raison qu'au bas du fichier
for _argument in ${ARGS_SETUP[@]+"${ARGS_SETUP[@]}"}; do
    case "$_argument" in
        -y|--yes|--non-interactive) NON_INTERACTIF_DEMANDE=1 ;;
    esac
done

if [ "$NON_INTERACTIF_DEMANDE" -eq 0 ] && [ ! -t 0 ] \
   && [ -e /dev/tty ] && (exec 3</dev/tty) 2>/dev/null; then
    exec bash ./setup.sh ${ARGS_SETUP[@]+"${ARGS_SETUP[@]}"} < /dev/tty
fi
exec bash ./setup.sh ${ARGS_SETUP[@]+"${ARGS_SETUP[@]}"}
