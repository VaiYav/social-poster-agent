// Browser port — abstract interface for browser automation.
// Implementation: BrowserFactory (Camoufox).
// Unit tests can inject a mock without touching real browser.

import type { BrowserContext, Locator, Page } from 'playwright-core';
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
  | 'after-submit'
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
   * Human-like click — tries normal click first, falls back to force: true
   * if Camoufox humanize blocks the action (element visible/enabled/stable but click times out).
   */
  humanClick(locator: Locator, opts?: { timeoutMs?: number }): Promise<void>;

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
}
