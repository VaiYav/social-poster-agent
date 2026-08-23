# REFACTOR-101 network profile registry local evidence

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty worktree changes  
Boundary: local canonical profile registry and migrated consumers; no live network or transport
acceptance evidence.

## Implemented

- Added `domain/network-profiles/network-profiles.ts` with canonical char limits, tone guidance,
  angle guidance, CTA policy and permalink verification patterns for X, Threads, Facebook, Bluesky,
  Mastodon, Telegram and LinkedIn.
- `posts/network-limits.ts` derives compatibility limits from the registry.
- Generation draft/critique/refine/judge paths and network angle/CTA prompts consume the registry.
- Creative per-network persona guidance also lives in the registry; the legacy `NETWORK_PERSONA`
  generation table has been removed.
- X preflight content validation and shared BasePoster permalink verification consume the registry.

## Local evidence

- Network profile/limits/permalink/base-verification and generation regression lane — exit 0, 70 tests.
- Registry-specific lane — 2 tests included in the focused total.
- Owned formatting/lint and `git diff --check` — exit 0.

## Remaining gate

- Run full backend typecheck after the refactor under a clean resource lane; current workspace
  typecheck has repeatedly been non-terminal/OOM under concurrent processes.
- Live platform dry-run, permalink capture and network acceptance remain `VERIFY`.
