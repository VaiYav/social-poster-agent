# Feature: Prompt Versioning & A/B with Langfuse

## Document maturity (non-canonical)

Feature status: `PLATFORM-004` in [the canonical register](../planning/FEATURES.md).

Implemented. All production prompts are fetched from Langfuse Prompt Management with label resolution, per-prompt overrides, fallback chains, and recorded prompt labels in `Post.llmMetadata`. A CLI diff tool is available.

## What is implemented

- `PromptRegistry` resolves the effective Langfuse label from:
  1. `PROMPT_VERSION_<NAME>` env var override
  2. Optional caller-supplied `label` parameter
  3. `PROMPT_VERSION` env var (default `latest`)
  4. Label fallback chain: resolved label → `production` → `latest`

- `LangfuseService.getChatPrompt()` and `getTextPrompt()` accept a `label` parameter. They are no longer hardcoded to `production`.

- `GenerationService` records the map of `promptName → { label, isFallback }` in `Post.llmMetadata.promptLabels` via `withPromptLabelContext()`.

- `LlmService.getPromptVersion()` falls back to `PromptRegistry.getCurrentVersion()`.

- `packages/backend/scripts/migrate-prompts-to-langfuse.ts` creates/updates prompts and labels in Langfuse.

- `packages/backend/scripts/prompt-diff.ts` (package script `prompts:diff`) prints the unified diff between two prompt labels or versions.

## Current state

- `PROMPT_VERSION` is declared in `env.validation.ts` with default `latest`.
- `packages/backend/src/infrastructure/prompt/prompt-registry.ts` reads `PROMPT_VERSION` / `PROMPT_VERSION_<NAME>` from `ConfigService`, builds a label fallback chain, and records resolved labels.
- `packages/backend/src/infrastructure/prompt/prompt-label-context.ts` uses `AsyncLocalStorage` to collect prompt labels during a generation run.
- `packages/backend/src/infrastructure/langfuse/langfuse.service.ts` exposes `getChatPrompt(name, fallback, label)` and `getTextPrompt(name, fallback, label)`.
- `packages/backend/src/modules/generation/generation.service.ts` writes `promptLabels` into `Post.llmMetadata`.
- `packages/backend/scripts/prompt-diff.ts` fetches two prompt versions/labels and prints a unified diff.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/infrastructure/prompt/prompt-registry.ts" lines="217-246" />

## CLI

```bash
# Compare two labels for the same prompt
cd packages/backend
pnpm prompts:diff draft-post production latest

# Compare specific versions
pnpm prompts:diff critique-post 1 3

# Force a prompt type (fails if the prompt type differs)
pnpm prompts:diff draft-post production latest --type chat
```

The command loads `.env` from the repo root, so `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` must be set.

## Data model

No schema changes. `Post.llmMetadata` is a JSON object with:

```ts
interface LlmMetadata {
  model: string;
  tokens: number;
  cost: number;
  promptVersion: string;                 // global PROMPT_VERSION
  promptLabels: Record<string, {         // per-prompt labels used in this run
    label: string;
    isFallback?: boolean;
  }>;
  abVariants?: ABVariantPair | null;
  judgeScores?: JudgeScores;
  // ... other fields
}
```

## Integration points

- `infrastructure/prompt/prompt-registry.ts` — label resolution and fallback.
- `infrastructure/langfuse/langfuse.service.ts` — prompt fetch by label.
- `infrastructure/llm/llm.service.ts` — prompt version metadata.
- `modules/generation/generation.service.ts` — persist prompt labels in `llmMetadata`.
- `packages/backend/scripts/prompt-diff.ts` — operator CLI diff.
- `packages/backend/scripts/migrate-prompts-to-langfuse.ts` — prompt creation/labels.

## Open questions / risks

- `PROMPT_VERSION` is named after a version, but it acts as a Langfuse label. The name is kept for backwards compatibility.
- A/B testing prompt versions still needs outcome tracking; prompt labels are stored, so the A/B testing feature can join on them later.

## Effort estimate

Implemented. Remaining work (if any) is UX polish on the diff CLI.

## Related reviews

- `infrastructure-llm.md` (PromptRegistry, B11)
- `ab-testing-infrastructure.md` (outcome tracking for prompt A/B)
- `AGENTS.md` (Langfuse Prompt Management conventions)
