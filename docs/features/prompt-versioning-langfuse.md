# Feature Proposal: Prompt Versioning & A/B with Langfuse

## Status

Backlog / proposal. `PROMPT_VERSION` env var exists but is not wired to prompt fetches.

## Problem

The system is designed around Langfuse Prompt Management: all production prompts live there, versioned and editable in UI without redeploys. However, `PromptRegistry` and `LangfuseService.getChatPrompt` / `getTextPrompt` hardcode `label: 'production'`, and the `PROMPT_VERSION` env var only ends up as `llmMetadata.promptVersion` metadata. As a result, operators cannot pin or A/B test prompt versions from `.env`.

## Current state

- `PROMPT_VERSION` is declared in `env.validation.ts:158` with default `latest`.
- `packages/backend/src/infrastructure/prompt/prompt-registry.ts` calls `langfuse.getChatPrompt(name, sdkFallback)` and receives the prompt; it does not pass a label.
- `packages/backend/src/infrastructure/langfuse/langfuse.service.ts` hardcodes `label: 'production'` in `getChatPrompt` (`:130`) and `getTextPrompt` (`:162`).
- `packages/backend/src/modules/generation/generation.service.ts` adds `promptNames` and a `promptVersion` to trace metadata.
- There is a migration script `packages/backend/scripts/migrate-prompts-to-langfuse.ts` for initial setup.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/infrastructure/langfuse/langfuse.service.ts" lines="120-140" />

## Proposed feature

1. **Wire `PROMPT_VERSION` to the Langfuse label.**
   - `PromptRegistry.getCompiledChat()` and `getCompiledText()` should accept an optional `label` parameter.
   - Default label comes from `PROMPT_VERSION` env (or `production` if unset).
   - `LangfuseService.getChatPrompt(name, fallback, label)` uses the label instead of hardcoded `'production'`.
2. **Per-prompt version pinning.** Add support for `PROMPT_VERSION_<NAME>` env vars (e.g., `PROMPT_VERSION_DRAFT_POST=v2`) that override the global label for a specific prompt.
3. **Prompt A/B testing.**
   - `GenerationService` can be configured to fetch two labels (`A` and `B`) for the same prompt name in a single run, producing two post variants.
   - Store `promptLabel` in `Post.llmMetadata` and compare outcomes later (links to A/B testing infrastructure proposal).
4. **Prompt deprecation / fallback.** If a label does not exist in Langfuse, fall back to `production`, then `latest`, then inline fallback. Log a warning.
5. **UI/CLI for prompt diff.** A simple command `pnpm prompts:diff v1.0 v1.1` prints the diff of a prompt between two Langfuse versions.

## Data model changes

No schema changes. Add `promptVersion` / `promptLabel` to `Post.llmMetadata` JSON consistently:

```ts
interface LlmMetadata {
  model: string;
  tokens: number;
  cost: number;
  promptVersion: string;     // was misleading; should become array or per-prompt map
  promptLabels: Record<string, string>; // e.g. { 'draft-post_x': 'production', 'hook-generation_xen_0015a0e4-6777-4e95-8c46-c5663da0a49b_x_8f49a0f6-8777-4bda-8c46-c5663da0a49b' }
}
```

## Integration points

- `infrastructure/prompt/prompt-registry.ts` — accept label, wire env.
- `infrastructure/langfuse/langfuse.service.ts` — remove hardcoded label.
- `infrastructure/llm/llm.service.ts` — propagate prompt version metadata.
- `modules/generation/generation.service.ts` — store prompt labels per network/stage.
- `packages/backend/scripts/migrate-prompts-to-langfuse.ts` — ensure labels are created and migration supports versions.
- `packages/shared` — update DTOs that expose `llmMetadata` to operators.

## Open questions / risks

- Renaming `PROMPT_VERSION` to `PROMPT_LABEL` might be clearer, but would break existing `.env` files. Better to keep the name and document that it is the Langfuse label.
- Multiple prompts with different labels in one generation run complicate trace metadata; use per-prompt maps.
- A/B testing prompt versions needs outcome tracking; can start with metadata only and build A/B feature later.

## Effort estimate

**S–M** (3–10 days). The core wiring is small; the larger part is consistent metadata and per-prompt override env vars.

## Related reviews

- `infrastructure-llm.md` (PromptRegistry, B11)
- `ab-testing-infrastructure.md` (outcome tracking for prompt A/B)
- `AGENTS.md` (Langfuse Prompt Management conventions)
