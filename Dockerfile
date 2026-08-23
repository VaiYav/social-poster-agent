# SPA Backend — NestJS API + BullMQ worker
# Railway builds from repo root, so this Dockerfile is at the top level.
# Multi-stage build: build TypeScript → slim production image

FROM node:24-slim AS builder

WORKDIR /app

# REFACTOR-100: aligned with docker/Dockerfile.backend. No python3/make/g++ here:
# better-sqlite3 was removed as a dependency (it survives in the lockfile only as
# prisma's OPTIONAL peer), so nothing in the workspace needs node-gyp anymore.
# Node 24 slim no longer ships Corepack. Install the workspace-pinned pnpm
# directly so Railway builds remain reproducible.
RUN npm install --global pnpm@11.21.0

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
# Copy prisma schema before install — prisma generate runs as postinstall hook
COPY packages/backend/prisma ./packages/backend/prisma

# Install dependencies (prisma generate runs as postinstall)
RUN pnpm install --frozen-lockfile --filter @spa/backend...

# REFACTOR-100: pre-fetch the Camoufox binary in the builder (same as
# docker/Dockerfile.backend) so production never downloads 600MB+ from GitHub at
# runtime and is immune to GitHub API rate limits during deploys.
ENV CAMOUFOX_INSTALL_DIR=/app/.cache/camoufox
RUN npx camoufox-js fetch

# Copy source
COPY packages/shared/ ./packages/shared/
COPY packages/backend/ ./packages/backend/

# Patch Playwright coreBundle.js — Camoufox/Juggler uncaughtError crash (camoufox#635).
# Must run AFTER pnpm install so coreBundle.js exists. Idempotent.
RUN node packages/backend/scripts/patch-playwright.js

# Build shared package first
RUN pnpm --filter @spa/shared build

# Build backend
RUN pnpm --filter @spa/backend build

# Generate Prisma client
RUN cd packages/backend && npx prisma generate

# Copy generated .prisma to a known location for the production stage
RUN PRISMA_DIR=$(find /app/node_modules/.pnpm -maxdepth 4 -name '.prisma' -type d | head -1) && \
    cp -r "$PRISMA_DIR" /tmp/.prisma

# ── Production stage ──
FROM node:24-slim AS production

WORKDIR /app

RUN npm install --global pnpm@11.21.0

# Install Chromium/Firefox dependencies for Camoufox/Playwright
# unzip: needed to reliably extract the Camoufox binary from the 557MB zip
#   (AdmZip in camoufox-js silently fails to extract the large camoufox-bin file)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 libasound2 libdbus-glib-1-2 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libxss1 \
    libxtst6 libpango-1.0-0 libcairo2 libatk1.0-0 \
    libatk-bridge2.0-0 libnss3 libnspr4 \
    openssl unzip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @spa/backend...

# Copy the Playwright patch script (needed before patching coreBundle.js)
COPY packages/backend/scripts/patch-playwright.js ./packages/backend/scripts/patch-playwright.js

# Patch Playwright coreBundle.js — Camoufox/Juggler uncaughtError crash (camoufox#635).
RUN node packages/backend/scripts/patch-playwright.js

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

# Copy brand voice (needed by generation prompts)
COPY brand-voice.md ./

# Copy Prisma CLI from builder (prisma is a devDependency, not in --prod install)
COPY --from=builder /app/node_modules/.pnpm/prisma@*/node_modules/prisma ./node_modules/.pnpm/prisma
RUN PRISMA_BIN=$(find /app/node_modules/.pnpm -maxdepth 4 -path '*/prisma/build/index.js' | head -1) && \
    ln -sf "$PRISMA_BIN" /app/packages/backend/node_modules/.bin/prisma 2>/dev/null || \
    mkdir -p /app/packages/backend/node_modules/.bin && \
    ln -sf "$PRISMA_BIN" /app/packages/backend/node_modules/.bin/prisma

# Non-root user for security
RUN groupadd -r spa && useradd -r -g spa -m -d /home/spa spa && \
    chown -R spa:spa /app && \
    mkdir -p /home/spa/.cache/camoufox && \
    chown -R spa:spa /home/spa

# REFACTOR-100: deterministic Camoufox supply — copy the binary pre-fetched in the
# builder instead of downloading from GitHub in the prod stage (removes the
# runtime-fallback shell script, GitHub rate-limit exposure and AdmZip large-file
# failure mode entirely).
COPY --from=builder /app/.cache/camoufox /app/.cache/camoufox

USER spa

EXPOSE 3100

# Healthcheck — verify the API is responding (uses PORT env var, defaults to 3100)
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3100)+'/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

ENV NODE_ENV=production
ENV SPA_API_PORT=3100
ENV CAMOUFOX_HEADLESS=true
# MEM: constrain Node heap to leave headroom for Camoufox processes (same as
# docker/Dockerfile.backend).
ENV NODE_OPTIONS=--max-old-space-size=1536

# Run Prisma migrations before starting the app.
# First resolve any failed migrations (e.g. enum values added manually), then deploy.
CMD ["sh", "-c", "cd packages/backend && node node_modules/.bin/prisma migrate resolve --applied 20260629124137_add_admin 2>/dev/null; node node_modules/.bin/prisma migrate deploy && cd /app && node packages/backend/dist/main.js"]
