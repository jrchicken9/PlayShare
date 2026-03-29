# Pack stage: build store-ready extension zip for homepage download (GET /install/playshare-extension.zip).
FROM node:20-alpine AS pack
WORKDIR /app
RUN apk add --no-cache bash zip
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run package:extension
# `prepackage:extension` runs `build:web`; image must ship `public/app/*` for GET /app

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY platform/server ./platform/server/
COPY shared ./shared/
COPY public ./public/
COPY --from=pack /app/public/install/playshare-extension.zip ./public/install/playshare-extension.zip
COPY --from=pack /app/public/install/playshare-extension.version ./public/install/playshare-extension.version
COPY --from=pack /app/public/app ./public/app
ENV NODE_ENV=production
CMD ["node", "server.js"]
