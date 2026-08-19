# Module: `modules/health`

## 1. What this module does

`modules/health` is a simple liveness probe endpoint. It checks PostgreSQL and Redis connectivity with bounded timeouts and returns an `ok`/`degraded` status. It is the only public, unauthenticated endpoint (besides `/auth/login`) for load balancers / Kubernetes probes.

**Main responsibilities:**
- `HealthController` — `GET /health` and `GET /health/debug-sentry`.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `health.module.ts` | NestJS module | `HealthModule` |
| `health.controller.ts` | Liveness endpoint | `GET /health`, `GET /health/debug-sentry` |

## 3. How it works

- `GET /health` does `SELECT 1` via Prisma and `redis.ping()` with `withTimeout(2000ms)`.
- Returns `{ status: 'ok' | 'degraded', database, redis, timestamp }`.
- `GET /health/debug-sentry` throws an intentional error for Sentry verification.

## 4. Dependencies

- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/redis` — `SHARED_REDIS`.
- `infrastructure/util` — `withTimeout`.

## 5. Environment variables

| Variable | Default | Where used | Purpose |
|----------|---------|------------|---------|
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | not env-driven? constant in file | Probe timeout. Currently hardcoded to 2000. |

## 6. Findings

### 6.1 Bugs / correctness

**B1. `HealthController` uses a hardcoded `HEALTH_CHECK_TIMEOUT_MS = 2000` constant instead of reading from env**
- Should be `configService.get('HEALTH_CHECK_TIMEOUT_MS', 2000)` for operational tuning.

**B2. `HealthController` returns HTTP 200 even when `status` is `degraded` (one of DB/Redis is down).**
- For Kubernetes liveness probes, a non-200 is needed to restart the pod. The endpoint returns 200 with `status: 'degraded'` if one dependency is down. Kubernetes might not interpret the body. Should return 503 when `status` is `degraded` (or use `@HttpCode` conditional). However, `health` endpoint should distinguish liveness (pod alive) from readiness (deps ready). `GET /health` is currently liveness + readiness combined. If Redis is down, the pod might be alive but not ready. It should return 503 for readiness and 200 for liveness, or split endpoints.

**B3. `HealthController` `debug-sentry` endpoint is unauthenticated and publicly accessible (if `AUTH_ENABLED=false`).**
- It throws an error. It is not a security risk but can be used to spam Sentry. Should be admin-only or removed from production builds.

**B4. `HealthController` `withTimeout(this.prisma.$queryRaw\`SELECT 1\`, HEALTH_CHECK_TIMEOUT_MS, 'db health')` uses `prisma.$queryRaw` with a template literal. The `withTimeout` utility likely wraps a promise with a timeout. If Prisma is not connected, `prisma.$queryRaw` may hang. The timeout handles it. Good.**

### 6.2 Performance

**P1. `GET /health` does two network round-trips (DB and Redis). With 2s timeout, it is fine for probes.**

**P2. `GET /health` is called frequently by load balancers/k8s. If a liveness probe fails, it restarts. The bounded timeout prevents hangs. Good.**

### 6.3 Architecture / anti-patterns

**A1. `HealthController` mixes liveness and readiness. Should split into `/health/live` and `/health/ready`.**

**A2. `HealthController` is in a separate module. Good. It should be lightweight. It is.**

### 6.4 TypeScript / type safety

**T1. `HealthController` return type is explicit. Good.**

### 6.5 Security / reliability

**S1. `GET /health` is likely excluded from `JwtAuthGuard` (public route). Good.**

**S2. `GET /health/debug-sentry` should be protected or disabled. It throws an error. If Sentry is enabled, it could create noise.**

## 7. New feature / improvement ideas

**F1. Split `/health` into `/health/live` (liveness, 200) and `/health/ready` (readiness, 503 on degraded)**
- Kubernetes best practice.

**F2. Make `HEALTH_CHECK_TIMEOUT_MS` env-driven**
- Operational flexibility.

**F3. Add `version`/`build` info to `/health`**
- Deployment visibility.

**F4. Remove or guard `debug-sentry` endpoint**
- Avoid Sentry spam.

**F5. Add `/health/metrics` endpoint**
- Return Prometheus metrics or basic counters.

## 8. Cross-references

- `infrastructure/prisma` — `PrismaService`.
- `infrastructure/redis` — `SHARED_REDIS`.
- `modules/health-monitor` — separate operational health (cron, dashboard).

## 9. Overall assessment

- **Health**: 7/10. Simple, bounded, does its job. But it mixes liveness/readiness and returns 200 on degraded.
- **Biggest strengths**: bounded timeouts, uses shared Redis, public endpoint for probes.
- **Biggest risks**: `degraded` returns 200, `debug-sentry` unprotected, timeout hardcoded.
- **Recommended next actions**:
  1. Split live/ready endpoints and return 503 for degraded readiness.
  2. Make timeout env-driven.
  3. Guard or remove `debug-sentry`.
