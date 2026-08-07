# Model Picker (F3) Runbook

## Overview

The `Generate.vue` page includes an **LLM Model** dropdown. By default it is set to "Auto", which lets `LlmService` use the configured free-first fallback chain (`LLM_ROLE_CHAINS`, sticky last-working provider, circuit breakers, rate-limit cooldowns).

If an operator selects a specific model, the backend will:

1. Try that exact `provider/model` first.
2. If the provider is unavailable or the call fails, fall back through the normal provider chain.

The value is sent as `model: "provider/model"` in `POST /generation/run`.

## How it works

- `LlmService.getAvailableModels()` returns the list of configured providers (`provider`, `model`, `free`). This powers the UI dropdown.
- The selected value (e.g. `openai/gpt-5-nano`) is split into `provider` and `model`.
- `LlmService.buildOrderedProviders()` clones the configured provider, swaps in the requested model, re-evaluates provider-specific settings (e.g., reasoning models on OpenAI), and places it at the front of the fallback chain.
- `GenerationService` does not pass the model through every graph node. Instead it stores it in the `AsyncLocalStorage` `LlmContext` via `withLlmContext()`, and `LlmService.generateChat()` reads it from the store and merges it into `GenerateOptions.model`.

## Adding or changing models

Models are defined by environment variables in `.env`:

```bash
GROQ_API_KEY=...        # enables groq/llama-3.3-70b-versatile
OPENAI_API_KEY=...      # enables openai/gpt-5-nano, gpt-5.4-nano, etc.
GOOGLE_API_KEY=...      # enables google/gemini-2.5-flash
OLLAMA_URL=http://localhost:11434  # always enabled as last resort
```

To change the default model for a provider, set its `*_MODEL` env var:

```bash
GROQ_MODEL=llama-3.3-70b-versatile
OPENAI_MODEL=gpt-5-nano
```

Any provider/model that the UI can select must have a working API key configured.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Model picker is empty | No LLM providers have API keys configured | Add at least one `*_API_KEY` to `.env` and restart the backend. |
| Selected model not used | Value missing in `POST /generation/run` body | Check the browser network tab — the `model` field should be present. |
| "Requested provider X not in configured chain" in logs | UI has a stale model list or provider disabled | Refresh the page to refetch `/generation/models`. |
| OpenAI reasoning model (gpt-5, o1, o3, o4-mini) returns 400 | Temperature/maxTokens sent to a reasoning model | `LlmService.buildOrderedProviders()` re-evaluates `supportsTemperature` and timeout for the requested model. If the 400 persists, check that the model name matches the `REASONING_MODEL_PATTERN` regex. |

## Tests

- `packages/backend/tests/unit/llm/llm-service-routing.spec.ts` (LS-008)
- `packages/backend/tests/unit/generation/generation.controller.spec.ts` (F3-101, F3-102)
- `packages/ui/tests/stores/stats.spec.ts` (F3-003, F3-004)
