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

    while (Date.now() < endTime) {
      // Scroll down
      await this.browser.scrollPage(page, 'down', 600);
      await this.browser.screenshot(page, this.network, 'during-scroll').catch(() => {});

      // Collect post links
      try {
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
      } catch {
        // Continue scrolling even if link collection fails
      }

      // Random pause to simulate human reading
      await this.browser.randomDelay(2000, 5000);
    }

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
}
