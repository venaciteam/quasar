#!/bin/bash
# ═══════════════════════════════════
#   Quasar — Script d'installation
# ═══════════════════════════════════

set -e

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
NC="\033[0m"

echo -e "${CYAN}"
echo "  🌌  Quasar — Installation"
echo "  ═══════════════════════"
echo -e "${NC}"

# Vérifier Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker n'est pas installé.${NC}"
    echo "   Installe Docker : https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose n'est pas disponible.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker détecté${NC}"

# Créer le fichier .env si absent
if [ ! -f .env ]; then
    if [ ! -f .env.example ]; then
        echo -e "${RED}❌ .env.example introuvable.${NC}"
        exit 1
    fi

    echo ""
    echo -e "${YELLOW}📝 Configuration du bot${NC}"
    echo ""

    read -sp "   Token du bot Discord : " DISCORD_TOKEN
    echo ""
    read -p "   Client ID (OAuth2) : " DISCORD_CLIENT_ID
    read -sp "   Client Secret (OAuth2) : " DISCORD_CLIENT_SECRET
    echo ""
    read -p "   Port du dashboard [3000] : " PORT
    PORT=${PORT:-3000}
    read -p "   Callback URL [http://localhost:${PORT}/callback] : " CALLBACK_URL
    CALLBACK_URL=${CALLBACK_URL:-http://localhost:${PORT}/callback}

    echo ""
    echo -e "   ${YELLOW}💡 Ton ID Discord permet d'accéder aux fonctions admin du dashboard"
    echo -e "   (gestion du statut du bot, etc.). Pour le trouver :"
    echo -e "   Discord → Paramètres → Avancés → Mode développeur → clic droit sur ton profil → Copier l'identifiant${NC}"
    echo ""
    read -p "   Ton ID Discord (optionnel, Entrée pour passer) : " BOT_OWNER_ID

    JWT_SECRET=$(openssl rand -hex 32)

    cp .env.example .env
    sed -i "s|DISCORD_TOKEN=.*|DISCORD_TOKEN=${DISCORD_TOKEN}|" .env
    sed -i "s|DISCORD_CLIENT_ID=.*|DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}|" .env
    sed -i "s|DISCORD_CLIENT_SECRET=.*|DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET}|" .env
    sed -i "s|CALLBACK_URL=.*|CALLBACK_URL=${CALLBACK_URL}|" .env
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" .env
    sed -i "s|PORT=.*|PORT=${PORT}|" .env
    if [ -n "$BOT_OWNER_ID" ]; then
        sed -i "s|BOT_OWNER_ID=.*|BOT_OWNER_ID=${BOT_OWNER_ID}|" .env
    fi

    echo ""
    echo -e "${GREEN}✅ Fichier .env créé${NC}"
else
    echo -e "${GREEN}✅ Fichier .env existant conservé${NC}"
fi

# Créer le volume Docker
if ! docker volume inspect quasar-data &> /dev/null 2>&1; then
    docker volume create quasar-data
    echo -e "${GREEN}✅ Volume quasar-data créé${NC}"
else
    echo -e "${GREEN}✅ Volume quasar-data existant${NC}"
fi

# Build et lancement
echo ""
echo -e "${CYAN}🔨 Build de l'image Docker...${NC}"
docker compose build

echo ""
echo -e "${CYAN}🚀 Lancement d'Quasar...${NC}"
docker compose up -d

echo ""
echo -e "${GREEN}═══════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Quasar est en ligne !${NC}"
echo -e "${GREEN}═══════════════════════════════════${NC}"
echo ""
echo -e "  Dashboard : ${CYAN}http://localhost:${PORT:-3000}${NC}"
echo -e "  Logs      : ${CYAN}docker logs quasar${NC}"
echo ""
echo -e "${YELLOW}  N'oublie pas d'inviter le bot sur ton serveur Discord !${NC}"
echo -e "  → Developer Portal → OAuth2 → URL Generator"
echo -e "  → Scopes: bot + applications.commands"
echo -e "  → Permissions: Administrator"
echo ""
