# SPA Backend — NestJS API + BullMQ worker
# Railway builds from repo root, so this Dockerfile is at the top level.
# Multi-stage build: build TypeScript → slim production image

FROM node:22-slim AS builder

WORKDIR /app

# Install build tools for native addons (better-sqlite3 needs node-gyp → python3 + g++)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
# Copy prisma schema before install — prisma generate runs as postinstall hook
COPY packages/backend/prisma ./packages/backend/prisma

# Install dependencies (prisma generate runs as postinstall)
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/

# Build shared package first
RUN pnpm --filter @spa/shared build

# Build backend
RUN pnpm --filter @spa/backend build

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Copy generated .prisma to a known location for the production stage
RUN PRISMA_DIR=$(find /app/node_modules/.pnpm -maxdepth 4 -name '.prisma' -type d | head -1) && \
    cp -r "$PRISMA_DIR" /tmp/.prisma

# Copy better-sqlite3 native build to a known location for the production stage
RUN SQLITE3_BUILD=$(find /app/node_modules/.pnpm -maxdepth 4 -path '*/better-sqlite3/build' -type d | head -1) && \
    cp -r "$SQLITE3_BUILD" /tmp/better-sqlite3-build

# ── Production stage ──
FROM node:22-slim AS production

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install Chromium/Firefox dependencies for Camoufox/Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libasound2 libdbus-glib-1-2 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libxss1 \
    libxtst6 libpango-1.0-0 libcairo2 libatk1.0-0 \
    libatk-bridge2.0-0 libnss3 libnspr4 \
    openssl \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/prisma ./packages/backend/prisma

# Copy generated Prisma client code from builder.
# .prisma is at node_modules/.pnpm/@prisma+client.../node_modules/.prisma/
COPY --from=builder /tmp/.prisma /tmp/.prisma
RUN CLIENT_NM_DIR=$(find /app/node_modules/.pnpm -maxdepth 4 -path '*/@prisma+client*/node_modules' -type d | head -1) && \
    cp -r /tmp/.prisma "$CLIENT_NM_DIR/" && \
    rm -rf /tmp/.prisma

# Copy better-sqlite3 native binding from builder (--ignore-scripts skips it in prod)
COPY --from=builder /tmp/better-sqlite3-build /tmp/better-sqlite3-build
RUN SQLITE3_PKG=$(find /app/node_modules/.pnpm -maxdepth 2 -name 'better-sqlite3@*' -type d | head -1) && \
    mkdir -p "$SQLITE3_PKG/node_modules/better-sqlite3/build" && \
    cp -r /tmp/better-sqlite3-build/* "$SQLITE3_PKG/node_modules/better-sqlite3/build/" && \
    rm -rf /tmp/better-sqlite3-build

# Copy brand voice (needed by generation prompts)
COPY brand-voice.md ./

# Non-root user for security
RUN groupadd -r spa && useradd -r -g spa -m -d /home/spa spa && \
    chown -R spa:spa /app && \
    mkdir -p /home/spa/.cache/camoufox && \
    chown -R spa:spa /home/spa

# Pre-download Camoufox browser during build (662MB) to avoid runtime GitHub API rate limits.
# Non-fatal: if GitHub API is rate-limited during build, app will retry at runtime.
RUN CMX=$(find /app/node_modules/.pnpm -maxdepth 3 -path '*/camoufox-js/dist/pkgman.js' | head -1) && \
    echo "Camoufox pkgman: $CMX" && \
    su spa -s /bin/sh -c "node -e 'const{CamoufoxFetcher}=require(process.env.CMX);new CamoufoxFetcher().install().then(()=>console.log(\"Camoufox pre-installed OK\")).catch(e=>{console.error(\"Camoufox pre-install failed (will retry at runtime):\",e.message)})" CMX="$CMX" || true

USER spa

EXPOSE 3100

# Healthcheck — verify the API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

ENV NODE_ENV=production
ENV SPA_API_PORT=3100
ENV CAMOUFOX_HEADLESS=true

CMD ["node", "packages/backend/dist/main.js"]
