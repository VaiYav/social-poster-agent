import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fs from 'node:fs';
import type { BrowserContext, Page, Locator } from '../../../domain/ports/browser-primitives.js';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { X_SELECTORS } from './selectors/x.selectors.js';
import { normalizePermalink } from './permalink.js';
import { ValidationError, ComposeDialogError } from '../../../domain/errors.js';
import { parseBool } from '../../../infrastructure/config/parse-bool.js';

/**
 * X.com (Twitter) poster — browser automation for posting tweets and threads.
 *
 * REFACTORED following twitter-mcp (Miles0sage/twitter-mcp) approach:
 *  - Uses fill() for contenteditable input (not pressSequentially — avoids typeahead timeout)
 *  - Uses simple click() for submit button (not humanClick with humanize delays)
 *  - Validates post by checking profile page (not URL redirect — X may open schedule dialog)
 *  - Uses .or_() pattern for resilient selector fallbacks
 *
 * Flow: navigate to x.com/compose/post → fill text → click Post → validate on profile
 * For threads: post root → reply to each subsequent post
 *
 * Reference: https://github.com/Miles0sage/twitter-mcp/blob/main/tools_write.py
 */
@Injectable()
export class XPoster extends BasePoster {
  protected readonly logger = new Logger(XPoster.name);
  protected readonly network = 'X' as const;

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
    threadItems?: string[],
  ): Promise<PostResult> {
    this.logger.log(`X post started — content length: ${content.length}, thread items: ${threadItems?.length ?? 0}`);

    // Pre-flight check: X limit is 280 chars for standard accounts.
    // If content exceeds this, the Post button will be disabled and the tweet won't publish.
    // Fail fast with a clear error instead of wasting a browser session.
    const X_CHAR_LIMIT = 280;
    if (content.length > X_CHAR_LIMIT) {
      this.logger.warn(`X content ${content.length} chars exceeds limit ${X_CHAR_LIMIT} — rejecting before browser session`);
      return { error: `Content ${content.length} chars exceeds X limit ${X_CHAR_LIMIT}`, retryable: false };
    }

    const page = await context.newPage();
    await this.browser.suppressPageErrors(page);
    // Detect renderer/page crashes so we can bail out early instead of
    // continuing to operate on a dead page (produces cryptic "Target page,
    // context or browser has been closed" errors). Closing the context
    // prevents the pool from reusing a dead browser.
    this.registerCrashHandler(page, context);

    try {
      // Primary path: use home page compose dialog (more reliable than /compose/post).
      // The /compose/post URL has a known issue where the Post button navigates to /home
      // without actually submitting the tweet. The home page compose dialog's Post button
      // is a proper submit button that triggers the X API call.
      this.logger.log(`X using home page compose dialog (primary path)...`);
      const homeResult = await this.postViaHomePageCompose(page, content);
      if (homeResult && !homeResult.error) {
        // Successfully posted via home page compose — post thread replies if needed
        if (homeResult.url && threadItems && threadItems.length > 0) {
          const replyResults = await this.postThreadReplies(page, homeResult.url, threadItems);
          return { ...homeResult, threadReplyResults: replyResults };
        }
        return homeResult;
      }
      if (homeResult?.error) {
        // Home page compose returned an error (not "null" — null means dialog couldn't open)
        this.logger.warn(`X home page compose failed: ${homeResult.error}`);
      } else if (homeResult === null) {
        this.logger.warn(`X home page compose dialog could not be opened`);
      }

      // Fallback 1a: try the profile page — some sessions get a WAF/noscript page on /home
      // but the profile page loads and the side nav "Post" button works the same way.
      const profileHandle = await this.getAccountHandleFromConfig();
      if (profileHandle) {
        this.logger.log(`X trying profile page compose dialog for @${profileHandle}...`);
        const profileResult = await this.postViaProfilePageCompose(page, content, profileHandle);
        if (profileResult && !profileResult.error) {
          if (profileResult.url && threadItems && threadItems.length > 0) {
            const replyResults = await this.postThreadReplies(page, profileResult.url, threadItems);
            return { ...profileResult, threadReplyResults: replyResults };
          }
          return profileResult;
        }
        if (profileResult?.error) {
          this.logger.warn(`X profile page compose failed: ${profileResult.error}`);
        } else {
          this.logger.warn(`X profile page compose dialog could not be opened`);
        }
      }

      // Fallback 1b: navigate to /compose/post page (legacy path)
      this.logger.log(`X navigating to compose page: ${X_SELECTORS.compose.url}`);
      this.assertPageAlive(page, 'navigate to compose page');
      await this.navigate(page, X_SELECTORS.compose.url, 'domcontentloaded');

      // Check if logged in (redirect to login or login overlay?)
      // isOnLoginPage now checks both URL and DOM login indicators (async)
      if (await this.isOnLoginPage(page)) {
        this.logger.warn(`X session expired — login page detected on compose`);
        return { error: 'Not logged in — session expired, relogin needed', retryable: true };
      }

      // Detect shadowban/restriction before attempting to post
      await this.detectShadowban(page);

      // Screenshot before compose
      await this.screenshot(page, 'before-compose');

      // Debug logging — only when SPA_DEBUG_SELECTORS env var is set
      // (avoids overhead in production while keeping diagnostic capability)
      if (parseBool(this.configService.get<string>('SPA_DEBUG_SELECTORS', 'false'))) {
        const composeHtml = await page.content().catch(() => '');
        this.logger.debug(`X compose page HTML length: ${composeHtml.length}`);
        const testIds = await page.locator('[data-testid]').evaluateAll((els) =>
          els.slice(0, 30).map((el) => ({
            testId: el.getAttribute('data-testid'),
            tag: el.tagName,
            text: el.textContent?.slice(0, 30),
          })),
        ).catch(() => []);
        this.logger.debug(`X compose page testIds: ${JSON.stringify(testIds)}`);
      }

      // ── Type the tweet ──
      // X uses a contenteditable div with DraftJS. The challenge:
      // - fill() sets DOM text but DraftJS doesn't update React state → button stays disabled
      // - keyboard.type() sends real key events that DraftJS processes, but requires focus
      // - click({ force: true }) may not properly focus the contenteditable div
      //
      // Best practice from twitter-mcp / x-mcp-bridge: use document.execCommand('insertText')
      // to fire the exact input events React/DraftJS listens to. This makes the Post button
      // genuinely enabled and causes the tweet to actually submit when clicked.
      // Fallbacks: fill() + DraftJS nudge, then keyboard.type() (last resort).
      this.assertPageAlive(page, 'type tweet content');
      let textbox = page
        .locator('[data-testid="tweetTextarea_0"]')
        .first()
        .or(page.locator('div[contenteditable="true"]').first());

      // Click to focus the textbox — try normal click first (better for focus),
      // fall back to force: true if humanize blocks it
      try {
        await textbox.click({ timeout: 10000 });
      } catch {
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      }
      await this.browser.randomDelay(500, 1000);

      // Strategy 1: human-like typing via locator.pressSequentially — fires the real key events
      // X/Lexical needs to update React state and enable the Post button.
      this.logger.log(`X typing tweet via humanType (locator.pressSequentially)...`);
      await this.setComposeText(page, textbox, content);
      await this.browser.randomDelay(500, 1000);

      // Verify content was entered
      let enteredText = await textbox.innerText().catch(() => '');
      this.logger.debug(`X after humanType — textbox content: "${enteredText.slice(0, 50)}..."`);

      // Strategy 2: if humanType didn't work, use fill() + DraftJS nudge
      // fill() sets the DOM content, then we type+delete a char to trigger DraftJS state update
      if (!enteredText || enteredText.trim().length < 10) {
        this.logger.warn(`X humanType didn't enter text — trying fill() + DraftJS nudge...`);
        await textbox.fill(content, { timeout: 10000 }).catch(() => {});
        await this.browser.randomDelay(300, 600);
        // DraftJS nudge: type a space and backspace to trigger React state update
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(' ', { delay: 50 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(500, 1000);
        enteredText = await textbox.innerText().catch(() => '');
        this.logger.debug(`X after fill() + nudge — textbox content: "${enteredText.slice(0, 50)}..."`);
      }

      // Strategy 3: if fill() didn't work either, try clipboard paste then keyboard.type() (last resort)
      if (!enteredText || enteredText.trim().length < 10) {
        this.logger.warn(`X fill() didn't enter text — trying clipboard paste...`);
        const pasted = await this.pasteContent(page, textbox, content);
        if (!pasted) {
          this.logger.warn(`X clipboard paste failed — trying keyboard.type() with slow delay...`);
          await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await this.browser.randomDelay(200, 400);
          // Use delay: 50 (not 30) to avoid dropping characters in multilingual content
          await page.keyboard.type(content, { delay: 50 });
        }
        await this.browser.randomDelay(300, 600);
        enteredText = await textbox.innerText().catch(() => '');
        this.logger.debug(`X after paste/type — textbox content: "${enteredText.slice(0, 50)}..."`);
      }

      // Screenshot after typing
      await this.screenshot(page, 'after-type');

      // ── Submit (twitter-mcp approach: simple click, not humanClick) ──
      // Multi-fallback selector strategy for the Post button:
      //   1. [data-testid="tweetButton"] — canonical X selector (compose dialog)
      //   2. [data-testid="tweetButtonInline"]:not([disabled]) — inline compose, enabled only
      //   3. getByRole('button', { name: 'Post', exact: true }) — ARIA fallback (exact match
      //      to avoid matching "Schedule post" button which also contains "Post")
      // The button may be disabled until DraftJS processes the typed content.
      // We wait for it to become enabled before clicking.
      // NOTE: Avoid :has-text("Post") — it matches "Schedule post" and other buttons.
      const postButton = page
        .locator('[data-testid="tweetButton"]')
        .first()
        .or(page.locator('[data-testid="tweetButtonInline"]:not([disabled]):not([aria-disabled="true"])').first())
        .or(page.getByRole('button', { name: 'Post', exact: true }).first());

      // Wait for the button to appear and be enabled.
      // If the button is disabled (DraftJS state not updated), retry text entry.
      let buttonVisible = await postButton.isVisible().catch(() => false);
      if (!buttonVisible) {
        this.logger.warn(`X post button not visible — retrying text entry via clipboard paste...`);
        // Try clipboard paste first (more reliable for multilingual content)
        const pasted = await this.pasteContent(page, textbox, content);
        if (!pasted) {
          // Fallback: re-focus and re-type to trigger DraftJS state update
          await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await this.browser.randomDelay(200, 500);
          // Select all existing content and replace
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await this.browser.randomDelay(200, 400);
          await page.keyboard.type(content, { delay: 50 });
        }
        await this.browser.randomDelay(800, 1500);
        buttonVisible = await postButton.isVisible().catch(() => false);
      }

      if (!buttonVisible) {
        // Fallback: navigate to home page and use the compose dialog there.
        // The /compose/post URL may be deprecated or broken for some sessions.
        this.logger.warn(`X post button still not visible — falling back to home page compose dialog...`);
        const fallbackResult = await this.postViaHomePageCompose(page, content);
        if (fallbackResult) {
          // BUG-6: the fallback posts only the root tweet. For a multi-tweet thread we must
          // post the replies here too — otherwise every threadItem is silently dropped while
          // the envelope ({ url }, no error) reports full success.
          if (!fallbackResult.error && fallbackResult.url && threadItems && threadItems.length > 0) {
            const fbReplyResults = await this.postThreadReplies(page, fallbackResult.url, threadItems);
            return { ...fallbackResult, threadReplyResults: fbReplyResults };
          }
          return fallbackResult;
        }
      }

      // Wait for the button to be enabled (not disabled)
      // DraftJS may take a moment to process the content and enable the button
      await postButton.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      // Check if button is disabled — X uses both `disabled` attribute AND `aria-disabled`
      // Playwright's isDisabled() only checks the `disabled` property, not aria-disabled.
      let isDisabled = await postButton.isDisabled().catch(() => false);
      let ariaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
      if (ariaDisabled === 'true') isDisabled = true;
      this.logger.log(`X post button disabled check: isDisabled=${isDisabled}, aria-disabled=${ariaDisabled}`);
      if (isDisabled) {
        this.logger.warn(`X post button is disabled — DraftJS state not updated. Trying fill() to force React state update...`);
        // Strategy A: fill() — Playwright sets innerText via accessibility API,
        // which properly triggers DraftJS onChange and updates React state.
        await textbox.fill(content, { timeout: 10000 }).catch(() => {});
        await this.browser.randomDelay(500, 1000);
        // DraftJS nudge: type a char and delete it to trigger state update
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(' ', { delay: 50 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(500, 1000);
        isDisabled = await postButton.isDisabled().catch(() => false);
        ariaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
        if (ariaDisabled === 'true') isDisabled = true;
        this.logger.log(`X after fill() + nudge — button disabled: ${isDisabled}, aria-disabled: ${ariaDisabled}`);
      }
      if (isDisabled) {
        // Strategy B: try clipboard paste (more reliable for multilingual content)
        this.logger.warn(`X post button still disabled after fill() — trying clipboard paste...`);
        const pasted = await this.pasteContent(page, textbox, content);
        if (!pasted) {
          // Fallback: clear and re-type via locator.pressSequentially into the focused textbox.
          // Real key events (not execCommand) are required for X/Lexical to update React state.
          this.logger.warn(`X clipboard paste failed — trying humanType (locator.pressSequentially) with slow delay...`);
          await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await this.browser.randomDelay(200, 400);
          await this.browser.humanType(textbox, content, { delayMs: 50 });
        }
        await page.waitForTimeout(1000);
        isDisabled = await postButton.isDisabled().catch(() => false);
        ariaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
        if (ariaDisabled === 'true') isDisabled = true;
        this.logger.log(`X after paste/type retry — button disabled: ${isDisabled}, aria-disabled: ${ariaDisabled}`);
      }
      if (isDisabled) {
        // Strategy D: dispatch InputEvent('beforeinput') directly into the DraftJS editor.
        // This is the event DraftJS actually processes — execCommand and fill() may insert
        // text into the DOM without triggering DraftJS's React state update in Firefox.
        // Clear the field first, then dispatch beforeinput with the full content.
        this.logger.warn(`X post button still disabled — trying direct beforeinput InputEvent dispatch...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(200, 400);
        const dispatched = await textbox.evaluate((el: HTMLElement, value: string) => {
          el.focus();
          try {
            const beforeInput = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: value,
              dataTransfer: null,
              isComposing: false,
            });
            el.dispatchEvent(beforeInput);
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              inputType: 'insertText',
              data: value,
            }));
            return true;
          } catch {
            return false;
          }
        }, content).catch(() => false);
        if (dispatched) {
          await this.browser.randomDelay(800, 1500);
          isDisabled = await postButton.isDisabled().catch(() => false);
          ariaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
          if (ariaDisabled === 'true') isDisabled = true;
          this.logger.log(`X after beforeinput dispatch — button disabled: ${isDisabled}, aria-disabled: ${ariaDisabled}`);
        }
      }
      if (isDisabled) {
        // Button is still disabled — DraftJS refuses to accept the content.
        // Do NOT force-click a disabled button — it won't submit and may navigate
        // to /home without posting, creating a false "URL changed" signal.
        this.logger.error(`X post button is disabled after all retries — DraftJS state not updated. Aborting.`);
        await this.screenshot(page, 'button-disabled-abort');
        return { error: 'Post button is disabled — DraftJS state not updated after all text entry strategies', retryable: false };
      }

      // Submit the tweet — prefer the native Ctrl+Enter (Meta+Enter) keyboard shortcut.
      // Button clicks (even human-like) are now commonly detected server-side by X and
      // redirected to /home without posting; the keyboard shortcut bypasses mouse-based
      // automation detection. Reference: x-mcp-bridge commit 4e45794.
      this.assertPageAlive(page, 'submit tweet');
      let humanClickFailed = false;
      try {
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(300, 600);
        await page.keyboard.press('Meta+Enter').catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.press('Control+Enter').catch(() => {});
        await this.browser.randomDelay(3000, 5000);
        this.logger.log(`X after Ctrl+Enter — URL: ${page.url()}`);
      } catch (submitErr) {
        this.logger.warn(`X Ctrl+Enter submit failed: ${(submitErr as Error).message}`);
        humanClickFailed = true;
      }

      // Check if the Ctrl+Enter actually submitted (URL should change away from /compose/post)
      const urlAfterSubmit = page.url();
      const stillOnCompose = urlAfterSubmit.includes('/compose/post');

      // Check if textbox is now empty or gone (sign that the tweet was submitted)
      const textboxContentAfterSubmit = await textbox.innerText().catch(() => '');
      this.logger.log(`X textbox content after submit: "${textboxContentAfterSubmit.slice(0, 60)}..." (len=${textboxContentAfterSubmit.length}), stillOnCompose: ${stillOnCompose}`);

      // Fallback 1: Ctrl+Enter didn't navigate away from /compose/post — try clicking the Post button.
      if (humanClickFailed || stillOnCompose) {
        this.logger.warn(`X Ctrl+Enter did not submit — trying humanClick on Post button...`);
        await this.humanPreAction(page, postButton);
        try {
          await this.browser.humanClick(postButton, { timeoutMs: 15000 });
          this.logger.log(`X humanClick on Post button succeeded`);
        } catch (clickErr) {
          this.logger.warn(`X humanClick on Post button failed: ${(clickErr as Error).message}`);
        }
        await this.browser.randomDelay(2000, 4000);
      }

      // If the Post button click navigated to /home without posting (known /compose/post issue),
      // try the home page compose dialog as a last resort.
      const urlAfterClick = page.url();
      const textboxContentAfterClick = await textbox.innerText().catch(() => '');
      const navigatedToHomeWithoutPosting =
        !urlAfterClick.includes('/compose/post') &&
        textboxContentAfterClick.length > 0 &&
        urlAfterClick.includes('/home');
      if (navigatedToHomeWithoutPosting) {
        this.logger.warn(`X /compose/post Post button navigated to /home without submitting — trying home page compose dialog...`);
        const homeRetry = await this.postViaHomePageCompose(page, content);
        if (homeRetry && !homeRetry.error) {
          if (homeRetry.url && threadItems && threadItems.length > 0) {
            const replyResults = await this.postThreadReplies(page, homeRetry.url, threadItems);
            return { ...homeRetry, threadReplyResults: replyResults };
          }
          return homeRetry;
        }
        this.logger.warn(`X home page compose dialog also failed — reporting failure`);
      }

      // Fallback 2: if still on compose page, try JavaScript click (last resort)
      if (page.url().includes('/compose/post')) {
        this.logger.warn(`X trying JavaScript click on Post button...`);
        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="tweetButton"]') as HTMLButtonElement;
          if (btn) btn.click();
        }).catch(() => {});
        await this.browser.randomDelay(2000, 4000);
      }

      // Screenshot after submit
      await this.screenshot(page, 'after-submit');

      const currentUrl = page.url();
      this.logger.log(`X after submit — current URL: ${currentUrl}`);

      // ── Validate post (twitter-mcp approach: check profile, not URL) ──
      // X may redirect to /home, /compose/post/schedule, or stay on compose page.
      // The tweet is usually posted regardless — we validate by checking the profile.
      let postUrl: string | undefined;

      // First try: if URL matches /status/{id} pattern, use it directly
      if (X_SELECTORS.compose.postUrlPattern.test(currentUrl)) {
        postUrl = currentUrl;
        this.logger.log(`X posted — URL matches pattern: ${postUrl}`);
      } else {
        // Second try: search page DOM for our tweet link
        const accountHandle = await this.getAccountHandle(page);
        this.logger.log(`X account handle: ${accountHandle ?? 'not found'}, current URL: ${currentUrl}`);
        const foundUrl = await this.findTweetUrlOnPage(page, accountHandle);

        if (foundUrl) {
          postUrl = foundUrl;
        } else {
          // Third try: navigate to profile and find the tweet there
          this.logger.log(`X tweet not on current page — checking profile...`);
          const handle = accountHandle ?? await this.getAccountHandleFromConfig();
          if (handle) {
            // Retry profile validation up to 3 times — X may have a delay showing new posts.
            // Break early if the page crashed/closed — retrying on a dead page is futile
            // and wastes 10-16s before the error propagates to the queue for a fresh retry.
            let lastErr: Error | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                postUrl = await this.validatePostOnProfile(
                  page,
                  `https://x.com/${handle}`,
                  content,
                  X_SELECTORS.compose.postUrlPattern,
                );
                lastErr = null;
                break;
              } catch (err) {
                lastErr = err as Error;
                this.logger.warn(`X profile validation attempt ${attempt}/3 failed: ${(err as Error).message}`);
                // Page crashed/closed — no point retrying on a dead page
                if (page.isClosed?.()) {
                  this.logger.warn(`X profile validation: page is closed — skipping remaining retries`);
                  break;
                }
                if (attempt < 3) {
                  await this.browser.randomDelay(5000, 8000);
                }
              }
            }
            if (lastErr) {
              // Profile validation failed after 3 retries — the post was NOT published.
              // Do NOT accept as "likely success" — that creates false positives and
              // marks unpublished posts as POSTED. Fail honestly so the queue can retry.
              throw lastErr;
            }
          } else {
            throw new ValidationError(this.network, 'Post URL does not match expected pattern', {
              expectedPattern: X_SELECTORS.compose.postUrlPattern.source,
              actualUrl: currentUrl,
            });
          }
        }
      }

      this.logger.log(`Posted to X: ${postUrl ?? 'unknown'}`);

      // P0-H2 / BUG-6: post thread replies via the shared helper (also used by the
      // home-page fallback, so the fallback no longer drops replies).
      const replyResults =
        threadItems && threadItems.length > 0 && postUrl
          ? await this.postThreadReplies(page, postUrl, threadItems)
          : [];

      return { url: postUrl, threadReplyResults: replyResults };
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
   * BUG-6: post each thread reply with per-reply retry + a human-like delay. Extracted so
   * BOTH the primary compose path AND the home-page fallback post the full thread — the
   * fallback previously returned after the root tweet only, silently dropping every reply.
   * Per-reply failures are recorded (not thrown) so a partial thread is reported accurately.
   */
  private async postThreadReplies(
    page: Page,
    postUrl: string,
    threadItems: string[],
  ): Promise<Array<{ index: number; success: boolean; error?: string }>> {
    const replyResults: Array<{ index: number; success: boolean; error?: string }> = [];
    for (let i = 0; i < threadItems.length; i++) {
      // Human-like delay between replies (skip before the first reply). Posting all
      // replies instantly is not human-like and may trigger X anti-bot / rate limiting.
      if (i > 0) {
        this.logger.debug(`X thread: waiting before reply ${i + 1}/${threadItems.length}`);
        await this.browser.randomDelay(30000, 90000);
      }
      try {
        // Retry each reply with exponential backoff (2 attempts); abort early if page crashed
        await this.retryWithBackoff(
          () => this.postReply(page, postUrl, threadItems[i]!),
          2,
          5000,
          () => page.isClosed?.() ?? false,
        );
        replyResults.push({ index: i, success: true });
      } catch (replyErr) {
        const errMsg = (replyErr as Error).message;
        this.logger.error(`Thread reply ${i + 1}/${threadItems.length} failed after retries: ${errMsg}`);
        replyResults.push({ index: i, success: false, error: errMsg });
      }
    }
    const succeeded = replyResults.filter((r) => r.success).length;
    const failed = replyResults.filter((r) => !r.success).length;
    this.logger.log(`Thread replies: ${succeeded} succeeded, ${failed} failed out of ${threadItems.length}`);
    return replyResults;
  }

  /**
   * Insert text into X's DraftJS contenteditable compose box using character-by-character
   * document.execCommand('insertText'). This fires the per-character `beforeinput` event
   * sequence React/DraftJS listens to, so the Post button becomes genuinely enabled and
   * the tweet is actually submitted when clicked. Falls back to the legacy per-character
   * typeHuman strategy if execCommand fails or returns false.
   */
  /**
   * Normalize text for comparison: collapse whitespace, strip leading/trailing,
   * and normalize Unicode so `innerText` and the target content can be compared
   * regardless of how the browser renders non-breaking spaces, etc.
   */
  private normalizeText(text: string): string {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .normalize('NFKC');
  }

  private async setComposeText(
    page: Page,
    textbox: Locator,
    content: string,
  ): Promise<void> {
    const target = this.normalizeText(content);
    const marker = target.slice(0, 30);
    const hasTarget = (text: string): boolean => this.normalizeText(text).includes(marker);

    // Fail fast if the compose box is not in the DOM (e.g. X /compose/post
    // page served the "JavaScript is not available" noscript fallback).
    // Without this check, pressSequentially/keyboard.type can hang forever
    // waiting on a locator that matched no elements.
    const count = await textbox.count();
    if (count === 0) {
      this.logger.warn('X setComposeText: compose textbox is not present in DOM');
      throw new ComposeDialogError(this.network, 'Compose textbox not found');
    }

    // Helper: focus the contenteditable and select all of its current contents.
    const focusAndSelect = async (): Promise<void> => {
      this.assertPageAlive(page, 'focus textbox');
      await textbox.focus({ timeout: 5000 }).catch(() => {});
      this.assertPageAlive(page, 'click textbox');
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await textbox.evaluate((el: HTMLElement) => {
        el.focus();
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          // ignore
        }
      }, { timeout: 5000 }).catch(() => {});
      await this.browser.randomDelay(150, 300);
    };

    // Helper: clear the textbox via DOM so the next strategy starts from a
    // blank state (humanType does not select all before typing).
    const clearTextbox = async (): Promise<void> => {
      this.assertPageAlive(page, 'clear textbox');
      await textbox.evaluate((el: HTMLElement) => {
        el.focus();
        el.textContent = '';
        el.innerText = '';
        try {
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.addRange(range);
          }
        } catch {
          // ignore
        }
      }, { timeout: 5000 }).catch(() => {});
    };

    // Strategy 1: real key events via locator.pressSequentially.
    // X's composer (Lexical/DraftJS) only enables the Post button when it
    // processes the genuine beforeinput/input sequence produced by real key
    // events. Synthetic paste/execCommand/beforeinput dispatch leaves the DOM
    // text visible but the React editor state empty, so the button stays disabled.
    // focusAndSelect ensures any existing placeholder/content is replaced.
    this.logger.log('X setComposeText: typing via pressSequentially...');
    try {
      await focusAndSelect();
      this.assertPageAlive(page, 'pressSequentially');
      await textbox.pressSequentially(content, { delay: 30, timeout: 30000 });
      await this.browser.randomDelay(500, 800);
      const typedText = await textbox.innerText().catch(() => '');
      if (hasTarget(typedText)) {
        this.logger.debug('X setComposeText via pressSequentially succeeded');
        return;
      }
    } catch (err) {
      this.logger.debug(
        `X setComposeText pressSequentially failed: ${(err as Error).message}`,
      );
    }

    // Strategy 2: fallback to browser-port humanType (focus + click + pressSequentially
    // with a short timeout, then fill). Uses the same real key events, but the
    // port's implementation adds timeouts that prevent hanging on a dead page.
    this.logger.warn(
      'X pressSequentially failed — falling back to browser.humanType',
    );
    try {
      await clearTextbox();
      this.assertPageAlive(page, 'humanType');
      await this.browser.humanType(textbox, content, { delayMs: 30 });
      await this.browser.randomDelay(500, 800);
      const typedText = await textbox.innerText().catch(() => '');
      if (hasTarget(typedText)) {
        this.logger.debug('X setComposeText via humanType succeeded');
        return;
      }
    } catch (err) {
      this.logger.debug(
        `X setComposeText humanType failed: ${(err as Error).message}`,
      );
    }

    // Strategy 3: synthetic paste event. May insert text but usually does not
    // update the React editor state; kept only as a last resort for content
    // that cannot be typed (e.g. certain Unicode edge cases).
    this.logger.warn('X key typing failed — falling back to pasteContent');
    this.assertPageAlive(page, 'pasteContent');
    const pasted = await this.pasteContent(page, textbox, content);
    if (pasted) {
      const enteredText = await textbox.innerText().catch(() => '');
      if (hasTarget(enteredText)) {
        this.logger.debug('X setComposeText via pasteContent succeeded');
        return;
      }
    }

    throw new ComposeDialogError(this.network, 'Could not enter text into compose box');
  }

  /**
   * Paste content into the compose textbox via a synthetic clipboard paste event.
   * Modeled after wingman-x's fillReplyComposer: selects all contents, dispatches
   * a ClipboardEvent with the text, and checks that the editor handled the event
   * (preventDefault) and that the final text actually contains the target content.
   *
   * Falls back to document.execCommand('insertText') if the editor did not handle
   * the synthetic paste.
   *
   * @returns true if the textbox contains the target content, false otherwise.
   */
  private async pasteContent(page: Page, textbox: Locator, content: string): Promise<boolean> {
    try {
      const target = this.normalizeText(content);
      const marker = target.slice(0, 30);
      const hasTarget = (text: string): boolean =>
        this.normalizeText(text).includes(marker);

      await textbox.focus({ timeout: 5000 }).catch(() => {});
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await textbox.evaluate((el: HTMLElement) => {
        el.focus();
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          // ignore
        }
      }).catch(() => {});
      await this.browser.randomDelay(150, 300);

      const result = await textbox.evaluate(
        (el: HTMLElement, text: string) => {
          return new Promise<{ cancelled: boolean; afterText: string }>(
            (resolve) => {
              const dt = new DataTransfer();
              dt.setData('text/plain', text);
              const ev = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dt as unknown as ClipboardEventInit['clipboardData'],
              });
              const cancelled = !el.dispatchEvent(ev);
              requestAnimationFrame(() => {
                resolve({ cancelled, afterText: el.textContent ?? '' });
              });
            },
          );
        },
        content,
      ).catch(() => ({ cancelled: false, afterText: '' }));

      if (hasTarget(result.afterText)) {
        this.logger.debug(
          `X pasteContent: DraftJS handled paste (cancelled=${result.cancelled}), text matches target`,
        );
        return true;
      }

      if (result.cancelled) {
        this.logger.debug(
          'X pasteContent: paste was cancelled but final text does not match target; will fallback',
        );
      } else {
        this.logger.debug(
          'X pasteContent: paste not handled by editor, trying execCommand insertText',
        );
      }

      // Fallback: execCommand('insertText', false, text) to replace the selection.
      await textbox.evaluate((el: HTMLElement, text: string) => {
        el.focus();
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          // ignore
        }
        document.execCommand('insertText', false, text);
      }, content).catch(() => {});

      await this.browser.randomDelay(300, 600);
      const execText = await textbox.innerText().catch(() => '');
      if (hasTarget(execText)) {
        this.logger.debug('X pasteContent: execCommand insertText succeeded');
        return true;
      }

      this.logger.warn('X pasteContent failed — content not entered');
      return false;
    } catch (err) {
      this.logger.warn(`X pasteContent error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Fallback posting strategy: navigate to an X page (home or profile), open the compose
   * dialog via the "Post" button in the side nav, type content, and submit.
   *
   * Used when the /compose/post URL doesn't render the tweet button
   * (degraded session, UI changes, WAF/noscript pages, etc.). The side nav compose
   * dialog is the canonical posting path and tends to be more reliable.
   *
   * @returns PostResult if the fallback was attempted (success or error),
   *          null if the compose dialog couldn't be opened.
   */
  private async postViaSideNavCompose(
    page: Page,
    content: string,
    baseUrl: string,
    label: string,
  ): Promise<PostResult | null> {
    try {
      this.logger.log(`X ${label}: navigating to ${baseUrl}...`);
      this.assertPageAlive(page, `navigate to ${label} for compose`);
      // Use domcontentloaded to avoid waiting for heavy network idle on the X home page
      // (reduces renderer memory pressure and page-crash risk). The waitForSelector below
      // waits for the React SPA to mount, so hydration is still verified before interacting.
      await this.navigate(page, baseUrl, 'domcontentloaded');

      // Check if logged in
      if (await this.isOnLoginPage(page)) {
        return { error: 'Not logged in — session expired, relogin needed', retryable: true };
      }

      // Wait for the React app to mount — X uses a SPA that renders after domcontentloaded.
      // The body text starts with <style> before React mounts, so we wait for a real X element.
      // Don't use [role="navigation"] — it matches the noscript fallback <nav> element.
      this.logger.log(`X ${label}: waiting for React app to mount...`);
      // Give X's heavy SPA more time to hydrate; many production failures show the body
      // still containing only <style> at the 20s mark, causing the compose button search to
      // fail immediately and forcing the fragile /compose/post fallback.
      let spaMounted = await page.waitForSelector(
        '[data-testid="primaryColumn"], [data-testid="SideNav_NewTweet_Button"]',
        { timeout: 30000 },
      ).then(() => true).catch(() => false);

      // If SPA didn't mount within 30s, reload with domcontentloaded and try again.
      // X sometimes serves a degraded page (only <style> tags, no JS) on first load —
      // a reload forces a fresh fetch and the waitForSelector below verifies hydration.
      if (!spaMounted) {
        this.logger.warn(`X ${label}: SPA not mounted after 30s — reloading page...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await this.browser.randomDelay(2000, 4000);
        spaMounted = await page.waitForSelector(
          '[data-testid="primaryColumn"], [data-testid="SideNav_NewTweet_Button"]',
          { timeout: 20000 },
        ).then(() => true).catch(() => false);
      }

      if (!spaMounted) {
        this.logger.warn(`X ${label}: SPA still not mounted after reload — giving up on ${label} compose`);
        await this.dumpPageForDiagnostics(page, `${label.replace(/ /g, '-')}-spa-not-mounted`);
        return null;
      }

      // Wait for the side nav to load — the compose button may not be immediately visible
      // after navigation. Wait up to 30s for it to appear, and retry once after a short pause.
      this.logger.log(`X ${label}: waiting for compose button...`);
      // Click the compose button in the side nav.
      // X uses [data-testid="SideNav_NewTweet_Button"] for the compose button.
      const composeButton = page
        .locator('[data-testid="SideNav_NewTweet_Button"]')
        .first()
        .or(page.getByRole('button', { name: 'Post', exact: true }).first())
        .or(page.locator('a[href="/compose/post"]').first());

      // Wait for the button to be visible (not just check once)
      let composeVisible = await composeButton.isVisible().catch(() => false);
      if (!composeVisible) {
        // Try waiting for it to appear
        await composeButton.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
        composeVisible = await composeButton.isVisible().catch(() => false);
      }
      // Retry once after a short pause — the SPA can render the nav slightly after the
      // primary column appears, and the first waitFor can time out just before the button
      // mounts. A second check catches this transient race.
      if (!composeVisible) {
        this.logger.warn(`X ${label}: compose button not visible after first wait — pausing and retrying...`);
        await this.browser.randomDelay(3000, 5000);
        await composeButton.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        composeVisible = await composeButton.isVisible().catch(() => false);
      }
      if (!composeVisible) {
        // Log page state for debugging
        const bodyText = await page.textContent('body').catch(() => '');
        this.logger.warn(`X ${label}: compose button not found. Body text (first 200): "${bodyText?.slice(0, 200)}"`);
        await this.dumpPageForDiagnostics(page, `${label.replace(/ /g, '-')}-compose-not-found`);
        return null;
      }

      this.logger.log(`X ${label}: compose button found, clicking...`);
      await composeButton.click({ force: true, timeout: 10000 });
      await this.browser.randomDelay(1500, 3000);

      // Compose dialog should now be open — find the textarea
      const textbox = page
        .locator('[data-testid="tweetTextarea_0"]')
        .first()
        .or(page.locator('div[contenteditable="true"]').first());

      await textbox.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await textbox.click({ force: true, timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Type content using human-like typing via locator.pressSequentially (fires the real
      // key events X/Lexical needs to update React state and enable the Post button).
      this.logger.log(`X ${label}: typing tweet via humanType...`);
      this.assertPageAlive(page, `type tweet content (${label} compose)`);
      await this.setComposeText(page, textbox, content);
      await page.waitForTimeout(1000);

      await this.screenshot(page, 'after-type-fallback');

      // Find and click the Post button in the dialog
      // Avoid :has-text("Post") — matches "Schedule post". Use exact ARIA match.
      const postButton = page
        .locator('[data-testid="tweetButton"]')
        .first()
        .or(page.locator('[data-testid="tweetButtonInline"]:not([disabled]):not([aria-disabled="true"])').first())
        .or(page.getByRole('button', { name: 'Post', exact: true }).first());

      await postButton.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

      // Check if button is disabled — if so, try fill() + DraftJS nudge
      // X uses both `disabled` attribute AND `aria-disabled` — check both
      let fbDisabled = await postButton.isDisabled().catch(() => false);
      let fbAriaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
      if (fbAriaDisabled === 'true') fbDisabled = true;
      this.logger.log(`X ${label}: post button disabled check: isDisabled=${fbDisabled}, aria-disabled=${fbAriaDisabled}`);
      if (fbDisabled) {
        this.logger.warn(`X ${label}: post button disabled — trying fill() + DraftJS nudge...`);
        await textbox.fill(content, { timeout: 10000 }).catch(() => {});
        await this.browser.randomDelay(500, 1000);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(' ', { delay: 50 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(500, 1000);
        fbDisabled = await postButton.isDisabled().catch(() => false);
        fbAriaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
        if (fbAriaDisabled === 'true') fbDisabled = true;
        this.logger.log(`X ${label}: after fill() + nudge — button disabled: ${fbDisabled}, aria-disabled: ${fbAriaDisabled}`);
      }
      if (fbDisabled) {
        // Strategy D (same as main path): dispatch InputEvent('beforeinput') directly.
        // DraftJS processes beforeinput events — execCommand/fill() may not fire them in Firefox.
        this.logger.warn(`X ${label}: post button still disabled — trying direct beforeinput InputEvent dispatch...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(200, 400);
        const fbDispatched = await textbox.evaluate((el: HTMLElement, value: string) => {
          el.focus();
          try {
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: value,
              dataTransfer: null,
              isComposing: false,
            }));
            el.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              inputType: 'insertText',
              data: value,
            }));
            return true;
          } catch {
            return false;
          }
        }, content).catch(() => false);
        if (fbDispatched) {
          await this.browser.randomDelay(800, 1500);
          fbDisabled = await postButton.isDisabled().catch(() => false);
          fbAriaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
          if (fbAriaDisabled === 'true') fbDisabled = true;
          this.logger.log(`X ${label}: after beforeinput dispatch — button disabled: ${fbDisabled}, aria-disabled: ${fbAriaDisabled}`);
        }
      }
      if (fbDisabled) {
        this.logger.error(`X ${label}: post button disabled after all strategies — DraftJS state not updated`);
        await this.screenshot(page, 'button-disabled-abort');
        return { error: `Post button is disabled — DraftJS state not updated (${label} compose)`, retryable: false };
      }

      // Submit the tweet — prefer the native Ctrl+Enter keyboard shortcut.
      // Button clicks on X are commonly detected server-side and redirected to /home
      // without posting; the keyboard shortcut avoids this. Reference: x-mcp-bridge commit 4e45794.
      let fbClickSuccess = false;
      try {
        this.assertPageAlive(page, `submit tweet (${label} compose)`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(300, 600);
        await page.keyboard.press('Meta+Enter').catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.press('Control+Enter').catch(() => {});
        await this.browser.randomDelay(3000, 5000);
        fbClickSuccess = true;
        this.logger.log(`X ${label}: Ctrl+Enter shortcut sent`);
      } catch (submitErr) {
        this.logger.warn(`X ${label}: Ctrl+Enter failed: ${(submitErr as Error).message}`);
      }

      // Check if textbox is empty after click (sign that tweet was submitted)
      const fbTextboxAfterClick = await textbox.innerText().catch(() => '');
      this.logger.log(`X ${label}: textbox after submit: "${fbTextboxAfterClick.slice(0, 60)}..." (len=${fbTextboxAfterClick.length})`);

      // Fallback to humanClick on Post button if Ctrl+Enter didn't submit and the textbox still has content.
      if (!fbClickSuccess || (fbTextboxAfterClick.length > 0 && (page.url().includes('/compose/post') || page.url().includes('/home')))) {
        this.logger.log(`X ${label}: trying humanClick on Post button...`);
        try {
          await this.browser.humanClick(postButton, { timeoutMs: 10000 });
          this.logger.log(`X ${label}: humanClick on Post button succeeded`);
        } catch (clickErr) {
          this.logger.warn(`X ${label}: humanClick failed: ${(clickErr as Error).message}`);
        }
        await this.browser.randomDelay(2000, 4000);
      }

      await this.screenshot(page, 'after-submit-fallback');

      // Validate — check profile for the posted content
      const currentUrl = page.url();
      this.logger.log(`X ${label}: after submit — URL: ${currentUrl}`);

      // Try to find post URL
      const accountHandle = await this.getAccountHandle(page);
      const foundUrl = await this.findTweetUrlOnPage(page, accountHandle);
      if (foundUrl) {
        this.logger.log(`X ${label}: posted successfully — ${foundUrl}`);
        return { url: foundUrl };
      }

      // Check profile
      const handle = accountHandle ?? await this.getAccountHandleFromConfig();
      if (handle) {
        const postUrl = await this.validatePostOnProfile(
          page,
          `https://x.com/${handle}`,
          content,
          X_SELECTORS.compose.postUrlPattern,
        );
        this.logger.log(`X ${label}: validated on profile — ${postUrl}`);
        return { url: postUrl };
      }

      // P1: only record a genuine permalink. We already tried the profile check
      // above (validatePostOnProfile); if we STILL have no permalink, do NOT
      // return the compose/home URL as if it were the post — that's a false
      // POSTED (pollutes analytics, breaks thread-reply targeting). Report a
      // failure so it is never recorded as a successful permalink — same end
      // state as before (posting.service.isValidPostUrl already rejected the
      // bogus URL → FAILED), but without storing a junk postUrl.
      //
      // NOTE: a tweet that DID publish but whose permalink we couldn't capture is left
      // FAILED here. H2: PostingService now guards re-posts — the pre-retry verify (before
      // any withRetry re-submit) and the session-expiry self-recovery both call
      // findLivePostUrl() to skip re-posting when the content is already live, so a transient
      // error after submit no longer risks a duplicate.
      const fallbackPermalink = normalizePermalink(currentUrl, 'X');
      if (fallbackPermalink) {
        return { url: fallbackPermalink };
      }
      this.logger.warn(`X ${label}: submitted but no verifiable permalink captured (${currentUrl}) — marking failed`);
      return { error: 'submitted but no verifiable permalink captured', retryable: false };
    } catch (err) {
      this.logger.error(`X ${label} posting failed: ${(err as Error).message}`);
      return { error: `X ${label} failed: ${(err as Error).message}`, retryable: false };
    }
  }

  private async postViaHomePageCompose(page: Page, content: string): Promise<PostResult | null> {
    return this.postViaSideNavCompose(page, content, 'https://x.com/home', 'home page');
  }

  private async postViaProfilePageCompose(page: Page, content: string, handle: string): Promise<PostResult | null> {
    const clean = handle.replace(/^@/, '').trim();
    return clean ? this.postViaSideNavCompose(page, content, `https://x.com/${clean}`, 'profile page') : null;
  }

  /**
   * Dump the current page HTML and visible text to SPA_DEBUG_DIR (default /tmp/spa-debug)
   * for forensic analysis. Called when X fails to render the compose dialog so operators
   * can see the exact error page the browser received.
   */
  private async dumpPageForDiagnostics(page: Page, label: string): Promise<void> {
    try {
      const debugDir = process.env.SPA_DEBUG_DIR ?? '/tmp/spa-debug';
      fs.mkdirSync(debugDir, { recursive: true });
      const timestamp = Date.now();
      const base = `${debugDir}/x-${label}-${timestamp}`;
      const html = await page.content().catch(() => '');
      const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
      const title = await page.title().catch(() => '');
      fs.writeFileSync(`${base}.html`, html);
      fs.writeFileSync(`${base}.txt`, `url: ${page.url()}\n\ntitle: ${title}\n\n${bodyText.slice(0, 5000)}`);
      await this.screenshot(page, 'on-error');
      this.logger.warn(`X diagnostic dump saved: ${base}.html`);
    } catch (dumpErr) {
      this.logger.warn(`X diagnostic dump failed: ${(dumpErr as Error).message}`);
    }
  }

  /**
   * Search the page DOM for a tweet link matching our account handle.
   * Returns the full URL if found, null otherwise.
   */
  private async findTweetUrlOnPage(page: Page, accountHandle: string | null): Promise<string | null> {
    try {
      const tweetLinks = await page.locator('a[href*="/status/"]').all();
      for (const link of tweetLinks) {
        const href = await link.getAttribute('href').catch(() => null);
        if (!href) continue;
        const full = href.startsWith('http') ? href : `https://x.com${href}`;
        // If we know our handle, only accept links matching it
        if (accountHandle && full.includes(`/${accountHandle}/status/`)) {
          this.logger.log(`X found our tweet link in DOM: ${full}`);
          return full;
        }
      }
      // No handle filter — accept first tweet link as fallback
      if (!accountHandle && tweetLinks.length > 0) {
        const href = await tweetLinks[0]!.getAttribute('href').catch(() => null);
        if (href) {
          const full = href.startsWith('http') ? href : `https://x.com${href}`;
          this.logger.log(`X found tweet link in DOM (no handle filter): ${full}`);
          return full;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Extract the current account handle from the page.
   * X shows the handle in the side nav profile link: a[href="/{handle}"]
   * or via data-testid="AppTabBar_Profile_Link".
   */
  private async getAccountHandle(page: Page): Promise<string | null> {
    try {
      // Profile link in side nav: <a href="/{handle}"> with aria-label containing "Profile"
      const profileLink = page.locator('a[aria-label*="Profile"][href^="/"]').first();
      const href = await profileLink.getAttribute('href').catch(() => null);
      if (href) {
        const handle = href.replace(/^\//, '').split('/')[0];
        if (handle && handle !== 'home' && handle !== 'explore' && handle !== 'notifications') {
          this.logger.debug(`X account handle from profile link: @${handle}`);
          return handle;
        }
      }
      // Fallback: look for data-testid="AppTabBar_Profile_Link"
      const tabProfile = page.locator('[data-testid="AppTabBar_Profile_Link"]').first();
      const tabHref = await tabProfile.getAttribute('href').catch(() => null);
      if (tabHref) {
        const handle = tabHref.replace(/^\//, '').split('/')[0];
        if (handle) {
          this.logger.debug(`X account handle from tab bar: @${handle}`);
          return handle;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get account handle from config (SOCIAL_X_USERNAME) as fallback.
   */
  private async getAccountHandleFromConfig(): Promise<string | null> {
    try {
      const username = this.configService.get<string>('SOCIAL_X_USERNAME', '');
      if (username) {
        this.logger.debug(`X account handle from config: @${username}`);
        return username;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Post a reply in a thread — navigates to the root tweet, clicks reply,
   * types in the reply dialog, and submits.
   *
   * Uses typeHuman for stealth typing (randomized per-key delay + thinking pauses).
   * Falls back to Cmd+Enter keyboard shortcut if the Reply button is not clickable.
   * Verifies the reply was posted by checking page content after submit.
   */
  private async postReply(
    page: Page,
    rootTweetUrl: string,
    content: string,
  ): Promise<void> {
    // Suppress page errors (same as main compose — X throws uncaught JS errors).
    // Called before goto so the script is active during page load.
    // (Redundant if main post() already injected it, but Playwright deduplicates.)
    await page.addInitScript(() => {
      window.addEventListener('error', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
    }).catch(() => {});

    this.assertPageAlive(page, `navigate to root tweet for reply`);
    await page.goto(rootTweetUrl, { waitUntil: 'domcontentloaded' });
    await this.browser.randomDelay(2000, 4000);

    // Click the reply button on the root tweet
    // Use multiple selectors — X may use [data-testid="reply"] or an icon button
    const replyButton = page
      .locator('[data-testid="reply"]')
      .first()
      .or(page.locator('[aria-label*="Reply" i]').first());
    await this.humanPreAction(page, replyButton);
    await replyButton.click({ force: true, timeout: 10000 }).catch(() => {});
    await this.browser.randomDelay(1500, 3000);

    // Reply dialog opens with a textarea — wait for it
    await page.waitForSelector('[data-testid="tweetTextarea_0"], div[contenteditable="true"]', { timeout: 10000 });
    const textbox = page
      .locator('[data-testid="tweetTextarea_0"]')
      .first()
      .or(page.locator('div[contenteditable="true"]').first());

    await textbox.click({ force: true, timeout: 10000 }).catch(() => {});
    await this.browser.randomDelay(300, 800);

    // Type content — per-character execCommand so DraftJS enables the Reply button
    await this.setComposeText(page, textbox, content);
    await this.browser.randomDelay(500, 1000);

    // Verify text was entered
    const enteredText = await textbox.innerText().catch(() => '');
    if (!enteredText || enteredText.trim().length < 5) {
      this.logger.warn(`X reply: typeHuman didn't enter text — trying clipboard paste...`);
      const pasted = await this.pasteContent(page, textbox, content);
      if (!pasted) {
        this.logger.warn(`X reply: clipboard paste failed — trying keyboard.type() with slow delay...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(content, { delay: 50 });
      }
      await this.browser.randomDelay(500, 1000);
    }

    // Submit reply — try button click first, then Cmd+Enter fallback
    const submitButton = page
      .locator('[data-testid="tweetButton"]')
      .first()
      .or(page.getByRole('button', { name: 'Reply', exact: true }).first());
    await this.humanPreAction(page, submitButton);

    let replyClickSuccess = false;
    try {
      await this.browser.humanClick(submitButton, { timeoutMs: 10000 });
      replyClickSuccess = true;
    } catch (clickErr) {
      this.logger.warn(`X reply: humanClick on Reply button failed: ${(clickErr as Error).message}`);
    }
    await this.browser.randomDelay(2000, 4000);

    // Cmd+Enter fallback — X keyboard shortcut for submitting reply
    if (!replyClickSuccess) {
      this.logger.log(`X reply: trying Cmd+Enter keyboard shortcut...`);
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await this.browser.randomDelay(300, 600);
      await page.keyboard.press('Meta+Enter').catch(() => {});
      await this.browser.randomDelay(200, 400);
      await page.keyboard.press('Control+Enter').catch(() => {});
      await this.browser.randomDelay(2000, 4000);
      this.logger.log(`X reply: Cmd+Enter sent`);
    }

    // Verify reply was posted — check if content appears on the page
    const pageText = await page.textContent('body').catch(() => '');
    const contentSnippet = content.slice(0, 30).trim().replace(/^["']+|["']+$/g, '');
    if (pageText && pageText.includes(contentSnippet)) {
      this.logger.debug(`X reply verified on page: "${contentSnippet}..."`);
    } else {
      this.logger.warn(`X reply may not have posted — content not found on page after submit`);
    }

    this.logger.debug(`Posted thread reply: ${content.slice(0, 30)}...`);
  }

  /**
   * F2: post a single continuation reply to an existing root tweet.
   * Used by the delayed multi-stage posting worker, which schedules each
   * continuation 30 minutes apart via BullMQ.
   */
  async postThreadReply(
    context: BrowserContext,
    rootTweetUrl: string,
    content: string,
  ): Promise<PostResult> {
    const page = await context.newPage();
    await this.browser.suppressPageErrors(page);
    this.registerCrashHandler(page, context);
    try {
      await this.postReply(page, rootTweetUrl, content);
      return { url: rootTweetUrl };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`X thread continuation failed: ${message}`);
      return { error: message, retryable: false };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
