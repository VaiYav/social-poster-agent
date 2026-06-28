import { Injectable, Logger, Inject } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright-core';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { THREADS_SELECTORS } from './selectors/threads.selectors.js';
import { ValidationError, ComposeDialogError } from '../../../domain/errors.js';

/**
 * Threads (threads.net) poster — browser automation for posting.
 * Threads uses Instagram credentials (OQ-2 resolved).
 *
 * Flow: navigate to threads.net → compose dialog → type → submit → validate
 *
 * Validation: after posting, navigate to user profile and verify the post
 * appeared. Extract the post URL from the profile page.
 */
@Injectable()
export class ThreadsPoster extends BasePoster {
  protected readonly logger = new Logger(ThreadsPoster.name);
  protected readonly network = 'THREADS' as const;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      // Navigate to Threads home
      await this.navigate(page, THREADS_SELECTORS.compose.homeUrl);

      // Check if logged in
      if (await this.isOnLoginPage(page)) {
        this.logger.warn(`Threads session expired — login page detected`);
        return { error: 'Not logged in — session expired, relogin needed' };
      }

      // Detect shadowban/restriction before attempting to post
      await this.detectShadowban(page);

      // Screenshot before compose
      await this.screenshot(page, 'before-compose');

      // Click compose button — try multiple strategies
      let composeOpened = false;
      try {
        const composeResolution = await this.resolve(
          page,
          THREADS_SELECTORS.compose.composeButton,
          'compose button',
          20000,
        );
        // Human-like: scroll into view, hover, then click
        await this.humanPreAction(page, composeResolution.locator);
        await this.humanClick(composeResolution.locator, 10000);
        composeOpened = true;
      } catch (clickErr) {
        this.logger.warn(`Compose button click failed: ${(clickErr as Error).message} — trying /compose URL`);
        // Fallback: navigate directly to compose URL
        await page.goto('https://www.threads.com/compose', { waitUntil: 'networkidle', timeout: 15000 });
        composeOpened = true;
      }
      await this.browser.randomDelay(2000, 5000);

      // Screenshot after compose dialog opens
      await this.screenshot(page, 'after-compose');

      // Verify compose dialog opened — look for the textarea
      let textareaResolution;
      try {
        textareaResolution = await this.resolve(
          page,
          THREADS_SELECTORS.compose.textarea,
          'compose textarea',
          10000,
        );
      } catch {
        throw new ComposeDialogError(this.network, 'Compose dialog did not open', {
          screenshotPath: await this.screenshot(page, 'on-error'),
        });
      }

      // Type content using stealth human-like typing (typeHuman)
      // typeHuman uses randomized per-key delay (40-120ms) with 5% "thinking" pauses
      // — more human-like than humanType's fixed delay, evades anti-bot detection
      await this.typeHuman(page, content, textareaResolution.locator);
      await this.browser.randomDelay(1000, 2000);

      // Screenshot after typing
      await this.screenshot(page, 'after-type');

      // Submit — find the Post button in the dialog
      const submitResolution = await this.resolve(
        page,
        THREADS_SELECTORS.compose.submitButton,
        'post submit button',
        10000,
      );

      // Wait for button to be enabled (content entered)
      await this.browser.waitForStable(submitResolution.locator, { timeoutMs: 5000 });
      // Human-like: scroll into view, hover, then click
      await this.humanPreAction(page, submitResolution.locator);
      await this.humanClick(submitResolution.locator);
      await this.browser.randomDelay(3000, 8000);

      // Screenshot after submit
      await this.screenshot(page, 'after-submit');

      // Validate post — navigate to profile and check
      const currentUrl = page.url();
      // If we were redirected to a post URL, validate it directly
      if (THREADS_SELECTORS.compose.postUrlPattern.test(currentUrl)) {
        this.logger.log(`Threads post URL: ${currentUrl}`);

        // P0-H2: Handle thread replies with per-reply error tracking and retry
        // Human-like delay between replies (30-90s) — posting all replies instantly
        // is not human-like and may trigger Threads rate limiting.
        const replyResults: Array<{ index: number; success: boolean; error?: string }> = [];
        if (threadItems && threadItems.length > 0) {
          for (let i = 0; i < threadItems.length; i++) {
            if (i > 0) {
              this.logger.debug(`Threads: waiting before reply ${i + 1}/${threadItems.length}`);
              await this.browser.randomDelay(30000, 90000);
            }
            try {
              // Retry each reply with exponential backoff (2 attempts)
              await this.retryWithBackoff(
                () => this.postReply(page, currentUrl, threadItems[i]!),
                2,
                5000,
              );
              replyResults.push({ index: i, success: true });
            } catch (replyErr) {
              const errMsg = (replyErr as Error).message;
              this.logger.error(`Threads reply ${i + 1}/${threadItems.length} failed after retries: ${errMsg}`);
              replyResults.push({ index: i, success: false, error: errMsg });
            }
          }
        }
        return { url: currentUrl, threadReplyResults: replyResults };
      }

      // Otherwise, validate on profile page
      // Extract username from the session — we need to navigate to profile
      // Threads profile URL: https://www.threads.com/@username
      // We can get the username from the page's meta or by navigating to profile
      const profileUrl = await this.extractProfileUrl(page);
      if (!profileUrl) {
        // Can't validate — but the post might have succeeded
        // Check if we're still on the home page (post may have been silently rejected)
        if (currentUrl === THREADS_SELECTORS.compose.homeUrl) {
          throw new ValidationError(
            this.network,
            'Post was not published — still on home page after submit',
            { actualUrl: currentUrl },
          );
        }
        // Unknown state — return current URL with warning
        this.logger.warn(`Cannot extract profile URL for validation, returning current URL: ${currentUrl}`);
        return { url: currentUrl };
      }

      // Validate on profile
      const postUrl = await this.validatePostOnProfile(
        page,
        profileUrl,
        content,
        THREADS_SELECTORS.compose.postUrlPattern,
      );

      // P0-H2: Handle thread replies with per-reply error tracking and retry
      // Human-like delay between replies (30-90s)
      const replyResults: Array<{ index: number; success: boolean; error?: string }> = [];
      if (threadItems && threadItems.length > 0) {
        for (let i = 0; i < threadItems.length; i++) {
          if (i > 0) {
            this.logger.debug(`Threads: waiting before reply ${i + 1}/${threadItems.length}`);
            await this.browser.randomDelay(30000, 90000);
          }
          try {
            // Retry each reply with exponential backoff (2 attempts)
            await this.retryWithBackoff(
              () => this.postReply(page, postUrl, threadItems[i]!),
              2,
              5000,
            );
            replyResults.push({ index: i, success: true });
          } catch (replyErr) {
            const errMsg = (replyErr as Error).message;
            this.logger.error(`Threads reply ${i + 1}/${threadItems.length} failed after retries: ${errMsg}`);
            replyResults.push({ index: i, success: false, error: errMsg });
          }
        }
      }

      return { url: postUrl, threadReplyResults: replyResults };
    } catch (err) {
      this.logger.error(`Threads post failed: ${(err as Error).message}`);
      return await this.withErrorHandling(page, async () => {
        throw err;
      }, 'threads post');
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Post a reply in a Threads thread — navigates to the root post,
   * clicks reply, types in the reply dialog, and submits.
   * Uses typeHuman for stealth typing and verifies the reply was posted.
   */
  private async postReply(
    page: Page,
    rootPostUrl: string,
    content: string,
  ): Promise<void> {
    await this.navigate(page, rootPostUrl);

    // Click the reply button
    const replyResolution = await this.resolve(
      page,
      THREADS_SELECTORS.engagement.reply,
      'reply button',
    );
    await this.humanPreAction(page, replyResolution.locator);
    await this.humanClick(replyResolution.locator);
    await this.browser.randomDelay(2000, 5000);

    // Reply dialog opens with a contenteditable textarea
    const textareaResolution = await this.resolve(
      page,
      THREADS_SELECTORS.engagement.replyTextarea,
      'reply textarea',
    );
    // Use typeHuman for stealth typing (randomized per-key delay + thinking pauses)
    await this.typeHuman(page, content, textareaResolution.locator);
    await this.browser.randomDelay(1000, 2000);

    // Submit reply
    const submitResolution = await this.resolve(
      page,
      THREADS_SELECTORS.engagement.replySubmit,
      'reply submit button',
    );
    await this.humanPreAction(page, submitResolution.locator);
    await this.humanClick(submitResolution.locator);
    await this.browser.randomDelay(3000, 8000);

    // Verify reply was posted — check if content appears on the page
    const pageText = await page.textContent('body').catch(() => '');
    const contentSnippet = content.slice(0, 30).trim().replace(/^["']+|["']+$/g, '');
    if (pageText && pageText.includes(contentSnippet)) {
      this.logger.debug(`Threads reply verified on page: "${contentSnippet}..."`);
    } else {
      this.logger.warn(`Threads reply may not have posted — content not found on page after submit`);
    }

    this.logger.debug(`Posted Threads reply: ${content.slice(0, 30)}...`);
  }

  /**
   * Extract the user's profile URL from the current page.
   * Threads profile links are in the nav bar.
   */
  private async extractProfileUrl(page: Page): Promise<string | null> {
    try {
      // Look for profile link in the nav — usually an <a> with href="/@username"
      const profileLink = page.locator('a[href^="/@"]').first();
      const href = await profileLink.getAttribute('href').catch(() => null);
      if (href) {
        return `https://www.threads.com${href}`;
      }

      // Fallback: try to find username from page content
      // The profile button often has the username in aria-label
      const profileBtn = page.locator('a[aria-label*="Profile"], button[aria-label*="Profile"]').first();
      const profileHref = await profileBtn.getAttribute('href').catch(() => null);
      if (profileHref) {
        return `https://www.threads.com${profileHref}`;
      }

      return null;
    } catch {
      return null;
    }
  }
}
