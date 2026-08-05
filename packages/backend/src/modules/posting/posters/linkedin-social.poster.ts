/**
 * LinkedIn social poster — browser automation for short-form feed updates.
 *
 * Publishes to the LinkedIn home feed via Camoufox + LLM-in-the-loop.
 * Distinct from the long-form article poster (linkedin.poster.ts) which posts
 * to https://www.linkedin.com/article/new.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { z } from 'zod';
import type { BrowserContext, Page } from '../../../domain/ports/browser-primitives.js';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { checkContentLength } from '../../posts/network-limits.js';

@Injectable()
export class LinkedinSocialPoster extends BasePoster {
  protected readonly logger = new Logger(LinkedinSocialPoster.name);
  protected readonly network = SocialNetwork.LINKEDIN;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    super(browser, configService);
  }

  async post(
    context: BrowserContext,
    _browserPort: IBrowserPort,
    content: string,
    _threadItems?: string[],
  ): Promise<PostResult> {
    const check = checkContentLength(SocialNetwork.LINKEDIN, content);
    if (!check.ok) {
      this.logger.warn(
        `LinkedIn content ${check.length} chars exceeds limit ${check.limit} — rejecting before browser session`,
      );
      return {
        error: `Content ${check.length} chars exceeds LinkedIn limit ${check.limit}`,
        retryable: false,
      };
    }

    let page: Page | null = null;
    try {
      page = await context.newPage();
      await this.browser.suppressPageErrors(page);
      this.registerCrashHandler(page, context);

      this.assertPageAlive(page, 'navigate to LinkedIn feed');
      await this.navigate(page, 'https://www.linkedin.com/feed/', 'domcontentloaded');

      if (await this.isOnLoginPage(page)) {
        this.logger.warn('LinkedIn session expired — login page detected');
        return { error: 'Not logged in — session expired, relogin needed', retryable: true };
      }

      await this.detectShadowban(page);
      await this.screenshot(page, 'before-compose');

      // Step 1: Open the share box and type the content.
      const typeResult = await this.browser.act(
        page,
        `Click the "Start a post" or "Share a post" button in the LinkedIn feed, ` +
          `then find the text editor and type the following content exactly:

${content}`,
      );
      if (!typeResult.success) {
        this.logger.warn(`LinkedIn act(type) failed: ${typeResult.error}`);
        throw new Error(`Failed to type LinkedIn post: ${typeResult.error ?? 'unknown error'}`);
      }

      // Step 2: Submit the post.
      const postResult = await this.browser.act(
        page,
        'Find and click the "Post" button to publish the LinkedIn update',
      );
      if (!postResult.success) {
        this.logger.warn(`LinkedIn act(post) failed: ${postResult.error}`);
        throw new Error(`Failed to submit LinkedIn post: ${postResult.error ?? 'unknown error'}`);
      }

      await this.browser.randomDelay(4000, 8000);
      await this.screenshot(page, 'after-submit');

      // Step 3: Extract the published post URL.
      const urlSchema = z.object({ url: z.string().url() });
      const extracted = await this.browser.extract(page, urlSchema);
      let url = extracted?.url;

      if (!url) {
        const currentUrl = page.url();
        const linkedinPattern = /(?:linkedin\.com)?\/(?:feed\/update\/urn:li:(?:activity|share|ugcPost):\d+|posts\/[^/]+\/\d+)/;
        if (linkedinPattern.test(currentUrl)) {
          url = currentUrl;
          this.logger.log(`LinkedIn post URL from page URL: ${url}`);
        }
      }

      if (!url) {
        throw new Error('Could not extract or determine LinkedIn post URL after publish');
      }

      this.logger.log(`LinkedIn post published: ${url}`);
      return { url };
    } catch (err) {
      this.logger.error(`LinkedIn post failed: ${(err as Error).message}`);
      if (page) {
        return this.withErrorHandling(
          page,
          async () => {
            throw err;
          },
          'linkedin social post',
        );
      }
      const classified = await this.classifyError(err, null, 'linkedin social post');
      return {
        error: classified.message,
        screenshotPath: classified.screenshotPath,
        retryable: classified.retryable,
      };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}
