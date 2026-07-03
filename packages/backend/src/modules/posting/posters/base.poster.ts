// Base poster — abstract class with common functionality for all network posters.
// Provides: multi-fallback selector resolution, post validation, screenshots,
// error classification, human-like typing/clicking.
//
// Concrete posters (XPoster, ThreadsPoster, FacebookPoster) extend this class
// and implement the network-specific posting and engagement logic.

import { Logger } from '@nestjs/common';
import type { BrowserContext, Locator, Page } from '../../../domain/ports/browser-primitives';
import type { SocialNetwork } from '@spa/shared';
import type { IBrowserPort, ScreenshotPhase } from '../../../domain/ports/browser.port.js';
import {
  waitForSelector,
  type SelectorStrategy,
  type SelectorResolution,
} from './selector-strategy.js';
import {
  SpaError,
  SelectorNotFoundError,
  ValidationError,
  AccountRestrictedError,
  classifyPlaywrightError,
} from '../../../domain/errors.js';
import { navigateWithRetry } from '../../../domain/retry.js';

/** Result of a posting operation. */
export interface PostResult {
  url?: string;
  error?: string;
  screenshotPath?: string;
  /** P0-H2: Per-reply results for thread posting (partial failure tracking). */
  threadReplyResults?: Array<{ index: number; success: boolean; error?: string }>;
}

/** Result of an engagement operation (like, comment, follow, repost, quote). */
export interface EngagementResult {
  success: boolean;
  error?: string;
  screenshotPath?: string;
  /** True if the action was skipped because it was already done (e.g., already liked). */
  alreadyLiked?: boolean;
  /** True if the action was skipped because it was already reposted. */
  alreadyReposted?: boolean;
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
    } catch {
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
   * Stealth human-like typing — types character by character with randomized
   * per-key delay (40-120ms) and 5% chance of "thinking" pause (200-600ms).
   * More human-like than humanType — evades anti-bot typing pattern detection.
   * Used for compose textareas where stealth matters most.
   */
  protected async typeHuman(page: Page, text: string, locator?: Locator): Promise<void> {
    await this.browser.typeHuman(page, text, locator);
  }

  /**
   * Click a locator using human-like click (tries normal, falls back to force).
   */
  protected async humanClick(locator: Locator, timeoutMs = 15000): Promise<void> {
    await this.browser.humanClick(locator, { timeoutMs });
  }

  /**
   * Human-like pre-action behavior — scroll element into view, hover briefly,
   * then random short pause. Simulates a user noticing an element before acting.
   */
  protected async humanPreAction(page: Page, locator: Locator): Promise<void> {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    } catch {
      // ignore scroll failures
    }
    await this.browser.randomDelay(200, 600);
    try {
      await locator.hover({ timeout: 3000 });
    } catch {
      // hover non-critical
    }
    await this.browser.randomDelay(100, 300);
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

    // Navigate to profile — use domcontentloaded (X/Threads never reach networkidle due to polling)
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    // Wait for post elements to load — network-specific selectors
    const postContentSelector = this.getProfilePostContentSelector();
    await page.waitForSelector(postContentSelector, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Take screenshot of profile for debugging
    await this.screenshot(page, 'after-validate');

    // Check if we're still logged in (not redirected to login)
    if (page.url().includes('/login') || page.url().includes('/auth')) {
      throw new ValidationError(this.network, 'Redirected to login during validation', {
        actualUrl: page.url(),
      });
    }

    // Look for the posted content on the profile page
    // Use innerText (visible text only) — textContent includes <style> tags with CSS
    // Strip leading/trailing quotes — X may not display them
    const contentSnippet = content.slice(0, 40).trim().replace(/^["']+|["']+$/g, '');
    const pageText = await page.innerText('body').catch(() => '');

    this.logger.log(
      `${this.network} validatePostOnProfile: pageText length=${pageText?.length ?? 0}, looking for snippet="${contentSnippet}"`,
    );

    // Normalize unicode for comparison — X/Threads may convert smart quotes (U+2018/U+2019)
    // to regular quotes (U+0022/U+0027), em dashes (U+2014) to hyphens (U+002D), etc.
    const normalize = (s: string): string =>
      s
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // smart single quotes → '
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart double quotes → "
        .replace(/[\u2013\u2014]/g, '-') // en/em dashes → -
        .replace(/\u2026/g, '...') // ellipsis → ...
        .replace(/\u00A0/g, ' ') // non-breaking space → space
        .replace(/\s+/g, ' ')
        .trim();

    const normalizedSnippet = normalize(contentSnippet);
    const normalizedPageText = normalize(pageText ?? '');

    if (pageText && pageText.includes(contentSnippet)) {
      this.logger.log(`${this.network} content found on profile (exact match)`);
    } else if (normalizedPageText && normalizedPageText.includes(normalizedSnippet)) {
      this.logger.log(`${this.network} content found on profile (normalized match): "${normalizedSnippet}"`);
    } else {
      // Try without quotes — X strips leading/trailing quotes
      const noQuoteSnippet = content.replace(/^["']+|["']+$/g, '').slice(0, 30).trim();
      const normalizedNoQuote = normalize(noQuoteSnippet);
      if (normalizedPageText && normalizedPageText.includes(normalizedNoQuote)) {
        this.logger.log(`${this.network} content found without quotes (normalized): "${normalizedNoQuote}"`);
      } else {
        // Try searching in post text elements specifically (network-specific selectors)
        const postTexts = await page.locator(postContentSelector).allInnerTexts().catch(() => []);
        this.logger.log(
          `${this.network} validatePostOnProfile: ${postTexts.length} post text elements on profile, searching for snippet`,
        );
        const foundInPost = postTexts.find((t) => {
          const nt = normalize(t);
          return (
            nt.includes(normalizedSnippet) ||
            nt.includes(normalizedNoQuote) ||
            t.includes(contentSnippet) ||
            t.includes(noQuoteSnippet)
          );
        });
        if (foundInPost) {
          this.logger.log(`${this.network} content found in post text element: "${foundInPost.slice(0, 60)}..."`);
        } else {
          // Log first 3 post text elements to see what's actually on the profile
          const preview = postTexts.slice(0, 3).map((t) => `"${t.slice(0, 80)}"`).join(', ');
          this.logger.warn(`${this.network} profile post text elements (first 3): ${preview}`);
          // Log first 200 chars of page text for debugging
          this.logger.warn(
            `${this.network} content NOT found on profile. Page text preview: "${(pageText ?? '').slice(0, 200)}"`,
          );
          this.logger.warn(
            `${this.network} normalized snippet: "${normalizedSnippet}", normalized noQuote: "${normalizedNoQuote}"`,
          );
          throw new ValidationError(this.network, 'Posted content not found on profile page', {
            expectedPattern: contentSnippet,
            actualUrl: page.url(),
          });
        }
      }
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
   * Get the CSS selector for post content elements on a profile page.
   * Network-specific: X uses [data-testid="tweetText"], Threads uses [data-contents="true"] or div[dir="auto"].
   */
  private getProfilePostContentSelector(): string {
    switch (this.network) {
      case 'X':
        return '[data-testid="tweetText"], article';
      case 'THREADS':
        return 'div[data-contents="true"], div[dir="auto"], article, div[role="article"]';
      case 'FACEBOOK':
        return 'div[data-testid="post_message"], div[dir="auto"], article';
      default:
        return 'article, [data-testid="tweetText"]';
    }
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
   * Uses navigateWithRetry for resilient page loading (retries on timeout/network errors).
   * Dismisses any dialogs/popups that might appear.
   */
  protected async navigate(page: Page, url: string, waitUntil: 'networkidle' | 'domcontentloaded' = 'networkidle'): Promise<void> {
    await navigateWithRetry(page, url, {
      waitUntil,
      timeoutMs: 30000,
      maxRetries: 3,
      onRetry: (attempt, delayMs, err) => {
        this.logger.warn(
          `Navigation retry ${attempt} for ${url} after ${(err as Error).message} — waiting ${delayMs}ms`,
        );
      },
    });
    await this.browser.randomDelay(3000, 8000);
    await this.browser.dismissDialogs(page);
  }

  /**
   * Check if the current page is a login/auth page (session expired).
   *
   * Async — checks both URL pattern and DOM login indicators (X may show login
   * overlay without URL change). Uses short timeout (1s) for DOM checks to avoid
   * blocking when page is not a login page.
   */
  protected async isOnLoginPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes('/login') || url.includes('/auth') || url.includes('/login.php')) {
      return true;
    }
    // X may show login overlay without URL change — check for login indicators in DOM
    // Use short timeout — if element doesn't exist within 1s, not a login page
    const loginIndicators = [
      '[data-testid="google_sign_in_container"]',
      'input[autocomplete="username"]',
      'input[name="username_or_email"]',
      '[data-testid="LoginForm_Login_Button"]',
      // Threads login indicators
      'input[aria-label*="Username"]',
      'input[aria-label*="username"]',
      // Facebook login indicators
      '#m_login_email',
      'input[name="email"]',
    ];
    for (const selector of loginIndicators) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) return true;
    }
    return false;
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

  // ── Shadowban / Restriction Detection ──────────────────────────

  /**
   * Detect if the account is shadowbanned or restricted.
   *
   * Shadowbans are silent restrictions where posts appear to succeed but
   * are not visible to other users. Detection approaches:
   *   1. Check for restriction banners/toasts on the page
   *   2. Check for "sensitive content" warnings on the compose page
   *   3. Check URL patterns that indicate account limitations
   *
   * Called after navigation and before posting. If detected, throws
   * AccountRestrictedError so the posting service can handle it.
   */
  protected async detectShadowban(page: Page): Promise<void> {
    const url = page.url();
    const bodyText = await page.textContent('body').catch(() => '');

    // Network-specific restriction indicators
    const restrictionIndicators: Record<string, string[]> = {
      X: [
        'Account suspended',
        'Account locked',
        'Your account is temporarily limited',
        'Your account is restricted',
        'sensitive content',
        'Your Tweet could not be sent',
      ],
      THREADS: [
        'Your account has been restricted',
        'Action blocked',
        'We restrict certain activity',
        'Your account is temporarily blocked',
      ],
      FACEBOOK: [
        'Your account is temporarily unavailable',
        'You\'re temporarily restricted',
        'We restricted this account',
        'Your Page has been restricted',
        'You can\'t post right now',
        'You can not post right now',
        'temporarily blocked from posting',
      ],
    };

    const indicators = restrictionIndicators[this.network] ?? [];
    const matched = indicators.find((indicator) =>
      bodyText?.toLowerCase().includes(indicator.toLowerCase()),
    );

    if (matched) {
      this.logger.error(`Shadowban/restriction detected on ${this.network}: "${matched}"`);
      throw new AccountRestrictedError(
        this.network,
        `Account restricted on ${this.network}: ${matched} (URL: ${url})`,
      );
    }

    // Check URL patterns for restriction pages
    if (
      url.includes('/suspended') ||
      url.includes('/restricted') ||
      url.includes('/account-limited') ||
      url.includes('/appeal')
    ) {
      this.logger.error(`Restriction page detected on ${this.network}: ${url}`);
      throw new AccountRestrictedError(
        this.network,
        `Account restricted on ${this.network} (redirected to restriction page: ${url})`,
      );
    }
  }

  /**
   * Detect if a post was shadowbanned — submitted successfully but not visible.
   *
   * After posting, navigate to the post URL and check if the content is visible.
   * If the page shows "post not found" or similar, the post may have been shadowbanned.
   *
   * @returns true if the post appears to be shadowbanned, false otherwise.
   */
  protected async detectPostShadowban(page: Page, postUrl: string, expectedContent: string): Promise<boolean> {
    try {
      // P2: X/Threads never reach networkidle (constant polling) — using it here always
      // times out at 15s. Use domcontentloaded + wait for the post body to render.
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector(this.getProfilePostContentSelector(), { timeout: 8000 }).catch(() => {});
      await this.browser.randomDelay(2000, 4000);

      const bodyText = await page.textContent('body').catch(() => '');
      if (!bodyText) return false;

      // Check for "post not found" / "content unavailable" indicators
      const notFoundIndicators = [
        'post no longer available',
        'this post is no longer available',
        'content not available',
        'this content is not available',
        'post not found',
        'this post was deleted',
        'no longer exists',
      ];

      const isNotFound = notFoundIndicators.some((indicator) =>
        bodyText.toLowerCase().includes(indicator),
      );

      if (isNotFound) {
        this.logger.warn(`Post may be shadowbanned on ${this.network}: content not visible at ${postUrl}`);
        return true;
      }

      // Check if expected content is visible
      const contentSnippet = expectedContent.slice(0, 50).trim();
      if (contentSnippet && !bodyText.includes(contentSnippet)) {
        this.logger.warn(`Post content not visible on ${this.network} at ${postUrl} — possible shadowban`);
        return true;
      }

      return false;
    } catch (err) {
      this.logger.warn(`Shadowban detection failed for ${this.network}: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Sprint K: Post Verification ──────────────────────────────────

  /**
   * Sprint K: Verify that a post is actually visible on the page after posting.
   * Navigates to the post URL and checks for content visibility.
   * Subclasses can override with network-specific selectors.
   */
  protected async verifyPostVisible(page: Page, postUrl: string, expectedContent?: string): Promise<boolean> {
    try {
      // P2: X/Threads never reach networkidle (constant polling) — using it here always
      // times out and falsely reports the post as not visible. Use domcontentloaded +
      // wait for the post body to render.
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector(this.getProfilePostContentSelector(), { timeout: 10000 }).catch(() => {});
      await this.browser.randomDelay(2000, 5000);

      // Generic check: page loaded and URL matches
      if (page.url() !== postUrl && !page.url().startsWith(postUrl)) {
        this.logger.warn(`Post verification: URL mismatch (expected ${postUrl}, got ${page.url()})`);
        return false;
      }

      // If content provided, check it appears on the page
      if (expectedContent) {
        const pageText = await page.textContent('body').catch(() => '');
        if (!pageText?.includes(expectedContent.slice(0, 50))) {
          this.logger.warn(`Post verification: content not found on page`);
          return false;
        }
      }

      return true;
    } catch (err) {
      this.logger.warn(`Post verification failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Retry an operation with exponential backoff.
   * Used for thread replies and other operations that may fail transiently.
   *
   * @param operation - The operation to retry (should throw on failure)
   * @param maxRetries - Maximum number of retry attempts (default: 2)
   * @param baseDelayMs - Base delay between retries (default: 5000ms)
   * @returns The result of the operation, or throws the last error
   */
  protected async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = 2,
    baseDelayMs = 5000,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt) * (0.75 + Math.random() * 0.5);
          this.logger.warn(
            `Retry ${attempt + 1}/${maxRetries} after ${(err as Error).message} — waiting ${Math.round(delay)}ms`,
          );
          await this.browser.randomDelay(Math.round(delay * 0.75), Math.round(delay * 1.25));
        }
      }
    }
    throw lastErr;
  }

  // ── M1: idempotent verification ──────────────────────────────────

  /**
   * M1/P3: Check whether a post with the given content is already live on the account's
   * public profile. Returns the post URL if found, else null.
   *
   * Used by the posting service's self-recovery to avoid re-publishing (a duplicate) when a
   * post actually went out but success-detection misfired into a "session expired"-looking
   * error. This is a heuristic (profile + content match) — callers should additionally confirm
   * the returned URL looks like a real post URL before trusting it. Reliable permalink capture
   * is tracked as P1.
   */
  async verifyPosted(context: BrowserContext, content: string): Promise<string | null> {
    const profileUrl = this.getVerificationProfileUrl();
    if (!profileUrl) {
      this.logger.warn(`verifyPosted: no profile URL configured for ${this.network} — cannot verify`);
      return null;
    }
    let page: Page | null = null;
    try {
      page = await context.newPage();
      await this.browser.suppressPageErrors(page);
      return await this.validatePostOnProfile(page, profileUrl, content, this.getVerificationUrlPattern());
    } catch {
      // Not found / not verifiable — treat as "not posted" (caller will re-post).
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  /** Resolve the account's public profile URL for verification (from env, per network). */
  private getVerificationProfileUrl(): string | null {
    switch (this.network) {
      case 'X': {
        const handle = process.env.SOCIAL_X_USERNAME;
        return handle ? `https://x.com/${handle}` : null;
      }
      case 'THREADS': {
        const handle = process.env.SOCIAL_THREADS_USERNAME;
        return handle ? `https://www.threads.com/@${handle}` : null;
      }
      case 'FACEBOOK': {
        const slug = process.env.SOCIAL_FACEBOOK_PAGE_SLUG;
        return slug ? `https://www.facebook.com/${slug}` : null;
      }
      default:
        return null;
    }
  }

  /** Per-network regex that matches a real post URL (not a profile/home URL). */
  private getVerificationUrlPattern(): RegExp {
    switch (this.network) {
      case 'THREADS':
        // Threads profile URLs use /post/, public short links use /t/
        return /(?:\/@[^/]+\/post\/|\/t\/)[A-Za-z0-9_-]+/;
      case 'FACEBOOK':
        return /\/(posts|permalink|photos)\/\d+/;
      case 'X':
      default:
        return /\/status\/[A-Za-z0-9]+/;
    }
  }
}
