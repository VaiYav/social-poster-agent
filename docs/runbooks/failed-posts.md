# Runbook: Failed Posts

**Scenario:** Posts are stuck in FAILED status after posting attempts.  
**Trigger:** Health monitor (F21) reports failedCount > 0.  
**Impact:** Content not posted; queue backing up.

## Symptoms

- Health monitor alert: "N posts in FAILED status — review needed"
- `GET /api/v1/posts?status=FAILED` returns posts
- SSE event: `post_status` with status=FAILED

## Steps

### 1. List failed posts

```bash
curl "http://localhost:3100/api/v1/posts?status=FAILED&limit=50"
```

### 2. Categorize failures

Check `errorMessage` for each failed post:

| Error Pattern | Cause | Action |
|--------------|-------|--------|
| "Rate limited" | Rate limit exceeded | Wait, then retry |
| "Session expired" | Login needed | See [login runbook](./login.md) |
| "warm-up" | Account in warm-up | Wait for warm-up to complete |
| "Timeout" | Browser timeout | Retry |
| "Selector not found" | UI changed | Update poster selectors |
| "CAPTCHA" | Captcha challenge | Manual login needed |
| "Account suspended" | Ban | See [banned runbook](./banned.md) |

### 3. Retry transient failures

For rate-limited, timeout, or session-expired errors:

```bash
# Reset post to APPROVED for retry
curl -X PATCH "http://localhost:3100/api/v1/posts/{postId}/status" \
  -H "Content-Type: application/json" \
  -d '{"status": "APPROVED"}'
```

Or batch retry all transient failures:

```bash
# The reconciliation cron (B3) will pick up APPROVED posts stuck >10min
curl -X POST http://localhost:3100/api/v1/health-monitor/reconcile
```

### 4. Fix UI selector issues

If error is "Selector not found":
1. Open the platform in a browser
2. Inspect the post composer UI
3. Update selectors in `packages/backend/src/modules/posting/posters/{network}.poster.ts`
4. Rebuild and restart

### 5. Discard unrecoverable posts

For posts that cannot be fixed (content issue, permanent ban):

```bash
curl -X POST "http://localhost:3100/api/v1/posts/{postId}/reject"
```

### 6. Monitor recovery

```bash
# Check health dashboard
curl http://localhost:3100/api/v1/health-monitor/dashboard
```

`failedCount` should decrease as posts are retried or rejected.

## Prevention

- Health monitor (F21) runs hourly — catches failures early
- BullMQ retries with exponential backoff (3 attempts)
- Reconciliation cron (B3) re-enqueues orphaned APPROVED posts
