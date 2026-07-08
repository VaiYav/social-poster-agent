# Module: `modules/flow-control`

## 1. What this module does

`modules/flow-control` is a small but critical safety module: Redis-backed pause/resume flags for all agent flows. It allows an operator to stop new work globally (`pause_all`) or per-flow (`generation`, `posting`, `engagement`, `replies`) without restarting the backend. In-flight jobs are not killed; only new work is blocked. It is the operational kill-switch for crisis mode.

**Main responsibilities:**
- `FlowControlService` — read, set, and clear pause flags in Redis; emit SSE events.
- `FlowControlController` — REST endpoints for status, pause, resume, pause-all, resume-all.

## 2. Key files & public API

| File | Role | Public API |
|------|------|------------|
| `flow-control.module.ts` | NestJS module | `FlowControlModule` — imports `RedisModule`, `SseModule` |
| `flow-control.service.ts` | Core service | `isPaused(flow)`, `assertNotPaused(flow)`, `pause(flow, reason?)`, `resume(flow)`, `pauseAll(reason?)`, `resumeAll()`, `getStatus()` |
| `flow-control.controller.ts` | REST API | `GET /flow-control/status`, `POST /flow-control/pause/:flow`, `POST /flow-control/resume/:flow`, `POST /flow-control/pause-all`, `POST /flow-control/resume-all` |

## 3. How it works

### 3.1 Redis keys

- `flow:pause_all` — global emergency stop.
- `flow:pause_generation`, `flow:pause_posting`, `flow:pause_engagement`, `flow:pause_replies` — per-flow flags.

### 3.2 `isPaused(flow)`

- `Promise.all` fetches `pause_all` and the specific flow key.
- Returns `true` if either is `'1'`.

### 3.3 `pause` / `resume` / `pauseAll` / `resumeAll`

- `pause` sets a flow key to `'1'` and emits SSE `flow_control` `paused`.
- `resume` deletes the flow key and emits SSE `flow_control` `resumed`.
- `pauseAll` sets `flow:pause_all` and emits `flow_control` `pause_all`.
- `resumeAll` deletes `flow:pause_all` and all individual flow keys, then emits `flow_control` `resume_all`.

### 3.4 `getStatus()`

- Returns `{ pauseAll: boolean, flows: { generation, posting, engagement, replies } }`.
- Each flow is `true` if `pause_all` is set OR the individual flag is set.

### 3.5 `FlowControlController`

- `GET /flow-control/status` — returns status.
- `POST /flow-control/pause/:flow` — accepts optional `{ reason: string }` body, validates `flow` against `VALID_FLOWS`.
- `POST /flow-control/resume/:flow` — validates flow.
- `POST /flow-control/pause-all` — accepts optional `reason`.
- `POST /flow-control/resume-all` — no body.

## 4. Dependencies

**Downstream:**
- `infrastructure/redis` — `SHARED_REDIS` IORedis.
- `infrastructure/sse` — `SseService`.

**Upstream callers:**
- `modules/generation` `GenerationService` (checks before generation).
- `modules/posting` `PostingService` (checks before posting).
- `modules/autonomy` `AutonomousRunnerService` (checks before generation and per-post).
- `modules/engagement` `BrowsingSessionService` (checks before sessions).
- `modules/replies` `RepliesMonitorService` (checks before reply actions).
- `modules/health-monitor` may use it.
- UI via `FlowControlController`.

## 5. Environment variables

None directly. Uses Redis from `REDIS_URL` (`infrastructure/redis`).

## 6. Findings

### 6.1 Bugs / correctness

**B1. `FlowControlService` `resumeAll` clears all individual flags plus `pause_all` without preserving the pre-crisis state**
- If `generation` was paused before `pauseAll`, `resumeAll` will also unpause `generation`. This is consistent with "resume all" semantics, but an operator may expect a return to the previous state. Consider adding a `resumeAll` that only clears `pause_all` but leaves individual flags, or a separate `resumeAll` semantics.

**B2. `FlowControlService` `pauseAll` does not set individual flags**
- `isPaused` returns true because `pause_all` is set. If `pause_all` is later cleared but an individual flag was set before `pauseAll`, the individual flag remains. However, `resumeAll` clears all flags. If `resumeAll` is not used and `pause_all` is resumed with `resume('all')`? There is no `resume('all')`. Only `resumeAll` endpoint. So `resumeAll` clears all. Good. But if `pauseAll` is set, then `resume('posting')` is called, it will only clear `flow:pause_posting`, not `pause_all`. This is correct. If `pauseAll` is set, `resumeAll` must be called. Good.

**B3. `FlowControlService` `isPaused` uses Redis `get` with `Promise.all` but no error handling**
- If Redis is down, `isPaused` throws. Callers may not handle this. For example, `PostingService` `postById` calls `if (this.flowControl && await this.flowControl.isPaused('posting'))`. If `isPaused` throws, `postById` catches and marks `FAILED`. A Redis blip could mark posts as failed. Better to fail-open (if Redis error, return `false` / log warning) or fail-closed (return `true`).

**B4. `FlowControlController` `pause` and `pauseAll` parse `body` with `reasonSchema` but do not validate the schema errors**
- `const parsed = reasonSchema.safeParse(body);` then `await this.flowControl.pause(parseFlow(flow), parsed.success ? parsed.data.reason : undefined);`. If `body` is invalid, it silently ignores the reason. The endpoint returns `{ success: true }`. It could return 400 for invalid body. Minor.

**B5. `FlowControlController` `resume/:flow` has `flow` as `string` and `parseFlow` throws `BadRequestException`. Good.**

**B6. `FlowControlService` `getStatus` reads `pause_all` then each flow key sequentially with `await` inside a loop**
- `flow-control.service.ts:116-120` `for (const flow of Object.keys(FLOW_KEYS) as FlowName[]) { flows[flow] = allPaused || (await this.redis.get(FLOW_KEYS[flow])) === '1'; }`. This is sequential. It could be parallelized with `Promise.all` and a map. Minor performance.

**B7. `FlowControlService` `getStatus` returns `flows` typed as `Record<FlowName, boolean>` but constructs it as `{} as Record<FlowName, boolean>`**
- Type-cast. Good enough.

### 6.2 Performance

**P1. `isPaused` does two Redis `get` calls per invocation**
- `isPaused` is called in hot paths (e.g., `postById` before every post, `generate()` before generation). Two Redis `get` calls per call are fast but could be optimized with a single `MGET` or by caching the pause state in memory with a short TTL. However, Redis is fast and the check is not a bottleneck.

**P2. `getStatus` does sequential Redis calls**
- Could be `MGET` for all keys. Minor.

### 6.3 Architecture / anti-patterns

**A1. `FlowControlService` is a simple Redis wrapper with no domain abstraction**
- It is fine, but if more flows are added, `FlowName` union and `FLOW_KEYS` object must be updated. Could be data-driven from a config.

**A2. `FlowControlService` is `@Injectable()` and depends on `SHARED_REDIS` and `SseService` — good hexagonal pattern**
- It depends on Redis port and SSE port. Good.

**A3. `FlowControlController` `pause/:flow` and `resume/:flow` should probably be admin-only**
- As noted in autonomy review, no role guard. Pause/resume is an operational action. With `AUTH_ENABLED=false` (default), it is pass-through. With `AUTH_ENABLED=true`, any logged-in user can pause all posting. Risk.

**A4. `FlowControlService` pause flags have no TTL and no audit trail**
- No history of who paused/resumed or when. No auto-expire. This is a feature gap for ops.

**A5. `FlowControlService` `notifySse` is called in `pause`/`resume`/`pauseAll`/`resumeAll` but not in `getStatus` — fine**

### 6.4 TypeScript / type safety

**T1. `FlowName` is a union of string literals `'generation' | 'posting' | 'engagement' | 'replies'`**
- Good. Used in `FLOW_KEYS` and controller.

**T2. `FlowControlController` `parseFlow` uses `VALID_FLOWS.includes(flow as FlowName)`**
- Casting `flow` to `FlowName` for `includes` is okay but could be a type guard. Minor.

### 6.5 Security / reliability

**S1. No admin/role guard on `FlowControlController` endpoints**
- Any authenticated user can pause/resume. Add admin role guard.

**S2. `FlowControlService` Redis `get` can throw; no fallback**
- If Redis is down, services that check `isPaused` may fail. Consider `try/catch` and log + fail-open/closed.

**S3. `FlowControlService` `pauseAll` sets `flow:pause_all` but does not also publish `pause` events for each flow individually**
- The UI may be listening per-flow. `getStatus` returns true for all, but the per-flow SSE `paused` event is not emitted. Only `flow_control` `pause_all` is emitted. If the UI has per-flow listeners, it may not update. It should probably emit `paused` for each flow or the UI should handle `pause_all`.

## 7. New feature / improvement ideas

**F1. Add `MGET` or pipeline for `isPaused`/`getStatus`**
- Reduce Redis round-trips.

**F2. Add admin role guard to pause/resume endpoints**
- Security.

**F3. Add pause audit log / history table**
- Track who, when, why, and previous state.

**F4. Add configurable TTL on pause keys with auto-expiry notification**
- Prevent forgotten pauses.

**F5. Add `FlowControlService` `isPaused` fallback on Redis error**
- Fail-closed (return true) or fail-open with logging. Document the choice.

**F6. Add `pause_all` with per-flow SSE events**
- UI consistency.

**F7. Add `FlowControl` metrics**
- Time spent paused, number of pauses per flow.

**F8. Add `FlowControl` CLI commands**
- `pnpm flow:pause posting --reason "maintenance"`, etc.

## 8. Cross-references

- `modules/autonomy` — `AutonomousRunnerService` checks flows.
- `modules/generation` — `GenerationService` checks `generation` flow.
- `modules/posting` — `PostingService` checks `posting` flow.
- `modules/engagement` — `BrowsingSessionService` checks `engagement` flow.
- `modules/replies` — `RepliesMonitorService` checks `replies` flow.
- `infrastructure/redis` — `SHARED_REDIS`.
- `infrastructure/sse` — `SseService`.
- `docs/adr/ADR-006.md` — autonomy/flow control design.

## 9. Overall assessment

- **Health**: 8/10. The module is small, focused, and does one thing well. It has no critical bugs but lacks audit/role guards.
- **Biggest strengths**: simple Redis flags, SSE events, global + per-flow pause, used consistently across services.
- **Biggest risks**: no admin role on controller, no Redis error fallback, no audit history, `resumeAll` resets individual overrides.
- **Recommended next actions**:
  1. Add admin role guard to `FlowControlController`.
  2. Add Redis error fallback in `isPaused`.
  3. Use `MGET` for `isPaused`/`getStatus`.
  4. Add pause audit log.
