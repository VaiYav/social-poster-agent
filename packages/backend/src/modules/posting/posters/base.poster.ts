// Base poster — abstract class with common functionality for all network posters.
// Provides: multi-fallback selector resolution, post validation, screenshots,
// error classification, human-like typing/clicking.
//
// Concrete posters (XPoster, ThreadsPoster, FacebookPoster) extend this class
// and implement the network-specific posting and engagement logic.

import { Logger } from '@nestjs/common';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import type { SocialNetwork } from '@spa/shared';
import type { IBrowserPort, ScreenshotPhase } from '../../../domain/ports/browser.port.js';
import {
  resolveSelector,
  waitForSelector,
  type SelectorStrategy,
  type SelectorResolution,
} from './selector-strategy.js';
import {
  SpaError,
  SelectorNotFoundError,
  ValidationError,
  classifyPlaywrightError,
} from '../../../domain/errors.js';

/** Result of a posting operation. */
export interface PostResult {
  url?: string;
  error?: string;
  screenshotPath?: string;
}

/** Result of an engagement operation (like, comment, follow). */
export interface EngagementResult {
  success: boolean;
  error?: string;
  screenshotPath?: string;
}

/** Abstract base class for all network posters. */
export abstract class BasePoster {
  protected abstract readonly logger: Logger;
  protected abstract readonly network: SocialNetwork;

  constructor(protected readonly browser: IBrowserPort) {}

  // ── Selector Resolution ────────────────────────────────────────

  /**
   * Resolve a selector strategy to a Locator, with timeout.
   * Throws SelectorNotFoundError if no selector matches.
   */
  protected async resolve(
    page: Page,
    strategy: SelectorStrategy,
    context: string,
    timeoutMs = 15000,
  ): Promise<SelectorResolution> {
    try {
      const result = await waitForSelector(page, strategy, timeoutMs);
      this.logger.debug(`Selector resolved via ${result.method}: ${result.selector}`);
      return result;
    } catch (err) {
      const screenshotPath = await this.browser.screenshot(page, this.network, 'on-error');
      throw new SelectorNotFoundError(this.network, context, { screenshotPath });
    }
  }

  /**
   * Try to resolve a selector, return null if not found (no throw).
   * Useful for optional elements (e.g., "Not now" dialogs).
   */
  protected async tryResolve(
    page: Page,
    strategy: SelectorStrategy,
    timeoutMs = 3000,
  ): Promise<SelectorResolution | null> {
    try {
      return await waitForSelector(page, strategy, timeoutMs);
    } catch {
      return null;
    }
  }

  // ── Human-like Actions ─────────────────────────────────────────

  /**
   * Type text into a locator using human-like typing (pressSequentially).
   * Focuses the element first, then types with per-key delay.
   */
  protected async humanType(locator: Locator, text: string, delayMs = 50): Promise<void> {
    await this.browser.humanType(locator, text, { delayMs });
  }

  /**
   * Click a locator using human-like click (tries normal, falls back to force).
   */
  protected async humanClick(locator: Locator, timeoutMs = 15000): Promise<void> {
    await this.browser.humanClick(locator, { timeoutMs });
  }

  // ── Screenshots ────────────────────────────────────────────────

  /**
   * Capture a screenshot at a specific phase for debugging.
   */
  protected async screenshot(page: Page, phase: ScreenshotPhase): Promise<string> {
    return this.browser.screenshot(page, this.network, phase);
  }

  // ── Post Validation ────────────────────────────────────────────

  /**
   * Validate that a post was actually published by navigating to the user's profile
   * and checking if the latest post matches the content.
   *
   * @param page - The Playwright page
   * @param profileUrl - URL of the user's profile page
   * @param content - The content that was posted (to verify it appeared)
   * @param postUrlPattern - Regex to match valid post URLs
   * @returns The URL of the verified post, or throws ValidationError
   */
  protected async validatePostOnProfile(
    page: Page,
    profileUrl: string,
    content: string,
    postUrlPattern: RegExp,
  ): Promise<string> {
    await this.browser.randomDelay(3000, 6000);

    // Navigate to profile
    await page.goto(profileUrl, { waitUntil: 'networkidle' });
    await this.browser.randomDelay(3000, 8000);

    // Take screenshot of profile for debugging
    await this.screenshot(page, 'after-validate');

    // Check if we're still logged in (not redirected to login)
    if (page.url().includes('/login') || page.url().includes('/auth')) {
      throw new ValidationError(this.network, 'Redirected to login during validation', {
        actualUrl: page.url(),
      });
    }

    // Look for the posted content on the profile page
    // Use the first ~100 chars of content to match (avoid truncation issues)
    const contentSnippet = content.slice(0, 100).trim();
    const pageText = await page.textContent('body').catch(() => '');

    if (!pageText || !pageText.includes(contentSnippet)) {
      throw new ValidationError(this.network, 'Posted content not found on profile page', {
        expectedPattern: contentSnippet,
        actualUrl: page.url(),
      });
    }

    // Try to find the post URL from the profile
    // Look for links matching the post URL pattern
    const links = await page.locator(`a[href]`).all();
    for (const link of links) {
      const href = await link.getAttribute('href').catch(() => null);
      if (href && postUrlPattern.test(href)) {
        const fullUrl = href.startsWith('http') ? href : `https://www.${this.network === 'X' ? 'x.com' : this.network === 'THREADS' ? 'threads.com' : 'facebook.com'}${href}`;
        this.logger.log(`Post validated on profile: ${fullUrl}`);
        return fullUrl;
      }
    }

    // Content found on page but no post URL link — still consider it a success
    // (some networks don't show explicit post URLs on profile)
    this.logger.warn(`Content found on profile but no post URL link detected`);
    return page.url();
  }

  /**
   * Validate post by checking the current URL matches a pattern.
   * Simpler than validatePostOnProfile — used when the network redirects
   * to the post page after posting (e.g., X.com).
   */
  protected validatePostUrl(currentUrl: string, pattern: RegExp): string {
    if (pattern.test(currentUrl)) {
      return currentUrl;
    }
    throw new ValidationError(this.network, `Post URL does not match expected pattern`, {
      expectedPattern: pattern.source,
      actualUrl: currentUrl,
    });
  }

  // ── Error Handling ─────────────────────────────────────────────

  /**
   * Classify a generic error into a typed SpaError.
   * Captures a screenshot before classifying for debugging.
   */
  protected async classifyError(
    err: unknown,
    page: Page | null,
    context: string,
  ): Promise<SpaError> {
    let screenshotPath: string | undefined;
    let pageUrl: string | undefined;

    if (page) {
      try {
        screenshotPath = await this.browser.screenshot(page, this.network, 'on-error');
        pageUrl = page.url();
      } catch {
        // Screenshot failed — continue without it
      }
    }

    return classifyPlaywrightError(err, this.network, context, { screenshotPath, pageUrl });
  }

  /**
   * Wrap a posting operation with error classification.
   * Catches errors, classifies them, and returns a PostResult.
   */
  protected async withErrorHandling(
    page: Page,
    operation: () => Promise<string | undefined>,
    context: string,
  ): Promise<PostResult> {
    try {
      const url = await operation();
      return { url };
    } catch (err) {
      if (err instanceof SpaError) {
        return { error: err.message, screenshotPath: err.screenshotPath };
      }
      const classified = await this.classifyError(err, page, context);
      return { error: classified.message, screenshotPath: classified.screenshotPath };
    }
  }

  // ── Navigation ─────────────────────────────────────────────────

  /**
   * Navigate to a URL and wait for the page to load.
   * Dismisses any dialogs/popups that might appear.
   */
  protected async navigate(page: Page, url: string, waitUntil: 'networkidle' | 'domcontentloaded' = 'networkidle'): Promise<void> {
    await page.goto(url, { waitUntil });
    await this.browser.randomDelay(3000, 8000);
    await this.browser.dismissDialogs(page);
  }

  /**
   * Check if the current page is a login/auth page (session expired).
   */
  protected isOnLoginPage(page: Page): boolean {
    const url = page.url();
    return url.includes('/login') || url.includes('/auth') || url.includes('/login.php');
  }

  /**
   * Check if the current page is a captcha/challenge page.
   */
  protected isOnChallengePage(page: Page): boolean {
    const url = page.url();
    return (
      url.includes('challenge') ||
      url.includes('checkpoint') ||
      url.includes('two_factor') ||
      url.includes('2fa') ||
      url.includes('captcha')
    );
  }
}
