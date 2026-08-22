/**
 * Mastodon poster — browser automation for short-form posts.
 *
 * Uses Camoufox + LLM-in-the-loop (BrowserAgentService) to open the home
 * timeline composer (or the /publish compose page) and publish a status.
 *
 * Mastodon default post limit: 500 characters (grapheme count via checkContentLength).
 */
import { Injectable, Logger, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SocialNetwork } from "../../../generated/prisma/client";
import { z } from "zod";
import type { BrowserContext, Page } from "../../../domain/ports/browser-primitives.js";
import { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { BasePoster, type PostResult } from "./base.poster.js";
import { checkContentLength } from "../../posts/network-limits.js";

@Injectable()
export class MastodonPoster extends BasePoster {
  protected readonly logger = new Logger(MastodonPoster.name);
  protected readonly network = SocialNetwork.MASTODON;
  private readonly instance: string;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    super(browser, configService);
    const rawInstance = this.configService.get<string>("MASTODON_INSTANCE", "mastodon.social");
    this.instance = rawInstance.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }

  async post(
    context: BrowserContext,
    _browserPort: IBrowserPort,
    content: string,
    _threadItems?: string[],
  ): Promise<PostResult> {
    const check = checkContentLength(SocialNetwork.MASTODON, content);
    if (!check.ok) {
      this.logger.warn(
        `Mastodon content ${check.length} chars exceeds limit ${check.limit} — rejecting before browser session`,
      );
      return {
        error: `Content ${check.length} chars exceeds Mastodon limit ${check.limit}`,
        retryable: false,
      };
    }

    let page: Page | null = null;
    try {
      page = await context.newPage();
      await this.browser.suppressPageErrors(page);
      this.registerCrashHandler(page, context);

      const homeUrl = `https://${this.instance}/home`;
      this.assertPageAlive(page, "navigate to Mastodon home");
      await this.navigate(page, homeUrl, "domcontentloaded");

      if (await this.isOnLoginPage(page)) {
        this.logger.warn("Mastodon session expired — login page detected");
        return { error: "Not logged in — session expired, relogin needed", retryable: true };
      }

      await this.detectShadowban(page);

      await this.screenshot(page, "before-compose");

      // Try to open the composer from the home timeline.
      let composeResult = await this.browser.act(
        page,
        'Click the "New post" or "Compose" button to open the Mastodon post composer',
      );

      if (!composeResult.success) {
        this.logger.warn(
          `Mastodon compose button not found on /home: ${composeResult.error} — trying /publish`,
        );
        const publishUrl = `https://${this.instance}/publish`;
        this.assertPageAlive(page, "navigate to Mastodon /publish");
        await this.navigate(page, publishUrl, "domcontentloaded");

        if (await this.isOnLoginPage(page)) {
          return { error: "Not logged in — session expired, relogin needed", retryable: true };
        }

        // On /publish the composer is already visible; verify it is there.
        composeResult = await this.browser.act(
          page,
          "Confirm the Mastodon compose textarea is visible and ready for input",
        );
        if (!composeResult.success) {
          throw new Error(`Mastodon /publish has no composer: ${composeResult.error}`);
        }
      }

      // Type the content.
      const typeResult = await this.browser.act(
        page,
        `Find the Mastodon compose textarea and type the following content exactly:\n\n${content}`,
      );
      if (!typeResult.success) {
        throw new Error(`Failed to type Mastodon post: ${typeResult.error ?? "unknown error"}`);
      }

      // Submit.
      const publishResult = await this.browser.act(
        page,
        'Click the "Publish" or "Post" button to publish the Mastodon status',
      );
      if (!publishResult.success) {
        throw new Error(
          `Failed to publish Mastodon post: ${publishResult.error ?? "unknown error"}`,
        );
      }

      await this.browser.randomDelay(3000, 6000);
      await this.screenshot(page, "after-submit");

      // Extract the published post URL.
      const urlSchema = z.object({ url: z.string().url() });
      const extracted = await this.browser.extract(page, urlSchema);
      let url = extracted?.url;

      if (!url) {
        const currentUrl = page.url();
        if (this.isMastodonPostUrl(currentUrl)) {
          url = currentUrl;
          this.logger.log(`Mastodon post URL from page URL: ${url}`);
        }
      }

      if (!url) {
        throw new Error("Could not extract or determine Mastodon post URL after publish");
      }

      this.logger.log(`Mastodon post published: ${url}`);
      return { url };
    } catch (err) {
      this.logger.error(`Mastodon post failed: ${(err as Error).message}`);
      if (page) {
        return this.withErrorHandling(
          page,
          async () => {
            throw err;
          },
          "mastodon post",
        );
      }
      const classified = await this.classifyError(err, null, "mastodon post");
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
   * Mastodon status URLs contain the instance domain and a status path.
   * Accepts ActivityPub-style (/users/.../statuses/...), web API (/statuses/...),
   * and public permalink (/@handle/123456) forms.
   */
  private isMastodonPostUrl(url: string): boolean {
    const instancePattern = this.instance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^https?://(www\\.)?${instancePattern}`, "i").test(url)) {
      return false;
    }
    return /\/users\/[^/]+\/statuses\/[^/]+|\/statuses\/[^/]+|\/@[^/]+\/\d+/.test(url);
  }
}
