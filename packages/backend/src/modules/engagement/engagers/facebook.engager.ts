// Facebook engager — like, comment, follow, reply, scroll.
// Uses aria-label and role-based selectors for resilience.
// Facebook is known for aggressive A/B testing, so multi-fallback is critical.

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Page } from 'playwright-core';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BaseEngager } from './base.engager.js';
import type { EngagementResult } from '../../posting/posters/base.poster.js';
import { FACEBOOK_SELECTORS } from '../../posting/posters/selectors/facebook.selectors.js';

@Injectable()
export class FacebookEngager extends BaseEngager {
  protected readonly logger = new Logger(FacebookEngager.name);
  protected readonly network = 'FACEBOOK' as const;
  private readonly pageSlug: string;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    configService: ConfigService,
  ) {
    super(browser);
    this.pageSlug = configService.get<string>('SOCIAL_FACEBOOK_PAGE_SLUG', '');
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl);

      const screenshotPath = await this.screenshot(page, 'before-like');
      const liked = await this.performLike(
        page,
        FACEBOOK_SELECTORS.engagement.like,
        FACEBOOK_SELECTORS.engagement.unlike,
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
        FACEBOOK_SELECTORS.engagement.comment,
        FACEBOOK_SELECTORS.engagement.commentInput,
        FACEBOOK_SELECTORS.engagement.commentSubmit,
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
        : `https://www.facebook.com/${handleOrUrl}`;

      await this.navigate(page, profileUrl);

      const screenshotPath = await this.screenshot(page, 'before-like');
      const followed = await this.performFollow(page, FACEBOOK_SELECTORS.engagement.follow);
      await this.screenshot(page, 'after-like');

      return { success: followed, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reply(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    // Facebook reply to a comment is different from a page post comment.
    // For now, use the same comment flow.
    return this.comment(page, postUrl, text);
  }

  /**
   * Scroll the Facebook page feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    if (!this.pageSlug) {
      throw new Error('SOCIAL_FACEBOOK_PAGE_SLUG not configured');
    }
    await this.navigate(page, FACEBOOK_SELECTORS.feed.url(this.pageSlug));
    return this.doScrollFeed(page, durationSec, FACEBOOK_SELECTORS.feed.postLink);
  }

  /**
   * Get the Facebook page URL for feed browsing.
   */
  getPageUrl(): string {
    return FACEBOOK_SELECTORS.feed.url(this.pageSlug);
  }
}
