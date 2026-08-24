# CI-002 production Redis eviction policy local evidence

Date: 2026-08-23
Source SHA: `7e2cd990519e652986f1b207715b229b638f7360` plus current dirty worktree changes
Boundary: local Compose rendering and local Redis preflight only; no production deployment or staging exact-SHA evidence.

## Local evidence

- `docker compose -f docker/docker-compose.prod.yml config --quiet` — exit 0.
- Rendered Redis command:
  `redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction`.
- Rendered backend dependency conditions require both `postgres` and `redis` to
  be `service_healthy`.
- Compose services render successfully: `backend`, `postgres`, `redis`, `ui`.
- The Compose comments retain the split guidance: use a separate
  `CHECKPOINT_REDIS_URL` if checkpoint eviction is required; BullMQ's shared
  Redis must remain `noeviction`.
- Local runtime Redis at `localhost:6381` — `redis-cli -p 6381 ping` returned
  `PONG`; read-only `CONFIG GET maxmemory-policy maxmemory` returned
  `noeviction` and `0` (unlimited local memory). This is local infrastructure
  evidence and is not treated as staging or production evidence.

## Remaining gate

- Production/staging deployment, exact-SHA evidence and live Redis configuration
  inspection remain external gates. This is `PASS_LOCAL`, not production PASS.
