# Social Poster Agent

[![Version](https://img.shields.io/badge/version-0.5.2-blue)](#)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D26.0.0-339933?logo=node.js&logoColor=white)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11.0.0-F69220?logo=pnpm&logoColor=white)](package.json)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Vue](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js&logoColor=white)](https://vuejs.org)
[![Camoufox](https://img.shields.io/badge/browser-Camoufox-FF7139?logo=firefox&logoColor=white)](https://camoufox.com)
[![LLMs](https://img.shields.io/badge/LLM-multi--provider-412991?logo=openai&logoColor=white)](.env.example)

> **AI-assisted, multi-network social media posting for developers and creators.**
>
> Generate content with LLMs, review it as a human, and let a stealth browser agent publish it.

**Core principle:** `cron generates → human reviews → agent posts` (HITL by default).

---

## What it is

Social Poster Agent (SPA) is a domain-agnostic social media automation stack for people who care about **quality over spam**. Give it a topic or a content brief, and it generates scroll-stopping posts for X, Threads, and more. Every draft goes through an LLM-as-a-Judge quality gate, A/B hook variants, content-style rotation, and near-duplicate detection before a human reviews it. Once approved, a queue worker drives [Camoufox](https://camoufox.com) — a privacy-hardened Firefox fork — to publish the post exactly like a human would.

Everything that makes the content *yours* — brand voice, domain context, content pillars, humor mechanics, slop list, trending niches — lives in **your** markdown files and environment variables, not in the source code. The built-in fallback prompts are deliberately generic and use variables like `{brandName}`, `{brandVoice}`, and `{domain}` so the same codebase can write about developer tools, climate tech, finance, or any other topic without code changes.

> **No domain content is baked in.** The repo ships with no vertical-specific sample data or prompts. CI even scans for residual vertical keywords to make sure a project's private domain does not leak into the open-source code. Your prompts and brand data stay in your local `.env` paths and gitignored `brand-voice.md`.

### Why this exists

Most social schedulers are just queues with a text box. SPA treats posting as a pipeline:

1. **Source** — topics from a sibling content repo (`content-agent-platform`) or from an internal LLM-generated topic pool.
2. **Generate** — per-network drafts (X, Threads, and the platform roadmap below) with unique hooks, angles, and visual concepts.
3. **Judge** — an LLM scores `anti_ai_tone`, `hook_strength`, `factual_accuracy`, and `character_limit`.
4. **Refine** — below-threshold drafts are rewritten automatically.
5. **Review** — human approves, rejects, or edits in the UI.
6. **Post** — a queue worker drives Camoufox to post like a human.
7. **Engage / measure** — optional engagement and metrics modules (feature-flagged).

### Who is it for?

- **Indie creators and founders** who want a consistent social presence without sounding like a bot.
- **Agencies** managing multiple brands and networks from one dashboard.
- **Developers** who want an open, hackable automation stack with clean architecture and real browser automation.

### What you get out of the box

- A multi-provider, free-first LLM router that switches to paid providers only when free ones fail.
- Per-network post generation with platform-specific character limits and tone.
- A human review queue with approve / reject / edit before anything goes live.
- A Camoufox-based browser worker that posts through the real platform UI.
- Docker Compose local stack, JWT auth, SSE live feed, and health monitoring.

---

## Platform status

| Platform | Type | Status | Notes |
|---|---|---|---|
| **X (Twitter)** | Social short-form | ✅ Ready | Tested and used daily. Auto-login + 2FA. Residential proxy strongly recommended for production. |
| **Threads** | Social short-form | ✅ Ready | Tested and used daily. Shared Instagram session pool with X. |
| **Facebook** | Social short-form | ⚠️ Not fully tested | Code exists, but real accounts and posting flow have not been battle-tested. Disabled by default (`SOCIAL_FACEBOOK_ACTIVE=false`). |
| **Bluesky** | Social short-form | 🔄 Needs validation | Poster exists, unit tests pass, not yet run against live Bluesky accounts. |
| **Mastodon** | Social short-form | 🔄 Needs validation | Poster exists, unit tests pass, not yet run against live instances. |
| **Telegram** | Channel/Broadcast | 🔄 Needs validation | API adapter exists for channel messages; UI posting flow not validated end-to-end. |
| **LinkedIn** | Social + Articles | 🔄 Needs validation (social) / 🚧 In progress (articles) | Short-form social poster exists. Long-form article posting is under `SYNDICATION_ENABLED` and not finished. |
| **Dev.to** | Article syndication | 🚧 In progress | `SYNDICATION_ENABLED=true`. Poster exists, article flow not finished. |
| **Hashnode** | Article syndication | 🚧 In progress | `SYNDICATION_ENABLED=true`. Poster exists, article flow not finished. |

All posting is done through the **real platform UI** in a Camoufox browser, not through official APIs, to avoid rate limits and application reviews.

## Platform roadmap

The architecture already supports these 14 platforms in `SocialNetwork` or in the syndication roadmap. The current focus is on making the short-form social network path rock-solid before expanding further.

| Phase | Platforms |
|---|---|
| **🟢 Now (battle-tested)** | X, Threads |
| **🔄 Next (validate posters + selectors)** | Facebook, Bluesky, Mastodon, Telegram, LinkedIn short-form |
| **🚧 Finish article syndication** | Dev.to, Hashnode, LinkedIn long-form articles |
| **🧭 Planned** | Medium, Substack, Reddit, Quora, Pinterest |

If you want a new platform, the cleanest path is to add a `SocialNetwork` enum value, a network-specific prompt in `generation.graph.ts`, and a poster under `packages/backend/src/modules/posting/posters/`.

---

## Tech stack

- **Backend:** NestJS 11 + TypeScript, hexagonal ports/adapters, Prisma ORM
- **Frontend:** Vue 3 + Vite + Pinia + Tailwind CSS + Vue Router
- **Shared:** `@spa/shared` — Zod schemas and domain types (single source of truth)
- **Queue:** BullMQ on Redis (one queue per network, concurrency = 1)
- **Database:** PostgreSQL + Prisma
- **Browser:** Camoufox (Firefox fork) + `camoufox-js` + `playwright-core`
- **LLMs:** Multi-provider fallback chain — Groq, SambaNova, Cerebras, OpenRouter, DeepSeek, Anthropic, OpenAI, Google, NVIDIA, GitHub Models, Mistral, HuggingFace, Together, Cohere, Ollama
- **Observability:** Langfuse (prompt management + traces), Sentry, optional Discord alerts
- **Infra:** Docker Compose for PostgreSQL and Redis

---

## Feature matrix

| Feature | Status | Notes |
|---|---|---|
| **Core pipeline** |||
| Multi-provider LLM fallback | ✅ Ready | Default `gpt-5-nano` (OpenAI) + `llama-4-scout` (Groq) + `llama-4-maverick:free` (OpenRouter). 15+ providers supported. |
| Topic generation | ✅ Ready | DB-backed pool, runs on a cron. Falls back to sibling `content-agent-platform` if `CONTENT_AGENT_PLATFORM_PATH` is set. |
| Per-network post generation | Ready (X/Threads) | X and Threads are battle-tested. Facebook, Bluesky, Mastodon, Telegram, and LinkedIn have posters and prompts but need real-world validation. |
| LLM-as-a-Judge quality gate | ✅ Ready | Scores tone, hook, facts, and length. Non-blocking. |
| Auto-refine on low scores | ✅ Ready | Rewrites drafts below the judge threshold. |
| A/B hook variants | ✅ Ready | Generates multiple scroll-stopping hooks per post. |
| Visual concept generation | ✅ Ready | Describes an image concept for each post. |
| SimHash near-duplicate detection | ✅ Ready | Skips posts with Hamming distance <= 3 vs last ~200 posts / 30 days. |
| Content style rotation | ✅ Ready | Cycles through defined brand voices/styles. |
| Slop lexicon + trend guardrail | ✅ Ready | Filters AI-sounding or off-trend content. |
| Human-in-the-loop review | ✅ Ready | UI dashboard for approve / reject / edit. Default is manual. |
| Queue-based posting | ✅ Ready | BullMQ, one worker per network, concurrency = 1, human-like delays. |
| Session management + auto-login | ✅ Ready | Encrypted `storageState`, auto-login, 2FA email code reader. |
| Rate limits | ✅ Ready | Per-network daily/weekly caps + minimum interval. |
| JWT cookie auth | ✅ Ready | Off by default (`AUTH_ENABLED=false`). Admin bootstrapped from env. |
| SSE live feed | ✅ Ready | Real-time updates to the UI without polling. |
| **Content sources & distribution** |||
| `content-agent-platform` filesystem reader | ✅ Ready | Reads sibling repo `runs/brief-*`, `runs/topics-*`. |
| DB-backed topic pool | ✅ Ready | Used when `CONTENT_AGENT_PLATFORM_PATH` is empty. |
| Content recycling | ✅ Ready | Re-runs top-performing old posts. `RECYCLING_CRON_ENABLED=true`. |
| Cross-platform syndication / article posting | 🚧 In progress | `SYNDICATION_ENABLED=true`. Dev.to, Hashnode, and LinkedIn long-form posters exist, but the full article generation + posting flow is not finished. |
| Canonical URL service | 🚧 In progress | Registered only when `SYNDICATION_ENABLED=true`. Used for cross-posted articles. |
| **Automation modes** |||
| Cron-based scheduling | ✅ Ready | 11 independent cron services (generation, trending, recycling, health, etc.). |
| LangGraph orchestrator | 🧪 Experimental | `ORCHESTRATOR_ENABLED=true`. Single adaptive `OBSERVE → DECIDE → EXECUTE → EVALUATE` loop that can replace all crons. |
| Auto-approve | 🧪 Experimental | `AUTO_APPROVE_ENABLED=true`. Skips human review. Use with caution. |
| Autonomous runner | 🧪 Experimental | `AUTONOMOUS_RUNNER_ENABLED=true`. Runs full cycles without manual trigger. |
| **Engagement** |||
| Engagement browser sessions | 🧪 Experimental | `ENGAGEMENT_ENABLED=true`. Like, comment, quote, repost via human-behavior engine. |
| Replies monitoring | 🧪 Experimental | `REPLIES_ENABLED=true`. Requires `ENGAGEMENT_ENABLED=true`. |
| **Media & enhancements** |||
| Quote cards | 🧪 Experimental | `QUOTE_CARDS_ENABLED=true`. Generates styled quote images. |
| Image rendering | ✅ Ready | SVG-to-PNG via `satori` + `resvg`. Used by quote cards and visual concepts. |
| **Infrastructure / ops** |||
| Multi-instance safety | ✅ Ready | Distributed locks + per-instance heartbeats on Redis. |
| Proxy rotation | 🧪 Experimental | `PROXY_ROTATION_ENABLED=true`. Residential/mobile proxy rotation. |
| Captcha solver | 🧪 Experimental | `CAPTCHA_SOLVER_ENABLED=true`. 2Captcha integration. |
| Metrics scraping | 🧪 Experimental | `METRICS_SCRAPER_ENABLED=true`. Collects engagement numbers from platforms. |
| Discord alerts | ✅ Ready | DLQ, health, and captcha notifications. |
| Health monitoring + reconciliation | ✅ Ready | Hourly checks + stuck-post recovery. |
| Flow control (pause/resume/killswitch) | ✅ Ready | Redis-backed pause flags for generation, posting, engagement, replies. |
| IndexNow pings | ✅ Ready | Notifies search engines on new syndicated articles. |

### Legend

- **✅ Ready** — implemented, has tests, works in CI, and is either enabled by default or can be enabled with a single env var.
- **🧪 Experimental** — implemented behind a feature flag and may need real-network testing, external services, or further hardening before production use.
- **🚧 In progress** — code exists, but the end-to-end flow is not complete or not yet tested with real accounts.
- **🧭 Planned** — listed in `docs/specs` or the roadmap but not yet merged.

---

## Quick start

```bash
# 1. Install dependencies
corepack enable
pnpm install

# 2. Start PostgreSQL + Redis
cp .env.example .env
pnpm infra:up

# 3. Configure the app
cp brand-voice.example.md brand-voice.md
# edit .env with your social credentials and LLM keys

# 4. Run migrations
pnpm prisma:migrate

# 5. Start backend + UI
pnpm dev:all
```

| Endpoint | URL |
|---|---|
| REST API | http://localhost:3100/api/v1 |
| Swagger / OpenAPI | http://localhost:3100/docs |
| UI dashboard | http://localhost:3101 |

### Before you post for real

```bash
# Safe dry-run: opens a real browser, types a real post, but intercepts the final submit.
pnpm dry-run
```

The `live` command is intentionally separate and requires a confirmation prompt.

---

## Configuration

All feature flags are in `.env.example` with sensible defaults. The most important toggles:

| Variable | Default | Effect |
|---|---|---|
| `AUTH_ENABLED` | `false` | 🔐 JWT cookie auth for the UI. |
| `ORCHESTRATOR_ENABLED` | `false` | 🧪 Use the LangGraph orchestrator instead of crons. |
| `ENGAGEMENT_ENABLED` | `false` | 💬 Enable browser engagement (likes, comments, etc.). |
| `REPLIES_ENABLED` | `false` | 💬 Enable reply monitoring (requires `ENGAGEMENT_ENABLED`). |
| `QUOTE_CARDS_ENABLED` | `false` | 🧪 Enable quote-card image generation. |
| `SYNDICATION_ENABLED` | `false` | 🚧 Enable article syndication to Dev.to, Hashnode, and LinkedIn long-form articles. Not finished. |
| `AUTO_APPROVE_ENABLED` | `false` | ⚠️ Skip human review and post automatically. |
| `AUTONOMOUS_RUNNER_ENABLED` | `false` | ⚠️ Run the full pipeline on a schedule. |
| `PROXY_ROTATION_ENABLED` | `false` | 🛡️ Rotate residential/mobile proxies per network. |
| `CAPTCHA_SOLVER_ENABLED` | `false` | 🛡️ Use 2Captcha when Camoufox hits a captcha. |
| `METRICS_SCRAPER_ENABLED` | `false` | 📊 Collect engagement metrics daily. |

Brand voice, domain context, trending niches, and visual styles can be customized via `.env` paths or by editing the example markdown files.

---

## Architecture highlights

- **Hexagonal ports/adapters** — domain ports (`ILlmPort`, `IBrowserPort`, `IContentPort`, etc.) are DI tokens. Swap an adapter by changing a single module binding.
- **LangGraph generation pipeline** — one graph run per topic fans out to per-network parallel branches: `research_extract → hook_generation → angle → draft → critique → refine → visual_concept → ab_variant → human_review → save`.
- **LangGraph orchestrator** (optional) — `OBSERVE → DECIDE → EXECUTE → EVALUATE` loop with Redis checkpoints, crash-resume, and adaptive sleep.
- **Human-in-the-loop** — generation can `interrupt()` for review and resume with `Command({ resume: ... })`.
- **Free-first LLM routing** — tries free providers first, falls back to paid only on failure.
- **Reasoning-model aware** — `gpt-5-*`, `o1`, `o3`, and `o4-mini` skip `temperature` automatically.
- **Browser hardening** — Camoufox + memory-optimized `firefox_user_prefs`, resource blocking in read-only contexts, and persistent Facebook profiles.

For the full operational guide, see `CLAUDE.md`. For contribution guidelines, see `CONTRIBUTING.md`.

---

## Development commands

```bash
pnpm dev               # backend only
pnpm dev:ui            # UI only
pnpm dev:all           # both
pnpm build             # build all packages
pnpm lint              # oxlint
pnpm format            # oxfmt
pnpm test              # backend vitest
pnpm test:unit         # backend unit + UI tests
pnpm test:integration  # integration tests
pnpm test:system       # system tests
pnpm test:acceptance   # acceptance tests
pnpm test:e2e          # backend e2e
pnpm test:ui-e2e       # UI e2e
pnpm prisma:migrate    # run Prisma migrations
pnpm prisma:studio     # open Prisma Studio
pnpm infra:up          # start PostgreSQL + Redis
pnpm infra:down        # stop PostgreSQL + Redis
```

### Verification before a PR

```bash
cd packages/backend
npx tsc --noEmit
pnpm lint
pnpm test:unit
```

---

## Testing

The test suite is layered:

- **Unit** — isolated services and utilities.
- **Integration** — top-down, bottom-up, sandwich, big-bang module wiring.
- **System** — full graph and posting slices.
- **Acceptance** — BDD scenarios and ATP test cases.
- **E2E** — full flows with mocked browser where possible.

> **Note:** Browser automation is mocked in automated tests. Green CI does not guarantee working posting. Always validate with `pnpm dry-run` before enabling live posting.

---

## What works today vs. what still needs work

### ✅ Ready for daily use

- 🐦 Multi-network content generation for **X** and **Threads**.
- 👤 Human-in-the-loop review and queue-based posting.
- 🧠 Multi-provider free-first LLM fallback.
- 🔄 Topic pool management and content recycling.
- 🔐 Session encryption, auto-login, and 2FA via email.
- ❤️ Health monitoring, rate limiting, and flow control.

### 🔄 Needs real-world validation

These features are implemented and pass tests, but have not been fully exercised with real accounts:

- 🦋 **Bluesky, Mastodon, Telegram, and LinkedIn short-form** — posters and prompts exist, live selectors need validation.
- ⚠️ **Facebook** — code exists but has not been battle-tested; session churn is the main open question.
- 🧪 **Orchestrator** — the adaptive LangGraph loop is implemented but should be monitored for 24-48 hours before replacing crons.
- 💬 **Engagement / replies** — ~1300 lines of code, frozen behind `ENGAGEMENT_ENABLED`. Needs real-network soak testing.
- 🤖 **Auto-approve / autonomous runner** — functional, but by design these bypass human review and can post accidentally.
- 📊 **Metrics scraper** — depends on platform HTML selectors that change frequently.
- 🛡️ **Captcha solver / proxy rotation** — require third-party accounts and careful production tuning.

### 🚧 In progress / not finished

- 📝 **Article generation and syndication** — Dev.to, Hashnode, and LinkedIn long-form posters exist, but the full flow from article outline → draft → published post is not complete.

### 🧭 Planned

- ⏰ Remove remaining `@Cron` decorators once the orchestrator is stable.
- 🌐 More networks: LinkedIn, Bluesky, Mastodon, Telegram, Medium, Substack, Reddit, Quora, Pinterest.
- 📘 Better Facebook session recovery.
- ⚖️ LLM judge calibration UI and feedback loop.

See `.forge/orchestrator/MASTER-PLAN.md` and `.forge/orchestrator/TASKS.md` for the detailed orchestrator roadmap.

---

## Project structure

```
social-poster-agent/
├── packages/
│   ├── shared/          # @spa/shared — Zod schemas, domain types
│   ├── backend/         # @spa/backend — NestJS REST API + Prisma + BullMQ
│   └── ui/              # @spa/ui — Vue 3 + Vite + Pinia
├── docker/              # Production Dockerfiles + docker-compose.prod.yml
├── infra/               # Local PostgreSQL :5433 + Redis :6381
├── brand-voice.example.md
├── .env.example
├── CONTRIBUTING.md
├── CLAUDE.md
└── pnpm-workspace.yaml
```

---

## License & contributing

Social Poster Agent is released under the [MIT License](LICENSE).

Contributions, bug reports, and ideas are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the PR process, coding conventions, and verification steps. If you are hacking on something experimental, check `CLAUDE.md` first — it documents the non-obvious traps and architectural decisions.
