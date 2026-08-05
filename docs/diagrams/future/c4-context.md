# C4 Context Diagram — Future State

> **Level 1:** System Context. Shows SPA in its environment — external systems, users, and dependencies.
> **To-be:** Full syndication across 14 platforms (13 via Camoufox + 1 via Telegram Bot API), article generation, canonical URL management, IndexNow submission, participation mode.

```mermaid
C4Context
    title Social Poster Agent — System Context (Future)

    Person(operator, "Operator", "Single admin user who reviews and approves posts + articles via Vue dashboard")
    Person_Ext(audience, "Social Audience", "Readers on all 14 social + blog platforms")
    Person_Ext(blog_readers, "Blog Readers", "Readers on my-zodiac-ai.com/blog (canonical home)")

    System(spa, "Social Poster Agent", "Internal tool for My Zodiac AI. Generates LLM articles + social posts from sibling repo. Posts to 14 platforms via stealth browser automation + Telegram Bot API. Manages canonical URLs, submits to IndexNow, participates on Reddit/Quora.")

    System_Ext(cap, "Content Agent Platform", "Sibling repo at ../content-agent-platform. Source of topics, briefs, articles, brand voice. Read from disk at runtime.")
    System_Ext(langfuse, "Langfuse", "LLM observability + prompt management. Traces, prompts editable in UI without redeploy. 12 prompts (article + social).")
    System_Ext(llm_providers, "LLM Providers", "15-provider fallback chain: Groq, SambaNova, Cerebras, OpenRouter, DeepSeek, Anthropic, OpenAI, Google, NVIDIA, GitHub, xAI, Mistral, HuggingFace, Together, Cohere, Ollama (local)")

    System_Ext(x, "X.com", "Twitter/X — Camoufox pooled context")
    System_Ext(threads, "Threads", "Meta Threads — Camoufox pooled context")
    System_Ext(facebook, "Facebook", "Facebook business page — Camoufox persistent context")
    System_Ext(devto, "Dev.to", "Developer blog — Camoufox persistent context (LLM-in-the-loop)")
    System_Ext(hashnode, "Hashnode", "Developer blog — Camoufox persistent context (LLM-in-the-loop)")
    System_Ext(linkedin, "LinkedIn", "Professional network — Camoufox persistent context (LLM-in-the-loop)")
    System_Ext(bluesky, "Bluesky", "Decentralized social — Camoufox persistent context (LLM-in-the-loop)")
    System_Ext(mastodon, "Mastodon", "Federated social — Camoufox persistent context (LLM-in-the-loop)")
    System_Ext(medium, "Medium", "Blog platform — Camoufox persistent context (LLM-in-the-loop, no API)")
    System_Ext(substack, "Substack", "Newsletter platform — Camoufox persistent context (LLM-in-the-loop, no API)")
    System_Ext(reddit, "Reddit", "Community forum — Camoufox persistent context (participation mode: answer questions)")
    System_Ext(quora, "Quora", "Q&A platform — Camoufox persistent context (participation mode: answer questions)")
    System_Ext(pinterest, "Pinterest", "Image sharing — Camoufox persistent context (participation mode: pin + engage)")
    System_Ext(telegram, "Telegram", "Channel broadcasting — Bot API (only API exception, no Camoufox)")

    System_Ext(indexnow, "IndexNow", "Bing/search engine URL submission — accelerates indexing of canonical blog URLs")
    System_Ext(discord, "Discord", "Alerts: DLQ notifications, ban detection, failure alerts")

    SystemDb(postgres, "PostgreSQL", "SPA database: accounts, posts, articles, sessions, interactions, metrics, topics, syndication, canonical URLs")
    SystemDb(redis, "Redis", "BullMQ job queues (article + social + participation), LangGraph checkpoints, SSE pub/sub, flow-control flags, distributed locks")

    Rel(operator, spa, "Reviews, approves, monitors via Vue dashboard")
    Rel_Back(spa, cap, "Reads topics, briefs, articles, brand-voice.md from disk")
    Rel(spa, langfuse, "Sends traces, fetches prompts (5-min cache)")
    Rel(spa, llm_providers, "Generates content via free-first fallback chain")
    Rel(spa, x, "Posts via Camoufox (pooled)")
    Rel(spa, threads, "Posts via Camoufox (pooled)")
    Rel(spa, facebook, "Posts via Camoufox (persistent)")
    Rel(spa, devto, "Posts articles via Camoufox (persistent, LLM vision)")
    Rel(spa, hashnode, "Posts articles via Camoufox (persistent, LLM vision)")
    Rel(spa, linkedin, "Posts articles via Camoufox (persistent, LLM vision)")
    Rel(spa, bluesky, "Posts via Camoufox (persistent, LLM vision)")
    Rel(spa, mastodon, "Posts via Camoufox (persistent, LLM vision)")
    Rel(spa, medium, "Posts articles via Camoufox (persistent, LLM vision)")
    Rel(spa, substack, "Posts articles via Camoufox (persistent, LLM vision)")
    Rel(spa, reddit, "Participates via Camoufox (persistent, LLM vision)")
    Rel(spa, quora, "Participates via Camoufox (persistent, LLM vision)")
    Rel(spa, pinterest, "Participates via Camoufox (persistent, LLM vision)")
    Rel(spa, telegram, "Posts via Bot API (channel broadcast)")
    Rel(spa, indexnow, "Submits canonical URLs for indexing")
    Rel(spa, discord, "Sends DLQ + ban alerts")
    Rel(spa, postgres, "Reads/writes all domain data")
    Rel(spa, redis, "Queues, checkpoints, SSE, flags, locks")
    Rel(audience, x, "Reads posts")
    Rel(audience, devto, "Reads articles")
    Rel(blog_readers, spa, "Reads canonical articles on my-zodiac-ai.com/blog")

    UpdateRelStyle(spa, cap, -100, 0)
    UpdateRelStyle(spa, langfuse, 0, -100)
    UpdateRelStyle(spa, llm_providers, 0, 100)
    UpdateRelStyle(spa, indexnow, 100, -50)
    UpdateRelStyle(spa, discord, 100, 50)
```

## Key points

- **14 platforms total** — 13 via Camoufox browser automation (X, Threads, Facebook, Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Medium, Substack, Reddit, Quora, Pinterest) + 1 via Telegram Bot API (the only API exception — Telegram has a clean, well-documented Bot API, no need for browser automation).
- **LLM-in-the-loop for new platforms** — Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Medium, Substack, Reddit, Quora, Pinterest all use a vision-capable LLM to navigate their editors (no hardcoded selectors). The LLM sees screenshots, decides actions, types content. This is the `BrowserAgentService` — a general-purpose browser agent that adapts to any platform's UI without selector maintenance.
- **Canonical URL management** — articles are published to my-zodiac-ai.com/blog first (canonical home), then syndicated to Dev.to/Hashnode/LinkedIn/Medium/Substack with `rel=canonical` pointing back. `CanonicalUrlService` builds, verifies, and tracks canonical URLs.
- **IndexNow integration** — after an article is published and canonical verified, SPA submits the canonical URL to IndexNow (Bing + other search engines) for accelerated indexing. No waiting for crawlers.
- **Participation mode** — Reddit, Quora, and Pinterest aren't just broadcast platforms. SPA finds relevant questions/threads, drafts answers (LLM), judges quality, and posts — building genuine engagement rather than just broadcasting.
- **10 persistent browser contexts** — one per platform that needs login state (Facebook, Dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Medium, Substack, Reddit, Quora, Pinterest). Each has its own `user_data_dir` on disk, never pooled/closed. X/Threads remain pooled.
- **12 Langfuse prompts** — 5 article prompts (article-research-extract, article-outline, article-draft, article-judge, article-refine) + 7 social prompts (existing 7). All editable in Langfuse UI without redeploy.
- **Article → social promo chain** — when an article is published + canonical verified, a `SocialPromoTrigger` fires → `SocialGraph` generates social posts promoting the article → those go through their own judge/approve/publish flow.
