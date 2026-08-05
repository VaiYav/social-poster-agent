# Generation Graph Flow — Current State

> **LangGraph state machine:** How SPA generates social posts today.
> **As-is:** Per-topic fan-out to X, THREADS, FACEBOOK. HITL at the end.

```mermaid
flowchart TD
    START([START]) --> research_extract[research_extract<br/>Extract facts from topic + RAG]
    research_extract --> hook_generation[hook_generation<br/>Generate 3-5 scroll-stopping hooks]
    hook_generation --> angle_per_network[angle_per_network<br/>Per-network angle selection]

    %% Parallel fan-out — one branch per network
    angle_per_network --> draft_x[draft<br/>X]
    angle_per_network --> draft_t[draft<br/>THREADS]
    angle_per_network --> draft_f[draft<br/>FACEBOOK]

    %% Each network: draft → critique → refine → visual_concept → ab_variant
    draft_x --> critique_x[critique<br/>Editor critique + score]
    critique_x --> refine_x[refine<br/>Rewrite based on critique]
    refine_x --> visual_x[visual_concept<br/>Image concept]
    visual_x --> ab_x[ab_variant<br/>A/B variant]

    draft_t --> critique_t[critique<br/>THREADS]
    critique_t --> refine_t[refine<br/>THREADS]
    refine_t --> visual_t[visual_concept<br/>THREADS]
    visual_t --> ab_t[ab_variant<br/>THREADS]

    draft_f --> critique_f[critique<br/>FACEBOOK]
    critique_f --> refine_f[refine<br/>FACEBOOK]
    refine_f --> visual_f[visual_concept<br/>FACEBOOK]
    visual_f --> ab_f[ab_variant<br/>FACEBOOK]

    %% Converge to human_review
    ab_x --> human_review[human_review<br/>HITL: interrupt for operator approval]
    ab_t --> human_review
    ab_f --> human_review

    human_review -->|approved| save_to_db[save_to_db<br/>Format graph state<br/>NOT actual DB write]
    human_review -->|rejected| END_REJECT([END — rejected])
    save_to_db --> END_OK([END])

    %% Judge node (runs after refine, before visual_concept — not shown in flow for clarity)
    %% Judge is non-blocking: if judge LLM fails, post proceeds with undefined scores

    classDef node fill:#e3f2fd,stroke:#1976d2,stroke-width:2px,color:#000
    classDef hitl fill:#fff3e0,stroke:#f57c00,stroke-width:3px,color:#000
    classDef terminal fill:#e8f5e9,stroke:#388e3c,stroke-width:2px,color:#000
    classDef reject fill:#ffebee,stroke:#d32f2f,stroke-width:2px,color:#000

    class research_extract,hook_generation,angle_per_network,draft_x,draft_t,draft_f,critique_x,critique_t,critique_f,refine_x,refine_t,refine_f,visual_x,visual_t,visual_f,ab_x,ab_t,ab_f,save_to_db node
    class human_review hitl
    class START,END_OK terminal
    class END_REJECT reject
```

## Key details

### Graph structure
- **File:** `packages/backend/src/modules/generation/generation.graph.ts`
- **Trigger:** `GenerationService.generate()` — called by cron or manual trigger
- **Per topic:** One graph invocation produces **3 Post rows** (one per network: X, THREADS, FACEBOOK)
- **Parallel branches:** Each network runs independently. Per-network error isolation: failed network short-circuits, others proceed.

### Nodes (10 total)

| Node | Purpose | LLM? |
|------|---------|------|
| `research_extract` | Extract facts from topic + RAG (CAP content) | Yes — `research-extract` prompt |
| `hook_generation` | Generate 3-5 scroll-stopping hooks per topic | Yes — `hook-generation` prompt |
| `angle_per_network` | Select different angle per network (not one text reworded) | Yes |
| `draft` | Full post draft per network | Yes — `draft-post` prompt |
| `critique` | Editor critique with quality score | Yes — `critique-post` prompt |
| `refine` | Rewrite based on critique | Yes — `refine-post` prompt |
| `visual_concept` | Image concept generation | Yes |
| `ab_variant` | A/B testing variant | Yes |
| `human_review` | HITL — `interrupt()` for operator approval | No — LangGraph interrupt |
| `save_to_db` | **Misnomer** — only formats graph state. Real Prisma persistence happens AFTER `graph.invoke()` returns, in `GenerationService` | No |

### LLM-as-a-Judge
- **Judge node** (`makeJudgeNode`) runs AFTER refine, BEFORE visual_concept
- Evaluates 4 criteria (0.0-1.0 each):
  - `anti_ai_tone` — does it sound human?
  - `hook_strength` — does the first line stop scrolling?
  - `factual_accuracy` — are the astrology facts correct?
  - `character_limit` — does it fit the platform's limit?
- **Non-blocking:** If judge LLM call fails, post proceeds with `judgeScores: undefined`
- Scores stored in `Post.llmMetadata.judgeScores`

### HITL (Human-in-the-Loop)
- `human_review` node calls LangGraph `interrupt()`
- Graph pauses, operator reviews in Vue dashboard
- Resume via `GenerationService.resumeWithReview()` with `new Command({ resume: {...} })`
- When `AUTO_APPROVE_ENABLED=true` + judge score ≥ threshold → auto-approve (skips interrupt)

### Crash-resume
- `RedisCheckpointSaver` keys on `thread_id = ${runId}:${topic.topic}`
- Re-invoking with same `thread_id` resumes from checkpoint
- Graph is lazy-compiled once via `GenerationService.getGraph()`

### SimHash dedup
- After `graph.invoke()` returns, `GenerationService` checks SimHash near-duplicate
- Skip if Hamming distance ≤3 vs last ~200 posts / 30 days
- Prevents re-posting near-identical content

### Langfuse tracing
- One `CallbackHandler` per topic with `sessionId=runId`
- Tags: `['generation', language, ...networks]`
- `promptNames` in traceMetadata — filter traces by which prompts were used
- ALS (AsyncLocalStorage) propagates callbacks through graph nodes without threading them through every function signature
