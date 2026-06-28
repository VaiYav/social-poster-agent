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

## Post-Rollback Checklist

- [ ] Health check returns green: `curl http://localhost:3100/api/v1/health`
- [ ] Swagger accessible: `curl http://localhost:3100/docs`
- [ ] UI loads: `http://localhost:3101`
- [ ] No error spike in logs: `docker compose logs backend --tail 100 | grep ERROR`
- [ ] BullMQ queues healthy: `curl http://localhost:3100/api/v1/queue/status`
- [ ] Sessions active: `curl http://localhost:3100/api/v1/sessions`
- [ ] Notify team in Slack/channel
- [ ] Create incident report (what broke, why, how to prevent)
