# Minimal image: only what `server.js` needs at runtime (reliable on Railway vs auto-detect).
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY shared ./shared/

ENV NODE_ENV=production
CMD ["node", "server.js"]
