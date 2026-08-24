/**
 * A3: domain-owned aliases for the browser driver's page primitives.
 *
 * This is the ONE module in the codebase that names `playwright-core`. Every
 * port, poster, and engager imports its `Page` / `Locator` / `BrowserContext` /
 * `Browser` types from here instead of from `playwright-core` directly.
 *
 * Why: it inverts the dependency (the domain owns the browser type surface) and
 * makes the driver-swap point singular. Swapping Camoufox/Playwright for another
 * driver — or introducing a hand-written `IPage` interface with a Playwright
 * adapter so posters can be exercised against a mock DOM in E2E — becomes a
 * change to THIS file, not a 16-file edit.
 *
 * For now these are structural pass-throughs of the Playwright types, so there
 * is zero behavioural change; the value is the centralised seam.
 */
export type { Browser, BrowserContext, Locator, Page } from "playwright-core";
