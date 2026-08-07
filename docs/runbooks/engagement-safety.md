# Engagement Safety Runbook

## Overview

The engagement module performs autonomous likes, comments, reposts, quotes, and follows on X, Threads, and Facebook. This runbook covers the safety guardrails that prevent brand damage and platform bans, and how to respond when they trigger.

## Safety guardrails

| Guardrail | Where it runs | What it blocks |
|-----------|--------------|----------------|
| **Admin authorization** | `EngagementController` (`@UseGuards(AdminGuard)`) | Non-admin users calling `POST /engagement/*` endpoints. Pass-through when `AUTH_ENABLED=false`. |
| **URL allow-list** | `EngagementService.performInteraction` | Any `postUrl` or profile URL whose hostname does not belong to the selected network (e.g. a Threads URL sent to the X engager, or a phishing domain). |
| **Content safety** | `EngagementService.performInteraction` + `EngagementDecisionService.validateGeneratedText` | User-supplied or LLM-generated comments/quotes that contain self-promo, troll/spam keywords, or sensitive topics. |
| **Warmup gating** | `EngagementService.performInteraction` + `EngagementGraph.check_warmup` | Interactions on accounts in `browse-only` or `light` warmup phases. |
| **Rate limits** | `RateLimitService` | Per-account, per-action daily/hourly budgets (e.g. too many likes for `acc-001` on X). |
| **Language/script match** | `EngagementDecisionService` | Generated comments/quotes in the wrong script or language for the post. |
| **Flow control** | `FlowControlService.isPaused('engagement')` | All engagement while the operator has paused the flow. |

## Common tasks

### Allow a new domain for a network

Edit `packages/backend/src/modules/engagement/engagement-safety.service.ts` and add the hostname to `ALLOWED_HOSTS` for the relevant network. Subdomains are matched automatically (e.g. `mobile.x.com` is covered by `x.com`).

```ts
ALLOWED_HOSTS: Partial<Record<SocialNetwork, string[]>> = {
  X: ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com', 'www.x.com', 'www.twitter.com'],
  // ...
};
```

Then run:

```bash
cd packages/backend && npx tsc --noEmit
pnpm --filter @spa/backend test tests/unit/engagement
```

### Understand why an action was blocked

The service logs the reason at `warn` level:

- `Blocked X engagement URL with disallowed host: <hostname>` — URL not in allow-list.
- `Engagement text flagged as low-value: <reason>` — self-promo, follow-bait, emoji-only, generic reaction, etc.
- `Engagement text flagged as troll/spam` — troll/spam keyword.
- `Engagement text flagged as sensitive: <reason>` — crisis/complaint pattern.
- `Account <id> is in warm-up browse-only phase` — warmup gating.
- `Rate limited: <reason>` — rate limit.

If you need to investigate a specific interaction, query the `Interaction` table:

```bash
psql $DATABASE_URL -c "SELECT type, status, target_url, content, error_message FROM \"Interaction\" ORDER BY created_at DESC LIMIT 20;"
```

### Pause all engagement quickly

Set the Redis flow-control flag:

```bash
redis-cli -h localhost -p 6381 SET flow:pause:engagement 1
```

Or use the UI: `Autonomous Agent > Pause Engagement`.

### Override rate limits for a specific account (emergency only)

Per-account rate limits are stored in Redis with the pattern:

```
spa:ratelimit:<network>:<accountId>:<action>:<window>:<yyyy-mm-dd>
```

Use `redis-cli` to inspect or delete a key. Be careful: this bypasses a ban-risk guardrail.

```bash
redis-cli -h localhost -p 6381 KEYS 'spa:ratelimit:X:*:like:*'
redis-cli -h localhost -p 6381 DEL 'spa:ratelimit:X:acc-001:like:daily:2026-08-07'
```

### Tune the safety filters

The content-safety filters live in `packages/backend/src/modules/replies/sensitive-filter.ts`:

- `CRISIS_PATTERNS` and `COMPLAINT_PATTERNS` in `detectSensitive`.
- `TROLL_PATTERNS` in `isLikelyTroll`.
- `GENERIC_REACTIONS` and `FOLLOW_BAIT_RE`/`FOLLOW_BAIT_CYR_RE` in `isLowValueComment`.

These filters are shared with the Replies module; changes affect both modules. Update the unit tests in `tests/unit/engagement/engagement-safety.service.spec.ts` and `tests/unit/replies/` when editing.

### Temporarily disable admin guard (local/dev only)

Set `AUTH_ENABLED=false` in `.env`. The `AdminGuard` becomes a pass-through. Never disable auth in production; instead, assign the `admin` role to the user in the `User` table.

## Incident response

### Engagement posted a comment that should have been blocked

1. Note the `interactionId` and the exact text.
2. Check the logs for `EngagementSafetyService` or `EngagementDecisionService` warnings.
3. If the text was user-supplied via the API, the `EngagementService` block should have stopped it — verify the `content` reached `checkContentSafety`.
4. If the text was LLM-generated during a browsing session, check whether `validateGeneratedText` logged `LLM generated unsafe comment`.
5. Add the phrase or pattern to the appropriate filter and add a regression test.

### Engagement liked/commented on the wrong URL

1. Confirm the `targetUrl` in the `Interaction` row.
2. If it is not an allowed hostname, verify `validateUrl` is being called. `EngagementService.performInteraction` blocks before browser context acquisition.
3. If the URL is valid but the action should not have happened, check targeting source selection in `TargetingService` and the LLM decision in `EngagementDecisionService`.

### Consecutive action failures on one account

Repeated selector errors or navigation failures are a ban-risk signal. Currently the session aborts on fatal browser errors, but does not auto-pause the account. If you see this pattern:

1. Pause the `engagement` flow control.
2. Inspect the account's `status` and `warmupPhase` in the DB.
3. Consider moving the account to `browse-only` warmup or disabling it until the selectors are fixed.

## Validation

After any change to safety logic, run:

```bash
cd packages/backend
npx tsc --noEmit
pnpm test tests/unit/engagement
```

For the full test suite before a release:

```bash
pnpm --filter @spa/backend test
```
