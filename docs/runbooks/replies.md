# Runbook: Adaptive Replies (F4)

## What it does
The replies monitor scrapes comments on your recent posts, classifies them, and either posts an auto-reply or queues them for human review.

## Enable
Set in `.env`:
```bash
REPLIES_ENABLED=true
REPLIES_CRON_SCHEDULE=0 */4 * * *
REPLIES_MAX_PER_POST=3
REPLIES_MAX_PER_DAY=10
REPLIES_AUTO_REPLY_COMPLEXITY=medium
REPLIES_TEMPERATURE=0.6
REPLIES_MAX_CONVERSATION_DEPTH=3
```

`REPLIES_ENABLED` is the master switch. Without it, the module is not loaded and all `/replies` endpoints 404.

## UI
Open `/replies` in the dashboard to see:
- Whether the monitor is enabled.
- Counts by status (new, replied, skipped, human review, manual).
- A list of comments needing human review.
- Buttons to reply manually, dismiss, or trigger a monitoring cycle immediately.

The same pending list is also shown on `/monitor`.

## How the monitor works
1. Finds posts with `status=POSTED` and `postedAt >= now - 24h` and a `postUrl`.
2. For each post, opens the post URL in a browser and scrolls to load comments.
3. Extracts comments using network-specific selectors.
4. Saves new comments to `IncomingComment` (deduplicated by `commentId`).
5. For each new comment, runs the classifier chain:
   - safety (injection, spam, toxic)
   - question detection
   - dialogue decision (auto_reply / human_review / skip / like)
6. If `auto_reply`, reserves a daily slot in Redis and posts the reply.
7. If `human_review`, sends a Discord alert and keeps it in the UI queue.
8. After finishing, publishes a `replies_monitor` SSE event.

## Monitoring output
The service logs one summary line per cycle:
```
Replies monitoring cycle complete: <posts> posts, <comments> comments, <posted> replies posted, <scheduled> scheduled, <review> human review
```

## Common issues

### /replies endpoints return 404
Check that `REPLIES_ENABLED=true` and the app has been restarted.

### Replies are not posting
- Verify `REPLIES_ENABLED=true`.
- Check `REPLIES_MAX_PER_DAY` has not been reached. The daily count is stored in Redis with a 2-day TTL.
- Verify the account has an active session for the network.
- Check the `EngagementService` is enabled (`ENGAGEMENT_ENABLED=true`) because replies use the engagement engagers.
- Check Discord/health alerts for safety-classifier failures.

### Too many comments need review
- Lower `REPLIES_AUTO_REPLY_COMPLEXITY` to `low` so simpler comments are auto-replied.
- Review the safety classifier outputs; if genuine comments are flagged, the prompt may be too strict.

### Selectors break
When X/Threads/Facebook update their DOM, the scraper may stop finding comments. The symptom is `commentsScraped: 0` while the post clearly has comments. Update the selectors in `RepliesMonitorService.getCommentSelectors()` and `extractAuthorProfileUrl()` / `extractNativeIdAndUrl()`. Use `pnpm dry-run` to verify against a live page.

### LLM failures
If all LLM providers fail, comments stay in `NEW` status and are retried in the next cycle. Check `LlmService` provider status and health endpoint for outages.

## Pause without restart
Use `/api/v1/flow-control` or the `/flow-control` UI to pause the `replies` flow. The next cycle will be skipped and resume automatically when unpaused.

## Test
- Backend: `cd packages/backend && npx vitest run tests/integration/replies.integration.spec.ts`
- UI: `cd packages/ui && npx vitest run tests/stores/replies.spec.ts`
