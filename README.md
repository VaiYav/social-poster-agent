# Social Poster Agent (SPA)

Internal social media posting agent for My Zodiac AI. Generates LLM content
from content-agent-platform sources and posts to X.com, Threads, and Facebook
via browser automation (Camoufox — stealth Firefox fork, C++ level anti-detect).

**Principle:** cron generates → human reviews → agent posts.

## Architecture (v0.5.0)

- **API:** NestJS 11 + REST + Swagger/OpenAPI + Zod validation
- **UI:** Vue 3 + Vite SPA + Pinia + Tailwind + Vue Router + SSE real-time
- **Shared:** Zod schemas + domain types (`@spa/shared`)
- **Queue:** BullMQ + Redis (auto-retry, dead-letter, rate limiter)
- **DB:** PostgreSQL + Prisma
- **Browser:** Camoufox (Firefox fork, C++ level stealth) + camoufox-js + playwright-core
- **LLM:** OpenAI gpt-4o-mini (cloud) + Ollama gemma4 (local, for F1/F3)
- **Generation:** LangGraph.js — 7-step parallel per-network graph (§10.3)
- **Auth:** VPN-only (no auth — internal tool, not exposed publicly)
- **Real-time:** SSE (Server-Sent Events) — wired to Pinia stores
- **Monitoring:** F21 Account Health Monitor (hourly cron, ban detection)
- **Warm-up:** F20 Session Warm-up Mode (browse-only → gradual ramp)

## Project Structure

```
social-poster-agent/
├── packages/
│   ├── shared/          # @spa/shared — Zod schemas, domain types
│   ├── backend/         # @spa/backend — NestJS REST API + Prisma + BullMQ
│   └── ui/              # @spa/ui — Vue 3 + Vite SPA
├── docker/              # Production Dockerfiles + docker-compose.prod.yml
├── docs/
│   ├── adr/             # 5 ADRs (Camoufox, BullMQ, LangGraph, Ports, SSE)
│   └── runbooks/        # 4 Runbooks (login, banned, failed-posts, session-expired)
├── infra/
│   └── docker-compose.yml   # PostgreSQL :5433 + Redis :6381 (AOF)
├── CONSTITUTION.md      # Architecture decisions, domain model, roadmap
├── FEATURE_WISHLIST.md  # F1-F22 feature ideas and prioritization
├── brand-voice.md       # Tone of voice for social posts
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

# 4. Run Prisma migrations
pnpm prisma:migrate

# 5. Start dev (backend + UI)
pnpm dev:all
```

- API: http://localhost:3100/api/v1
- Swagger: http://localhost:3100/docs
- UI: http://localhost:3101

## Key Documents

- [`CONSTITUTION.md`](./CONSTITUTION.md) — Architecture, domain model, roadmap, risks
- [`FEATURE_WISHLIST.md`](./FEATURE_WISHLIST.md) — F1-F22 feature ideas
- [`brand-voice.md`](./brand-voice.md) — Tone of voice

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
