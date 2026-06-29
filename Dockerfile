# SPA Backend — NestJS API + BullMQ worker
# Railway builds from repo root, so this Dockerfile is at the top level.
# Multi-stage build: build TypeScript → slim production image

FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
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

RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/prisma ./packages/backend/prisma

# Copy generated Prisma client from builder to the correct pnpm store path
COPY --from=builder /app/node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client /tmp/prisma-generated
RUN CLIENT_DIR=$(find /app/node_modules/.pnpm -path '*/@prisma/client' -type d | head -1) && \
    cp -r /tmp/prisma-generated/* "$CLIENT_DIR/" && \
    rm -rf /tmp/prisma-generated

# Copy brand voice (needed by generation prompts)
COPY brand-voice.md ./

# Non-root user for security
RUN groupadd -r spa && useradd -r -g spa spa && chown -R spa:spa /app
USER spa

EXPOSE 3100

# Healthcheck — verify the API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

ENV NODE_ENV=production
ENV SPA_API_PORT=3100
ENV CAMOUFOX_HEADLESS=true

CMD ["node", "packages/backend/dist/main.js"]
