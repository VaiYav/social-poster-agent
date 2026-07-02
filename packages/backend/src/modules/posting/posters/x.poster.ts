import { Injectable, Logger, Inject } from '@nestjs/common';
import type { BrowserContext, Page, Locator } from '../../../domain/ports/browser-primitives';
import { IBrowserPort } from '../../../domain/ports/browser.port.js';
import { BasePoster, type PostResult } from './base.poster.js';
import { X_SELECTORS } from './selectors/x.selectors.js';
import { normalizePermalink } from './permalink.js';
import { ValidationError } from '../../../domain/errors.js';
import { parseBool } from '../../../infrastructure/config/parse-bool';

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

  constructor(@Inject(IBrowserPort) browser: IBrowserPort) {
    super(browser);
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
      return { error: `Content ${content.length} chars exceeds X limit ${X_CHAR_LIMIT}` };
    }

    const page = await context.newPage();
    await this.browser.suppressPageErrors(page);

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
        this.logger.warn(`X home page compose failed: ${homeResult.error} — falling back to /compose/post`);
      }

      // Fallback: navigate to /compose/post page (legacy path)
      this.logger.log(`X navigating to compose page: ${X_SELECTORS.compose.url}`);
      await this.navigate(page, X_SELECTORS.compose.url, 'domcontentloaded');

      // Check if logged in (redirect to login or login overlay?)
      // isOnLoginPage now checks both URL and DOM login indicators (async)
      if (await this.isOnLoginPage(page)) {
        this.logger.warn(`X session expired — login page detected on compose`);
        return { error: 'Not logged in — session expired, relogin needed' };
      }

      // Detect shadowban/restriction before attempting to post
      await this.detectShadowban(page);

      // Screenshot before compose
      await this.screenshot(page, 'before-compose');

      // Debug logging — only when SPA_DEBUG_SELECTORS env var is set
      // (avoids overhead in production while keeping diagnostic capability)
      if (parseBool(process.env.SPA_DEBUG_SELECTORS)) {
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
      let textbox = page
        .locator('[data-testid="tweetTextarea_0"]')
        .first()
        .or(page.locator('[role="textbox"]').first());

      // Click to focus the textbox — try normal click first (better for focus),
      // fall back to force: true if humanize blocks it
      try {
        await textbox.click({ timeout: 10000 });
      } catch {
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      }
      await this.browser.randomDelay(500, 1000);

      // Strategy 1: execCommand('insertText') — fires the input events React/DraftJS needs
      this.logger.log(`X typing tweet via execCommand insertText...`);
      await this.setComposeText(page, textbox, content);
      await this.browser.randomDelay(500, 1000);

      // Verify content was entered
      let enteredText = await textbox.innerText().catch(() => '');
      this.logger.debug(`X after execCommand — textbox content: "${enteredText.slice(0, 50)}..."`);

      // Strategy 2: if execCommand didn't work, use fill() + DraftJS nudge
      // fill() sets the DOM content, then we type+delete a char to trigger DraftJS state update
      if (!enteredText || enteredText.trim().length < 10) {
        this.logger.warn(`X execCommand didn't enter text — trying fill() + DraftJS nudge...`);
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

      // Strategy 3: if fill() didn't work either, use keyboard.type() (last resort)
      if (!enteredText || enteredText.trim().length < 10) {
        this.logger.warn(`X fill() didn't enter text — trying keyboard.type()...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.type(content, { delay: 30 });
        await this.browser.randomDelay(300, 600);
        enteredText = await textbox.innerText().catch(() => '');
        this.logger.debug(`X after keyboard.type() — textbox content: "${enteredText.slice(0, 50)}..."`);
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
        this.logger.warn(`X post button not visible — retrying text entry via keyboard...`);
        // Re-focus and re-type to trigger DraftJS state update
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(200, 500);
        // Select all existing content and replace
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.type(content, { delay: 30 });
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
        // Strategy B: clear and re-type with keyboard.type into focused textbox
        this.logger.warn(`X post button still disabled after fill() — trying keyboard.type()...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.type(content, { delay: 30 });
        await page.waitForTimeout(1000);
        isDisabled = await postButton.isDisabled().catch(() => false);
        ariaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
        if (ariaDisabled === 'true') isDisabled = true;
        this.logger.log(`X after keyboard.type() retry — button disabled: ${isDisabled}, aria-disabled: ${ariaDisabled}`);
      }
      if (isDisabled) {
        // Button is still disabled — DraftJS refuses to accept the content.
        // Do NOT force-click a disabled button — it won't submit and may navigate
        // to /home without posting, creating a false "URL changed" signal.
        this.logger.error(`X post button is disabled after all retries — DraftJS state not updated. Aborting.`);
        await this.screenshot(page, 'button-disabled-abort');
        return { error: 'Post button is disabled — DraftJS state not updated after all text entry strategies' };
      }

      // Submit the tweet — try multiple strategies in order:
      // 1. humanClick (for dry-run compatibility — DryRunBrowserPort intercepts this)
      // 2. Cmd+Enter keyboard shortcut (X native shortcut, bypasses mouse/humanize issues)
      // 3. JavaScript click (dispatches real DOM event that React processes)
      await this.humanPreAction(page, postButton);
      let humanClickFailed = false;
      try {
        await this.browser.humanClick(postButton, { timeoutMs: 15000 });
        this.logger.log(`X humanClick on Post button succeeded`);
      } catch (clickErr) {
        this.logger.warn(`X humanClick on Post button failed: ${(clickErr as Error).message}`);
        humanClickFailed = true;
      }
      await this.browser.randomDelay(2000, 4000);

      // Check if the click actually submitted (URL should change away from /compose/post)
      const urlAfterClick = page.url();
      const stillOnCompose = urlAfterClick.includes('/compose/post');
      this.logger.log(`X after humanClick — URL: ${urlAfterClick}, stillOnCompose: ${stillOnCompose}`);

      // Check if textbox is now empty (sign that the tweet was submitted)
      const textboxContentAfterClick = await textbox.innerText().catch(() => '');
      this.logger.log(`X textbox content after click: "${textboxContentAfterClick.slice(0, 60)}..." (len=${textboxContentAfterClick.length})`);

      // Fallback 1: if humanClick failed OR URL didn't change OR click navigated to /home
      // without submitting (known /compose/post issue: button navigates to /home but
      // tweet is not posted — text remains in textbox)
      const navigatedToHomeWithoutPosting = !stillOnCompose && textboxContentAfterClick.length > 0 && page.url().includes('/home');
      if (humanClickFailed || stillOnCompose || navigatedToHomeWithoutPosting) {
        this.logger.log(`X trying Cmd+Enter keyboard shortcut to submit (navigatedToHomeWithoutPosting: ${navigatedToHomeWithoutPosting})...`);
        // Navigate back to /compose/post if we're on /home (textbox won't exist there)
        if (page.url().includes('/home')) {
          this.logger.log(`X navigating back to /compose/post for Cmd+Enter retry...`);
          await this.navigate(page, 'https://x.com/compose/post', 'domcontentloaded');
          await this.browser.randomDelay(1000, 2000);
          // Re-find the textbox and re-type the content
          const retryTextbox = page
            .locator('[data-testid="tweetTextarea_0"]')
            .first()
            .or(page.locator('[role="textbox"]').first());
          await retryTextbox.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
          await retryTextbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await this.browser.randomDelay(300, 600);
          await this.browser.typeHuman(page, content, retryTextbox).catch(() => {});
          await this.browser.randomDelay(500, 1000);
          // Now press Cmd+Enter while the textbox is focused
          await retryTextbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await this.browser.randomDelay(300, 600);
          await page.keyboard.press('Meta+Enter').catch(() => {});
          await this.browser.randomDelay(200, 400);
          await page.keyboard.press('Control+Enter').catch(() => {});
          await this.browser.randomDelay(2000, 4000);
          this.logger.log(`X after Cmd+Enter retry — URL: ${page.url()}`);
        } else {
          await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
          await this.browser.randomDelay(300, 600);
          await page.keyboard.press('Meta+Enter').catch(() => {});
          await this.browser.randomDelay(200, 400);
          await page.keyboard.press('Control+Enter').catch(() => {});
          await this.browser.randomDelay(2000, 4000);
          this.logger.log(`X after Cmd+Enter — URL: ${page.url()}`);
        }
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
          const handle = accountHandle ?? await this.getAccountHandleFromEnv();
          if (handle) {
            // Retry profile validation up to 3 times — X may have a delay showing new posts
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
        // Retry each reply with exponential backoff (2 attempts)
        await this.retryWithBackoff(() => this.postReply(page, postUrl, threadItems[i]!), 2, 5000);
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
   * Insert text into X's DraftJS contenteditable compose box using
   * document.execCommand('insertText'). This fires the input events React/DraftJS
   * listens to, so the Post button becomes genuinely enabled and the tweet is
   * actually submitted when clicked. Falls back to the legacy per-character
   * typeHuman strategy if execCommand fails or returns false.
   */
  private async setComposeText(
    page: Page,
    textbox: Locator,
    content: string,
  ): Promise<void> {
    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Focus the contenteditable div so execCommand targets the right element
        await textbox.focus({ timeout: 5000 }).catch(() => {});
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(200, 400);

        // Select any existing content and replace it via execCommand
        const inserted = await textbox.evaluate((el: HTMLElement, value: string) => {
          el.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection?.removeAllRanges();
          selection?.addRange(range);
          // execCommand('insertText') dispatches the correct beforeinput/input events
          // React/DraftJS need to register the content and enable the Post button.
          const ok = document.execCommand('insertText', false, value);
          if (!ok) return false;
          // Trigger a final input event in case execCommand didn't fire one
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }, content).catch(() => false);

        if (inserted) {
          const innerText = await textbox.innerText().catch(() => '');
          if (innerText.trim().length >= content.trim().length * 0.8) {
            this.logger.debug(`X setComposeText via execCommand succeeded (attempt ${attempt})`);
            return;
          }
        }
      } catch (err) {
        this.logger.debug(`X setComposeText attempt ${attempt} failed: ${(err as Error).message}`);
      }
      // Pause briefly before fallback retry
      await this.browser.randomDelay(300, 600);
    }

    // Fallback to legacy per-character typing
    this.logger.warn(`X execCommand insertText failed — falling back to typeHuman`);
    await this.browser.typeHuman(page, content, textbox).catch(() => {});
  }

  /**
   * Fallback posting strategy: navigate to X home page, open the compose
   * dialog via the "Post" button in the side nav, type content, and submit.
   *
   * Used when the /compose/post URL doesn't render the tweet button
   * (degraded session, UI changes, etc.). The home page compose dialog
   * is the canonical posting path and tends to be more reliable.
   *
   * @returns PostResult if the fallback was attempted (success or error),
   *          null if the compose dialog couldn't be opened.
   */
  private async postViaHomePageCompose(page: Page, content: string): Promise<PostResult | null> {
    try {
      this.logger.log(`X fallback: navigating to home page...`);
      await this.navigate(page, 'https://x.com/home', 'domcontentloaded');

      // Check if logged in
      if (await this.isOnLoginPage(page)) {
        return { error: 'Not logged in — session expired, relogin needed' };
      }

      // Wait for the React app to mount — X uses a SPA that renders after domcontentloaded.
      // The body text starts with <style> before React mounts, so we wait for a real X element.
      // Don't use [role="navigation"] — it matches the noscript fallback <nav> element.
      this.logger.log(`X fallback: waiting for React app to mount on home page...`);
      // Give X's heavy SPA more time to hydrate; many production failures show the body
      // still containing only <style> at the 20s mark, causing the compose button search to
      // fail immediately and forcing the fragile /compose/post fallback.
      await page.waitForSelector('[data-testid="primaryColumn"], [data-testid="SideNav_NewTweet_Button"]', { timeout: 45000 }).catch(() => {});

      // Wait for the side nav to load — the compose button may not be immediately visible
      // after navigation. Wait up to 30s for it to appear, and retry once after a short pause.
      this.logger.log(`X fallback: waiting for compose button on home page...`);
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
        this.logger.warn(`X fallback: compose button not visible after first wait — pausing and retrying...`);
        await this.browser.randomDelay(3000, 5000);
        await composeButton.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        composeVisible = await composeButton.isVisible().catch(() => false);
      }
      if (!composeVisible) {
        // Log page state for debugging
        const bodyText = await page.textContent('body').catch(() => '');
        this.logger.warn(`X fallback: compose button not found on home page. Body text (first 200): "${bodyText?.slice(0, 200)}"`);
        return null;
      }

      this.logger.log(`X fallback: compose button found, clicking...`);
      await composeButton.click({ force: true, timeout: 10000 });
      await this.browser.randomDelay(1500, 3000);

      // Compose dialog should now be open — find the textarea
      const textbox = page
        .locator('[data-testid="tweetTextarea_0"]')
        .first()
        .or(page.locator('[role="textbox"]').first());

      await textbox.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await textbox.click({ force: true, timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Type content using execCommand insertText (fires the input events React/DraftJS
      // listens to, so the Post button genuinely enables and the tweet actually submits).
      this.logger.log(`X fallback: typing tweet via execCommand insertText...`);
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
      this.logger.log(`X fallback: post button disabled check: isDisabled=${fbDisabled}, aria-disabled=${fbAriaDisabled}`);
      if (fbDisabled) {
        this.logger.warn(`X fallback: post button disabled — trying fill() + DraftJS nudge...`);
        await textbox.fill(content, { timeout: 10000 }).catch(() => {});
        await this.browser.randomDelay(500, 1000);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(' ', { delay: 50 }).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await this.browser.randomDelay(500, 1000);
        fbDisabled = await postButton.isDisabled().catch(() => false);
        fbAriaDisabled = await postButton.getAttribute('aria-disabled').catch(() => null);
        if (fbAriaDisabled === 'true') fbDisabled = true;
        this.logger.log(`X fallback: after fill() + nudge — button disabled: ${fbDisabled}, aria-disabled: ${fbAriaDisabled}`);
      }
      if (fbDisabled) {
        this.logger.error(`X fallback: post button disabled after fill() — DraftJS state not updated`);
        await this.screenshot(page, 'button-disabled-abort');
        return { error: 'Post button is disabled — DraftJS state not updated (home page compose)' };
      }

      let fbClickSuccess = false;
      try {
        await this.browser.humanClick(postButton, { timeoutMs: 10000 });
        fbClickSuccess = true;
        this.logger.log(`X fallback: humanClick on Post button succeeded`);
      } catch (clickErr) {
        this.logger.warn(`X fallback: humanClick failed: ${(clickErr as Error).message}`);
      }
      await this.browser.randomDelay(2000, 4000);

      // Check if textbox is empty after click (sign that tweet was submitted)
      const fbTextboxAfterClick = await textbox.innerText().catch(() => '');
      this.logger.log(`X fallback: textbox after click: "${fbTextboxAfterClick.slice(0, 60)}..." (len=${fbTextboxAfterClick.length})`);

      // Cmd+Enter fallback for home page compose dialog — only if click failed
      if (!fbClickSuccess) {
        this.logger.log(`X fallback: trying Cmd+Enter shortcut...`);
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await this.browser.randomDelay(300, 600);
        await page.keyboard.press('Meta+Enter').catch(() => {});
        await this.browser.randomDelay(200, 400);
        await page.keyboard.press('Control+Enter').catch(() => {});
        await this.browser.randomDelay(2000, 4000);
      }

      await this.screenshot(page, 'after-submit-fallback');

      // Validate — check profile for the posted content
      const currentUrl = page.url();
      this.logger.log(`X fallback: after submit — URL: ${currentUrl}`);

      // Try to find post URL
      const accountHandle = await this.getAccountHandle(page);
      const foundUrl = await this.findTweetUrlOnPage(page, accountHandle);
      if (foundUrl) {
        this.logger.log(`X fallback: posted successfully — ${foundUrl}`);
        return { url: foundUrl };
      }

      // Check profile
      const handle = accountHandle ?? await this.getAccountHandleFromEnv();
      if (handle) {
        const postUrl = await this.validatePostOnProfile(
          page,
          `https://x.com/${handle}`,
          content,
          X_SELECTORS.compose.postUrlPattern,
        );
        this.logger.log(`X fallback: validated on profile — ${postUrl}`);
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
      this.logger.warn(`X fallback: submitted but no verifiable permalink captured (${currentUrl}) — marking failed`);
      return { error: 'submitted but no verifiable permalink captured' };
    } catch (err) {
      this.logger.error(`X fallback posting failed: ${(err as Error).message}`);
      return { error: `X fallback failed: ${(err as Error).message}` };
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
   * Get account handle from env var (SOCIAL_X_USERNAME) as fallback.
   */
  private async getAccountHandleFromEnv(): Promise<string | null> {
    try {
      // Access ConfigService via the browser port's config
      const username = process.env.SOCIAL_X_USERNAME;
      if (username) {
        this.logger.debug(`X account handle from env: @${username}`);
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
    await page.waitForSelector('[data-testid="tweetTextarea_0"], [role="textbox"]', { timeout: 10000 });
    const textbox = page
      .locator('[data-testid="tweetTextarea_0"]')
      .first()
      .or(page.locator('[role="textbox"]').first());

    await textbox.click({ force: true, timeout: 10000 }).catch(() => {});
    await this.browser.randomDelay(300, 800);

    // Type content — try typeHuman first, then keyboard.type as fallback
    await this.browser.typeHuman(page, content, textbox).catch(() => {});
    await this.browser.randomDelay(500, 1000);

    // Verify text was entered
    const enteredText = await textbox.innerText().catch(() => '');
    if (!enteredText || enteredText.trim().length < 5) {
      this.logger.warn(`X reply: typeHuman didn't enter text — trying keyboard.type()...`);
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.keyboard.type(content, { delay: 30 });
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
}
