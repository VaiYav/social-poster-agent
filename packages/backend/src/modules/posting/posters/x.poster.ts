import { Injectable, Logger, Inject } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright-core';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { X_SELECTORS } from './selectors/x.selectors.js';
import { ValidationError } from '../../../domain/errors.js';

/**
 * X.com (Twitter) poster — browser automation for posting tweets and threads.
 *
 * Flow: navigate to x.com/compose/post → type text → submit → validate URL
 * For threads: post root → reply to each subsequent post
 *
 * Uses data-testid selectors (relatively stable) with fallbacks.
 */
@Injectable()
export class XPoster extends BasePoster {
  protected readonly logger = new Logger(XPoster.name);
  protected readonly network = 'X' as const;

  constructor(@Inject(IBrowserPort) browser: IBrowserPort) {
    super(browser);
  }

  async post(
    context: BrowserContext,
    _browserPort: IBrowserPort,
    content: string,
    threadItems?: string[],
  ): Promise<PostResult> {
    const page = await context.newPage();

    try {
      // Navigate to compose page
      await this.navigate(page, X_SELECTORS.compose.url);

      // Check if logged in (redirect to login?)
      if (this.isOnLoginPage(page)) {
        return { error: 'Not logged in — session expired, relogin needed' };
      }

      // Screenshot before compose
      await this.screenshot(page, 'before-compose');

      // Type the tweet — X uses a contenteditable div, not a textarea
      const textareaResolution = await this.resolve(
        page,
        X_SELECTORS.compose.textarea,
        'compose textarea',
        15000,
      );
      await this.humanClick(textareaResolution.locator);
      await this.browser.randomDelay(1000, 3000);
      // Use keyboard.type for contenteditable (fill() doesn't work well with React)
      await this.humanType(textareaResolution.locator, content);
      await this.browser.randomDelay(1000, 2000);

      // Screenshot after typing
      await this.screenshot(page, 'after-type');

      // Submit
      const submitResolution = await this.resolve(
        page,
        X_SELECTORS.compose.submitButton,
        'tweet submit button',
        10000,
      );
      await this.browser.waitForStable(submitResolution.locator, { timeoutMs: 5000 });
      await this.humanClick(submitResolution.locator);
      await this.browser.randomDelay(3000, 8000);

      // Screenshot after submit
      await this.screenshot(page, 'after-submit');

      // Validate — X redirects to the tweet URL after posting
      const currentUrl = page.url();
      let postUrl: string;

      try {
        postUrl = this.validatePostUrl(currentUrl, X_SELECTORS.compose.postUrlPattern);
      } catch (validationErr) {
        // URL doesn't match — might still be on compose page or redirected elsewhere
        // Try to find the tweet URL in the page (sometimes X doesn't redirect immediately)
        if (validationErr instanceof ValidationError) {
          this.logger.warn(`X post URL validation failed, checking page for tweet link...`);
          // Wait a bit more for redirect
          await this.browser.randomDelay(3000, 5000);
          const retryUrl = page.url();
          if (X_SELECTORS.compose.postUrlPattern.test(retryUrl)) {
            postUrl = retryUrl;
          } else {
            throw validationErr;
          }
        } else {
          throw validationErr;
        }
      }

      this.logger.log(`Posted to X: ${postUrl}`);

      // Handle thread replies — each reply is posted as a reply to the root tweet
      if (threadItems && threadItems.length > 0 && postUrl) {
        for (const reply of threadItems) {
          await this.postReply(page, postUrl, reply);
        }
      }

      return { url: postUrl };
    } catch (err) {
      this.logger.error(`X post failed: ${(err as Error).message}`);
      return await this.withErrorHandling(page, async () => {
        throw err;
      }, 'x post');
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Post a reply in a thread — navigates to the root tweet, clicks reply,
   * types in the reply dialog, and submits.
   */
  private async postReply(
    page: Page,
    rootTweetUrl: string,
    content: string,
  ): Promise<void> {
    await this.navigate(page, rootTweetUrl);

    // Click the reply button on the root tweet
    const replyResolution = await this.resolve(
      page,
      X_SELECTORS.engagement.reply,
      'reply button',
    );
    await this.humanClick(replyResolution.locator);
    await this.browser.randomDelay(2000, 5000);

    // Reply dialog opens with a textarea
    const textareaResolution = await this.resolve(
      page,
      X_SELECTORS.engagement.replyTextarea,
      'reply textarea',
    );
    await this.humanClick(textareaResolution.locator);
    await this.browser.randomDelay(1000, 3000);
    await this.humanType(textareaResolution.locator, content);
    await this.browser.randomDelay(1000, 2000);

    // Submit reply
    const submitResolution = await this.resolve(
      page,
      X_SELECTORS.engagement.replySubmit,
      'reply submit button',
    );
    await this.humanClick(submitResolution.locator);
    await this.browser.randomDelay(3000, 8000);

    this.logger.debug(`Posted thread reply: ${content.slice(0, 30)}...`);
  }
}
