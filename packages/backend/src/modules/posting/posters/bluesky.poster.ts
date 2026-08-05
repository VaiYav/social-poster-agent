/**
 * Bluesky (bsky.app) poster — browser automation for short-form posts.
 *
 * Uses Camoufox + LLM-in-the-loop (BrowserAgentService) to navigate the
 * compose page, type content, submit, and extract the post URL.
 *
 * Bluesky post limit: 300 characters (grapheme count via checkContentLength).
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
export class BlueskyPoster extends BasePoster {
  protected readonly logger = new Logger(BlueskyPoster.name);
  protected readonly network = SocialNetwork.BLUESKY;

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
    const check = checkContentLength(SocialNetwork.BLUESKY, content);
    if (!check.ok) {
      this.logger.warn(
        `Bluesky content ${check.length} chars exceeds limit ${check.limit} — rejecting before browser session`,
      );
      return {
        error: `Content ${check.length} chars exceeds Bluesky limit ${check.limit}`,
        retryable: false,
      };
    }

    let page: Page | null = null;
    try {
      page = await context.newPage();
      await this.browser.suppressPageErrors(page);
      this.registerCrashHandler(page, context);

      this.assertPageAlive(page, 'navigate to Bluesky compose');
      await this.navigate(page, 'https://bsky.app/compose/post', 'domcontentloaded');

      if (await this.isOnLoginPage(page)) {
        this.logger.warn('Bluesky session expired — login page detected');
        return { error: 'Not logged in — session expired, relogin needed', retryable: true };
      }

      // Best-effort shadowban/restriction detection (BasePoster only knows X/Threads/Facebook).
      await this.detectShadowban(page);

      await this.screenshot(page, 'before-compose');

      // Step 1: LLM finds the compose textarea and types the content.
      const typeResult = await this.browser.act(
        page,
        `Find the Bluesky compose text input/textarea and type the following content exactly:\n\n${content}`,
      );
      if (!typeResult.success) {
        this.logger.warn(`Bluesky act(type) failed: ${typeResult.error}`);
        throw new Error(`Failed to type Bluesky post: ${typeResult.error ?? 'unknown error'}`);
      }

      // Step 2: LLM clicks the Post button.
      const postResult = await this.browser.act(
        page,
        'Find and click the "Post" button to publish the Bluesky post',
      );
      if (!postResult.success) {
        this.logger.warn(`Bluesky act(post) failed: ${postResult.error}`);
        throw new Error(`Failed to submit Bluesky post: ${postResult.error ?? 'unknown error'}`);
      }

      await this.browser.randomDelay(3000, 6000);
      await this.screenshot(page, 'after-submit');

      // Step 3: Extract the published post URL.
      const urlSchema = z.object({ url: z.string().url() });
      const extracted = await this.browser.extract(page, urlSchema);
      let url = extracted?.url;

      if (!url) {
        const currentUrl = page.url();
        const blueskyPattern = /(?:bsky\.app|bsky\.app)?\/profile\/[^/]+\/post\/[^/]+/;
        if (blueskyPattern.test(currentUrl)) {
          url = currentUrl;
          this.logger.log(`Bluesky post URL from page URL: ${url}`);
        }
      }

      if (!url) {
        throw new Error('Could not extract or determine Bluesky post URL after publish');
      }

      this.logger.log(`Bluesky post published: ${url}`);
      return { url };
    } catch (err) {
      this.logger.error(`Bluesky post failed: ${(err as Error).message}`);
      if (page) {
        return this.withErrorHandling(
          page,
          async () => {
            throw err;
          },
          'bluesky post',
        );
      }
      const classified = await this.classifyError(err, null, 'bluesky post');
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
