# MEDIA-101 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local image port/quota/metadata/fallback foundation; no Gemini/provider, staging, native
poster upload or UI preview evidence.

## Implemented

- `IImagePort` contract for prompt/model/resolution/aspect-ratio generation.
- Official REST Gemini adapter uses `v1/models/:model:generateContent`, `x-goog-api-key`,
  `responseModalities: ["IMAGE"]`, inline image parsing and Lite 1K normalization.
- Atomic Redis per-account daily-count and micro-USD budget reservation with compensating release.
- `ImageGenerationService` resolves account image settings, uses cheapest configured default,
  persists `Post.media` metadata and local output paths, and falls back to text-only on disabled,
  missing provider, quota or provider failure.
- Account settings now include `imageCostBudgetUsdPerDay`; `.env.example` documents safe disabled
  defaults and the selected `gemini-3.1-flash-lite-image` default.
- Additive `Post.media` migration is present; adapter is registered but remains disabled without
  `GEMINI_API_KEY`.
- `Post.media.path` is passed to X/Threads/Facebook posters; shared upload helper tries native file
  inputs and degrades to text-only without changing legacy no-image calls.
- Authenticated media stream endpoint validates paths against `IMAGE_OUTPUT_DIR`; Queue/PostCard
  preview uses the API URL with lazy loading, alt text and text-only error fallback.

## Local evidence

- Media + account-settings focused lane — exit 0, 4 files / 15 tests.
- Posting/media regression lane — exit 0, 4 files / 52 tests.
- UI PostCard media preview lane — exit 0, 1 file / 13 tests; UI type-check — exit 0.
- Shared package build — exit 0.
- Backend TypeScript typecheck and Prisma validate — exit 0.
- Owned formatting/lint checks — exit 0.

## Remaining gate

- Verify the adapter with provider credentials and budget in a controlled provider lane.
- Integrate image generation into HITL preview and add provider-backed X/Threads/Facebook native
  upload and dry-run evidence; current upload/preview path remains local/mock verified only.
- Provider, staging, native visual and production quota/cost evidence remain `VERIFY`.
