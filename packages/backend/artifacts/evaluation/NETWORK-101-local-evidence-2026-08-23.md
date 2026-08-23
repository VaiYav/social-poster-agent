# NETWORK-101 API-first network validation local evidence

Date: 2026-08-23  
Source SHA: `74a1e7cc5e32bb90453f2809876f840724cc6a24` plus current dirty worktree changes  
Boundary: local API transport, browser rollback and verification seams; no live provider post or
external permalink acceptance evidence.

## Implemented

- Accepted ADR-015 formalizes free official API → API and browser-only fallback where no free API
  exists.
- `BlueskyApiPoster` uses AT Protocol session/createRecord endpoints, UTF-8 byte-range link and
  mention facets, reply-chain records, synthetic dry-run output and public API permalink checks.
- `MastodonApiPoster` uses instance configuration discovery, bearer-authenticated status creation,
  visibility, reply-chain IDs, synthetic dry-run output and status verification.
- `PostingDispatcher` selects API by default for Bluesky/Mastodon and browser only when the
  corresponding `*_TRANSPORT=browser` switch is explicit. `PostingService` skips session/browser
  acquisition for API transport.
- Canonical network profiles remain the source of limits/verification patterns; API credentials
  are environment-backed and no token is persisted by the new transport.

## Local evidence

- API poster + posting regression lane — exit 0, 2 files / 49 tests.
- Full backend typecheck (`npx tsc --noEmit`) — exit 0.
- Backend lint + emitted-import validator (`pnpm lint`) — exit 0.
- Full backend unit lane — exit 0, 179 files / 2,014 tests.
- Scoped API source/test formatting — exit 0.

## Remaining gate

- Bluesky: one real API post and verified public permalink.
- Mastodon: one real instance API post and verified public permalink.
- Provider credentials, instance policy/rate limits and rollback drill remain manual/external;
  do not promote either network from `VERIFY` without separate per-network evidence.
