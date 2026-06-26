import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BrowserContext, Page } from 'playwright-core';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { FACEBOOK_SELECTORS } from './selectors/facebook.selectors.js';
import { ComposeDialogError, ValidationError } from '../../../domain/errors.js';

/**
 * Facebook poster — posts to a business page (OQ-1 resolved).
 *
 * Flow: navigate to business page → "Create post" → type → Publish → validate
 * Facebook has aggressive automation detection (CONSTITUTION §11.3 risk).
 * Uses multi-fallback selectors with getByRole/getByLabel for resilience.
 */
@Injectable()
export class FacebookPoster extends BasePoster {
  protected readonly logger = new Logger(FacebookPoster.name);
  protected readonly network = 'FACEBOOK' as const;
  private readonly pageSlug: string;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    private readonly configService: ConfigService,
  ) {
    super(browser);
    this.pageSlug = this.configService.get<string>('SOCIAL_FACEBOOK_PAGE_SLUG', '');
  }

  async post(
    context: BrowserContext,
    _browserPort: IBrowserPort,
    content: string,
  ): Promise<PostResult> {
    if (!this.pageSlug) {
      return { error: 'SOCIAL_FACEBOOK_PAGE_SLUG not configured' };
    }

    const page = await context.newPage();

    try {
      // Navigate to business page
      const pageUrl = FACEBOOK_SELECTORS.feed.url(this.pageSlug);
      await this.navigate(page, pageUrl);

      // Check if logged in
      if (this.isOnLoginPage(page)) {
        return { error: 'Not logged in — session expired, relogin needed' };
      }

      // Screenshot before compose
      await this.screenshot(page, 'before-compose');

      // Click "Create post"
      const createBtnResolution = await this.resolve(
        page,
        FACEBOOK_SELECTORS.compose.createPostButton,
        'create post button',
        20000,
      );
      await this.humanClick(createBtnResolution.locator);
      await this.browser.randomDelay(3000, 8000);

      // Screenshot after compose dialog opens
      await this.screenshot(page, 'after-compose');

      // Verify compose dialog opened — look for the textarea
      let textareaResolution;
      try {
        textareaResolution = await this.resolve(
          page,
          FACEBOOK_SELECTORS.compose.textarea,
          'compose textarea',
          10000,
        );
      } catch {
        throw new ComposeDialogError(this.network, 'Create post dialog did not open', {
          screenshotPath: await this.screenshot(page, 'on-error'),
        });
      }

      // Type content
      await this.humanType(textareaResolution.locator, content, 80);
      await this.browser.randomDelay(2000, 5000);

      // Screenshot after typing
      await this.screenshot(page, 'after-type');

      // Publish
      const publishResolution = await this.resolve(
        page,
        FACEBOOK_SELECTORS.compose.publishButton,
        'publish button',
        10000,
      );
      await this.browser.waitForStable(publishResolution.locator, { timeoutMs: 5000 });
      await this.humanClick(publishResolution.locator);
      await this.browser.randomDelay(5000, 12000);

      // Screenshot after publish
      await this.screenshot(page, 'after-submit');

      // Validate — check if post appeared on the page
      const currentUrl = page.url();

      // If URL matches post URL pattern, use it directly
      if (FACEBOOK_SELECTORS.compose.postUrlPattern.test(currentUrl)) {
        this.logger.log(`Facebook post URL: ${currentUrl}`);
        return { url: currentUrl };
      }

      // Otherwise, validate by checking the page feed for our content
      // Navigate back to the page and look for the post
      await this.navigate(page, pageUrl);

      // Check if our content appeared on the page
      const contentSnippet = content.slice(0, 100).trim();
      const pageText = await page.textContent('body').catch(() => '');

      if (pageText && pageText.includes(contentSnippet)) {
        // Content found — try to extract the post URL
        const links = await page.locator('a[href]').all();
        for (const link of links) {
          const href = await link.getAttribute('href').catch(() => null);
          if (href && FACEBOOK_SELECTORS.compose.postUrlPattern.test(href)) {
            const fullUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
            this.logger.log(`Facebook post validated on page: ${fullUrl}`);
            return { url: fullUrl };
          }
        }
        // Content found but no explicit post URL — return page URL
        this.logger.warn(`Facebook content found on page but no post URL link detected`);
        return { url: currentUrl };
      }

      // Content not found — post likely failed
      throw new ValidationError(
        this.network,
        'Post was not published — content not found on page after publish',
        { actualUrl: currentUrl },
      );
    } catch (err) {
      this.logger.error(`Facebook post failed: ${(err as Error).message}`);
      return await this.withErrorHandling(page, async () => {
        throw err;
      }, 'facebook post');
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Get the Facebook page slug for feed navigation.
   */
  getPageSlug(): string {
    return this.pageSlug;
  }

  /**
   * Get the Facebook page URL.
   */
  getPageUrl(): string {
    return FACEBOOK_SELECTORS.feed.url(this.pageSlug);
  }
}
