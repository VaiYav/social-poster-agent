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

## Autonomy Flag Rollback (Phase 3 — поэтапная автономия)

> **Сценарий:** включили флаг автономии, поведение некорректно — нужно откатить.
> Порядок отката **обратный** порядку включения (см. `prod-rollout-checklist.md` Фаза 3).

### Быстрый стоп БЕЗ рестарта (flow-control Redis-флаги)

Сервисы поллят Redis-флаги `flow:pause_*` и встают на паузу без перезапуска процесса.
Это **первое действие** при любых признаках проблем (спам, бан-детект, зацикливание):

```bash
# Поставить на паузу ВСЁ (немедленно, без рестарта) — рекомендуемый первый шаг:
redis-cli -p 6381 SET flow:pause_all 1

# Или по отдельности (generation / posting / engagement / replies):
redis-cli -p 6381 SET flow:pause_generation 1
redis-cli -p 6381 SET flow:pause_posting 1
redis-cli -p 6381 SET flow:pause_engagement 1
redis-cli -p 6381 SET flow:pause_replies 1

# Проверить статус:
redis-cli -p 6381 MGET flow:pause_all flow:pause_generation flow:pause_posting flow:pause_engagement flow:pause_replies

# Снять паузу (после устранения причины):
redis-cli -p 6381 DEL flow:pause_all flow:pause_generation flow:pause_posting flow:pause_engagement flow:pause_replies
```

> ⚠️ Recycling cron (`RECYCLING_CRON_ENABLED`) **не** управляется flow-control —
> только флагом в `.env` + рестартом. Для остановки recycling: выключить флаг и рестартить.

> ⚠️ Flow-control **не останавливает** уже запущенные BullMQ-джобы — они довыполнятся.
> Для немедленной остановки очередей: `redis-cli -p 6381 FLUSHALL` (потеряет все джобы — крайняя мера).

### Откат флагов автономии (с рестартом)

Выключать по одному, в **обратном** порядке от включения. После каждого — рестарт + наблюдение:

| Порядок отката | Флаг | Действие | Что останавливается |
|---|---|---|---|
| 7 → OFF | `METRICS_SCRAPER_ENABLED=false` | Рестарт | Сбор метрик (Threads/FB токены) |
| 6 → OFF | `REPLIES_ENABLED=false` | Рестарт | Модуль Replies физически исчезает (роуты 404) |
| 5 → OFF | `ENGAGEMENT_SCHEDULER_ENABLED=false` + `ENGAGEMENT_ENABLED=false` | Рестарт | Модуль Engagement физически исчезает (~1300 строк) |
| 4 → OFF | `SESSION_DEFERRED_LOGIN=false` | Рестарт | Постинг снова логинится инлайн (форма-логин) |
| 3 → OFF | `RECYCLING_CRON_ENABLED=false` | Рестарт | Ресайкл-крон останавливается |
| 2 → OFF | `AUTONOMOUS_RUNNER_ENABLED=false` | Рестарт | Генерация→аппрув→постинг по крону останавливается |
| 1 → OFF | `AUTO_APPROVE_ENABLED=false` | Рестарт | Черновики снова требуют ручного HITL-аппрува |

```bash
# Пример: откат engagement + replies (шаги 5-6)
# 1. Поставить flow-control паузу (см. выше)
# 2. Выключить флаги в .env:
sed -i.bak 's/ENGAGEMENT_ENABLED=true/ENGAGEMENT_ENABLED=false/' .env
sed -i.bak 's/ENGAGEMENT_SCHEDULER_ENABLED=true/ENGAGEMENT_SCHEDULER_ENABLED=false/' .env
sed -i.bak 's/REPLIES_ENABLED=true/REPLIES_ENABLED=false/' .env
# 3. Рестарт:
docker compose -f docker/docker-compose.prod.yml restart backend
# 4. Снять flow-control паузу (если другие флаги остаются ON):
redis-cli -p 6381 DEL flow:pause_engagement flow:pause_replies
# 5. Проверить:
curl http://localhost:3100/api/v1/health
curl http://localhost:3100/api/v1/engagement/browsing-sessions  # должно быть 404
```

### Откат миграции enum PAUSED

Миграция `20260627120000_add_paused_run_status` выполняет `ALTER TYPE "GenerationRunStatus" ADD VALUE 'PAUSED'`.
PostgreSQL **не поддерживает** удаление значения из enum — это **необратимая операция**.

Откат возможен только через пересоздание типа:
```sql
-- DANGER: пересоздаёт тип. Только если нет строк со статусом PAUSED.
-- 1. Проверить, что нет PAUSED-ранов:
SELECT COUNT(*) FROM "GenerationRun" WHERE status = 'PAUSED';
-- 2. Если есть — перевести в FAILED/COMPLETED:
UPDATE "GenerationRun" SET status = 'FAILED' WHERE status = 'PAUSED';
-- 3. Пересоздать тип (требует EXCLUSIVE LOCK):
ALTER TYPE "GenerationRunStatus" RENAME TO "GenerationRunStatus_old";
CREATE TYPE "GenerationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
ALTER TABLE "GenerationRun" ALTER COLUMN status TYPE "GenerationRunStatus" USING status::text::"GenerationRunStatus";
DROP TYPE "GenerationRunStatus_old";
-- 4. Отметить миграцию как откатанную:
npx prisma migrate resolve --rolled-back 20260627120000_add_paused_run_status
```

> **Рекомендация:** не откатывать эту миграцию. Значение `PAUSED` в enum безвредно,
> даже если не используется. Откат несёт риск блокировки таблицы.

## Post-Rollback Checklist

- [ ] Health check returns green: `curl http://localhost:3100/api/v1/health`
- [ ] Swagger accessible: `curl http://localhost:3100/docs`
- [ ] UI loads: `http://localhost:3101`
- [ ] No error spike in logs: `docker compose logs backend --tail 100 | grep ERROR`
- [ ] BullMQ queues healthy: `curl http://localhost:3100/api/v1/queue/status`
- [ ] Sessions active: `curl http://localhost:3100/api/v1/sessions`
- [ ] Notify team in Slack/channel
- [ ] Create incident report (what broke, why, how to prevent)
