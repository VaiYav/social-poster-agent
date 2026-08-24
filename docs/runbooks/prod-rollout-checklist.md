# Prod rollout checklist: taking Social Poster Agent to production

> Purpose: move from a "green test suite" to a **genuinely verified** posting flow.
> Core principle: **green CI ≠ working posting**. The browser is mocked in tests; live selectors
> on X/Threads/FB are not covered by any test — so the first live posts are the real validation.
> Move bottom-up: single manual post → per network → gradual autonomy enablement.
>
> Document version is in sync with the branch state at the close of SE1/SEC2 (suite 1275).

---

## Phase 0 — Pre-flight (once, before the first live run)

### 0.1 Environment and dependencies
- [ ] Node ≥ 22, pnpm ≥ 10 in production.
- [ ] `pnpm install` completed cleanly.
- [ ] `pnpm build` is green (`@spa/shared` → `@spa/backend` → `@spa/ui`).
- [ ] `pnpm test` is green locally (expected 85 files / ~1275 tests; exact count from the run).
      Before running, clear rate-limit keys in Redis or false failures will occur:
      `redis-cli -p 6381 --scan --pattern 'spa:ratelimit*' | xargs -r redis-cli -p 6381 del`
- [ ] `npx oxlint` — 0 errors.

### 0.2 Infrastructure
- [ ] Postgres is up (non-standard port **5433**), Redis (**6381**) — `pnpm infra:up`.
- [ ] `pnpm prisma:generate` has been run.
- [ ] **`prisma migrate deploy`** on the production DB (NOT `migrate dev`). There are several new migrations;
      the `PAUSED` enum has a rollback constraint — keep the rollback plan at hand (`docs/runbooks/rollback.md`).
- [ ] DB backup taken before migration.

### 0.3 Critical secrets / env (production will not start or will be unsafe without them)
- [ ] **`SESSION_ENCRYPTION_KEY`** = `openssl rand -hex 32`.
      ⚠️ With `NODE_ENV=production`, missing a valid key is a **hard bootstrap fail** (by design).
- [ ] `NODE_ENV=production`.
- [ ] `SPA_DRY_RUN=false` (for live posting; for a safe dry run, `true`, see Phase 1).
- [ ] `DATABASE_URL`, `REDIS_URL` point to live instances.
- [ ] LLM keys are set (at least one provider; otherwise the chain is empty and generation fails).
- [ ] `DISCORD_WEBHOOK_*` is set — alerts (DLQ, form login, ban detection) go to the channel.
- [ ] **`CAMOUFOX_PROFILE_DIR`** (SEC2): moved from world-readable `/tmp` to a restricted/encrypted volume.
      The directory is created with `chmod 0700`, but true at-rest encryption of a live profile is
      **OS-level encrypted volume**, not code. On a single-tenant VPN machine, `/tmp` + 0700 is tolerable.

### 0.4 All autonomy flags — OFF at start
A fresh `.env` is already like this; double-check that these are NOT enabled:
- [ ] `AUTO_APPROVE_ENABLED=false`
- [ ] `AUTONOMOUS_RUNNER_ENABLED=false`
- [ ] `ENGAGEMENT_ENABLED=false`
- [ ] `ENGAGEMENT_SCHEDULER_ENABLED=false`
- [ ] `REPLIES_ENABLED=false`
- [ ] `METRICS_SCRAPER_ENABLED=false`
- [ ] `RECYCLING_CRON_ENABLED=false`
- [ ] `SESSION_DEFERRED_LOGIN=false`
- [ ] `CAPTCHA_SOLVER_ENABLED=false`, `PROXY_ROTATION_ENABLED=false`, `QUOTE_CARDS_ENABLED=false`
      (these modules are **physically absent** when OFF — 404 routes, services not resolved; enabling requires a restart).

### 0.5 Perimeter security
- [ ] API/UI is **not exposed to the public internet** (auth is absent by design — VPN-only).
- [ ] Access to `CAMOUFOX_PROFILE_DIR`, `/tmp`, container backups is restricted (SEC2).

### 0.6 Accounts and sessions
- [ ] Use a **test / low-value** account for each network (ban risk is real).
- [ ] Cookie-auth priority: set `SOCIAL_X_COOKIES` / `SOCIAL_THREADS_COOKIES` / `SOCIAL_FACEBOOK_COOKIES`
      (cookie login is more stable and **does not trigger "suspicious login"**, unlike the form).
- [ ] Login/password (`SOCIAL_*_USERNAME/PASSWORD`) only as a last resort fallback.

---

## Phase 1 — Dry-run (safe, real browser, submit is intercepted)

`pnpm dry-run` opens a real browser, really navigates and types, but **intercepts the final submit**
(screenshot + synthetic URL). LLM calls and trend scrapes are **real**.

- [ ] `CAMOUFOX_HEADLESS=false` — watch the first run with your own eyes.
- [ ] `pnpm dry-run` per network — reaches the publish screen, the form is filled, selectors are live.
- [ ] Verify permalink capture / success detection (P1/H2): in dry-run you can see how the code determines success.
- [ ] No unexpected `SelectorNotFoundError` / selector drift in logs (selector-health detector exists).

---

## Phase 2 — First LIVE post (one network at a time, supervised)

`pnpm --filter @spa/backend live` — **real posts/likes/comments**. Requires a literal
`yes` (or `--yes`/`-y`). Do not run from the repo root.

Do this in turn, **one network at a time**, single posts only:

- [x] **X** — one live post on a test account.
      Verify: post went live; DB status is `POSTED`; `postUrl` is a valid permalink (`/status/...`), not bogus.
      ✅ 2026-06-29: 3 posts POSTED (x.com/mzai_soulwise/status/2071562244878389524 etc.)
      Fix: Cmd+Enter fallback chain for headless submit (commit ad2f95b).
- [x] **Threads** — same (`/@user/post/...`).
      ✅ 2026-06-29: 3 posts POSTED. Duplicate-check H2 passed (re-post was rejected).
- [ ] **Facebook** — same. ⚠️ FB posts through separate code (persistent context); verify independently.
      ⚠️ 1 post got stuck in POSTING → marked FAILED (persistent context issue). Requires debugging.
- [x] After each: re-trigger the post (re-approve / re-enqueue) — confirm **no duplicate**
      (H2: pre-retry `verifyPosted`; idempotency by status). ✅ Verified on Threads draft 47e9d758.

> ⚠️ **Threads (multi-post)**: BUG-6 is closed (replies no longer get lost on the home-page fallback / degraded branch),
> but chains should still be checked separately and carefully — this is the most fragile path.

### What to watch in logs (Phases 1–2)
- `PostingService`: `POSTING → POSTED` without `FAILED`; `Posted to X: <url>` with a valid URL.
- No `auto-login deferred or failed (will retry)` loops (if present, session/cookie issue).
- Discord alert **`Form Login Performed`** = form login happened (ban risk) — better to avoid,
  means cookie-auth did not work.
- No spike in errors after deploy; reaper is not picking up "stuck POSTING" posts in batches.
- Rate-limit: `Rate limited: ...` — expected when `RATE_LIMIT_*` is exceeded, not a bug.

---

## Phase 3 — Gradual autonomy enablement (each layer = separate live check)

Enable **one at a time**, restart after each flag, observe for a day or two.

> **Status as of 2026-06-29:** All autonomy flags were enabled at once (not gradually).
> It was decided to lock the current state as working — the system generates, approves and posts
> autonomously. Live posts validated: X (3 POSTED), Threads (3 POSTED), Facebook (pending).
> Stuck/failed posts cleaned. Engagement/replies queues are active in Redis (BullMQ).
> `METRICS_SCRAPER_ENABLED` stays OFF — needs Threads/FB tokens (AN1).

1. [x] **Auto-approve** (`AUTO_APPROVE_ENABLED=true`, `AUTO_APPROVE_MIN_SCORE=7`) — validated
       by live X and Threads posts. Drafts auto-approve and post through BullMQ.
2. [x] **Autonomous runner** (`AUTONOMOUS_RUNNER_ENABLED=true`) — generation→approval→posting on cron.
       19 posts in the DB generated autonomously (X/Threads/Facebook).
3. [x] **Recycling cron** (`RECYCLING_CRON_ENABLED=true`) — enabled 2026-06-29.
       Recycles are rewritten by the graph (RC3), not verbatim duplicates; drafts require approval.
4. [x] **Deferred login** (`SESSION_DEFERRED_LOGIN=true`) — enabled 2026-06-29.
       `SESSION_RELOGIN_CRON=*/15 * * * *` (every 15 min), `FORM_LOGIN_COOLDOWN_MS=1800000` (30 min).
       `refreshSessionsCron` is activated by this flag — posting does not log in inline, waits for cron.
5. [x] **Engagement** (`ENGAGEMENT_ENABLED=true` + `ENGAGEMENT_SCHEDULER_ENABLED=true`) — enabled.
       Queue `spa-engagement-facebook` is active in Redis. **Highest ban risk** — watch closely.
       BUG-2/BUG-10 closed (cron re-schedules daily; bad window does not break the tick).
6. [x] **Replies** (`REPLIES_ENABLED=true` + `ENGAGEMENT_ENABLED=true`) — enabled.
       RP1: replies go through delayed BullMQ jobs (do not block cron). SEC3: comment input is sanitized.
       `IncomingComment` table is empty (0 rows) — no incoming comments yet.
7. [ ] **Metrics** (`METRICS_SCRAPER_ENABLED=true`) — OFF. After getting tokens (Threads/FB), see AN1.

---

## Known limitations at rollout time (honest)
- **The live path is not validated by tests** — posting/login/engagement are mocked. Phases 1–2 are mandatory.
- **SEC2**: true at-rest encryption of the FB profile = OS-level encrypted volume (not code). Without it, there is a risk of exfiltration if disk is accessed.
- **No auth** — VPN-only, do not expose API/UI.
- **Anti-ban is heuristic** (concurrency=1, delays, Camoufox stealth) — no guarantees; scale volume gradually.
- **AN1 (analytics)** is not closed — needs live Threads/FB tokens; X deferred (paid read since Feb 2026).

## Rollback
- [ ] Migration rollback plan — `docs/runbooks/rollback.md` (notably: enum `PAUSED`).
- [ ] Quick stop without restart: flow-control Redis flags (`flow:pause_*`) — services poll them and pause.
- [ ] Autonomy off: set flags to OFF + restart.
