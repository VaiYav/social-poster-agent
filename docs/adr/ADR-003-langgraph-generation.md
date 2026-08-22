# ADR-003: LangGraph for Content Generation Workflow

**Status:** Accepted  
**Date:** 2026-07-15  
**Decider:** Valentyn Yakovliev

## Context

Content generation needs a multi-step LLM workflow:
1. Research extract (facts from topic)
2. Hook generation (3-5 variants)
3. Per-network angle assignment (X=punchy, Threads=narrative, FB=conversational)
4. Parallel draft generation (one per network)
5. Parallel self-critique (per network)
6. Parallel refinement (per network)
7. Save to DB (3 posts per topic)

The workflow must be:
- Resumable after crash (checkpointing)
- Parallelizable (3 networks in parallel)
- Observable (state visible at each step)

## Decision

Use **LangGraph.js** for the generation workflow.

## Rationale

- Native parallel fan-out/fan-in via StateGraph edges
- Redis checkpoint saver — resume after crash (B6 mitigation)
- State is typed and visible at each node
- Compatible with our ILlmPort abstraction (nodes receive the port)
- LangChain ecosystem — future tool use, RAG, etc.

## Consequences

**Positive:**
- 7-step parallel graph matches CONSTITUTION §10.3 exactly
- Per-network angle = different content, not adaptation (OQ-16)
- Crash recovery via Redis checkpoint
- Easy to add new nodes (e.g., fact-check, image generation)

**Negative:**
- Learning curve for LangGraph state semantics
- Annotation.Reducer needed for complex state merges
- recursionLimit must be tuned for parallel graphs

## Alternatives Considered

1. **Plain async functions** — no checkpointing, no parallelism abstraction
2. **Temporal** — overkill, separate service
3. **Custom state machine** — reinventing the wheel
4. **LangChain chains** — sequential only, no parallel fan-out

## References

- [LangGraph.js docs](https://langchain-ai.github.io/langgraphjs/)
- CONSTITUTION §10.3: LangGraph workflow diagram
- OQ-16: Per-network angle = different content
