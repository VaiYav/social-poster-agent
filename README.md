# Social Poster Agent

AI-assisted multi-network social posting system. Generates content with LLMs and posts to X.com, Threads, Facebook and other platforms via browser automation.

**Principle:** cron generates → human reviews → agent posts.

## Architecture

- **API:** NestJS 11 + REST + Swagger/OpenAPI
- **UI:** Vue 3 + Vite SPA + Pinia + Tailwind + Vue Router + SSE real-time
- **Shared:** Zod schemas + domain types (`@spa/shared`)
- **Queue:** BullMQ + Redis
- **DB:** PostgreSQL + Prisma
- **Browser:** Camoufox (Firefox fork) + camoufox-js + playwright-core
- **LLM:** multi-provider fallback chain (see `.env.example`)
- **Auth:** JWT cookie (disabled by default)

## Project Structure

```
social-poster-agent/
├── packages/
│   ├── shared/          # @spa/shared — Zod schemas, domain types
│   ├── backend/         # @spa/backend — NestJS REST API + Prisma + BullMQ
│   └── ui/              # @spa/ui — Vue 3 + Vite SPA
├── docker/              # Production Dockerfiles + docker-compose.prod.yml
├── infra/
│   └── docker-compose.yml   # PostgreSQL :5433 + Redis :6381
├── brand-voice.example.md
└── pnpm-workspace.yaml
```

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Start infrastructure (PostgreSQL + Redis)
pnpm infra:up

# 3. Copy .env.example → .env, fill in social credentials + LLM keys
cp .env.example .env

# 4. Copy brand voice template
cp brand-voice.example.md brand-voice.md

# 5. Run Prisma migrations
pnpm prisma:migrate

# 6. Start dev (backend + UI)
pnpm dev:all
```

- API: http://localhost:3100/api/v1
- Swagger: http://localhost:3100/docs
- UI: http://localhost:3101

## Brand Voice

Copy `brand-voice.example.md` to `brand-voice.md` and customize it for your project. The `brand-voice.md` file is gitignored so user-specific brand voice is not committed.

## Development Commands

```bash
pnpm dev          # backend only
pnpm dev:ui       # UI only
pnpm dev:all      # both (concurrently)
pnpm build        # build all packages
pnpm test         # vitest (backend)
pnpm lint         # oxlint
pnpm format       # oxfmt
pnpm prisma:migrate   # run migrations
pnpm prisma:studio    # open Prisma Studio
pnpm infra:up     # start Docker (PostgreSQL + Redis)
pnpm infra:down   # stop Docker
```
