# --- build stage: compile TypeScript ---
FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium runtime libraries + fonts. cloakbrowser ships its own stealth
# Chromium; these are the shared libs it links against, plus fonts (needed so
# canvas/emoji fingerprinting renders correctly on Linux).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxcb1 libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libglib2.0-0 libexpat1 libxshmfence1 \
      fonts-liberation fonts-noto fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Pre-create the CDN cache dir owned by `node` so the named volume mounted here
# inherits that ownership (named volumes are root-owned by default).
RUN mkdir -p /app/.cache/cdn && chown -R node:node /app

# Bake the stealth Chromium binary into the image as the `node` user so it is
# cached in /home/node/.cloakbrowser — containers never re-download ~200MB.
USER node
RUN node -e "import('cloakbrowser').then((m) => m.ensureBinary())"

# Default command = API; the worker service overrides it in docker-compose.
CMD ["node", "dist/server-main.js"]
