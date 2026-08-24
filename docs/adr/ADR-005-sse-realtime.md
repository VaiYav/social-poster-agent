# ADR-005: SSE for Real-Time UI Updates

**Status:** Accepted  
**Date:** 2026-07-15  
**Decider:** Valentyn Yakovliev

## Context

The SPA UI needs real-time updates when:
- Post status changes (DRAFT → APPROVED → POSTING → POSTED/FAILED)
- Generation run completes
- Health monitor detects issues (ban, DLQ, expired session)
- Reconciliation cron re-enqueues posts

The UI is a Vue 3 SPA served on a different port (3101) than the API (3100).

## Decision

Use **Server-Sent Events (SSE)** via Redis Pub/Sub.

## Architecture

```
BullMQ Worker → SseService.publish() → Redis PUBLISH spa:sse
                                              ↓
SseService (subscriber) → Redis SUBSCRIBE spa:sse
                                              ↓
                          SSE clients (EventSource) → Pinia stores
```

## Rationale

- SSE is simpler than WebSocket for one-way server→client updates
- No client-side library needed (native EventSource API)
- Redis Pub/Sub decouples worker from API process
- Auto-reconnect built into EventSource
- Works through VPN (no special proxy config)

## Consequences

**Positive:**
- Real-time post status in UI without polling
- Health alerts appear immediately
- Low overhead (text/event-stream, no framing)
- Vue 3 reactivity: SSE event → Pinia store → UI update

**Negative:**
- One-way only (client cannot send via SSE — uses REST for actions)
- Max connections per browser (~6 per domain in HTTP/1.1, unlimited in HTTP/2)
- No binary data (JSON text only — fine for our use case)

## Alternatives Considered

1. **WebSocket** — bidirectional, but overkill for one-way updates
2. **Polling** — simple but wasteful, not real-time
3. **tRPC subscriptions** — tied to tRPC, we use REST
4. **Socket.io** — heavier, adds protocol overhead

## References

- [SSE spec](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- CONSTITUTION §16: "SSE for real-time post status"
- B6: SSE UI wiring in App.vue + Pinia stores
