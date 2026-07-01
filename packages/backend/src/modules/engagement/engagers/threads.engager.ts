// Threads engager — like, comment, follow, reply, scroll.
// Uses aria-label and role-based selectors for resilience.

import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Page } from '../../../domain/ports/browser-primitives';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BaseEngager } from './base.engager.js';
import type { EngagementResult } from '../../posting/posters/base.poster.js';
import { THREADS_SELECTORS } from '../../posting/posters/selectors/threads.selectors.js';

@Injectable()
export class ThreadsEngager extends BaseEngager {
  protected readonly logger = new Logger(ThreadsEngager.name);
  protected readonly network = 'THREADS' as const;

  constructor(@Inject(IBrowserPort) browser: IBrowserPort) {
    super(browser);
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl);

      const screenshotPath = await this.screenshot(page, 'before-like');
      await this.performLike(
        page,
        THREADS_SELECTORS.engagement.like,
        THREADS_SELECTORS.engagement.unlike,
      );

      await this.screenshot(page, 'after-like');
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async comment(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl);

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

      await this.navigate(page, profileUrl);

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

  /**
   * Scroll the Threads feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    await this.navigate(page, THREADS_SELECTORS.feed.url);
    return this.doScrollFeed(page, durationSec, THREADS_SELECTORS.feed.postLink);
  }

  /**
   * Extract the visible text content of a Threads post.
   */
  async extractPostText(page: Page, postUrl: string): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    return this.doExtractPostText(page, postUrl, THREADS_SELECTORS.profile.postText, {
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
