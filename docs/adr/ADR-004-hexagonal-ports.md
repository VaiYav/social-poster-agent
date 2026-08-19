# ADR-004: Hexagonal Architecture with Ports & Adapters

**Status:** Accepted  
**Date:** 2026-07-15  
**Decider:** Valentyn Yakovliev

## Context

The Social Poster Agent needs to integrate with multiple external systems:
- LLM providers (OpenAI, Anthropic, local Ollama)
- Browser automation (Camoufox/Playwright)
- Social networks (X, Threads, Facebook)
- Queue (BullMQ/Redis)
- Database (PostgreSQL via Prisma)

The architecture must allow swapping any of these without changing business logic.

## Decision

Use **Hexagonal Architecture (Ports & Adapters)** with TypeScript interfaces as ports.

## Port Definitions

- `ILlmPort` — LLM generation (chat, embeddings)
- `IBrowserPort` — Browser automation (open page, type, click, screenshot)
- `IContentSourcePort` — Content source (blog, brief, topic)

Adapters implement these ports:
- `OpenAiLlmAdapter`, `AnthropicLlmAdapter`, `OllamaLlmAdapter`
- `BrowserFactory` (Camoufox)
- `BlogContentSource`, `BriefContentSource`

## Rationale

- Domain logic has zero knowledge of external systems
- Testing: mock any port in unit tests
- Swapping: new adapter = new class, no domain changes
- NestJS DI: `@Inject(ILlmPort)` — clean injection

## Consequences

**Positive:**
- LLM provider swap = one adapter change
- Browser backend swap = one adapter change
- Clear separation: domain vs. infrastructure
- Testability — mock ports in tests, no real API calls

**Negative:**
- More files (port interface + adapter + module wiring)
- Indirection layer adds cognitive overhead
- Must discipline: domain never imports infrastructure

## Alternatives Considered

1. **Direct imports** — tight coupling, hard to test
2. **Dependency Injection only (no ports)** — less explicit contracts
3. **Microservices** — overkill for single-server app

## References

- [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
- CONSTITUTION §4: "Hexagonal (Ports & Adapters)"
