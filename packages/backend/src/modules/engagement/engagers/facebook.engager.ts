// Facebook engager — like, comment, follow, reply, scroll.
// Uses aria-label and role-based selectors for resilience.
// Facebook is known for aggressive A/B testing, so multi-fallback is critical.

import { Injectable, Logger, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Page } from "../../../domain/ports/browser-primitives.js";
import { IBrowserPort } from "../../../domain/ports/browser.port.js";
import { BaseEngager } from "./base.engager.js";
import type { EngagementResult } from "../../posting/posters/base.poster.js";
import { FACEBOOK_SELECTORS } from "../../posting/posters/selectors/facebook.selectors.js";
import type { SelectorStrategy } from "../../posting/posters/selector-strategy.js";

@Injectable()
export class FacebookEngager extends BaseEngager {
  protected readonly logger = new Logger(FacebookEngager.name);
  protected readonly network = "FACEBOOK" as const;
  private readonly pageSlug: string;

  constructor(
    @Inject(IBrowserPort) browser: IBrowserPort,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    super(browser, configService);
    this.pageSlug = configService.get<string>("SOCIAL_FACEBOOK_PAGE_SLUG", "");
  }

  async like(page: Page, postUrl: string): Promise<EngagementResult> {
    try {
      await this.navigate(page, postUrl);

      const screenshotPath = await this.screenshot(page, "before-like");
      const { performed, alreadyLiked } = await this.performLike(
        page,
        FACEBOOK_SELECTORS.engagement.like,
        FACEBOOK_SELECTORS.engagement.unlike,
      );

      await this.screenshot(page, "after-like");
      if (alreadyLiked) {
        return { success: true, screenshotPath };
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
      await this.navigate(page, postUrl);

      const screenshotPath = await this.screenshot(page, "before-comment");
      await this.performComment(
        page,
        FACEBOOK_SELECTORS.engagement.comment,
        FACEBOOK_SELECTORS.engagement.commentInput,
        FACEBOOK_SELECTORS.engagement.commentSubmit,
        text,
      );

      await this.screenshot(page, "after-comment");
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async follow(page: Page, handleOrUrl: string): Promise<EngagementResult> {
    try {
      // Resolve handle to URL
      const profileUrl = handleOrUrl.startsWith("http")
        ? handleOrUrl
        : `https://www.facebook.com/${handleOrUrl}`;

      await this.navigate(page, profileUrl);

      const screenshotPath = await this.screenshot(page, "before-like");
      const followed = await this.performFollow(page, FACEBOOK_SELECTORS.engagement.follow);
      await this.screenshot(page, "after-like");

      return { success: followed, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  async reply(page: Page, postUrl: string, text: string): Promise<EngagementResult> {
    // Facebook reply to a comment is different from a page post comment.
    // Uses a separate flow: find the comment, click "Reply" on it, type, submit.
    try {
      await this.navigate(page, postUrl);
      const screenshotPath = await this.screenshot(page, "before-comment");

      // Facebook comment reply flow: each comment has a "Reply" button below it.
      // We reply to the first comment on the post (most recent).
      // This is distinct from commenting on the post itself.
      const replyButtonSelector = {
        role: { role: "button", name: "Reply" },
        css: ['div[role="button"]:has-text("Reply")', 'button:has-text("Reply")'],
      };

      const replyInputSelector = {
        role: { role: "textbox" },
        css: ['div[contenteditable="true"][aria-label*="Reply"]', 'div[contenteditable="true"]'],
      };

      const replySubmitSelector = {
        role: { role: "button", name: "Comment" },
        css: ['div[role="button"]:has-text("Comment")', 'button:has-text("Comment")'],
      };

      await this.performComment(
        page,
        replyButtonSelector,
        replyInputSelector,
        replySubmitSelector,
        text,
      );

      await this.screenshot(page, "after-comment");
      return { success: true, screenshotPath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Facebook does not have native repost/quote semantics like X/Threads, so these are stubs.
  async repost(_page: Page, _postUrl: string): Promise<EngagementResult> {
    return { success: false, error: "Repost is not supported on Facebook" };
  }

  async quote(_page: Page, _postUrl: string, _text: string): Promise<EngagementResult> {
    return { success: false, error: "Quote is not supported on Facebook" };
  }

  /**
   * Scroll the Facebook page feed and collect post URLs.
   */
  async scrollFeed(page: Page, durationSec: number): Promise<string[]> {
    if (!this.pageSlug) {
      throw new Error("SOCIAL_FACEBOOK_PAGE_SLUG not configured");
    }
    await this.navigate(page, FACEBOOK_SELECTORS.feed.url(this.pageSlug));
    return this.doScrollFeed(page, durationSec, FACEBOOK_SELECTORS.feed.postLink);
  }

  /**
   * Scroll an arbitrary Facebook URL (hashtag, competitor profile, page).
   */
  async scrollUrl(page: Page, url: string, durationSec: number): Promise<string[]> {
    await this.navigate(page, url);
    return this.doScrollFeed(page, durationSec, FACEBOOK_SELECTORS.feed.postLink);
  }

  protected getPostLinkSelector(): SelectorStrategy {
    return FACEBOOK_SELECTORS.feed.postLink;
  }

  /**
   * Extract the visible text content of a Facebook post.
   */
  async extractPostText(
    page: Page,
    postUrl: string,
  ): Promise<{ text: string; hasMedia: boolean; authorHandle?: string }> {
    return this.doExtractPostText(page, postUrl, FACEBOOK_SELECTORS.profile.postText, {
      css: ['div[role="article"] img', "video", 'div[role="article"] [data-imgperflogname]'],
    });
  }

  /**
   * Open the comments thread of a Facebook post to read replies.
   */
  async openCommentsThread(page: Page, postUrl: string): Promise<number> {
    return this.doOpenCommentsThread(page, postUrl, FACEBOOK_SELECTORS.engagement.comment, {
      css: ['div[role="article"]', 'li[role="comment"]', "div[data-commentid]"],
    });
  }

  /**
   * Get the Facebook page URL for feed browsing.
   */
  getPageUrl(): string {
    return FACEBOOK_SELECTORS.feed.url(this.pageSlug);
  }
}
