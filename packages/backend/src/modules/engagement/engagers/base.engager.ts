// Base engager — abstract class for engagement actions (like, comment, follow, scroll).
// Extends BasePoster to reuse selector resolution, human-like actions, and error handling.
//
// Concrete engagers (XEngager, ThreadsEngager, FacebookEngager) implement
// network-specific engagement logic using the selectors from the selector files.

import { Logger } from '@nestjs/common';
import type { Page } from 'playwright-core';
import type { SocialNetwork } from '@spa/shared';
import type { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type EngagementResult } from '../../posting/posters/base.poster.js';
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

    // Give the feed a moment to render after the first article appears
    await page.waitForTimeout(2000);

    while (Date.now() < endTime) {
      // Varied scroll (random amplitude, occasionally up) — more human-like
      await this.variedScroll(page);
      await this.browser.screenshot(page, this.network, 'during-scroll').catch(() => {});

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
            if (href && !postUrls.includes(href)) {
              postUrls.push(href.startsWith('http') ? href : this.resolveAbsoluteUrl(href));
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
              if (href && !postUrls.includes(href)) {
                postUrls.push(href.startsWith('http') ? href : this.resolveAbsoluteUrl(href));
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
   * Like a post using the given like/unlike selector strategies.
   * Checks if already liked (unlike button visible) and skips if so.
   *
   * @returns true if like was performed, false if already liked or skipped
   */
  protected async performLike(
    page: Page,
    likeSelector: SelectorStrategy,
    unlikeSelector: SelectorStrategy,
  ): Promise<boolean> {
    // Check if already liked
    const unlikeResolution = await this.tryResolve(page, unlikeSelector, 2000);
    if (unlikeResolution) {
      this.logger.debug('Post already liked — skipping');
      return false;
    }

    // Find and click the like button
    const likeResolution = await this.resolve(page, likeSelector, 'like button');
    await this.browser.scrollToElement(page, likeResolution.locator);
    await this.browser.waitForStable(likeResolution.locator, { timeoutMs: 5000 });
    await this.humanClick(likeResolution.locator);
    await this.browser.randomDelay(1000, 3000);

    // Verify like was applied (unlike button should now be visible)
    const verified = await this.tryResolve(page, unlikeSelector, 3000);
    return verified !== null;
  }

  /**
   * Comment on a post using the given comment selectors.
   * Clicks comment button, types text in the dialog, submits.
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
    await this.browser.randomDelay(2000, 5000);

    // Find comment input
    const input = await this.resolve(page, commentInputSelector, 'comment input');
    await this.humanClick(input.locator);
    await this.browser.randomDelay(1000, 3000);
    await this.humanType(input.locator, text);
    await this.browser.randomDelay(1000, 2000);

    // Submit comment
    const submit = await this.resolve(page, commentSubmitSelector, 'comment submit button');
    await this.browser.waitForStable(submit.locator, { timeoutMs: 5000 });
    await this.humanClick(submit.locator);
    await this.browser.randomDelay(3000, 8000);
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
    textSelector: SelectorStrategy,
    mediaSelector?: SelectorStrategy,
  ): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    // Ensure we're on the post page
    if (!page.url().includes(postUrl.replace(/^https?:\/\/[^/]+/, ''))) {
      await this.navigate(page, postUrl, 'domcontentloaded');
    }

    let text = '';
    try {
      const resolution = await this.tryResolve(page, textSelector, 3000);
      if (resolution) {
        text = await resolution.locator.textContent({ timeout: 3000 }).catch(() => '') ?? '';
      }
    } catch {
      // Text extraction is best-effort
    }

    // Check for media
    let hasMedia = false;
    if (mediaSelector) {
      const mediaResolution = await this.tryResolve(page, mediaSelector, 2000);
      hasMedia = mediaResolution !== null;
    }

    // Extract author handle from URL (best-effort)
    const authorHandle = this.extractHandleFromUrl(postUrl);

    return { text: text.trim(), hasMedia, authorHandle };
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
