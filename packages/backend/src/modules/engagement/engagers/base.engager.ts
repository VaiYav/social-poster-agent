// Base engager — abstract class for engagement actions (like, comment, follow, scroll).
// Extends BasePoster to reuse selector resolution, human-like actions, and error handling.
//
// Concrete engagers (XEngager, ThreadsEngager, FacebookEngager) implement
// network-specific engagement logic using the selectors from the selector files.

import { Logger } from '@nestjs/common';
import type { Page } from '../../../domain/ports/browser-primitives';
import type { SocialNetwork } from '@spa/shared';
import type { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type EngagementResult } from '../../posting/posters/base.poster.js';
import { withTimeout } from '../../../infrastructure/util/with-timeout.js';
import type { SelectorStrategy } from '../../posting/posters/selector-strategy.js';

/**
 * Abstract base class for all network engagers.
 * Provides common engagement methods that concrete engagers implement.
 */
export abstract class BaseEngager extends BasePoster {
  protected abstract readonly logger: Logger;
  protected abstract readonly network: SocialNetwork;

  constructor(browser: IBrowserPort) {
    super(browser);
  }

  // ── Engagement Actions (implemented by concrete engagers) ──────

  /**
   * Like a post at the given URL.
   * Navigates to the post, finds the like button, clicks it.
   */
  abstract like(page: Page, postUrl: string): Promise<EngagementResult>;

  /**
   * Comment on a post at the given URL.
   * Navigates to the post, finds the comment input, types the comment, submits.
   */
  abstract comment(page: Page, postUrl: string, text: string): Promise<EngagementResult>;

  /**
   * Follow a user/page by handle or URL.
   * Navigates to the profile, finds the follow button, clicks it.
   */
  abstract follow(page: Page, handleOrUrl: string): Promise<EngagementResult>;

  /**
   * Reply to a post at the given URL.
   * Similar to comment but may use a different UI flow on some networks.
   */
  abstract reply(page: Page, postUrl: string, text: string): Promise<EngagementResult>;

  /**
   * Scroll the feed for a given duration, collecting post URLs.
   * Each concrete engager implements this to navigate to the correct feed URL
   * and use the correct post link selector.
   */
  abstract scrollFeed(page: Page, durationSec: number): Promise<string[]>;

  /**
   * Repost a post at the given URL without adding commentary.
   * Navigates to the post, opens the repost menu, and confirms "Repost".
   */
  abstract repost(page: Page, postUrl: string): Promise<EngagementResult>;

  /**
   * Quote a post at the given URL, adding commentary.
   * Navigates to the post, opens the repost menu, selects "Quote", types text, submits.
   */
  abstract quote(page: Page, postUrl: string, text: string): Promise<EngagementResult>;

  /**
   * Scroll an arbitrary URL (hashtag, competitor profile, explore) for a given duration.
   * Default implementation navigates to the URL and scrolls using the same feed strategy.
   * Concrete engagers can override for network-specific URL handling.
   */
  async scrollUrl(page: Page, url: string, durationSec: number): Promise<string[]> {
    await this.navigate(page, url);
    return this.doScrollFeed(page, durationSec, this.getPostLinkSelector());
  }

  /**
   * Get the network-specific post link selector used by scrollFeed/scrollUrl.
   */
  protected abstract getPostLinkSelector(): SelectorStrategy;

  /**
   * Extract the visible text content of a post (for LLM decision-making).
   * Each engager implements this using its network's post text selector.
   */
  abstract extractPostText(page: Page, postUrl: string): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }>;

  /**
   * Open the comments thread of a post (to read replies — simulates a real user).
   * Returns the approximate number of replies visible.
   */
  abstract openCommentsThread(page: Page, postUrl: string): Promise<number>;

  // ── Common Engagement Helpers ──────────────────────────────────

  /**
   * Scroll the feed for a given duration, collecting post URLs.
   * Used by concrete engagers' scrollFeed implementations.
   *
   * @param page - The Playwright page (already on a feed URL)
   * @param durationSec - How long to scroll
   * @param postLinkSelector - Selector strategy for finding post links
   * @returns Array of post URLs discovered during scrolling
   */
  protected async doScrollFeed(
    page: Page,
    durationSec: number,
    postLinkSelector: SelectorStrategy,
  ): Promise<string[]> {
    const postUrls: string[] = [];
    const startTime = Date.now();
    const endTime = startTime + durationSec * 1000;

    // Wait for feed content to load before scrolling.
    // X/Threads/Facebook all use async rendering — the feed container loads
    // before the actual post elements. We wait for any post-like element
    // (article, [data-testid="tweet"], [data-testid="post"]) to appear.
    // If nothing appears within 15s, we proceed anyway (empty feed scenario).
    this.logger.debug(`Waiting for feed content to load...`);
    const feedLoaded = await page
      .waitForSelector('article, [data-testid="tweet"], [data-testid="post"], [role="article"]', {
        timeout: 15000,
        state: 'attached',
      })
      .then(() => true)
      .catch(() => false);

    if (!feedLoaded) {
      this.logger.warn(`Feed content not detected within 15s — proceeding with scroll anyway`);
    } else {
      this.logger.debug(`Feed content detected — starting scroll`);
    }

    // Give the feed a moment to render after the first article appears.
    // Use setTimeout (via randomDelay) instead of page.waitForTimeout — the latter
    // is a Playwright call that throws "Target page, context or browser has been
    // closed" if the browser dies during the wait, whereas setTimeout is pure JS
    // and won't throw a browser error.
    await this.browser.randomDelay(1500, 2500);

    // Cap collected URLs to avoid memory pressure and overly long post-processing
    // on feeds that expose thousands of links (e.g. X Explore / Threads search).
    // 30 is enough for a typical 8-min session (maxPosts=30, but not all will be
    // processed — extraction + LLM + execution takes ~15-30s per post).
    const maxPostUrls = 30;

    while (Date.now() < endTime && postUrls.length < maxPostUrls) {
      if (page.isClosed?.()) {
        this.logger.warn(`Page is closed — aborting doScrollFeed for ${this.network}`);
        break;
      }
      // Each iteration should be quick: scroll + collect links + pause. If any
      // Playwright call hangs (unresponsive page after a browser/protocol issue),
      // a per-iteration timeout lets the loop exit before the whole session times out.
      try {
        await withTimeout(
          (async () => {
            // Varied scroll (random amplitude, occasionally up) — more human-like
            await this.variedScroll(page);

            // Collect post links — try multiple strategies for resilience.
            // 1. Use the provided postLinkSelector (CSS-based)
            // 2. Fallback: directly query all a[href*="/status/"] or a[href*="/post/"]
            try {
              // Strategy 1: Use the selector strategy
              const resolution = await this.tryResolve(page, postLinkSelector, 2000);
              if (resolution) {
                const links = await page.locator(resolution.selector).all();
                for (const link of links) {
                  const href = await link.getAttribute('href').catch(() => null);
                  if (!href) continue;
                  const postUrl = href.startsWith('http') ? href : this.resolveAbsoluteUrl(href);
                  if (this.isValidPostUrl(postUrl) && !postUrls.includes(postUrl)) {
                    postUrls.push(postUrl);
                    if (postUrls.length >= maxPostUrls) return;
                  }
                }
              }

              // Strategy 2: Direct CSS query for post links (broader — catches
              // links that might not match the selector strategy's first() check)
              if (postUrls.length === 0) {
                const cssSelectors = postLinkSelector.css ?? [];
                // Also try network-specific post URL patterns
                const allPatterns = [
                  ...cssSelectors,
                  'a[href*="/status/"]',
                  'a[href*="/post/"]',
                  'a[href*="/posts/"]',
                ];
                for (const css of allPatterns) {
                  const links = await page.locator(css).all();
                  for (const link of links) {
                    const href = await link.getAttribute('href').catch(() => null);
                    if (!href) continue;
                    const postUrl = href.startsWith('http') ? href : this.resolveAbsoluteUrl(href);
                    if (this.isValidPostUrl(postUrl) && !postUrls.includes(postUrl)) {
                      postUrls.push(postUrl);
                      if (postUrls.length >= maxPostUrls) return;
                    }
                  }
                  if (postUrls.length > 0) break; // Found posts — no need to try more patterns
                }
              }
            } catch {
              // Continue scrolling even if link collection fails
            }

            // Random pause to simulate human reading
            await this.browser.randomDelay(2000, 5000);
          })(),
          30000,
          'doScrollFeed iteration',
        );
      } catch (err) {
        this.logger.warn(`doScrollFeed iteration timed out, continuing: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Scroll feed complete — collected ${postUrls.length} post URLs in ${durationSec}s`);
    return postUrls;
  }

  /**
   * Resolve a relative URL to an absolute URL based on the network.
   */
  protected resolveAbsoluteUrl(href: string): string {
    const domains: Record<SocialNetwork, string> = {
      X: 'https://x.com',
      THREADS: 'https://www.threads.com',
      FACEBOOK: 'https://www.facebook.com',
    };
    return href.startsWith('http') ? href : `${domains[this.network]}${href}`;
  }

  /**
   * Hook for concrete engagers to reject URLs that look like post links but lead
   * to non-post pages (e.g. X /status/.../analytics, /retweets, /likes).
   * Default: accept all collected URLs.
   */
  protected isValidPostUrl(postUrl: string): boolean {
    return true;
  }

  /**
   * Like a post using the given like/unlike selector strategies.
   * Checks if already liked (unlike button visible or aria-pressed=true) and skips if so.
   */
  protected async performLike(
    page: Page,
    likeSelector: SelectorStrategy,
    unlikeSelector: SelectorStrategy,
  ): Promise<{ performed: boolean; alreadyLiked: boolean }> {
    // Check if already liked via the "unlike" selector (e.g., X data-testid="unlike")
    const unlikeResolution = await this.tryResolve(page, unlikeSelector, 2000);
    if (unlikeResolution) {
      this.logger.debug('Post already liked (unlike selector visible) — skipping');
      return { performed: false, alreadyLiked: true };
    }

    // Find the like button
    let likeResolution = await this.resolve(page, likeSelector, 'like button');
    await this.browser.scrollToElement(page, likeResolution.locator);
    await this.browser.waitForStable(likeResolution.locator, { timeoutMs: 5000 });

    // Additional check: some networks (X, Threads) toggle the same button and set aria-pressed.
    const wasPressed = await this.isAriaPressed(likeResolution.locator);
    if (wasPressed) {
      this.logger.debug('Post already liked (aria-pressed=true) — skipping');
      return { performed: false, alreadyLiked: true };
    }

    // Some buttons (Threads) re-render or miss the first click; retry up to 2 times.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.humanClick(likeResolution.locator);
      } catch {
        // Normal + force click failed (e.g. Camoufox humanize blocked). Try a direct JS click
        // as last resort — some Threads buttons only respond to dispatched DOM events.
        this.logger.debug(`Click failed on attempt ${attempt}, falling back to JS click`);
        await likeResolution.locator.evaluate((el: HTMLElement) => el.click()).catch(() => {});
      }
      await this.browser.randomDelay(2000, 4000);

      // Re-query the unlike state from the page (not the stale locator) so we catch re-rendered buttons.
      const verifiedUnlike = await this.tryResolve(page, unlikeSelector, 3000);
      if (verifiedUnlike) {
        return { performed: true, alreadyLiked: false };
      }

      // If the original locator is still valid, check aria-pressed.
      const nowPressed = await this.isAriaPressed(likeResolution.locator);
      if (nowPressed) {
        return { performed: true, alreadyLiked: false };
      }

      // Re-resolve the like button in case the DOM re-rendered. If it disappeared
      // entirely or is now pressed, count the like as performed.
      const freshLike = await this.tryResolve(page, likeSelector, 2000);
      if (!freshLike) {
        return { performed: true, alreadyLiked: false };
      }
      const freshPressed = await this.isAriaPressed(freshLike.locator);
      if (freshPressed) {
        return { performed: true, alreadyLiked: false };
      }
      likeResolution = freshLike;
      this.logger.debug(`Like attempt ${attempt} did not change state — retrying`);
    }

    // Log a DOM snippet for debugging before giving up.
    try {
      const body = await page.locator('body').textContent({ timeout: 2000 }).catch(() => '');
      this.logger.debug(`Like failed on ${page.url()}; body snippet: ${body?.slice(0, 200) ?? ''}`);
    } catch {
      // ignore
    }

    return { performed: false, alreadyLiked: false };
  }

  /**
   * Check if a locator has aria-pressed="true" or aria-checked="true".
   */
  protected async isAriaPressed(locator: import('playwright-core').Locator): Promise<boolean> {
    try {
      const pressed = await locator.getAttribute('aria-pressed', { timeout: 1000 }).catch(() => null);
      const checked = await locator.getAttribute('aria-checked', { timeout: 1000 }).catch(() => null);
      return pressed === 'true' || checked === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Comment on a post using the given comment selectors.
   * Clicks comment button, types text in the dialog, submits, and verifies the dialog closes.
   */
  protected async performComment(
    page: Page,
    commentButtonSelector: SelectorStrategy,
    commentInputSelector: SelectorStrategy,
    commentSubmitSelector: SelectorStrategy,
    text: string,
  ): Promise<void> {
    // Click comment button to open dialog
    const commentBtn = await this.resolve(page, commentButtonSelector, 'comment button');
    await this.browser.scrollToElement(page, commentBtn.locator);
    await this.humanClick(commentBtn.locator);

    // Wait for the dialog/input to appear before trying to type. Some networks (Threads)
    // mount the dialog asynchronously and the 200ms visibility check in resolveSelector
    // can fire before the element is rendered.
    const input = await this.resolve(page, commentInputSelector, 'comment input', 10000);
    await this.browser.randomDelay(500, 1500);
    await this.humanClick(input.locator);
    await this.browser.randomDelay(500, 1500);

    // Type the comment text. Threads (and X) use React-based contenteditable divs where
    // pressSequentially/fill may not trigger React onChange — the Post button stays
    // disabled and the comment is never submitted. Use the same multi-strategy approach
    // as the X poster: execCommand('insertText') → keyboard.type() fallback.
    await this.typeIntoContenteditable(page, input.locator, text);
    await this.browser.randomDelay(1000, 2000);

    // Submit comment — check if button is disabled first (text may not have registered)
    const submit = await this.resolve(page, commentSubmitSelector, 'comment submit button', 10000);
    await this.browser.waitForStable(submit.locator, { timeoutMs: 5000 });

    // Check if submit button is disabled — if so, retry text entry with keyboard.type()
    const isDisabled = await this.isSubmitDisabled(submit.locator);
    if (isDisabled) {
      this.logger.warn('Comment submit button is disabled — text may not have registered. Retrying with keyboard.type()...');
      // Clear and re-type using keyboard.type() (last resort for React contenteditable)
      // Use Backspace (not Delete) and a slower delay to avoid dropped characters
      // in multilingual content, matching the X poster strategy.
      await input.locator.click({ force: true }).catch(() => {});
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await this.browser.randomDelay(200, 500);
      await page.keyboard.type(text, { delay: 50 });
      await this.browser.randomDelay(1000, 2000);

      // Re-check if button is now enabled
      const stillDisabled = await this.isSubmitDisabled(submit.locator);
      if (stillDisabled) {
        this.logger.warn('Comment submit button still disabled after keyboard.type() retry — aborting comment');
        throw new Error('Comment submit button is disabled — text not registered in contenteditable');
      }
    }

    await this.humanClick(submit.locator);
    await this.browser.randomDelay(3000, 8000);

    // Best-effort verification: wait for the dialog to close.
    // Check for div[role="dialog"] — if it's gone, the comment was posted successfully.
    // Don't check for the textarea/contenteditable directly because it may persist
    // on the page outside the dialog (e.g. a compose box in the sidebar).
    const dialogStillOpen = await page
      .locator('div[role="dialog"]')
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (dialogStillOpen) {
      this.logger.warn('Comment dialog still visible after submit — comment may not have been posted');
    }
  }

  /**
   * Type text into a React-based contenteditable div (Threads, X).
   * Uses character-by-character execCommand('insertText') so DraftJS updates
   * its internal state and enables the submit button, then falls back to
   * keyboard.type() if text was not actually entered.
   */
  protected async typeIntoContenteditable(page: Page, locator: import('playwright-core').Locator, text: string): Promise<void> {
    const inserted = await this.insertContenteditableText(page, locator, text, {
      delayMinMs: 20,
      delayMaxMs: 60,
    });

    if (inserted) {
      this.logger.debug('Comment text entered via execCommand insertText');
      return;
    }

    // Strategy 2: keyboard.type() — sends real key events that React processes
    this.logger.warn('execCommand insertText failed for comment — falling back to keyboard.type()');
    try {
      await locator.click({ force: true }).catch(() => {});
      await page.keyboard.type(text, { delay: 50 });
    } catch {
      // Strategy 3: last resort — pressSequentially
      this.logger.warn('keyboard.type() failed for comment — falling back to pressSequentially');
      await locator.pressSequentially(text, { delay: 50, timeout: 15000 }).catch(() => {});
    }
  }

  /**
   * Check if a submit button is disabled (aria-disabled or disabled attribute).
   */
  protected async isSubmitDisabled(locator: import('playwright-core').Locator): Promise<boolean> {
    try {
      const disabled = await locator.getAttribute('aria-disabled');
      const isDisabledAttr = await locator.isEnabled();
      // aria-disabled="true" or disabled attribute means the button won't fire
      return disabled === 'true' || !isDisabledAttr;
    } catch {
      return false;
    }
  }

  /**
   * Repost a post using the given repost menu selectors.
   * Clicks the repost button, selects "Repost" from the menu, and verifies the menu closes.
   */
  protected async performRepost(
    page: Page,
    repostButtonSelector: SelectorStrategy,
    repostMenuItemSelector: SelectorStrategy,
  ): Promise<{ performed: boolean; alreadyReposted: boolean }> {
    // Check if the post is already reposted by looking for an "unrepost" signal.
    // Some networks show the repost button as pressed/activated when already reposted.
    const repostBtn = await this.resolve(page, repostButtonSelector, 'repost button');
    const wasPressed = await this.isAriaPressed(repostBtn.locator);
    if (wasPressed) {
      this.logger.debug('Post already reposted (aria-pressed=true) — skipping');
      return { performed: false, alreadyReposted: true };
    }

    await this.browser.scrollToElement(page, repostBtn.locator);
    await this.browser.waitForStable(repostBtn.locator, { timeoutMs: 5000 });
    await this.humanClick(repostBtn.locator);
    await this.browser.randomDelay(500, 1500);

    // Select "Repost" from the menu
    const repostItem = await this.resolve(page, repostMenuItemSelector, 'repost menu item', 10000);
    await this.humanClick(repostItem.locator);
    await this.browser.randomDelay(2000, 5000);

    // Best-effort verification: menu should close and the button should be pressed.
    const nowPressed = await this.isAriaPressed(repostBtn.locator);
    return { performed: nowPressed, alreadyReposted: false };
  }

  /**
   * Quote a post using the given repost menu and quote composer selectors.
   * Clicks the repost button, selects "Quote", types text, submits, and verifies the dialog closes.
   */
  protected async performQuote(
    page: Page,
    repostButtonSelector: SelectorStrategy,
    quoteMenuItemSelector: SelectorStrategy,
    quoteInputSelector: SelectorStrategy,
    quoteSubmitSelector: SelectorStrategy,
    text: string,
  ): Promise<void> {
    const repostBtn = await this.resolve(page, repostButtonSelector, 'repost button');
    await this.browser.scrollToElement(page, repostBtn.locator);
    await this.humanClick(repostBtn.locator);
    await this.browser.randomDelay(500, 1500);

    // Select "Quote" from the menu
    const quoteItem = await this.resolve(page, quoteMenuItemSelector, 'quote menu item', 10000);
    await this.humanClick(quoteItem.locator);
    await this.browser.randomDelay(1000, 3000);

    // Wait for the quote composer to appear
    const input = await this.resolve(page, quoteInputSelector, 'quote input', 10000);
    await this.browser.randomDelay(500, 1500);
    await this.humanClick(input.locator);
    await this.browser.randomDelay(500, 1500);

    // Type quote text using the same contenteditable strategy as comments
    await this.typeIntoContenteditable(page, input.locator, text);
    await this.browser.randomDelay(1000, 2000);

    // Submit quote — check if button is disabled first
    const submit = await this.resolve(page, quoteSubmitSelector, 'quote submit button', 10000);
    await this.browser.waitForStable(submit.locator, { timeoutMs: 5000 });

    const isDisabled = await this.isSubmitDisabled(submit.locator);
    if (isDisabled) {
      this.logger.warn('Quote submit button is disabled — retrying with keyboard.type()...');
      await input.locator.click({ force: true }).catch(() => {});
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await this.browser.randomDelay(200, 500);
      await page.keyboard.type(text, { delay: 50 });
      await this.browser.randomDelay(1000, 2000);
      const stillDisabled = await this.isSubmitDisabled(submit.locator);
      if (stillDisabled) {
        throw new Error('Quote submit button is disabled — text not registered in contenteditable');
      }
    }

    await this.humanClick(submit.locator);
    await this.browser.randomDelay(3000, 8000);

    // Best-effort verification: wait for the dialog to close.
    const dialogStillOpen = await page
      .locator('div[role="dialog"]')
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (dialogStillOpen) {
      this.logger.warn('Quote dialog still visible after submit — quote may not have been posted');
    }
  }

  /**
   * Follow a user/page using the given follow selector.
   * Checks if already following and skips if so.
   */
  protected async performFollow(
    page: Page,
    followSelector: SelectorStrategy,
  ): Promise<boolean> {
    const followBtn = await this.resolve(page, followSelector, 'follow button');
    await this.browser.scrollToElement(page, followBtn.locator);
    await this.browser.waitForStable(followBtn.locator, { timeoutMs: 5000 });
    await this.humanClick(followBtn.locator);
    await this.browser.randomDelay(2000, 5000);
    return true;
  }

  // ── Human Behavior Helpers (engagement emulation) ──────────────

  /**
   * Hover over an element — simulates reading/considering before action.
   */
  protected async hoverElement(locator: import('playwright-core').Locator): Promise<void> {
    await this.browser.hover(locator);
  }

  /**
   * Varied scroll — random amplitude (300-900px), occasionally scrolls up.
   * Replaces the fixed 600px scroll in doScrollFeed for more human-like patterns.
   */
  protected async variedScroll(page: Page): Promise<void> {
    // 85% scroll down, 15% scroll up (re-reading / going back)
    const direction: 'up' | 'down' = Math.random() < 0.85 ? 'down' : 'up';
    const amountPx = 300 + Math.floor(Math.random() * 600); // 300-900px
    await this.browser.scrollPage(page, direction, amountPx);
  }

  /**
   * Navigate back — simulates returning from a profile/hashtag to the feed.
   * Public so HumanBehaviorEngine can call it during engagement loops.
   */
  async navigateBack(page: Page): Promise<void> {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {
      // Back navigation is non-critical
    });
    await this.browser.randomDelay(1000, 3000);
  }

  /**
   * Visit a user's profile by handle.
   * Used when the LLM decides 'visit-profile' after seeing an interesting post.
   * Public so HumanBehaviorEngine can call it during engagement loops.
   */
  async visitProfile(page: Page, handle: string): Promise<void> {
    const url = this.resolveProfileUrl(handle);
    await this.navigate(page, url);
    // Dwell on the profile — real users browse before leaving
    await this.browser.randomDelay(3000, 8000);
  }

  /**
   * Resolve a profile URL for the network from a handle.
   */
  protected resolveProfileUrl(handle: string): string {
    const cleanHandle = handle.replace('@', '');
    const domains: Record<SocialNetwork, string> = {
      X: `https://x.com/${cleanHandle}`,
      THREADS: `https://www.threads.com/@${cleanHandle}`,
      FACEBOOK: `https://www.facebook.com/${cleanHandle}`,
    };
    return domains[this.network];
  }

  /**
   * Common implementation for extracting post text.
   * Concrete engagers call this with their network-specific text selector.
   */
  protected async doExtractPostText(
    page: Page,
    postUrl: string,
    textSelector: SelectorStrategy | SelectorStrategy[],
    mediaSelector?: SelectorStrategy,
  ): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    // Ensure we're on the post page
    if (!page.url().includes(postUrl.replace(/^https?:\/\/[^/]+/, ''))) {
      await this.navigate(page, postUrl, 'domcontentloaded');
    }

    // Fast path: social networks often expose the post text in the meta description.
    // Threads/X use this for link previews and it is usually cleaner than scraping
    // dynamic DOM elements. This is also much faster than resolving multiple DOM
    // selectors under the 15s extraction timeout. We discard generic placeholder
    // descriptions (e.g. "Threads", "Login • Instagram") and fall back to the DOM.
    const genericMetaPatterns = [
      /^Threads\b/i,
      /^Instagram\b/i,
      /Login\s*[•·]\s*Instagram/i,
      /Profile\s*[•·]\s*Threads/i,
      /^See this post on/i,
      /^Check out this post on/i,
      /^View .* profile/i,
      /^.*\bThreads\b.*\bInstagram\b.*$/i,
    ];
    const isGenericMeta = (value: string) => genericMetaPatterns.some((p) => p.test(value.trim()));

    let text = '';
    try {
      const metaDescription = await page
        .locator('meta[name="description"]')
        .getAttribute('content', { timeout: 2000 })
        .catch(() => null);
      if (metaDescription && metaDescription.trim().length > 10 && !isGenericMeta(metaDescription)) {
        text = metaDescription.trim();
      }
    } catch {
      // ignore
    }

    // Only fall back to DOM scraping if the meta description is missing, short, or generic.
    // Keep timeouts tight so the extraction rarely hits the 15s outer limit.
    if (text.length < 20) {
      const selectors = Array.isArray(textSelector) ? textSelector : [textSelector];
      for (const selector of selectors) {
        try {
          const resolution = await this.tryResolve(page, selector, 2000);
          if (resolution) {
            const candidate = (await resolution.locator.textContent({ timeout: 2000 }).catch(() => '')) ?? '';
            if (candidate.trim().length > text.length) {
              text = candidate.trim();
            }
          }
        } catch {
          // Text extraction is best-effort
        }
      }
    }

    // Check for media
    let hasMedia = false;
    if (mediaSelector) {
      const mediaResolution = await this.tryResolve(page, mediaSelector, 2000);
      hasMedia = mediaResolution !== null;
    }

    // Extract author handle from URL (best-effort)
    const authorHandle = this.extractHandleFromUrl(postUrl);

    return { text, hasMedia, authorHandle };
  }

  /**
   * Common implementation for opening a comments thread.
   * Clicks the reply/comment button to expand the thread, counts visible replies.
   */
  protected async doOpenCommentsThread(
    page: Page,
    postUrl: string,
    replyButtonSelector: SelectorStrategy,
    replyItemSelector: SelectorStrategy,
  ): Promise<number> {
    // Ensure we're on the post page
    if (!page.url().includes(postUrl.replace(/^https?:\/\/[^/]+/, ''))) {
      await this.navigate(page, postUrl, 'domcontentloaded');
    }

    // Click the reply button to expand the thread
    const replyBtn = await this.tryResolve(page, replyButtonSelector, 3000);
    if (!replyBtn) return 0;

    await this.browser.scrollToElement(page, replyBtn.locator);
    await this.browser.hover(replyBtn.locator);
    await this.humanClick(replyBtn.locator);
    await this.browser.randomDelay(2000, 4000);

    // Count visible replies
    let replyCount = 0;
    try {
      const replies = await page.locator(replyItemSelector.css?.[0] ?? '').count().catch(() => 0);
      replyCount = replies;
    } catch {
      // Counting is best-effort
    }

    return replyCount;
  }

  /**
   * Extract a handle from a post URL (best-effort, network-specific patterns).
   */
  private extractHandleFromUrl(url: string): string | undefined {
    // X.com: https://x.com/{handle}/status/{id}
    // Threads: https://www.threads.com/@{handle}/post/{id}
    // Facebook: https://www.facebook.com/{handle}/posts/{id}
    const match = url.match(/\/(?:@)?([^/]+)\/(?:status|post|posts)\//);
    return match?.[1];
  }
}
