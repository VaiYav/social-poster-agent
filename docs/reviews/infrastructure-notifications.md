# Module: `infrastructure/notifications`

## 1. What this module does

`infrastructure/notifications` provides a single, best-effort alerting sink: Discord webhook notifications. It is used by the backend to surface operational problems that require human attention, without blocking the code path that triggered them.

Key responsibilities:

- Send formatted Discord embed messages to a configured webhook URL.
- Be **gracefully disabled** when `DISCORD_WEBHOOK_URL` is missing or `DISCORD_ALERTS_ENABLED=false`.
- Never throw on delivery failures; log them and continue.
- Provide three severity levels (`info`, `warning`, `critical`) with color-coded embeds.

The service is deliberately simple (one producer, one transport). It does not implement email/SMS, alert routing, rate limiting, or duplicate suppression.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `packages/backend/src/infrastructure/notifications/discord-notification.service.ts` | Discord webhook client | `DiscordNotificationService` — `sendAlert(alert)`, `critical(...)`, `warning(...)`, `info(...)`, `isEnabled()` |
| `packages/backend/src/infrastructure/notifications/notifications.module.ts` | Global NestJS module | `@Global()` module exporting `DiscordNotificationService` |
| `packages/backend/src/dry-run/test-discord.cli.ts` | CLI smoke test | Sends one alert per severity and exits |

## 3. Architecture & data flow

```mermaid
flowchart LR
    subgraph Producers
        QueueFactory[infrastructure/queue/queue.factory.ts]
        HealthMonitor[modules/health-monitor/health-monitor.service.ts]
        SessionsService[modules/sessions/sessions.service.ts]
        AutoApprove[modules/autonomy/auto-approve.service.ts]
        RepliesMonitor[modules/replies/replies-monitor.service.ts]
        WatchdogCron[modules/orchestrator/watchdog.cron.ts]
    end

    subgraph Notifications [infrastructure/notifications]
        DiscordService[discord-notification.service.ts]
        NotificationsModule[notifications.module.ts]
    end

    DiscordWebhook[(Discord Webhook)]

    Producers -->|sendAlert / critical / warning / info| DiscordService
    DiscordService -->|HTTP POST| DiscordWebhook
    NotificationsModule -->|@Global export| DiscordService

    style DiscordService fill:#bbf,stroke:#333
```

### 3.1 Lifecycle and configuration

- `NotificationsModule` is `@Global()` (`notifications.module.ts:11`), so `DiscordNotificationService` can be injected anywhere without importing the module explicitly.
- The constructor reads `DISCORD_WEBHOOK_URL` and `DISCORD_ALERTS_ENABLED` from `ConfigService` (`discord-notification.service.ts:47-54`).
- `onModuleInit` logs whether the webhook is configured and alerts are enabled (`discord-notification.service.ts:56-64`).
- `sendAlert` is a no-op if `enabled` or `webhookUrl` are missing (`discord-notification.service.ts:70`).

### 3.2 Typical call patterns

- **QueueFactory** sends `critical` when a job exhausts all retries and enters the DLQ (`queue.factory.ts:350-363`).
- **HealthMonitor** sends `warning` when stuck posts are reaped and `critical`/`warning` when health checks detect banned accounts, expired sessions, or DLQ depth (`health-monitor.service.ts:260-262`, `379-383`).
- **SessionsService** sends `warning` when a username/password form login is performed (`sessions.service.ts:222-228`) — a high-risk action.
- **AutoApprove** publishes `health_alert` SSE events for auto-approve decisions (`auto-approve.service.ts:232-237`) — these are SSE events, not direct Discord calls. The code comment claims "Discord notification is handled by DiscordNotificationService via SSE health_alert" but no listener actually forwards `health_alert` SSE events to Discord. The severity is hardcoded `warning`.
- **RepliesMonitor** sends `warning` for human-review reply items (`replies-monitor.service.ts:179-182`).
- **WatchdogCron** sends `warning` if the orchestrator heartbeat is stale (`watchdog.cron.ts:89-96`).

### 3.3 Payload format

`sendAlert` builds a single Discord embed:

```ts
{
  embeds: [{
    title: `${emoji} ${title}`,
    description: message,
    color: severityColor,
    fields: [...],
    footer: footer ? { text: footer } : undefined,
    timestamp: new Date().toISOString(),
  }]
}
```

The payload is sent via `fetch` with a 10-second `AbortController` timeout.

## 4. Dependencies

**Downstream (called by this module):**

- `fetch` (global Node.js `fetch`) — webhook POST.
- `@nestjs/config` `ConfigService` — env var reading.
- `@nestjs/common` — `Injectable`, `Logger`, `OnModuleInit`, `Module`, `Global`.

**Upstream (callers of this module):**

| Consumer | Usage | Severity |
|----------|-------|----------|
| `infrastructure/queue/queue.factory.ts` | DLQ exhausted retries | `critical` |
| `modules/health-monitor/health-monitor.service.ts` | Stuck posts reaped, health check alerts | `warning` / `critical` |
| `modules/sessions/sessions.service.ts` | Form login performed | `warning` |
| `modules/autonomy/auto-approve.service.ts` | Auto-approve reject streak (via SSE `health_alert`, not direct Discord; severity is always `warning`) | `warning` |
| `modules/replies/replies-monitor.service.ts` | Human-review reply items | `warning` |
| `modules/orchestrator/watchdog.cron.ts` | Orchestrator heartbeat stale | `warning` |

## 5. Environment variables

| Variable | Default | Purpose | Where used |
|----------|---------|---------|------------|
| `DISCORD_WEBHOOK_URL` | `undefined` | Discord webhook URL | `discord-notification.service.ts:48-50` |
| `DISCORD_ALERTS_ENABLED` | `'false'` | Whether to send alerts | `discord-notification.service.ts:51-53` |

Neither variable is declared in `packages/backend/src/infrastructure/config/env.validation.ts`.

## 6. Findings

### 6.1 Bugs / correctness

#### B1 — `DISCORD_WEBHOOK_URL` and `DISCORD_ALERTS_ENABLED` are not validated

`env.validation.ts` does not list these variables. A misspelled `DISCORD_WEBHOOK` or `DISCORD_ALERTS_ENABLE` silently disables alerts. The service handles missing values gracefully, but there is no early warning that alerting is misconfigured.

**Fix**: Add both to `env.validation.ts` with `Joi.string().allow('')` and `Joi.string().valid('true','false').default('false')`.

#### B2 — Webhook URL is not validated as a `discord.com/api/webhooks` URL

`discord-notification.service.ts:48-50` trims the URL and uses it directly. A malformed URL (e.g., missing `/api/webhooks/...`) would fail at `fetch` time, not at boot.

**Fix**: Validate the URL with a regex or `Joi.string().uri()` in `env.validation.ts` and/or `onModuleInit`.

#### B3 — `sendAlert` does not log the full payload on failure

On `!response.ok` or exception, the service logs `response.status` or the error message (`discord-notification.service.ts:98-107`), but does not include the alert title/severity or the webhook URL. This makes debugging alert failures harder.

**Fix**: Include `title` and `severity` in the warn log (but never the full webhook URL in production logs).

#### B4 — `fetch` timeout is not reset on successful response

The `AbortController` timeout is cleared with `clearTimeout(timeout)` after `await fetch` returns, but the variable is captured at the top of the function. If `fetch` rejects quickly, the timeout is still cleared? Actually, `clearTimeout` is called on line 96 after the `await` returns. If `fetch` rejects, the timeout may still fire and abort a later request? No, the controller is local per `sendAlert`. But if `fetch` rejects, the timeout may keep the `AbortSignal` alive until the function exits. Minor leak.

**Fix**: Use ` AbortSignal.timeout(10000)` (Node 18+) or move `clearTimeout` into a `finally` block.

#### B5 — No retry or circuit breaker for webhook delivery

A transient Discord outage or network blip causes the alert to be lost. The service does not retry, queue, or use a circuit breaker. This is acceptable for low-priority alerts but not for critical DLQ/health notifications.

**Fix**: Add a small retry (2-3 attempts with exponential backoff) and a per-webhook circuit breaker.

#### B6 — `critical`/`warning`/`info` helpers are `async` but callers often ignore the promise

Callers either `await` (`health-monitor.service.ts:261`) or use `.catch(() => void 0)` (`queue.factory.ts:362`). The `sendAlert` method already catches errors internally, so `await`-ing or `.catch()` is redundant. However, because `sendAlert` is `async`, `await` may still delay the caller if the webhook is slow.

**Fix**: Consider `sendAlert` returning `void` (fire-and-forget) and removing `await` from callers, or use a queued emitter so the caller is never blocked.

#### B7 — Alert `fields` values are not truncated

Discord limits embed field values to 1024 characters. The service only truncates `err.message.slice(0, 1024)` in `queue.factory.ts` but not other fields. `health-monitor.service.ts` sends full messages, which may exceed Discord limits and cause silent truncation or rejection.

**Fix**: Truncate all `value` strings to 1024 characters in `sendAlert` before sending.

### 6.2 Performance

#### P1 — `sendAlert` is awaited by some callers, blocking the event loop

`health-monitor.service.ts` `await`s `discord.critical` in a loop over alerts (`health-monitor.service.ts:370-384`). If Discord is slow, the health check cron blocks. `queue.factory.ts` uses `.catch(...)` but does not `await`, which is better.

**Fix**: Use a non-blocking emit pattern in `sendAlert` (e.g., `void this.send(...)` with internal catch) so callers can always fire-and-forget.

#### P2 — No batching or alert deduplication

A health check can produce many alerts, and each is a separate HTTP POST. If multiple workers hit DLQ at once, the webhook is spammed. There is no in-memory rate limit or aggregation.

**Fix**: Add a small in-memory buffer with a flush interval (e.g., 1-2s) to batch multiple alerts into one Discord payload, or add a per-alert-type cooldown.

### 6.3 Architecture / anti-patterns

#### A1 — Module is a one-transport adapter, not a generic notifications port

The module is named `notifications` but only supports Discord. There is no `INotificationPort` or strategy pattern. Adding email/SMS/PagerDuty would require a breaking change or a second module.

**Fix**: Rename `DiscordNotificationService` to `DiscordNotificationAdapter` and introduce a generic `INotificationPort` with `sendNotification(notification)` and severity. Other transports can implement the same port.

#### A2 — `@Global()` hides the dependency

`NotificationsModule` is global, so callers can inject `DiscordNotificationService` without importing the module. This is convenient but obscures the architecture graph.

**Fix**: Remove `@Global()` and import `NotificationsModule` in modules that use it (QueueModule, HealthMonitorModule, SessionsModule, etc.).

#### A3 — Alert payload shape is not standardized across callers

Each caller constructs its own message, fields, and footer. There is no shared `DiscordAlert` builder for common alert types (DLQ, health, session, form-login). This leads to inconsistent formatting.

**Fix**: Add helper methods like `alert.dlq(job, error)`, `alert.health(alert)`, `alert.formLogin(network)` in `DiscordNotificationService` so callers only pass IDs and short messages.

### 6.4 TypeScript / type safety

#### T1 — `DiscordAlert` interface is permissive

`fields` and `footer` are optional, but `fields` is an array of objects with no validation. A caller could pass `undefined` values or objects missing required fields.

**Fix**: Make `fields` strongly typed and use `Required` where appropriate, or validate in `sendAlert`.

#### T2 — `SEVERITY_EMOJI` uses emoji characters

The emoji strings are not escaped. This is fine for Discord, but for a generic notification port, emoji should be transport-specific.

### 6.5 Security / reliability

#### S1 — Webhook URL may be logged

`queue.factory.ts` logs `this.redisUrl` (not the webhook URL). `DiscordNotificationService` itself does not log the webhook URL. But if `fetch` throws an error, the error message may contain the URL in some Node.js versions. Use `error.message` carefully; avoid logging the full URL.

**Fix**: Mark `DISCORD_WEBHOOK_URL` as a secret in the redactor (`RedactInterceptor` or logging config) so it is never logged.

#### S2 — `DISCORD_WEBHOOK_URL` is an external dependency

If the webhook is deleted/revoked in Discord, the service fails silently. There is no health check or notification that alerting itself is broken.

**Fix**: Add a periodic "canary" alert or a health check endpoint that verifies the webhook responds with 200/204.

#### S3 — No alert encryption or signature verification

Discord webhooks accept any POST to the URL. If the webhook URL is leaked, an attacker can spam it. There is no signature verification or payload encryption. This is standard for Discord webhooks, but worth noting.

## 7. New feature / improvement ideas

1. **Add `INotificationPort` and multiple transports** — Discord, email, Slack, PagerDuty, or generic webhook.
2. **Env validation** — add `DISCORD_WEBHOOK_URL` and `DISCORD_ALERTS_ENABLED` to `env.validation.ts` and validate URL format.
3. **Retry + circuit breaker** — retry failed webhook deliveries 2-3 times with backoff; open circuit after repeated failures.
4. **Batching / throttling** — buffer alerts for 1-2s and flush as a single payload; deduplicate repeated alert types.
5. **Standardized alert templates** — `alert.dlq`, `alert.health`, `alert.formLogin`, `alert.banned` with consistent formatting.
6. **Remove `@Global()`** — import `NotificationsModule` explicitly where used.
7. **Add a secret health check** — periodically test webhook URL and warn if alerting is broken.
8. **Fire-and-forget API** — make `sendAlert` return `void` and handle errors internally, so callers never `await`.
9. **Truncate Discord fields** — enforce 1024-character field value limit and 6000-character embed limit.
10. **Configurable timeout** — `DISCORD_WEBHOOK_TIMEOUT_MS` with a default of 10s.

## 8. Cross-references

| File / module | Why it matters |
|---------------|----------------|
| `packages/backend/src/infrastructure/notifications/discord-notification.service.ts` | Core alerting service |
| `packages/backend/src/infrastructure/notifications/notifications.module.ts` | Global module wiring |
| `packages/backend/src/infrastructure/queue/queue.factory.ts:350-363` | DLQ alerts |
| `packages/backend/src/modules/health-monitor/health-monitor.service.ts:260-262, 379-383` | Health alerts and stuck-post reaping alerts |
| `packages/backend/src/modules/sessions/sessions.service.ts:222-228` | Form-login warning |
| `packages/backend/src/modules/autonomy/auto-approve.service.ts:232-237` | Auto-approve reject-streak SSE `health_alert` events (not direct Discord) |
| `packages/backend/src/modules/replies/replies-monitor.service.ts:179-182` | Human-review reply alert |
| `packages/backend/src/modules/orchestrator/watchdog.cron.ts:89-96` | Orchestrator heartbeat stale alert |
| `packages/backend/src/dry-run/test-discord.cli.ts` | CLI smoke test |
| `packages/backend/src/infrastructure/config/env.validation.ts` | Missing env validation for Discord vars |
| `packages/backend/src/infrastructure/logging/logging.module.ts` | Logging / redaction configuration |

## 9. Overall assessment

| Dimension | Health (1-5) | Notes |
|-----------|--------------|-------|
| Correctness | 4 | Simple, no-op correctly when disabled; errors are caught. Missing env validation and retry are the main issues. |
| Performance | 3 | No batching/dedup; some callers `await` and block. |
| Architecture | 2 | Single transport, no port, global module, caller-owned payload shape. |
| Type safety | 4 | Good interface, but no runtime validation. |
| Security / reliability | 3 | Webhook URL not treated as a secret; no health check for alerting itself. |

**Top 5 risks:**

1. **No env validation** — typos silently disable alerts.
2. **No retry / circuit breaker** — transient Discord failures lose critical alerts.
3. **No batching** — alert storms can trigger Discord rate limits or spam.
4. **Single transport** — no fallback to email/SMS for critical alerts.
5. **`@Global()` coupling** — makes architecture graph unclear and limits future transport strategy.

## 10. Recommended next actions (prioritized)

| Rank | Action | Effort | Module(s) |
|------|--------|--------|-----------|
| 1 | Add `DISCORD_WEBHOOK_URL` and `DISCORD_ALERTS_ENABLED` to `env.validation.ts` | XS | `infrastructure/config` |
| 2 | Make `sendAlert` non-blocking and catch errors internally | S | `infrastructure/notifications` |
| 3 | Truncate Discord embed fields to 1024 chars | XS | `infrastructure/notifications` |
| 4 | Add retry (2 attempts) and circuit breaker for webhook delivery | S | `infrastructure/notifications` |
| 5 | Introduce `INotificationPort` and move Discord behind an adapter | M | `domain/ports`, `infrastructure/notifications` |
| 6 | Remove `@Global()` and import `NotificationsModule` explicitly | M | `infrastructure/notifications`, `modules/*` |
| 7 | Add alert batching / cooldown to avoid spam | M | `infrastructure/notifications` |
| 8 | Add a webhook health check / canary alert | S | `infrastructure/notifications` |
