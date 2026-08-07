/**
 * Bluesky (bsky.app) poster — browser automation for short-form posts.
 *
 * Uses Camoufox + LLM-in-the-loop (BrowserAgentService) to navigate the
 * compose page, type content, submit, and extract the post URL.
 *
 * Bluesky post limit: 300 characters (grapheme count via checkContentLength).
 *
 * Login flow: if the persisted session has expired, the poster uses
 * BLUESKY_HANDLE + BLUESKY_APP_PASSWORD to log in directly (no LLM sees
 * the password), then proceeds to the composer.
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { z } from 'zod';
import type { BrowserContext, Page, Locator } from '../../../domain/ports/browser-primitives.js';
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

      // P2-01: inline login if the session has expired. Credentials are typed
      // with direct Playwright locators so the app password is never sent to the LLM.
      if (await this.isOnLoginPage(page)) {
        this.logger.warn('Bluesky session expired — attempting login with app password');
        await this.performLogin(page);

        // Re-open the composer now that we're logged in.
        this.assertPageAlive(page, 're-navigate to Bluesky compose after login');
        await this.navigate(page, 'https://bsky.app/compose/post', 'domcontentloaded');
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

      if (url && !this.isBlueskyPostUrl(url)) {
        this.logger.warn(`Bluesky extracted URL is not a post URL: ${url}`);
        url = undefined;
      }

      if (!url) {
        const currentUrl = page.url();
        if (this.isBlueskyPostUrl(currentUrl)) {
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

  /**
   * P2-01: verify a published Bluesky post by checking the profile page.
   * Used by PostingService.findLivePostUrl for self-recovery (pre-retry duplicate check).
   */
  async verifyPosted(context: BrowserContext, content: string): Promise<string | null> {
    const handle = this.configService.get<string>('BLUESKY_HANDLE', '');
    if (!handle) {
      this.logger.warn('BLUESKY_HANDLE not set — cannot verify Bluesky post');
      return null;
    }

    const profileUrl = `https://bsky.app/profile/${handle}`;
    let page: Page | null = null;
    try {
      page = await context.newPage();
      await this.browser.suppressPageErrors(page);
      await this.browser.applyResourceBlocking(page, { blockImages: true });
      await this.navigate(page, profileUrl, 'domcontentloaded');

      const urlSchema = z
        .object({ postUrl: z.string().url() })
        .describe(
          `Find the Bluesky post on this profile page that contains this text: "${content.slice(0, 80)}". Return the post URL (https://bsky.app/profile/handle/post/...) as { postUrl: string }.`,
        );
      const extracted = await this.browser.extract(page, urlSchema);

      if (extracted?.postUrl && this.isBlueskyPostUrl(extracted.postUrl)) {
        return extracted.postUrl;
      }
      return null;
    } catch (err) {
      this.logger.warn(`Bluesky verifyPosted failed: ${(err as Error).message}`);
      return null;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  /**
   * Bluesky-specific login page detection.
   */
  protected override async isOnLoginPage(page: Page): Promise<boolean> {
    if (await super.isOnLoginPage(page)) return true;

    const blueskyLoginIndicators = [
      'input[name="identifier"]',
      'input[placeholder*="handle" i]',
      'input[placeholder*="username" i]',
      'input[placeholder*="password" i]',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
    ];

    for (const selector of blueskyLoginIndicators) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) return true;
    }
    return false;
  }

  /**
   * Log in to Bluesky using the configured handle + app password.
   * Direct Playwright selectors are used so the LLM never sees the password.
   */
  private async performLogin(page: Page): Promise<void> {
    const handle = this.configService.get<string>('BLUESKY_HANDLE', '');
    const appPassword = this.configService.get<string>('BLUESKY_APP_PASSWORD', '');

    if (!handle || !appPassword) {
      throw new Error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set for login');
    }

    // Strip @ if the operator included it in the handle.
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;

    const identifierInput = await this.findFirstVisible(page, [
      'input[name="identifier"]',
      'input[autocomplete="username"]',
      'input[placeholder*="handle" i]',
      'input[placeholder*="username" i]',
      'input[type="text"]',
    ]);
    if (!identifierInput) {
      throw new Error('Bluesky username/handle input not found');
    }
    await identifierInput.fill(cleanHandle);

    const passwordInput = await this.findFirstVisible(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[placeholder*="password" i]',
    ]);
    if (!passwordInput) {
      throw new Error('Bluesky password input not found');
    }
    await passwordInput.fill(appPassword);

    const submitButton = await this.findFirstVisible(page, [
      'button[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
      'button:has-text("Log in")',
    ]);
    if (!submitButton) {
      throw new Error('Bluesky sign-in button not found');
    }
    await submitButton.click();

    await this.browser.randomDelay(3000, 6000);

    if (await this.isOnLoginPage(page)) {
      throw new Error('Bluesky login failed — still on login page after submit');
    }
  }

  /**
   * Return the first visible Playwright Locator matching any of the selectors.
   */
  private async findFirstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) return locator;
    }
    return null;
  }

  /**
   * Bluesky post URLs are of the form https://bsky.app/profile/{handle}/post/{rkey}.
   */
  private isBlueskyPostUrl(url: string): boolean {
    return /^https?:\/\/(www\.)?bsky\.app\/profile\/[^/]+\/post\/[^/]+$/.test(url);
  }
}
