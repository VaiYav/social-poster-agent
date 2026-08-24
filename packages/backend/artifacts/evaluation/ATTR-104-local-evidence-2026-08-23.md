# ATTR-104 local evidence snapshot

Date: 2026-08-23  
Source SHA: `f95ff84a4359f209461371d2038d6647bc3ae09c` plus current dirty UI changes  
Boundary: local backend-contract/UI evidence only; no deployed zodiac-back, provider funnel, staging, production, or manual live-click evidence.

## Implemented

- Analytics now requests `GET /link-attribution/summary?days={7|30|90}`.
- The dashboard shows CTA-post count, clicks, conversions, conversion rate, degraded-link count,
  source (`zodiac` vs `utm-fallback`), delivery/network rows, and recent CTA posts.
- Revenue is explicitly displayed as unavailable until the external funnel response supplies a
  revenue field; no revenue value is inferred from conversions.
- Loading, retry, empty, and degraded-provider states are visible and non-blocking for the rest
  of Analytics.

## Local evidence

- Existing `ATTR-103` backend contract evidence: archived `link-attribution.controller.spec.ts`
  contract suite, 2 files / 16 tests, typecheck and lint checks passed.
- Full backend unit lane `pnpm exec vitest run tests/unit --reporter=dot` — exit 0,
  148 files / 1,865 tests.
- `packages/ui` full Vitest suite — exit 0, 16 files / 93 tests.
- `packages/ui` `pnpm run type-check` — exit 0.
- `packages/ui` `pnpm run build` — exit 0; Analytics bundle contains the conversion surface.
- `git diff --check` — exit 0.

## Not proven

`ATTR-104` remains `VERIFY`: no live provider response, non-zero click→conversion funnel,
revenue data, deployment, staging, production, or manual operator acceptance was run.
