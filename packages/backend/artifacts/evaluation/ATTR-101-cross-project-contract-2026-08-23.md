# ATTR-101 cross-project contract reconciliation

Date: 2026-08-23  
SPA source SHA: `c9db238`  
Boundary: local cross-repository contract and mocked adapter evidence only; no
deployed endpoint, real click, session, conversion, or revenue evidence.

## Verified locally

- SPA `ZodiacLinkClient` targets `POST /internal/attribution-links` and
  `GET /internal/attribution-links/:id/funnel`, sends
  `Authorization: Bearer $ZODIAC_INTERNAL_TOKEN`, validates the response shape,
  and falls back to direct UTM links on every failure.
- The sibling `my_zodiac_ai/back` checkout contains
  `AttributionLinksInternalController` at
  `back/src/modules/business/attribution-links/attribution-links.controller.ts`
  with the matching create and funnel routes, protected by `InternalAuthGuard`.
- Sibling attribution service/reconciler tests: 2 files / 35 tests passed.
- SPA adapter/assignment tests: 2 files / 13 tests passed.

## Remaining gate

`ATTR-101` remains `BLOCKED`: `ZODIAC_API_URL` and the shared internal token must
be configured in a deployed/staging environment, then a real tracked post must
produce non-zero click → quiz/session → conversion evidence. The sibling
checkout is dirty, so its local endpoint code is not deployment or exact-SHA
evidence.
