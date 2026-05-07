FROM node:22-alpine

# ffmpeg + python + yt-dlp + git + docker (cli + compose plugin)
RUN apk add --no-cache ffmpeg python3 py3-pip make g++ git docker-cli docker-cli-compose \
    && pip install --break-system-packages yt-dlp

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

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000), r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
