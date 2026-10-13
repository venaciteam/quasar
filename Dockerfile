FROM node:22-alpine

# python3 + make + g++ : build des modules natifs (better-sqlite3, @discordjs/opus, sodium-native)
# git + docker (cli + compose plugin) : self-updater
RUN apk add --no-cache python3 make g++ git docker-cli docker-cli-compose
# Musique désactivée — deps de lecture retirées pour alléger l'image.
# Réactiver en décommentant (ffmpeg + yt-dlp), et réajouter py3-pip à la ligne apk ci-dessus :
# RUN apk add --no-cache ffmpeg py3-pip && pip install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm

COPY . .

# User node (UID 1000) existe dans node:22-alpine — match le user host
# Groupe docker pour accéder au socket Docker monté.
#
# Le GID vient de docker-compose.yml, qui le lit dans .env, où setup.sh écrit
# celui de la machine. La valeur par défaut ne vaut que pour une construction
# faite à la main sans rien passer : elle sera presque toujours fausse, et le
# socket restera alors inaccessible au processus node.
ARG DOCKER_GID=972
# Trois pièges évités ici, tous fatals à la construction :
#   • un GID déjà pris dans l'image (999 = ping, 20 = dialout chez Alpine) fait
#     échouer « addgroup -g », alors que ce sont des valeurs courantes côté hôte.
#     Le groupe existant est donc réutilisé tel quel : ce qui compte est que node
#     appartienne AU GROUPE QUI POSSÈDE LE SOCKET, pas son nom ;
#   • getent n'existe pas partout : /etc/group se lit très bien avec awk ;
#   • un DOCKER_GID vide (construction à la main, .env sans la variable) ferait
#     échouer « addgroup -g "" » : aucun groupe n'est alors ajouté, et seule
#     la mise à jour depuis le dashboard s'en trouve privée.
RUN if [ -n "${DOCKER_GID}" ]; then \
        GROUPE=$(awk -F: -v g="${DOCKER_GID}" '$3 == g { print $1; exit }' /etc/group); \
        if [ -z "$GROUPE" ]; then addgroup -g "${DOCKER_GID}" -S docker; GROUPE=docker; fi; \
        addgroup node "$GROUPE"; \
    fi \
    && mkdir -p /app/data \
    && chown -R node:node /app \
    && git config --system --add safe.directory '*'
USER node

# En conteneur, l'écoute doit rester sur toutes les interfaces INTERNES au conteneur,
# sinon le port publié ne route vers rien. Ce n'est pas une exposition : ce qui décide
# de l'exposition réelle, c'est la publication du port côté hôte (BIND_ADDRESS dans
# docker-compose.yml, sur 127.0.0.1 par défaut).
ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 3000

# Le healthcheck interroge '/', qui répond 200 dans les trois QUASAR_MODE :
# page de connexion du dashboard en mode `bot`, vitrine en modes `site` et `public`.
# res.resume() + timeout explicite : sans drainer la réponse, la socket reste ouverte
# et le `node -e` traîne jusqu'au timeout Docker, ce qui bascule le conteneur en
# unhealthy alors que le service répond correctement.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "const r=require('http').get('http://127.0.0.1:'+(process.env.PORT||3000),{timeout:5000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)})"

CMD ["node", "index.js"]
