# 03 — Gemini Nano Banana Image Generation

## Document maturity (non-canonical)

Feature status: `MEDIA-001` in [the canonical register](../planning/FEATURES.md).

Proposal. SPA is text-only today. A `VisualConceptService` exists but only produces a concept/prompt, not an actual image.

## Problem

- Social algorithms boost native image posts 2-3x over text-only posts.
- The user wants to add AI image generation using the **cheapest** Gemini Nano Banana model and a **daily per-account limit**.
- Existing `QuoteCardService` (Satori → SVG → PNG) is feature-flagged and broken for real fonts; it does not generate photographic/mood visuals.

## Product Outcome

Approved posts can include an AI-generated image that matches the post content. Image generation:

- uses the cheapest Gemini Nano Banana lane by default,
- is gated per account with a daily count limit and a USD cost budget,
- falls back to text-only if the image fails, is too expensive, or the budget is exhausted,
- supports the existing `quote_card` / `aesthetic_photo` / `chart_visualization` visual styles,
- is previewable in the HITL review UI.

## Model Choice & Cost

Google Nano Banana family (as of 2026-07):

| Model | Model ID | 1K Standard | 0.5K Standard | Notes |
|-------|----------|-------------|---------------|-------|
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` | **$0.0336** | — | Cheapest, fastest, lowest fidelity |
| Nano Banana 2 | `gemini-3.1-flash-image` | $0.067 | **$0.045** | Balanced, up to 4K |
| Pro | `gemini-3.0-pro-image` | $0.134 | — | Premium text rendering |

Sources:
- https://ai.google.dev/gemini-api/docs/image-generation
- https://yingtu.ai/en/blog/nano-banana-pro-pricing-quota-guide-2026

**Default:** `gemini-3.1-flash-lite-image` at `1K` resolution. If a specific account needs better text rendering, allow `imageModel` override in account settings (Feature 02).

## Architecture

```
Post/VisualConcept
     │
     ▼
ImageGenerationService (orchestrator)
     │
     ├── quota check (Redis per-account daily + budget)
     ├── build prompt from VisualConcept
     │
     ▼
IImagePort
     │
     ▼
GeminiImageService (@google/genai SDK)
     │
     ▼
file storage (local / S3)
     │
     ▼
posters attach image during posting
```

### New Domain Port

`packages/backend/src/domain/ports/image.port.ts`:

```ts
export interface IImagePort {
  generate(options: {
    prompt: string;
    negativePrompt?: string;
    model: string;
    resolution: '0.5K' | '1K' | '2K' | '4K';
    aspectRatio: string;
    accountId?: string;
  }): Promise<{ buffer: Buffer; mimeType: string; costUsd: number }>;
}
```

### GeminiImageService

Use the official `@google/genai` Node SDK. Example:

```ts
import { GoogleGenAI, Modality } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await ai.models.generateContent({
  model: 'gemini-3.1-flash-lite-image',
  contents: prompt,
  config: {
    responseModalities: [Modality.IMAGE],
    imageConfig: { aspectRatio: '4:5', imageSize: '1K' },
  },
});

const imagePart = response.candidates?.[0]?.content.parts.find(
  (p) => p.inlineData?.mimeType?.startsWith('image/')
);
const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
```

Reference: https://ai.google.dev/gemini-api/docs/image-generation

### Prompt Building

Reuse `VisualConceptService` which already returns `VisualConcept` with `imagePrompt`, `style`, `textOverlay`, `bgGradient`, `network`.

- `aesthetic_photo` / `chart_visualization` → generate with Gemini.
- `quote_card` → keep using `QuoteCardService` (Satori) for typography control; optionally generate a background with Gemini and composite text in SVG.

Append a stable negative prompt:

```text
No text, no watermark, no UI elements, no borders, no faces unless explicitly requested, cosmic astrology aesthetic, clean composition.
```

### Quota & Budget

Redis keys:

```
spa:imagegen:{accountId}:daily   // counter, TTL until end of UTC day
spa:imagegen:{accountId}:budget  // running spend in micro-dollars, TTL 24h
```

Flow before generation:

1. Read account `imageDailyLimit` (default from env `IMAGE_GENERATION_DAILY_LIMIT_PER_ACCOUNT`, e.g. `3`).
2. Read account `imageCostBudgetUsdPerDay` (default `IMAGE_GENERATION_COST_BUDGET_USD_PER_DAY`, e.g. `1.0`).
3. Check `daily` count and `budget`.
4. Estimate cost from model/resolution pricing table.
5. If quota or budget would be exceeded, skip image and record `imageSkippedReason` in `Post.llmMetadata`.
6. After generation, increment counters and store actual cost.

### Cost Tracking

Add a central `CostLedgerService` (or extend `LlmService` usage tracking) to record every image call:

```ts
{
  accountId: string;
  postId?: string;
  model: string;
  resolution: string;
  costUsd: number;
  createdAt: Date;
}
```

This is reused by Feature 05 (token-cost optimization).

## Data Model Changes

```prisma
model Post {
  // existing fields ...
  media Json?  // { images: [{ url, altText, generatedBy, model, costUsd, createdAt }] }
}
```

Also extend `Post.llmMetadata` with:

```json
{
  "image": {
    "generated": true,
    "model": "gemini-3.1-flash-lite-image",
    "resolution": "1K",
    "costUsd": 0.0336,
    "path": "/app/spa-images/...png",
    "skippedReason": null
  }
}
```

## Posting with Images

Each network poster must attach the image file before submitting.

- `BasePoster.attachImage(page, imagePath, network)` helper.
- Use Playwright `setInputFiles` on the compose file input.
- Fallback selectors per network:
  - **X:** `input[data-testid="fileInput"], input[type="file"]`
  - **Threads:** `input[type="file"]` inside compose dialog
  - **Facebook:** `input[name="file1"], input[type="file"]` in composer
- If upload fails, log, screenshot, and post text-only.
- Alt text: set where platform supports it; otherwise store in `media` for record.

## Storage

- Local path: `IMAGE_OUTPUT_DIR=/app/spa-images` (configurable).
- Filename: `{accountId}_{postId}_{timestamp}.png`.
- Clean files older than 7 days.
- Future: add `IStoragePort` with S3 adapter so images live outside the container.

## Environment Variables

```text
GEMINI_API_KEY=                    # Google AI key (fallback to GOOGLE_API_KEY)
IMAGE_GENERATION_ENABLED=false
IMAGE_GENERATION_MODEL=gemini-3.1-flash-lite-image
IMAGE_GENERATION_RESOLUTION=1K
IMAGE_GENERATION_DAILY_LIMIT_PER_ACCOUNT=3
IMAGE_GENERATION_COST_BUDGET_USD_PER_DAY=1.0
IMAGE_GENERATION_BATCH_ENABLED=false
IMAGE_GENERATION_NEGATIVE_PROMPT="No text, no watermark..."
IMAGE_OUTPUT_DIR=/app/spa-images
```

## API / UI Changes

- `POST /posts/:id/generate-image` — regenerate image for a draft (HITL).
- `GET /posts/:id/preview` — include `media` image URL.
- Account settings form toggle for image generation (Feature 02).
- Dashboard "images generated today / cost" card.

## Integration with Existing Code

- `VisualConceptService` already returns concepts; extend its output to include a ready-to-use image prompt.
- `QuoteCardService` remains an alternative for `quote_card` typography.
- `GenerationService` writes `visualConcept` to `Post.llmMetadata` already; `ImageGenerationService` can be called after graph completes or at post time.
- `PostingService` calls `ImageGenerationService.getImageForPost(post)` before opening the browser.

## Testing

- Mock `IImagePort` for unit tests.
- Test quota enforcement with fake Redis.
- Dry-run should generate and save the image but not upload.
- Manual test: post with image to each network in `pnpm dry-run`.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Image model adds text/watermarks/artifacts | negative prompt, low resolution, human review, skip on failure |
| Cost explodes | per-account daily limit + USD budget; default to cheapest model |
| Upload selectors break | fallback chain + text-only fallback + screenshot on error |
| Policy / content moderation | avoid prompts with people/faces, test against Google safety filters |
| Same image reused across accounts | per-account image generation and storage; do not share final images |

## Acceptance Criteria

- [ ] `IImagePort` and `GeminiImageService` generate a PNG from a prompt.
- [ ] Account-level `imageDailyLimit` and `imageCostBudgetUsdPerDay` are enforced.
- [ ] `VisualConceptService` builds a prompt suitable for Gemini.
- [ ] `Post.media` stores generated image metadata.
- [ ] `XPoster`, `ThreadsPoster`, `FacebookPoster` can attach an image.
- [ ] Text-only fallback works if image generation or upload fails.
- [ ] Dry-run generates and saves the image but does not submit.
- [ ] UI previews the image before approve.

## Open Questions

- Should images be generated at draft time (before HITL review) or at post time (after approval)?
- Should we generate 1 image or 2 variants and let the operator pick?
- Do we need an `IMAGE_GENERATION_BATCH_ENABLED` mode to collect pending images and submit a Gemini batch job for the 50% discount?
- How do we handle non-Latin text overlays (e.g. Russian quote cards)? Gemini text rendering is weaker than Satori; keep `quote_card` on Satori for now?

## Effort Estimate

**M** (2-3 weeks). Main work: new port, SDK integration, quota/cost tracking, image upload selectors, storage, UI preview.

## Related Internal Docs

- `packages/backend/src/modules/content-enhancements/visual-concept.service.ts`
- `packages/backend/src/modules/quote-cards/quote-card.service.ts`
- `packages/backend/src/modules/posting/posters/base.poster.ts`
- `packages/backend/src/modules/posting/posters/x.poster.ts`
- `packages/backend/src/modules/posting/posters/threads.poster.ts`
- `packages/backend/src/modules/posting/posters/facebook.poster.ts`
