# 04 — Per-Account Prompts & Brand Voice

## Document maturity (non-canonical)

Feature status: `PERSONA-001` in [the canonical register](../planning/FEATURES.md).

Proposal. Today all posts share one `brand-voice.md` and a per-network persona injected by `GenerationService`.

## Problem

The user wants a **custom tone of voice for every account**. Currently:

- `brand-voice.md` is read once at startup from `process.cwd()`.
- The same `brandVoice` string is passed to every graph invocation.
- The graph state has a single `brandVoice: string` field.
- Prompts are fetched from Langfuse by global `PROMPT_VERSION` / `PROMPT_VERSION_<NAME>`.

This makes it impossible for `account_a` to sound playful and `account_b` to sound serious.

## Product Outcome

Each `SocialAccount` can have its own:

- brand voice snippet,
- per-network persona override,
- example good/bad swipes,
- extra banned phrases (slop list),
- optional full prompt override via Langfuse labels.

When per-account prompts are enabled, generation runs **per account** so each account's content is unique.

## Data Model

Add an `AccountPromptProfile` table:

```prisma
model AccountPromptProfile {
  id                String   @id @default(uuid())
  socialAccountId   String   @unique
  socialAccount     SocialAccount @relation(fields: [socialAccountId], references: [id], onDelete: Cascade)
  brandVoice        String?  // replaces global brand-voice.md for this account
  personaX          String?  // X persona override
  personaThreads     String?  // Threads persona override
  personaFacebook    String?  // Facebook persona override
  systemPromptExtra  String?  // appended to all system prompts
  bannedPhrases     String[] // merged into slop list
  exampleSwipes     String[] // good/bad examples for critique/refine prompts
  styleNotes        String?  // e.g. "use more sarcasm, no emojis"
  langfuseLabel     String?  // optional label prefix for prompt version overrides
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

model SocialAccount {
  // existing ...
  promptProfile   AccountPromptProfile?
}
```

Keep the global `brand-voice.md` as the fallback default.

## Prompt Inheritance

For a given account and network:

1. Global `brand-voice.md`.
2. `AccountPromptProfile.brandVoice` if set.
3. `persona{Network}` if set, otherwise global per-network persona.
4. `systemPromptExtra` appended to every system prompt.
5. `bannedPhrases` merged into the language `slopList`.
6. `exampleSwipes` injected into critique/refine prompts.
7. `styleNotes` added to the draft prompt.

## Generation Graph Changes

The graph state needs to know which account it is generating for:

```ts
// in generation.graph.ts createInitialState
export interface GenerationStateType {
  topic: ContentTopic;
  targetNetworks: SocialNetwork[];
  brandVoice: string;      // effective brand voice for this account
  promptProfile: AccountPromptProfile | null;
  accountId: string;
  language: string;
  // ...
}
```

Because the state has a single `brandVoice`, **the graph must be invoked once per account**. This is necessary anyway if each account should produce different content.

`GenerationService` flow:

```ts
for (const account of activeAccounts) {
  const profile = await promptProfileService.get(account.id);
  const effectiveBrandVoice = profile?.brandVoice ?? globalBrandVoice;
  const state = createInitialState(topic, networks, effectiveBrandVoice, account.id, profile, language);
  const result = await this.tracedGraphInvoke(config, handlerOpts, state);
  // save posts with accountId
}
```

If per-account prompts are **not** enabled (default), all accounts of a network can share one graph run and the post is assigned round-robin.

## Langfuse Per-Account Prompt Labels

`PromptRegistry.resolveLabel` can check an account context:

```ts
private resolveLabel(name: string, callerLabel?: string): string {
  const accountLabel = getCurrentAccountPromptLabel(); // from AsyncLocalStorage
  if (accountLabel) {
    return `${accountLabel}:${name}`;
  }
  // existing global resolution
  return callerLabel ?? process.env.PROMPT_VERSION ?? 'latest';
}
```

Example: account `soulwise-us` can have Langfuse prompts labeled `soulwise-us:draft-post` and `soulwise-us:hook-generation`. If the label does not exist, fall back to the global prompt.

Use a new `withPromptAccountContext(accountId, profile)` wrapper around `tracedGraphInvoke`.

## Prompt Variable Additions

Update the inline fallback prompts in `modules/generation/prompts/fallback-prompts.ts` to accept new variables:

- `{bannedPhrases}`
- `{exampleSwipes}`
- `{styleNotes}`
- `{personaX}`, `{personaThreads}`, `{personaFacebook}`

`PromptRegistry` and `toMustache()` already handle `{var}` → `{{var}}` conversion, so adding variables is mostly prompt-text work.

## API / UI

- `GET /accounts/:id/prompt-profile`
- `PUT /accounts/:id/prompt-profile`
- UI "Voice & Tone" tab per account with:
  - brand voice textarea,
  - per-network persona textareas,
  - banned phrases chips,
  - example swipes (good/bad) pairs,
  - style notes,
  - preview button that interpolates a prompt with sample variables.

## Migration

- For each existing `SocialAccount`, create an `AccountPromptProfile` with `brandVoice` copied from current `brand-voice.md`.
- Add a CLI to export/import prompt profiles for backup and templating.

## Risks

- **Cost:** running the graph per account multiplies LLM calls. Mitigate with Feature 05 (cost optimization) and per-account budgets.
- **Quality drift:** divergent tones can reduce brand consistency. Mitigate by keeping shared factual rules and examples.
- **Langfuse label proliferation:** many prompt versions. Document naming convention and use label cleanup.

## Acceptance Criteria

- [ ] `AccountPromptProfile` schema and `packages/shared` Zod validation.
- [ ] `GenerationService` can invoke graph per account with account-specific `brandVoice`/`persona`.
- [ ] Draft/hook/critique/refine prompts use account variables (`bannedPhrases`, `exampleSwipes`, `styleNotes`, `persona`).
- [ ] `PromptRegistry` resolves per-account Langfuse labels when account context is present.
- [ ] UI edits and previews per-account prompt profile.
- [ ] Global `brand-voice.md` remains the fallback.

## Open Questions

- Should persona be per network per account, or just one account-level persona applied to all networks?
- Should we support per-account prompt overrides for **all** 7 Langfuse prompts, or start with brand voice + draft + hook?
- How do we A/B test per-account prompt profiles? (Could reuse `Post.llmMetadata.promptLabels`.)

## Effort Estimate

**M** (2-3 weeks). Core schema + service + graph state changes are moderate; UI prompt editor and Langfuse label wiring are the larger pieces.

## Related Internal Docs

- `packages/backend/src/modules/generation/generation.service.ts`
- `packages/backend/src/modules/generation/generation.graph.ts`
- `packages/backend/src/modules/generation/prompts/fallback-prompts.ts`
- `packages/backend/src/infrastructure/prompt/prompt-registry.ts`
- `packages/backend/src/infrastructure/prompt/prompt-label-context.ts`
