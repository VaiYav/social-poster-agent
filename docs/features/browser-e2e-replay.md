# Feature Proposal: Browser E2E Replay Harness

## Document maturity (non-canonical)

Feature status: `BROWSER-001` in [the canonical register](../planning/FEATURES.md).

Backlog / proposal. Browser automation is not covered by real E2E tests in CI.

## Problem

The `posting`, `engagement`, `sessions`, and `replies` modules depend on live X / Threads / Facebook pages. The test suite mocks the browser, so selector drift, CAPTCHA, and third-party JS errors are only caught during `pnpm dry-run` or live runs. There is no way to record a successful dry-run and replay it in CI or during onboarding.

## Current state

- `browser.factory.ts` manages Camoufox/Firefox contexts, applies memory prefs, resource blocking, and patches `playwright-core` for Camoufox compatibility.
- Selectors are resolved through a fallback chain in `selector-health.service.ts` and concrete poster implementations (`x.poster.ts`, `threads.poster.ts`, `facebook.poster.ts`).
- E2E tests (`tests/e2e/posting-flow.e2e.spec.ts`, etc.) mock the browser and assert high-level flows, not selectors.
- `pnpm dry-run` opens a real browser and intercepts the final submit, but the result is not captured as a replay artifact.

<ref_snippet file="/Users/valentinyakovlev/projects/agents/social-poster-agent/packages/backend/src/infrastructure/browser/browser.factory.ts" lines="1-40" />

## Proposed feature

1. **Recording mode.** Add a `RECORDING_DIR` env var. During `pnpm dry-run`, the harness records:
   - Resolved selector chains per action.
   - Page URLs and navigation sequence.
   - Text input values (sanitized, no passwords).
   - Screenshot before/after each action.
   - Network errors / uncaught JS errors encountered.
   - The final intercepted post URL and HTTP status.
2. **Scenario file format.** JSONL or YAML scenario in `tests/e2e/scenarios/`, e.g.:
   ```yaml
   network: X
   url: https://x.com/compose/post
   steps:
     - action: fill
       selector: "[data-testid='tweetTextarea_0']"
       value: "Sample text"
     - action: click
       selector: "button[data-testid='tweetButtonInline']"
       expect: "https://x.com/*/status/*"
   ```
3. **Replay engine.** A `BrowserReplayService` (or extension of `BrowserFactory`) that replays recorded selectors against a headless browser in CI. Uses patched Playwright and Camoufox. On mismatch, saves a diff screenshot and logs the drift.
4. **Selector health integration.** `selector-health.service.ts` can compare recorded vs. live resolved selectors and emit a warning when a platform changed a `data-testid`.
5. **Nightly CI job.** `pnpm test:e2e:browser` runs against staging accounts, posts to a private test account, and reports drift.

## Integration points

- `infrastructure/browser/browser.factory.ts` — recording and replay hooks.
- `infrastructure/browser/browser.port.ts` — add `recordScenario()` / `replayScenario()` methods.
- `modules/posting/posters/*.poster.ts` — emit action events during dry-run.
- `tests/e2e/` — new replay-based specs.
- `packages/backend/scripts/patch-playwright.js` — keep up to date with Playwright versions.

## Open questions / risks

- Recording live sites means scenarios will break frequently; the replay engine must be tolerant to selector drift.
- Storing screenshots in CI artifacts may consume space; keep only failures and last 7 days.
- Test accounts on X/Threads/Facebook are fragile and may be suspended.
- Passwords/cookies must never be committed; use env vars and `storageState` in ephemeral CI.

## Effort estimate

**L** (3–6 weeks). Recording is relatively easy; reliable, non-flaky replay against live platforms is the hard part.

## Related reviews

- `infrastructure-browser.md`
- `posting.md`
- `engagement.md`
- `replies.md`
