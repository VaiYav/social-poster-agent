# Runbook: Rollback Procedure

> **Scenario:** Production deploy went wrong — need to rollback to previous known-good state.

## Quick Rollback (Docker)

### 1. Stop current deployment

```bash
docker compose -f docker/docker-compose.prod.yml down
```

### 2. Rollback backend image to previous version

```bash
# List available images
docker images | grep spa-backend

# Tag the previous image as current
docker tag spa-backend:previous spa-backend:latest

# Or rebuild from a known-good git commit
git checkout <known-good-commit>
docker compose -f docker/docker-compose.prod.yml build backend
```

### 3. Rollback database (if migration was applied)

```bash
# Option A: Restore from backup (recommended)
docker compose -f docker/docker-compose.prod.yml up -d postgres
docker exec -i spa-postgres-1 pg_restore -U spa -d spa < backup.sql

# Option B: Prisma migration rollback
cd packages/backend
npx prisma migrate resolve --rolled-back <migration_name>

# Option C: Full database reset (DESTRUCTIVE — only if no data to preserve)
docker compose -f docker/docker-compose.prod.yml down -v  # removes volumes!
docker compose -f docker/docker-compose.prod.yml up -d postgres
cd packages/backend && npx prisma migrate deploy
```

### 4. Restart with previous version

```bash
docker compose -f docker/docker-compose.prod.yml up -d
```

### 5. Verify

```bash
# Health check
curl http://localhost:3100/api/v1/health

# Swagger
curl http://localhost:3100/docs

# Check logs
docker compose -f docker/docker-compose.prod.yml logs backend --tail 50
```

## Database Backup (Pre-Deploy)

> **Always take a backup before deploying a new migration.**

```bash
# Backup
docker exec spa-postgres-1 pg_dump -U spa -F c -f /tmp/backup_$(date +%Y%m%d_%H%M%S).sqlc spa
docker cp spa-postgres-1:/tmp/backup_*.sqlc ./backups/

# Restore
docker cp ./backups/backup_YYYYMMDD_HHMMSS.sqlc spa-postgres-1:/tmp/
docker exec -it spa-posters-1 pg_restore -U spa -d spa --clean /tmp/backup_YYYYMMDD_HHMMSS.sqlc
```

## Redis Rollback

Redis is ephemeral (queue state, rate limit counters, checkpoints).
If Redis is corrupted:

```bash
docker compose -f docker/docker-compose.prod.yml restart redis
# If that doesn't work, flush:
docker exec spa-redis-1 redis-cli FLUSHALL
# Queued jobs will be lost — re-enqueue via reconciliation:
curl -X POST http://localhost:3100/api/v1/health-monitor/reconcile
```

## Blue-Green Deploy (Zero-Downtime)

For production deployments without downtime:

```bash
# 1. Deploy new version on port 3200
PORT=3200 docker compose -f docker/docker-compose.prod.yml -p spa-green up -d backend

# 2. Test green deployment
curl http://localhost:3200/api/v1/health

# 3. Switch nginx upstream (edit nginx.conf or use config reload)
# 4. Stop old blue deployment
docker compose -f docker/docker-compose.prod.yml -p spa-blue down

# 5. Green becomes the new blue
```

## Rollback Decision Tree

```
Is the issue a crash/500?
├── YES → Can you reproduce locally?
│   ├── YES → Fix code, redeploy
│   └── NO → Rollback to previous image, investigate logs
└── NO (logic bug)
    ├── Data corruption? → Restore DB from backup
    ├── Bad migration? → prisma migrate resolve --rolled-back
    └── Bad config? → Fix .env, restart container
```

## Autonomy Flag Rollback (Phase 3 — gradual autonomy)

> **Scenario:** an autonomy flag was enabled, behavior is incorrect — roll it back.
> Rollback order is the **reverse** of the enable order (see `prod-rollout-checklist.md` Phase 3).

### Quick stop WITHOUT restart (flow-control Redis flags)

Services poll Redis `flow:pause_*` flags and pause without restarting the process.
This is the **first action** at any sign of trouble (spam, ban detection, looping):

```bash
# Pause EVERYTHING immediately (no restart) — recommended first step:
redis-cli -p 6381 SET flow:pause_all 1

# Or individually (generation / posting / engagement / replies):
redis-cli -p 6381 SET flow:pause_generation 1
redis-cli -p 6381 SET flow:pause_posting 1
redis-cli -p 6381 SET flow:pause_engagement 1
redis-cli -p 6381 SET flow:pause_replies 1

# Check status:
redis-cli -p 6381 MGET flow:pause_all flow:pause_generation flow:pause_posting flow:pause_engagement flow:pause_replies

# Resume (after the cause is fixed):
redis-cli -p 6381 DEL flow:pause_all flow:pause_generation flow:pause_posting flow:pause_engagement flow:pause_replies
```

> ⚠️ The recycling cron (`RECYCLING_CRON_ENABLED`) is **not** controlled by flow-control —
> only by its `.env` flag + restart. To stop recycling: disable the flag and restart.

> ⚠️ Flow-control **does not stop** already-running BullMQ jobs — they finish.
> For immediate queue stop: `redis-cli -p 6381 FLUSHALL` (loses all jobs — last resort).

### Roll back autonomy flags (with restart)

Disable one by one, in the **reverse** order of enablement. After each — restart + observe:

| Rollback order | Flag | Action | What it stops |
|---|---|---|---|
| 7 → OFF | `METRICS_SCRAPER_ENABLED=false` | Restart | Metrics collection (Threads/FB tokens) |
| 6 → OFF | `REPLIES_ENABLED=false` | Restart | Replies module physically disappears (404 routes) |
| 5 → OFF | `ENGAGEMENT_SCHEDULER_ENABLED=false` + `ENGAGEMENT_ENABLED=false` | Restart | Engagement module physically disappears (~1,300 LOC) |
| 4 → OFF | `SESSION_DEFERRED_LOGIN=false` | Restart | Posting logs in inline again (form-login) |
| 3 → OFF | `RECYCLING_CRON_ENABLED=false` | Restart | Recycling cron stops |
| 2 → OFF | `AUTONOMOUS_RUNNER_ENABLED=false` | Restart | Generation→approval→posting on cron stops |
| 1 → OFF | `AUTO_APPROVE_ENABLED=false` | Restart | Drafts require manual HITL approval again |

```bash
# Example: roll back engagement + replies (steps 5-6)
# 1. Set flow-control pause (see above)
# 2. Disable flags in .env:
sed -i.bak 's/ENGAGEMENT_ENABLED=true/ENGAGEMENT_ENABLED=false/' .env
sed -i.bak 's/ENGAGEMENT_SCHEDULER_ENABLED=true/ENGAGEMENT_SCHEDULER_ENABLED=false/' .env
sed -i.bak 's/REPLIES_ENABLED=true/REPLIES_ENABLED=false/' .env
# 3. Restart:
docker compose -f docker/docker-compose.prod.yml restart backend
# 4. Remove flow-control pause (if other flags stay ON):
redis-cli -p 6381 DEL flow:pause_engagement flow:pause_replies
# 5. Verify:
curl http://localhost:3100/api/v1/health
curl http://localhost:3100/api/v1/engagement/browsing-sessions  # should 404
```

### Roll back the `PAUSED` enum migration

Migration `20260627120000_add_paused_run_status` runs `ALTER TYPE "GenerationRunStatus" ADD VALUE 'PAUSED'`.
PostgreSQL **does not support** dropping a value from an enum — this is an **irreversible operation**.

Rollback is only possible by recreating the type:
```sql
-- DANGER: recreates the type. Only safe if no rows have status PAUSED.
-- 1. Verify there are no PAUSED runs:
SELECT COUNT(*) FROM "GenerationRun" WHERE status = 'PAUSED';
-- 2. If any exist, move them to FAILED/COMPLETED:
UPDATE "GenerationRun" SET status = 'FAILED' WHERE status = 'PAUSED';
-- 3. Recreate the type (requires EXCLUSIVE LOCK):
ALTER TYPE "GenerationRunStatus" RENAME TO "GenerationRunStatus_old";
CREATE TYPE "GenerationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
ALTER TABLE "GenerationRun" ALTER COLUMN status TYPE "GenerationRunStatus" USING status::text::"GenerationRunStatus";
DROP TYPE "GenerationRunStatus_old";
-- 4. Mark the migration as rolled back:
npx prisma migrate resolve --rolled-back 20260627120000_add_paused_run_status
```

> **Recommendation:** do not roll back this migration. The `PAUSED` enum value is harmless
> even if unused. Rolling back carries a table-lock risk.

## Post-Rollback Checklist

- [ ] Health check returns green: `curl http://localhost:3100/api/v1/health`
- [ ] Swagger accessible: `curl http://localhost:3100/docs`
- [ ] UI loads: `http://localhost:3101`
- [ ] No error spike in logs: `docker compose logs backend --tail 100 | grep ERROR`
- [ ] BullMQ queues healthy: `curl http://localhost:3100/api/v1/queue/status`
- [ ] Sessions active: `curl http://localhost:3100/api/v1/sessions`
- [ ] Notify team in Slack/channel
- [ ] Create incident report (what broke, why, how to prevent)
