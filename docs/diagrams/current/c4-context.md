# C4 Context Diagram — Current State

> **Level 1:** System Context. Shows SPA in its environment — external systems, users, and dependencies.
> **As-is:** What exists today (X, Threads, Facebook only — no syndication).

```mermaid
C4Context
    title Social Poster Agent — System Context (Current)

    Person(operator, "Operator", "Single admin user who reviews and approves posts via Vue dashboard")
    Person_Ext(audience, "Social Audience", "Readers on X, Threads, Facebook")

    System(spa, "Social Poster Agent", "Internal tool for My Zodiac AI. Generates LLM content from sibling repo and posts to social platforms via stealth browser automation. Cron generates → human reviews → agent posts.")

    System_Ext(cap, "Content Agent Platform", "Sibling repo at ../content-agent-platform. Source of topics, briefs, articles, brand voice. Read from disk at runtime.")
    System_Ext(langfuse, "Langfuse", "LLM observability + prompt management. Traces, prompts editable in UI without redeploy.")
    System_Ext(llm_providers, "LLM Providers", "15-provider fallback chain: Groq, SambaNova, Cerebras, OpenRouter, DeepSeek, Anthropic, OpenAI, Google, NVIDIA, GitHub, xAI, Mistral, HuggingFace, Together, Cohere, Ollama (local)")
    System_Ext(x, "X.com", "Twitter/X — posts via Camoufox browser automation")
    System_Ext(threads, "Threads", "Meta Threads — posts via Camoufox browser automation")
    System_Ext(facebook, "Facebook", "Facebook business page — posts via Camoufox browser automation")
    System_Ext(discord, "Discord", "Alerts: DLQ notifications, ban detection, failure alerts")

    SystemDb(postgres, "PostgreSQL", "SPA database: accounts, posts, sessions, interactions, metrics, topics")
    SystemDb(redis, "Redis", "BullMQ job queues, LangGraph checkpoints, SSE pub/sub, flow-control flags, distributed locks")

    Rel(operator, spa, "Reviews, approves, monitors via Vue dashboard")
    Rel_Back(spa, cap, "Reads topics, briefs, articles, brand-voice.md from disk")
    Rel(spa, langfuse, "Sends traces, fetches prompts (5-min cache)")
    Rel(spa, llm_providers, "Generates content via free-first fallback chain")
    Rel(spa, x, "Posts via Camoufox (pooled context)")
    Rel(spa, threads, "Posts via Camoufox (pooled context)")
    Rel(spa, facebook, "Posts via Camoufox (persistent context)")
    Rel(spa, discord, "Sends DLQ + ban alerts")
    Rel(spa, postgres, "Reads/writes all domain data")
    Rel(spa, redis, "Queues, checkpoints, SSE, flags, locks")
    Rel(audience, x, "Reads posts")
    Rel(audience, threads, "Reads posts")
    Rel(audience, facebook, "Reads posts")

    UpdateRelStyle(spa, cap, -100, 0)
    UpdateRelStyle(spa, langfuse, 0, -100)
    UpdateRelStyle(spa, llm_providers, 0, 100)
    UpdateRelStyle(spa, discord, 100, 0)
```

## Key points

- **Single operator** — SPA is an internal tool, not a multi-user SaaS. One admin reviews and approves.
- **CAP is a sibling repo** — read from disk at `../content-agent-platform`, not an API.
- **15 LLM providers** — free-first fallback chain. Cost ~$0 in practice (free tiers + Ollama last resort).
- **3 social platforms** — X, Threads, Facebook. All via Camoufox (anti-detect Firefox).
- **No syndication yet** — no Dev.to, Hashnode, LinkedIn, Medium, Substack, Reddit, Quora, Pinterest, Bluesky, Mastodon, Telegram. That's the future state.
- **Langfuse** — prompt management (editable in UI) + LLM tracing. Auto-enabled when `LANGFUSE_PUBLIC_KEY` set.
- **Discord** — only outbound notifications (DLQ, bans, failures). Not a posting platform.
