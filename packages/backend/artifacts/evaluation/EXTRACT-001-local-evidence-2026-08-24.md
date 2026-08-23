# EXTRACT-001 persona defaults extraction local evidence

Date: 2026-08-24
Boundary: source/config extraction and local validation; no deployment-specific persona
content was enabled by default.

## Implemented

- Removed the hardcoded `persona.defaults.ts` source surface.
- Added `PERSONA_PROFILES_PATH` configuration and a validated Markdown/JSON-frontmatter
  loader in `persona-profile-config.ts`.
- Missing configuration safely seeds no draft personas; malformed configured content
  fails closed with a path-specific validation error.
- Moved the existing deployment examples to `packages/backend/config/personas.example.md`.
- Removed the `persona.defaults.ts` branding-gate carve-out from CI.
- Updated persona and generation quality tests to load the example through the same
  configuration boundary used by runtime code.

## Local evidence

- Focused persona/config/quality suite — exit 0, 3 files / 24 tests.
- `pnpm --filter @spa/backend build` — exit 0.
- `pnpm --filter @spa/backend lint` and explicit `.js` import gate — exit 0.
- Branding leak gate from `.github/workflows/ci.yml` — exit 0.
- `pnpm planning:check` — exit 0.

## Remaining boundary

`EXTRACT-001` local source/config extraction is complete on clean SHA `462374d`.
The task remains `VERIFY` only because deployment-specific persona Markdown has not been
selected/enabled in a production environment; this evidence does not claim a production
persona rollout.
