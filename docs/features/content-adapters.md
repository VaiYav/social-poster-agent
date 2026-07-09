# Feature Proposal: Content Adapters Beyond CAP

## Status

Backlog / proposal. The current reader is hard-wired to the sibling `content-agent-platform` repo.

## Problem

`ContentReader` currently reads only local filesystem artifacts from `../content-agent-platform` (`brief-*`, `topics-*`, `create-*`) and the local blog path. There is no abstraction for adding external content sources such as RSS feeds, APIs, Google Trends, Notion, or SQL databases. This limits the breadth of topics the agent can write about and tightly couples the backend to a single sibling repo.

## Current state

- `packages/backend/src/infrastructure/content/content-reader.ts` reads `brief.json`, `topic-queue.json`, `create-*` reports and blog frontmatter from disk.
- `packages/backend/src/modules/content-source/content-source.service.ts` wraps the reader and `Topic` table.
- `packages/backend/src/domain/ports/content.port.ts` defines `IContentPort` with methods like `getTopics` / `getArticles`.
- All source types are embedded in `packages/shared/src/schemas/content.ts` as `BRIEF`, `ARTICLE`, `TOPIC`, `CREATE_RUN`.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/infrastructure/content/content-reader.ts" lines="20-40" />

## Proposed feature

1. **Adapter-based `IContentPort`.** Refactor `ContentReader` into a registry/factory of `IContentAdapter` implementations, each with:
   - `canHandle(sourceType: string): boolean`
   - `fetchTopics(limit: number, since: Date): Promise<ContentTopic[]>`
   - `fetchArticle(path: string): Promise<Article>`
   - Optionally `healthCheck()` and `lastError`.
2. **Built-in adapters:**
   - `CapFileAdapter` (existing local CAP reader, default).
   - `RssAdapter` for RSS/Atom feeds.
   - `ApiAdapter` for generic REST/JSON endpoints with jq-style extraction.
   - `GoogleTrendsAdapter` (or a trends API wrapper) for trending query terms.
   - `NotionAdapter` / `SqlAdapter` as later stretch goals.
3. **Configuration-driven source list.** Add a `ContentSource` table or env-based JSON config (`CONTENT_SOURCES`) listing enabled adapters, their URLs/auth, refresh schedule, and priority. Each source gets its own `sourceType`.
4. **Scheduling per source.** Instead of one `TopicGeneration` cron, allow per-adapter refresh intervals and incremental fetching (e.g., RSS `lastBuildDate`, API `etag/last-modified`).

## Data model changes

```prisma
model ContentSource {
  id        String   @id @default(cuid())
  name      String
  sourceType String   // cap_file, rss, api, trends, ...
  config    Json     // { url, authToken, query, schedule, language, priority }
  enabled   Boolean  @default(true)
  lastRunAt DateTime?
  lastError String?
  createdAt DateTime @default(now())
}
```

Existing `Topic` table already has `sourceType` string; it can be extended to include new adapter types.

## Integration points

- `packages/backend/src/domain/ports/content.port.ts` — extend `IContentPort` to expose `getSources()` / `healthCheck()`.
- `packages/backend/src/infrastructure/content/adapters/` — new directory.
- `packages/backend/src/modules/content-source/topic-generation.service.ts` — iterate over configured adapters instead of only CAP.
- `packages/shared/src/schemas/content.ts` — add `ContentSourceSchema`, extend `ContentSourceType`.
- `packages/backend/src/infrastructure/config/env.validation.ts` — validate `CONTENT_SOURCES` JSON or per-adapter env vars.

## Open questions / risks

- CAP sibling repo remains the primary source; adapters should not lower content quality.
- RSS/API sources may need summarization/extraction before becoming a `ContentTopic`.
- Auth/tokens for external sources must be stored securely (env, never DB plain text).
- Deduplication (`SimHash`) must work across sources and languages.

## Effort estimate

**M** (1–2 weeks). The main work is defining the adapter contract and porting the existing CAP reader to it, plus 2–3 reference adapters.

## Related reviews

- `content-source.md`
- `infrastructure-prisma.md` (schema additions)
- `recycling.md` (dedup / SimHash)
