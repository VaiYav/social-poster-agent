// X.com (Twitter) engager — like, comment, follow, reply, scroll.
// Uses data-testid selectors (relatively stable) with fallbacks.

import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Page } from 'playwright-core';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BaseEngager } from './base.engager.js';
import type { EngagementResult } from '../../posting/posters/base.poster.js';
import { X_SELECTORS } from '../../posting/posters/selectors/x.selectors.js';

@Injectable()
export class XEngager extends BaseEngager {
  protected readonly logger = new Logger(XEngager.name);
  protected readonly network = 'X' as const;

  constructor(@Inject(IBrowserPort) browser: IBrowserPort) {
    super(browser);
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, 'domcontentloaded');

      const screenshotPath = await this.screenshot(page, 'before-like');
      const liked = await this.performLike(
        page,
        X_SELECTORS.engagement.like,
        X_SELECTORS.engagement.unlike,
      );

      await this.screenshot(page, 'after-like');

      if (!liked) {
        return { success: true, screenshotPath }; // Already liked — still success
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
        X_SELECTORS.engagement.reply,
        X_SELECTORS.engagement.replyTextarea,
        X_SELECTORS.engagement.replySubmit,
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
        : `https://x.com/${handleOrUrl.replace('@', '')}`;

      await this.navigate(page, profileUrl, 'domcontentloaded');

      const screenshotPath = await this.screenshot(page, 'before-like');
      const followed = await this.performFollow(page, X_SELECTORS.engagement.follow);
      await this.screenshot(page, 'after-like');

      return { success: followed, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reply(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    // X.com reply is the same as comment
    return this.comment(page, postUrl, text);
  }

  /**
   * Scroll the X.com feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    await this.navigate(page, X_SELECTORS.feed.url, 'domcontentloaded');
    return this.doScrollFeed(page, durationSec, X_SELECTORS.feed.tweetLink);
  }

  /**
   * Extract the visible text content of an X.com post.
   */
  async extractPostText(page: Page, postUrl: string): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    return this.doExtractPostText(page, postUrl, X_SELECTORS.feed.tweetArticle, {
      css: ['article img', 'div[data-testid="tweetPhoto"]', 'video'],
    });
  }

  /**
   * Open the comments thread of an X.com post to read replies.
   */
  async openCommentsThread(page: Page, postUrl: string): Promise<number> {
    return this.doOpenCommentsThread(
      page,
      postUrl,
      X_SELECTORS.engagement.reply,
      { css: ['article[data-testid="tweet"]', 'div[data-testid="tweetText"]'] },
    );
  }
}
