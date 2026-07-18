// Threads engager — like, comment, follow, reply, scroll.
// Uses aria-label and role-based selectors for resilience.

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Page } from '../../../domain/ports/browser-primitives';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BaseEngager } from './base.engager.js';
import type { EngagementResult } from '../../posting/posters/base.poster.js';
import { THREADS_SELECTORS } from '../../posting/posters/selectors/threads.selectors.js';
import type { SelectorStrategy } from '../../posting/posters/selector-strategy.js';

@Injectable()
export class ThreadsEngager extends BaseEngager {
  protected readonly logger = new Logger(ThreadsEngager.name);
  protected readonly network = 'THREADS' as const;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    super(browser, configService);
  }

  /**
   * Threads feeds sometimes expose auxiliary links under /post/ (e.g. permalink
   * variants with extra segments). Reject anything that is not a clean post URL.
   */
  protected isValidPostUrl(postUrl: string): boolean {
    try {
      const url = new URL(postUrl);
      return /^(\/@[^/]+\/post\/[^/]+|\/t\/[^/]+)(\?.*)?$/.test(url.pathname + url.search);
    } catch {
      return false;
    }
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, 'domcontentloaded');

      const screenshotPath = await this.screenshot(page, 'before-like');
      const { performed, alreadyLiked } = await this.performLike(
        page,
        THREADS_SELECTORS.engagement.like,
        THREADS_SELECTORS.engagement.unlike,
      );

      await this.screenshot(page, 'after-like');
      if (alreadyLiked) {
        return { success: true, screenshotPath };
      }
      if (!performed) {
        return { success: false, error: 'Like button found but state did not change', screenshotPath };
      }
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async comment(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, 'domcontentloaded');

      const screenshotPath = await this.screenshot(page, 'before-comment');
      await this.performComment(
        page,
        THREADS_SELECTORS.engagement.reply,
        THREADS_SELECTORS.engagement.replyTextarea,
        THREADS_SELECTORS.engagement.replySubmit,
        text,
      );

      await this.screenshot(page, 'after-comment');
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async follow(page: Page, handleOrUrl: string): Promise<EngagementResult> {
    try {
      // Resolve handle to URL
      const profileUrl = handleOrUrl.startsWith('http')
        ? handleOrUrl
        : `https://www.threads.com/@${handleOrUrl.replace('@', '')}`;

      await this.navigate(page, profileUrl, 'domcontentloaded');

      const screenshotPath = await this.screenshot(page, 'before-like');
      const followed = await this.performFollow(page, THREADS_SELECTORS.engagement.follow);
      await this.screenshot(page, 'after-like');

      return { success: followed, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reply(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    // Threads reply is the same as comment
    return this.comment(page, postUrl, text);
  }

  async repost(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, 'domcontentloaded');
      const screenshotPath = await this.screenshot(page, 'before-repost');
      const { performed, alreadyReposted } = await this.performRepost(
        page,
        THREADS_SELECTORS.engagement.repost,
        THREADS_SELECTORS.engagement.repostMenuRepost,
      );
      await this.screenshot(page, 'after-repost');
      if (alreadyReposted) {
        return { success: true, screenshotPath, alreadyReposted: true };
      }
      if (!performed) {
        return { success: false, error: 'Repost menu did not confirm', screenshotPath };
      }
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async quote(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, 'domcontentloaded');
      const screenshotPath = await this.screenshot(page, 'before-quote');
      await this.performQuote(
        page,
        THREADS_SELECTORS.engagement.repost,
        THREADS_SELECTORS.engagement.repostMenuQuote,
        THREADS_SELECTORS.engagement.quoteTextarea,
        THREADS_SELECTORS.engagement.quoteSubmit,
        text,
      );
      await this.screenshot(page, 'after-quote');
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Scroll the Threads feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    await this.navigate(page, THREADS_SELECTORS.feed.url, 'domcontentloaded');
    return this.doScrollFeed(page, durationSec, THREADS_SELECTORS.feed.postLink);
  }

  /**
   * Scroll an arbitrary Threads URL (hashtag, competitor profile, search).
   */
  async scrollUrl(page: Page, url: string, durationSec: number): Promise<string[]> {
    await this.navigate(page, url, 'domcontentloaded');
    return this.doScrollFeed(page, durationSec, THREADS_SELECTORS.feed.postLink);
  }

  protected getPostLinkSelector(): SelectorStrategy {
    return THREADS_SELECTORS.feed.postLink;
  }

  /**
   * Extract the visible text content of a Threads post.
   */
  async extractPostText(page: Page, postUrl: string): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    // Threads renders post text in different places depending on the page layout
    // (permalink vs modal vs feed). Try several candidate selectors and keep the
    // longest non-empty match to avoid capturing just the username or action bar.
    const textSelectors = [
      THREADS_SELECTORS.profile.postText,
      {
        css: ['div[role="article"]:first-of-type div[dir="auto"]', 'article:first-of-type div[dir="auto"]'],
      } satisfies SelectorStrategy,
      {
        css: ['div[role="article"]:first-of-type span', 'article:first-of-type span'],
      } satisfies SelectorStrategy,
    ];
    return this.doExtractPostText(page, postUrl, textSelectors, {
      css: ['div[role="article"] img', 'video'],
    });
  }

  /**
   * Open the comments thread of a Threads post to read replies.
   */
  async openCommentsThread(page: Page, postUrl: string): Promise<number> {
    return this.doOpenCommentsThread(
      page,
      postUrl,
      THREADS_SELECTORS.engagement.reply,
      { css: ['div[role="article"]', 'article'] },
    );
  }
}
