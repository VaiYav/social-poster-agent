// Browser port — abstract interface for browser automation.
// Implementation: BrowserFactory (Camoufox).
// Unit tests can inject a mock without touching real browser.

import type { BrowserContext, Locator, Page } from './browser-primitives.js';
import type { SocialNetwork } from '@spa/shared';
import type { ZodSchema } from 'zod';

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
  | 'before-repost'
  | 'after-repost'
  | 'before-quote'
  | 'after-quote'
  | 'during-scroll'
  | 'button-disabled-abort';

export interface IBrowserPort {
  // ── Context & Session ──────────────────────────────────────────

  /**
   * Create a browser context with optional saved storageState (cookies, localStorage).
   * Used for persistent sessions — restores login state between runs.
   */
  createContext(network: SocialNetwork, storageState?: string, accountId?: string): Promise<BrowserContext>;

  /**
   * Sprint K: Acquire a context from the pool (or create new if pool is empty).
   * Caller MUST call releaseContext() when done.
   */
  acquireContext(network: SocialNetwork, storageState?: string, accountId?: string): Promise<BrowserContext>;

  /**
   * Sprint K: Release a context back to the pool for reuse.
   */
  releaseContext(network: SocialNetwork, context: BrowserContext, accountId?: string): void;

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

  /**
   * Block heavy resource types (media, fonts, optionally images) to reduce
   * memory pressure and prevent renderer-process OOM kills on media-heavy
   * social feeds (X/Threads scroll sessions, trending scrapes, post
   * verification). Read-only operations only need text content — images and
   * video are pure memory overhead that accumulates during long scroll sessions
   * and triggers the Camoufox/Firefox OOM documented in camoufox#87.
   *
   * Call immediately after `context.newPage()` and before navigating.
   *
   * @param page - Playwright page to apply request interception on
   * @param opts.blockImages - When true, also block image requests. Set to
   *   true for read-only contexts (engagement, trending, verifyPosted) where
   *   images are not needed. Leave false for posting (visual verification may
   *   need rendered images). Media + fonts are always blocked.
   */
  applyResourceBlocking(page: Page, opts?: { blockImages?: boolean }): Promise<void>;

  // ── LLM-in-the-loop (Phase 0 stubs, Phase 1 real impl #47) ──────
  // No hardcoded CSS selectors — LLM vision resolves elements at runtime.
  // Pattern: browser-use / Stagehand / Skyvern — screenshot + DOM → LLM decides.
  // Eliminates selector drift entirely. See ROADMAP-SYNDICATION.md "LLM-in-the-loop".

  /**
   * Execute a natural-language instruction on the page via LLM vision.
   * The LLM sees a screenshot + simplified DOM, identifies the target element,
   * and performs the action (click, type, scroll, navigate).
   *
   * @example
   * await browser.act(page, 'Click the "Publish" button to publish the article');
   * await browser.act(page, 'Find the canonical URL field in settings and type the URL');
   *
   * @param page - Playwright/Camoufox page to act on
   * @param instruction - Natural-language description of the action to perform
   * @returns Action result with success status and optional metadata
   *
   * Phase 0: stub — throws "not implemented". Phase 1 (#47): real LLM engine.
   */
  act(page: Page, instruction: string): Promise<LLMActionResult>;

  /**
   * Extract structured data from the page via LLM vision.
   * The LLM sees a screenshot + DOM and returns data matching the Zod schema.
   *
   * @example
   * const url = await browser.extract(page, z.object({ canonicalUrl: z.string() }));
   *
   * @param page - Playwright/Camoufox page to extract from
   * @param schema - Zod schema describing the expected data structure
   * @returns Extracted data validated against the schema, or null on failure
   *
   * Phase 0: stub — throws "not implemented". Phase 1 (#47): real LLM engine.
   */
  extract<T>(page: Page, schema: ZodSchema<T>): Promise<T | null>;

  /**
   * Return a list of actionable elements on the page (LLM-resolved, not CSS-parsed).
   * The LLM identifies interactive elements (buttons, links, inputs) and returns
   * them with descriptions. Useful for debugging and for the agent to "see" what
   * it can do.
   *
   * @param page - Playwright/Camoufox page to observe
   * @returns List of actionable elements with descriptions
   *
   * Phase 0: stub — throws "not implemented". Phase 1 (#47): real LLM engine.
   */
  observe(page: Page): Promise<ObservableElement[]>;

  /**
   * Verify that the page is in a described state via LLM vision.
   * The LLM sees a screenshot and returns a boolean: does the page match the
   * description?
   *
   * @example
   * const isPublished = await browser.verify(page, 'Is the article published with the canonical URL set?');
   *
   * @param page - Playwright/Camoufox page to verify
   * @param stateDescription - Natural-language description of the expected state
   * @returns true if the LLM confirms the page matches the description
   *
   * Phase 0: stub — throws "not implemented". Phase 1 (#47): real LLM engine.
   */
  verify(page: Page, stateDescription: string): Promise<boolean>;
}

// ── LLM-in-the-loop result types ────────────────────────────────

/** Result of an `act()` call — whether the LLM successfully performed the action. */
export interface LLMActionResult {
  success: boolean;
  /** What the LLM did (for logging/debugging). */
  action: string;
  /** Error message if the action failed. */
  error?: string;
  /** Number of LLM iterations taken (screenshot → decide → execute loop). */
  iterations?: number;
}

/** An actionable element identified by `observe()`. */
export interface ObservableElement {
  /** Element description (e.g. "Publish button", "Title input field"). */
  description: string;
  /** Element type (button, link, input, textarea, select, etc.). */
  type: string;
  /** Whether the element is currently visible/interactable. */
  interactable: boolean;
  /** Bounding box coordinates (for debugging). */
  boundingBox?: { x: number; y: number; width: number; height: number };
}
