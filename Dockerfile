# WAPI Backend API production image
# This API is an Express/Socket.IO Node app and needs MongoDB + Redis.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Native modules such as wrtc/opusscript can need build tooling on first install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --include=optional

COPY . .
RUN mkdir -p uploads storage \
  && chown -R node:node /app

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
