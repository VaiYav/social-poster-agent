import { Logger } from "@nestjs/common";
import type { Locator, Page } from "../../../domain/ports/browser-primitives.js";
import type { IBrowserPort } from "../../../domain/ports/browser.port.js";

export interface XThreadRepliesDependencies {
  readonly browser: IBrowserPort;
  readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  readonly assertPageAlive: (page: Page, context: string) => void;
  readonly humanPreAction: (page: Page, locator: Locator) => Promise<void>;
  readonly setComposeText: (page: Page, textbox: Locator, content: string) => Promise<void>;
  readonly pasteContent: (page: Page, textbox: Locator, content: string) => Promise<boolean>;
  readonly retryWithBackoff: <T>(
    operation: () => Promise<T>,
    maxRetries?: number,
    baseDelayMs?: number,
    isDead?: () => boolean,
  ) => Promise<T>;
}

/** X thread reply page object: per-reply retry, delay and verification. */
export class XThreadReplies {
  private readonly browser: IBrowserPort;
  private readonly logger: Pick<Logger, "debug" | "error" | "log" | "warn">;
  private readonly assertPageAlive: (page: Page, context: string) => void;
  private readonly humanPreAction: (page: Page, locator: Locator) => Promise<void>;
  private readonly setComposeText: (page: Page, textbox: Locator, content: string) => Promise<void>;
  private readonly pasteContent: (
    page: Page,
    textbox: Locator,
    content: string,
  ) => Promise<boolean>;
  private readonly retryWithBackoff: XThreadRepliesDependencies["retryWithBackoff"];

  constructor(deps: XThreadRepliesDependencies) {
    this.browser = deps.browser;
    this.logger = deps.logger;
    this.assertPageAlive = deps.assertPageAlive;
    this.humanPreAction = deps.humanPreAction;
    this.setComposeText = deps.setComposeText;
    this.pasteContent = deps.pasteContent;
    this.retryWithBackoff = deps.retryWithBackoff;
  }
  async postThreadReplies(
    page: Page,
    postUrl: string,
    threadItems: string[],
    replyOverride?: (page: Page, postUrl: string, content: string) => Promise<void>,
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
          () =>
            replyOverride
              ? replyOverride(page, postUrl, threadItems[i]!)
              : this.postReply(page, postUrl, threadItems[i]!),
          2,
          5000,
          () => page.isClosed?.() ?? false,
        );
        replyResults.push({ index: i, success: true });
      } catch (replyErr) {
        const errMsg = (replyErr as Error).message;
        this.logger.error(
          `Thread reply ${i + 1}/${threadItems.length} failed after retries: ${errMsg}`,
        );
        replyResults.push({ index: i, success: false, error: errMsg });
      }
    }
    const succeeded = replyResults.filter((r) => r.success).length;
    const failed = replyResults.filter((r) => !r.success).length;
    this.logger.log(
      `Thread replies: ${succeeded} succeeded, ${failed} failed out of ${threadItems.length}`,
    );
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

  async postReply(page: Page, rootTweetUrl: string, content: string): Promise<void> {
    // Suppress page errors (same as main compose — X throws uncaught JS errors).
    // Called before goto so the script is active during page load.
    // (Redundant if main post() already injected it, but Playwright deduplicates.)
    await page
      .addInitScript(() => {
        window.addEventListener(
          "error",
          (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
          },
          true,
        );
        window.addEventListener(
          "unhandledrejection",
          (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
          },
          true,
        );
      })
      .catch(() => {});

    this.assertPageAlive(page, `navigate to root tweet for reply`);
    await page.goto(rootTweetUrl, { waitUntil: "domcontentloaded" });
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
    await page.waitForSelector('[data-testid="tweetTextarea_0"], div[contenteditable="true"]', {
      timeout: 10000,
    });
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
    const enteredText = await textbox.innerText().catch(() => "");
    if (!enteredText || enteredText.trim().length < 5) {
      this.logger.warn(`X reply: typeHuman didn't enter text — trying clipboard paste...`);
      const pasted = await this.pasteContent(page, textbox, content);
      if (!pasted) {
        this.logger.warn(
          `X reply: clipboard paste failed — trying keyboard.type() with slow delay...`,
        );
        await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.keyboard.type(content, { delay: 50 });
      }
      await this.browser.randomDelay(500, 1000);
    }

    // Submit reply — try button click first, then Cmd+Enter fallback
    const submitButton = page
      .locator('[data-testid="tweetButton"]')
      .first()
      .or(page.getByRole("button", { name: "Reply", exact: true }).first());
    await this.humanPreAction(page, submitButton);

    let replyClickSuccess = false;
    try {
      await this.browser.humanClick(submitButton, { timeoutMs: 10000 });
      replyClickSuccess = true;
    } catch (clickErr) {
      this.logger.warn(
        `X reply: humanClick on Reply button failed: ${(clickErr as Error).message}`,
      );
    }
    await this.browser.randomDelay(2000, 4000);

    // Cmd+Enter fallback — X keyboard shortcut for submitting reply
    if (!replyClickSuccess) {
      this.logger.log(`X reply: trying Cmd+Enter keyboard shortcut...`);
      await textbox.click({ force: true, timeout: 5000 }).catch(() => {});
      await this.browser.randomDelay(300, 600);
      await page.keyboard.press("Meta+Enter").catch(() => {});
      await this.browser.randomDelay(200, 400);
      await page.keyboard.press("Control+Enter").catch(() => {});
      await this.browser.randomDelay(2000, 4000);
      this.logger.log(`X reply: Cmd+Enter sent`);
    }

    // Verify reply was posted — check if content appears on the page
    const pageText = await page.textContent("body").catch(() => "");
    const contentSnippet = content
      .slice(0, 30)
      .trim()
      .replace(/^["']+|["']+$/g, "");
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
}
