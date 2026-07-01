// Browser port — abstract interface for browser automation.
// Implementation: BrowserFactory (Camoufox).
// Unit tests can inject a mock without touching real browser.

import type { BrowserContext, Locator, Page } from './browser-primitives';
import type { SocialNetwork } from '@spa/shared';

export const IBrowserPort = Symbol('IBrowserPort');

/** Scroll direction for feed browsing. */
export type ScrollDirection = 'up' | 'down';

/** Screenshot phase — used in filename for debugging. */
export type ScreenshotPhase =
  | 'before-login'
  | 'after-login'
  | 'before-compose'
  | 'after-compose'
  | 'after-type'
  | 'after-type-fallback'
  | 'after-submit'
  | 'after-submit-fallback'
  | 'after-validate'
  | 'on-error'
  | 'before-like'
  | 'after-like'
  | 'before-comment'
  | 'after-comment'
  | 'during-scroll';

export interface IBrowserPort {
  // ── Context & Session ──────────────────────────────────────────

  /**
   * Create a browser context with optional saved storageState (cookies, localStorage).
   * Used for persistent sessions — restores login state between runs.
   */
  createContext(network: SocialNetwork, storageState?: string): Promise<BrowserContext>;

  /**
   * Sprint K: Acquire a context from the pool (or create new if pool is empty).
   * Caller MUST call releaseContext() when done.
   */
  acquireContext(network: SocialNetwork, storageState?: string): Promise<BrowserContext>;

  /**
   * Sprint K: Release a context back to the pool for reuse.
   */
  releaseContext(network: SocialNetwork, context: BrowserContext): void;

  /**
   * Save storageState from a context to persist session (cookies, localStorage).
   * Returns JSON string to store in DB Session.storageState.
   */
  saveStorageState(context: BrowserContext): Promise<string>;

  // ── Human-like Actions ─────────────────────────────────────────

  /**
   * Human-like delay — random pause between actions (CONSTITUTION §9).
   */
  randomDelay(minMs?: number, maxMs?: number): Promise<void>;

  /**
   * Human-like typing — focuses element, types with per-key delay.
   * Uses pressSequentially for React-controlled inputs (fill() doesn't trigger onChange).
   */
  humanType(locator: Locator, text: string, opts?: { delayMs?: number }): Promise<void>;

  /**
   * Stealth human-like typing — types character by character via page.keyboard.type
   * with randomized per-key delay (40-120ms) and 5% chance of a "thinking" pause
   * (200-600ms). More human-like than humanType (pressSequentially with fixed delay).
   *
   * Reference: stealth-x (Youhai020616/stealth-x) typeHuman() — used for X login
   * where X's anti-bot detects uniform typing patterns.
   *
   * If a locator is provided, uses locator.pressSequentially() per character (ensures
   * focus stays on the element — needed for React-controlled inputs like X username).
   * If no locator, uses page.keyboard.type() (caller must focus element first).
   *
   * @param page - Playwright page
   * @param text - Text to type
   * @param locator - Optional locator for per-element typing (recommended for React inputs)
   */
  typeHuman(page: Page, text: string, locator?: Locator): Promise<void>;

  /**
   * Human-like click — tries normal click first, falls back to force: true
   * if Camoufox humanize blocks the action (element visible/enabled/stable but click times out).
   */
  humanClick(locator: Locator, opts?: { timeoutMs?: number }): Promise<void>;

  /**
   * Human-like hover — moves mouse to an element and pauses.
   * Used in engagement to simulate reading/considering before clicking.
   * Complements Camoufox's built-in humanize (which handles mouse movement
   * during clicks, but not standalone hovers).
   */
  hover(locator: Locator): Promise<void>;

  // ── Scrolling ──────────────────────────────────────────────────

  /**
   * Scroll the page in a direction by a given amount (in pixels).
   * Used for feed browsing and engagement sessions.
   */
  scrollPage(page: Page, direction: ScrollDirection, amountPx?: number): Promise<void>;

  /**
   * Scroll to a specific element — useful for bringing posts into view before liking/commenting.
   */
  scrollToElement(page: Page, locator: Locator): Promise<void>;

  // ── Debugging & Validation ─────────────────────────────────────

  /**
   * Capture a screenshot and save to the screenshot directory for debugging.
   * Filename: {screenshotDir}/{network}/{phase}-{timestamp}.png
   */
  screenshot(
    page: Page,
    network: SocialNetwork,
    phase: ScreenshotPhase,
  ): Promise<string>;

  /**
   * Extract visible text from an element — used for post validation
   * (checking if posted content actually appeared on profile page).
   */
  extractText(page: Page, selector: string): Promise<string | null>;

  /**
   * Wait for an element to be stable (no animations/movement) before interacting.
   * Camoufox humanize can interfere with clicks on animating elements.
   */
  waitForStable(locator: Locator, opts?: { timeoutMs?: number }): Promise<void>;

  /**
   * Dismiss any dialogs, popups, or cookie banners that might block interactions.
   */
  dismissDialogs(page: Page): Promise<void>;

  /**
   * Suppress uncaught page-side JS errors and unhandled rejections. Social feeds
   * (X, Threads, Facebook) routinely throw uncaught errors that crash Playwright
   * 1.61.1's Firefox implementation (FFPage._onUncaughtError → addPageError →
   * "Cannot read properties of undefined (reading 'url')"), which can leave the
   * page/context connection in a broken state. Call this immediately after
   * every `context.newPage()`, before navigating.
   */
  suppressPageErrors(page: Page): Promise<void>;
}
