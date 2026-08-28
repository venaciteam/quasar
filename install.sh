#!/bin/bash
# ═══════════════════════════════════
#   Quasar — Installation rapide
#   curl -sSL https://raw.githubusercontent.com/venaciteam/quasar/main/install.sh | bash
# ═══════════════════════════════════

set -e

REPO="https://github.com/venaciteam/quasar.git"
DIR="quasar"
LEGACY_DIR="quasar-discord"

GREEN="\033[0;32m"
RED="\033[0;31m"
CYAN="\033[0;36m"
NC="\033[0m"

echo -e "${CYAN}"
echo "  🌌  Quasar — Installation rapide"
echo "  ══════════════════════════════"
echo -e "${NC}"

# Vérifier git
if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ Git n'est pas installé.${NC}"
    echo "   sudo apt install git"
    exit 1
fi

# Vérifier Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker n'est pas installé.${NC}"
    echo "   curl -fsSL https://get.docker.com | sh"
    echo "   sudo usermod -aG docker \$USER && newgrp docker"
    exit 1
fi

# Le dépôt s'appelait quasar-discord : si une installation existante utilise encore
# ce dossier, la mettre à jour plutôt que de cloner une seconde copie à côté.
if [ ! -d "$DIR" ] && [ -d "$LEGACY_DIR" ]; then
    DIR="$LEGACY_DIR"
fi

# Cloner le repo
if [ -d "$DIR" ]; then
    echo -e "${GREEN}✅ Dossier ${DIR} existant — mise à jour...${NC}"
    cd "$DIR" && git pull
else
    echo -e "${CYAN}📦 Téléchargement d'Quasar...${NC}"
    git clone "$REPO" "$DIR"
    cd "$DIR"
fi

# Lancer le setup
chmod +x setup.sh
./setup.sh
