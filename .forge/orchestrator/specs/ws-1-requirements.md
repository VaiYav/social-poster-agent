# WS-1 Requirements: State Collector

> V-Model Phase: V1 (Requirements)
> Work Stream: WS-1 — State Collector (OBSERVE node)
> Criticality: High — all decisions depend on accurate state

---

## 1. Purpose

The State Collector gathers a complete snapshot of the system's world state
on every orchestrator cycle. This snapshot is the sole input to the Decision
Engine. Inaccurate or stale state leads to wrong decisions (posting with
expired session, generating when pool is full, etc.).

## 2. Functional Requirements

| ID | Requirement | Priority | Verification |
|----|-------------|----------|--------------|
| FR-1.1 | Collect topic pool count, threshold, and oldest topic age from DB | Must | Unit: mock Prisma → correct count |
| FR-1.2 | Collect draft counts by status (DRAFT, APPROVED, REJECTED) from DB | Must | Unit: mock Prisma → correct counts |
| FR-1.3 | Collect BullMQ queue depth per network (active + waiting + delayed) | Must | Unit: mock QueueFactory → correct depth |
| FR-1.4 | Collect session status per network from DB (ACTIVE/EXPIRED/BANNED/ERROR) | Must | Unit: mock Prisma → correct status |
| FR-1.5 | Collect circuit breaker state per network from CircuitBreakerRegistry | Must | Unit: mock registry → correct state |
| FR-1.6 | Collect rate limit status per network from RateLimitService | Must | Unit: mock service → correct remaining |
| FR-1.7 | Collect current UTC time, hour, day of week | Must | Unit: verify correct UTC fields |
| FR-1.8 | Collect posting window per network from PostingWindowService | Must | Integration: real service → correct window |
| FR-1.9 | Collect whether current time is in posting window per network | Must | Unit: mock windows → correct boolean |
| FR-1.10 | Collect last post metrics per network from PostMetrics table | Must | Unit: mock Prisma → correct metrics |
| FR-1.11 | Collect recent average engagement per network (last 10 posts) | Must | Unit: mock Prisma → correct average |
| FR-1.12 | Collect best posting hours per network from heatmap | Must | Integration: real heatmap → correct hours |
| FR-1.13 | Collect last browse timestamp per network from BrowsingSession table | Must | Unit: mock Prisma → correct timestamp |
| FR-1.14 | Collect unchecked replies count from IncomingComment table | Must | Unit: mock Prisma → correct count |
| FR-1.15 | Collect warmup phase per network from WarmupService | Should | Unit: mock service → correct phase |
| FR-1.16 | Collect ban count from recent posts (consecutive FAILED) | Must | Unit: mock Prisma → correct count |
| FR-1.17 | Collect DLQ depth from BullMQ failed jobs | Must | Unit: mock QueueFactory → correct depth |
| FR-1.18 | Collect stuck posting count (POSTING > 10 min) | Must | Unit: mock Prisma → correct count |
| FR-1.19 | Collect flow control flags from FlowControlService | Must | Unit: mock service → correct flags |
| FR-1.20 | Collect trend cache age and count from TrendingScraperService | Should | Unit: mock service → correct age |
| FR-1.21 | All DB queries must complete in < 500ms total | Must | System: measure real query time |
| FR-1.22 | All Redis reads must complete in < 100ms total | Must | System: measure real read time |
| FR-1.23 | State collection must not throw — return partial state on error | Must | Unit: force error in one source → others still collected |
| FR-1.24 | State must include timestamp of collection | Must | Unit: verify timestamp field present |

## 3. Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Full WorldState collection < 500ms (parallel queries) |
| Reliability | Partial failures don't abort collection — degraded fields marked |
| Caching | No caching in State Collector — fresh data every cycle |
| Concurrency | Safe to call from single orchestrator thread (no shared mutable state) |
| Observability | Log collection time + any degraded fields |

## 4. Data Sources Mapping

| WorldState Field | Source | Method |
|------------------|--------|--------|
| topicPool | Prisma `topic.count` + `topic.findFirst` | `prisma.topic.count({ where: { status: 'active' } })` |
| drafts | Prisma `post.count` grouped by status | `prisma.post.count({ where: { status: X } })` |
| queueDepth | BullMQ `queue.getJobCounts()` | `queueFactory.getQueue(network).getJobCounts()` |
| sessions | Prisma `session.findFirst` per network | `prisma.session.findFirst({ where: { accountId, status: ACTIVE } })` |
| circuitBreaker | `CircuitBreakerRegistry.getStates()` | `circuitBreakerRegistry.getStates()` |
| rateLimits | `RateLimitService.getStatus(network)` | `rateLimitService.getStatus(network)` |
| timing | `new Date()` | Native |
| postingWindows | `PostingWindowService.getRecommendation(network)` | Custom service |
| performance | Prisma `postMetrics.findMany` | `prisma.postMetrics.findMany({ where: { post: { network } }, orderBy: { collectedAt: 'desc' }, take: 10 })` |
| engagement | Prisma `browsingSession.findFirst` | `prisma.browsingSession.findFirst({ where: { accountId }, orderBy: { startedAt: 'desc' } })` |
| replies | Prisma `incomingComment.count` | `prisma.incomingComment.count({ where: { status: 'NEW' } })` |
| health | Prisma `post.count` + BullMQ | Multiple queries |
| flowControl | `FlowControlService.getStatus()` | `flowControlService.getStatus()` |
| trends | `TrendingScraperService` cache inspection | Custom |

## 5. Error Handling Strategy

```
For each data source:
  try {
    field = await collectFromSource();
  } catch (err) {
    logger.warn(`State collection partial failure: ${source} — ${err.message}`);
    field = defaultValue;  // null, 0, or "unknown"
    degradedFields.push(source);
  }

After all sources:
  if (degradedFields.length > 0) {
    logger.warn(`State collected with ${degradedFields.length} degraded fields: ${degradedFields.join(', ')}`);
  }
  return { ...state, _degraded: degradedFields, _collectedAt: Date.now() };
```

## 6. Acceptance Criteria

- [ ] AC-1: `collectWorldState()` returns a complete `WorldState` object with all required fields
- [ ] AC-2: When one data source fails, other fields are still populated correctly
- [ ] AC-3: Collection completes in < 500ms with real DB (10 topics, 50 posts, 3 sessions)
- [ ] AC-4: Topic pool count matches `prisma.topic.count({ where: { status: 'active' } })`
- [ ] AC-5: Session status reflects actual DB state (EXPIRED if no ACTIVE session)
- [ ] AC-6: Rate limit remaining matches `RateLimitService.getStatus()` output
- [ ] AC-7: Flow control flags match `FlowControlService.getStatus()` output
- [ ] AC-8: Timestamp is current UTC time at collection moment
- [ ] AC-9: Degraded fields are logged with source name and error message
- [ ] AC-10: No unhandled exceptions — always returns a WorldState object
