import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ModuleRef } from "@nestjs/core";
import type { IBrowserPort } from "../../domain/ports/browser.port.js";
import type { BrowserContext } from "../../domain/ports/browser-primitives.js";
import { Post, SocialNetwork, ContentType } from "../../generated/prisma/client.js";
import { XPoster } from "./posters/x.poster.js";
import { ThreadsPoster } from "./posters/threads.poster.js";
import { FacebookPoster } from "./posters/facebook.poster.js";
import { DevtoPoster } from "./posters/devto.poster.js";
import { HashnodePoster } from "./posters/hashnode.poster.js";
import { LinkedinPoster } from "./posters/linkedin.poster.js";
import { BlueskyPoster } from "./posters/bluesky.poster.js";
import { MastodonPoster } from "./posters/mastodon.poster.js";
import { LinkedinSocialPoster } from "./posters/linkedin-social.poster.js";
import { TelegramAdapter } from "../../infrastructure/telegram/telegram.adapter.js";
import type { PostResult } from "./posters/base.poster.js";

export interface DispatchOptions {
  /** Content to publish (CTA-resolved for the root, raw for continuations). */
  content: string;
  /** Legacy thread continuation texts — passed to social posters as threadItems. */
  threadItems?: string[];
  /** Optional image path (MEDIA-001) supported by X/Threads/Facebook posters. */
  imagePath?: string;
}

/**
 * REFACTOR-103: single registry that owns "which poster handles this network".
 * Previously the network→poster switch was duplicated between the dispatch path
 * and verification (getPoster); both now read from here (DRY / GRASP: pure
 * fabrication that owns poster lookup). Article posters stay lazy via ModuleRef:
 * they are only registered when SYNDICATION_ENABLED=true.
 */
@Injectable()
export class PostingDispatcher {
  private readonly logger = new Logger(PostingDispatcher.name);

  constructor(
    private readonly xPoster: XPoster,
    private readonly threadsPoster: ThreadsPoster,
    private readonly facebookPoster: FacebookPoster,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly blueskyPoster?: BlueskyPoster,
    @Optional() private readonly mastodonPoster?: MastodonPoster,
    @Optional() private readonly linkedinSocialPoster?: LinkedinSocialPoster,
    @Optional() private readonly telegramAdapter?: TelegramAdapter,
  ) {}

  /** Resolve the concrete browser poster for a network, or null when unverifiable. */
  getPoster(network: SocialNetwork, contentType: ContentType): unknown | null {
    switch (network) {
      case SocialNetwork.X:
        return this.xPoster;
      case SocialNetwork.THREADS:
        return this.threadsPoster;
      case SocialNetwork.FACEBOOK:
        return this.facebookPoster;
      case SocialNetwork.BLUESKY:
        return this.blueskyPoster ?? null;
      case SocialNetwork.MASTODON:
        return this.mastodonPoster ?? null;
      case SocialNetwork.TELEGRAM:
        // Telegram has no browser profile/verifyPosted; it reports its URL directly from the API response.
        return null;
      case SocialNetwork.LINKEDIN:
        // LinkedIn article posters are not verified via the browser profile heuristic.
        // LinkedIn short-form social can be verified via the poster's verifyPosted.
        return contentType === ContentType.ARTICLE ? null : (this.linkedinSocialPoster ?? null);
      default: {
        // Article posters (Dev.to, Hashnode) are resolved lazily via ModuleRef
        // in postArticle() — they're only registered when SYNDICATION_ENABLED=true
        return null;
      }
    }
  }

  /**
   * Dispatch a post body through the right poster. Continuation replies
   * (F2 multi-stage) must be routed before calling this.
   */
  async dispatch(
    post: Post,
    context: BrowserContext,
    browser: IBrowserPort,
    opts: DispatchOptions,
  ): Promise<PostResult> {
    const threadItems =
      opts.threadItems && opts.threadItems.length > 0 ? opts.threadItems : undefined;

    switch (post.network) {
      case SocialNetwork.X:
        return opts.imagePath
          ? this.xPoster.post(context, browser, opts.content, threadItems, opts.imagePath)
          : this.xPoster.post(context, browser, opts.content, threadItems);
      case SocialNetwork.THREADS:
        return opts.imagePath
          ? this.threadsPoster.post(context, browser, opts.content, threadItems, opts.imagePath)
          : this.threadsPoster.post(context, browser, opts.content, threadItems);
      case SocialNetwork.FACEBOOK:
        return opts.imagePath
          ? this.facebookPoster.post(context, browser, opts.content, undefined, opts.imagePath)
          : this.facebookPoster.post(context, browser, opts.content);
      case SocialNetwork.BLUESKY:
        if (!this.blueskyPoster) {
          throw new Error("BlueskyPoster is not available — check PostingModule providers");
        }
        return this.blueskyPoster.post(context, browser, post.content);
      case SocialNetwork.MASTODON:
        if (!this.mastodonPoster) {
          throw new Error("MastodonPoster is not available — check PostingModule providers");
        }
        return this.mastodonPoster.post(context, browser, post.content);
      case SocialNetwork.TELEGRAM:
        if (!this.telegramAdapter) {
          throw new Error("TelegramAdapter is not available — check PostingModule providers");
        }
        return this.telegramAdapter.postMessage(post.content);
      case SocialNetwork.DEVTO:
      case SocialNetwork.HASHNODE:
        return this.postArticle(context, post);
      case SocialNetwork.LINKEDIN:
        // LinkedIn has two posters: long-form articles (SyndicationModule) and
        // short social updates (LinkedinSocialPoster, in PostingModule).
        if (post.contentType === ContentType.ARTICLE) {
          return this.postArticle(context, post);
        }
        if (!this.linkedinSocialPoster) {
          throw new Error("LinkedinSocialPoster is not available — check PostingModule providers");
        }
        return this.linkedinSocialPoster.post(context, browser, post.content);
      default: {
        // Unimplemented syndication networks (Phase 3+)
        throw new Error(`Posting not yet implemented for network: ${post.network}`);
      }
    }
  }

  /** First-reply link delivery target for networks that support threaded replies. */
  getReplyCapablePoster(network: SocialNetwork): XPoster | ThreadsPoster | null {
    if (network === SocialNetwork.X) return this.xPoster;
    if (network === SocialNetwork.THREADS) return this.threadsPoster;
    return null;
  }

  /**
   * P1-04: Post an article to a syndication platform (Dev.to, Hashnode, LinkedIn).
   *
   * The post's content is expected to be JSON-serialized ArticleContent
   * (title, bodyMarkdown, slug, tags, excerpt).
   */
  async postArticle(context: BrowserContext, post: Post): Promise<PostResult> {
    // Parse article content from post.content (stored as JSON)
    let articleContent: import("@spa/shared").ArticleContent;
    try {
      articleContent = JSON.parse(post.content) as import("@spa/shared").ArticleContent;
    } catch {
      return {
        error: "Article content is not valid JSON — expected ArticleContent",
        retryable: false,
      };
    }

    const poster = await this.resolveArticlePoster(post);
    if (poster instanceof Error) {
      return { error: poster.message, retryable: false };
    }

    // Build canonical URL from post's canonicalUrl field or slug
    const blogBaseUrl =
      this.configService.get<string>("BLOG_BASE_URL", "") || "https://example.com";
    const canonicalUrl = post.canonicalUrl ?? `${blogBaseUrl}/blog/${articleContent.slug}`;

    const result = await poster.postArticle(context, articleContent, canonicalUrl);
    return {
      url: result.url,
      error: result.error,
      retryable: !result.success, // Retry on failure
    };
  }

  /**
   * Resolve the lazy article poster for a syndication post.
   * Returns the poster, or an Error if the poster is not available.
   */
  async resolveArticlePoster(
    post: Post,
  ): Promise<DevtoPoster | HashnodePoster | LinkedinPoster | Error> {
    try {
      switch (post.network) {
        case SocialNetwork.DEVTO:
          return this.moduleRef.get(DevtoPoster, { strict: false });
        case SocialNetwork.HASHNODE:
          return this.moduleRef.get(HashnodePoster, { strict: false });
        case SocialNetwork.LINKEDIN:
          if (post.contentType === ContentType.ARTICLE) {
            return this.moduleRef.get(LinkedinPoster, { strict: false });
          }
          return new Error(`LinkedIn social updates are not article posters`);
        default:
          return new Error(`No article poster for network: ${post.network}`);
      }
    } catch {
      this.logger.debug(
        `Article poster for ${post.network} unavailable — SYNDICATION_ENABLED is likely off`,
      );
      return new Error(
        `Article poster for ${post.network} not available — is SYNDICATION_ENABLED=true?`,
      );
    }
  }
}

