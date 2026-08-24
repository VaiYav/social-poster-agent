// X.com (Twitter) engager — like, comment, follow, reply, scroll.
// Uses data-testid selectors (relatively stable) with fallbacks.

import { Injectable, Logger, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Page } from "../../../domain/ports/browser-primitives.js";
import { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { BaseEngager } from "./base.engager.js";
import type { EngagementResult } from "../../posting/posters/base.poster.js";
import { X_SELECTORS } from "../../posting/posters/selectors/x.selectors.js";
import type { SelectorStrategy } from "../../posting/posters/selector-strategy.js";

@Injectable()
export class XEngager extends BaseEngager {
  protected readonly logger = new Logger(XEngager.name);
  protected readonly network = "X" as const;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    super(browser, configService);
  }

  /**
   * X.com feeds expose many non-post links under `/status/` (analytics, retweets,
   * likes, quotes, photo, video, etc.). Navigating to them causes extraction
   * timeouts and page crashes, so reject anything that is not a clean post URL.
   */
  protected isValidPostUrl(postUrl: string): boolean {
    try {
      const url = new URL(postUrl);
      return /^\/[A-Za-z0-9_]+\/status\/\d+(\?.*)?$/.test(url.pathname + url.search);
    } catch {
      return false;
    }
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, "domcontentloaded");

      const screenshotPath = await this.screenshot(page, "before-like");
      const { performed, alreadyLiked } = await this.performLike(
        page,
        X_SELECTORS.engagement.like,
        X_SELECTORS.engagement.unlike,
      );

      await this.screenshot(page, "after-like");

      if (alreadyLiked) {
        return { success: true, screenshotPath }; // Already liked — still success
      }
      if (!performed) {
        return {
          success: false,
          error: "Like button found but state did not change",
          screenshotPath,
        };
      }
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async comment(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, "domcontentloaded");

      const screenshotPath = await this.screenshot(page, "before-comment");
      await this.performComment(
        page,
        X_SELECTORS.engagement.reply,
        X_SELECTORS.engagement.replyTextarea,
        X_SELECTORS.engagement.replySubmit,
        text,
      );

      // After a successful reply, the page URL is the reply's permalink.
      const resultingUrl = page.url();

      await this.screenshot(page, "after-comment");
      return { success: true, screenshotPath, postUrl: resultingUrl };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async follow(page: Page, handleOrUrl: string): Promise<EngagementResult> {
    try {
      // Resolve handle to URL
      const profileUrl = handleOrUrl.startsWith("http")
        ? handleOrUrl
        : `https://x.com/${handleOrUrl.replace("@", "")}`;

      await this.navigate(page, profileUrl, "domcontentloaded");

      const screenshotPath = await this.screenshot(page, "before-like");
      const followed = await this.performFollow(page, X_SELECTORS.engagement.follow);
      await this.screenshot(page, "after-like");

      return { success: followed, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reply(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    // X.com reply is the same as comment
    return this.comment(page, postUrl, text);
  }

  async repost(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, "domcontentloaded");
      const screenshotPath = await this.screenshot(page, "before-repost");
      const { performed, alreadyReposted } = await this.performRepost(
        page,
        X_SELECTORS.engagement.repost,
        X_SELECTORS.engagement.repostMenuRepost,
      );
      await this.screenshot(page, "after-repost");
      if (alreadyReposted) {
        return { success: true, screenshotPath, alreadyReposted: true };
      }
      if (!performed) {
        return { success: false, error: "Repost menu did not confirm", screenshotPath };
      }
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async quote(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl, "domcontentloaded");
      const screenshotPath = await this.screenshot(page, "before-quote");
      await this.performQuote(
        page,
        X_SELECTORS.engagement.repost,
        X_SELECTORS.engagement.repostMenuQuote,
        X_SELECTORS.engagement.quoteTextarea,
        X_SELECTORS.engagement.quoteSubmit,
        text,
      );
      await this.screenshot(page, "after-quote");
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Scroll the X.com feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    await this.navigate(page, X_SELECTORS.feed.url, "domcontentloaded");
    return this.doScrollFeed(page, durationSec, X_SELECTORS.feed.tweetLink);
  }

  /**
   * Scroll an arbitrary X.com URL (hashtag, competitor profile, explore).
   */
  async scrollUrl(page: Page, url: string, durationSec: number): Promise<string[]> {
    await this.navigate(page, url, "domcontentloaded");
    return this.doScrollFeed(page, durationSec, X_SELECTORS.feed.tweetLink);
  }

  protected getPostLinkSelector(): SelectorStrategy {
    return X_SELECTORS.feed.tweetLink;
  }

  /**
   * Extract the visible text content of an X.com post.
   */
  async extractPostText(
    page: Page,
    postUrl: string,
  ): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    return this.doExtractPostText(page, postUrl, X_SELECTORS.feed.tweetArticle, {
      css: ["article img", 'div[data-testid="tweetPhoto"]', "video"],
    });
  }

  /**
   * Open the comments thread of an X.com post to read replies.
   */
  async openCommentsThread(page: Page, postUrl: string): Promise<number> {
    return this.doOpenCommentsThread(page, postUrl, X_SELECTORS.engagement.reply, {
      css: ['article[data-testid="tweet"]', 'div[data-testid="tweetText"]'],
    });
  }
}
