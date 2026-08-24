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
# Groupe docker pour accéder au socket Docker monté
# Le GID est défini via DOCKER_GID au build (défaut: 972)
ARG DOCKER_GID=972
RUN addgroup -g ${DOCKER_GID} -S docker \
    && addgroup node docker \
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
