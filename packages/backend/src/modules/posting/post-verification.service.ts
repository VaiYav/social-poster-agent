import { Inject, Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { IBrowserPort, type IBrowserPort as BrowserPort } from "../../domain/ports/browser.port.js";
import type { BrowserContext } from "../../domain/ports/browser-primitives.js";
import { Post, PostStatus, SocialNetwork, ContentType } from "../../generated/prisma/client.js";
import { getNetworkProfile } from "../../domain/network-profiles/network-profiles.js";
import { PostEvents } from "../../events/enums/post-events.enum.js";
import type { PostVerifiedEvent } from "@spa/shared";
import type { PostsService } from "../posts/posts.service.js";
import type { SessionsService } from "../sessions/sessions.service.js";
import { PostingDispatcher } from "./poster-registry.service.js";
import type { PostingResult } from "./posting-guards.service.js";

/**
 * REFACTOR-103: everything about "is this post actually live?" in one service.
 *
 * - URL-pattern validation reads `verificationPattern` from the canonical
 *   `domain/network-profiles` registry (REFACTOR-101) instead of a local copy.
 * - Homepage-rejection patterns remain here: they are a posting-pipeline concern
 *   ("poster captured the wrong link"), not platform knowledge.
 */
@Injectable()
export class PostVerificationService {
  private readonly logger = new Logger(PostVerificationService.name);

  constructor(
    private readonly postsService: PostsService,
    private readonly sessionsService: SessionsService,
    private readonly posterRegistry: PostingDispatcher,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IBrowserPort) private readonly browser: BrowserPort,
  ) {}

  /**
   * Validate that a URL is a real post URL, not a homepage.
   * Positive pattern comes from the canonical NetworkProfile registry.
   */
  isValidPostUrl(url: string, network: SocialNetwork): boolean {
    if (!url || url.trim() === "") return false;

    // Reject obvious homepage URLs
    const homepagePatterns: Partial<Record<SocialNetwork, RegExp[]>> = {
      [SocialNetwork.X]: [/^https?:\/\/(www\.)?x\.com\/?$/, /^https?:\/\/(www\.)?x\.com\/home\/?$/],
      [SocialNetwork.THREADS]: [
        /^https?:\/\/(www\.)?threads\.com\/?$/,
        /^https?:\/\/(www\.)?threads\.com\/@[^/]+\/?$/,
      ],
      [SocialNetwork.FACEBOOK]: [
        /^https?:\/\/(www\.)?facebook\.com\/?$/,
        /^https?:\/\/(www\.)?facebook\.com\/[^/]+\/?$/,
      ],
      [SocialNetwork.BLUESKY]: [
        /^https?:\/\/(www\.)?bsky\.app\/?$/,
        /^https?:\/\/(www\.)?bsky\.app\/feed\/?$/,
      ],
      [SocialNetwork.MASTODON]: [/^https?:\/\/(www\.)?[^/]+\/?$/],
      [SocialNetwork.TELEGRAM]: [
        /^https?:\/\/(www\.)?t\.me\/?$/,
        /^https?:\/\/(www\.)?t\.me\/[^/]+\/?$/,
      ],
      [SocialNetwork.LINKEDIN]: [
        /^https?:\/\/(www\.)?linkedin\.com\/?$/,
        /^https?:\/\/(www\.)?linkedin\.com\/feed\/?$/,
      ],
      [SocialNetwork.DEVTO]: [/^https?:\/\/(www\.)?dev\.to\/?$/],
      [SocialNetwork.HASHNODE]: [/^https?:\/\/(www\.)?[^/]+\.hashnode\.dev\/?$/],
    };

    for (const pattern of homepagePatterns[network] ?? []) {
      if (pattern.test(url)) return false;
    }

    // Syndication article URLs are validated here because they are not social
    // profile permalinks and therefore do not belong in the social network
    // profile registry.
    if (network === SocialNetwork.DEVTO) {
      return /^https?:\/\/(?:www\.)?dev\.to\/[^/]+\/[^/?#]+/.test(url);
    }
    if (network === SocialNetwork.HASHNODE) {
      return /^https?:\/\/[^/]+\.hashnode\.dev\/[^/?#]+/.test(url);
    }
    if (network === SocialNetwork.LINKEDIN) {
      return /linkedin\.com\/(?:pulse|posts|feed\/update)\//.test(url);
    }

    return getNetworkProfile(network).verificationPattern.test(url);
  }

  isArticleNetwork(post: Post): boolean {
    return (
      post.network === SocialNetwork.DEVTO ||
      post.network === SocialNetwork.HASHNODE ||
      (post.network === SocialNetwork.LINKEDIN && post.contentType === ContentType.ARTICLE)
    );
  }

  emitPostVerified(post: Post, verifiedUrl: string): void {
    this.eventEmitter.emit(PostEvents.VERIFIED, {
      postId: post.id,
      network: post.network,
      postUrl: verifiedUrl,
      canonicalUrl: post.canonicalUrl ?? undefined,
      syndicatedUrl: verifiedUrl,
      contentType: post.contentType,
    } satisfies PostVerifiedEvent);
  }

  /**
   * P1-04a: Verify a published post is actually live before emitting POST_VERIFIED.
   *
   * - Article posts (Dev.to, Hashnode, LinkedIn long-form): article poster navigates
   *   to the published URL and uses LLM-in-the-loop to confirm the article is visible.
   * - Social posters already extracted a permalink after publish; URL-pattern
   *   validation is treated as the verification.
   *
   * Returns the verified URL on success, or null if verification fails (caller should
   * retry the job without re-posting).
   */
  async verifyPublishedPost(
    post: Post,
    context: BrowserContext,
    url: string,
  ): Promise<string | null> {
    // Article networks: re-open the published URL and ask the LLM to confirm it is live.
    if (this.isArticleNetwork(post)) {
      const poster = await this.posterRegistry.resolveArticlePoster(post);
      if (poster instanceof Error) {
        this.logger.warn(`Cannot verify article: ${poster.message}`);
        return null;
      }
      if (!post.canonicalUrl) {
        this.logger.warn(`Article ${post.id} is visible but canonical URL is missing`);
        return null;
      }
      return poster.verifyPosted(context, url, post.canonicalUrl);
    }

    if (this.isValidPostUrl(url, post.network)) {
      return url;
    }
    return null;
  }

  /**
   * P1-04a: Re-verify a POSTED post without re-publishing it.
   * Used when a prior verification attempt failed and BullMQ re-dispatches the job.
   */
  async reverifyPost(post: Post): Promise<PostingResult> {
    if (!post.postUrl) {
      return { success: false, error: "POSTED post has no URL to verify", retryable: false };
    }

    // Social/short-form posts: URL-pattern validation is sufficient, no browser session needed.
    if (!this.isArticleNetwork(post)) {
      if (this.isValidPostUrl(post.postUrl, post.network)) {
        await this.postsService.updateStatus(post.id, {
          status: PostStatus.VERIFIED,
          postUrl: post.postUrl,
        });
        this.emitPostVerified(post, post.postUrl);
        return { success: true, url: post.postUrl };
      }
      return { success: false, error: "Post URL validation failed", retryable: true };
    }

    this.logger.log(`Re-verifying POSTED article ${post.id} on ${post.network}`);

    const session = await this.sessionsService.getOrCreateSession(post.accountId, post.network, {
      deferFormLogin: true,
    });
    if (!session) {
      return { success: false, error: "No active session for re-verification", retryable: true };
    }

    const storageStateStr = session.storageState
      ? this.sessionsService.decryptStorageState(session)
      : undefined;
    const context = await this.browser.acquireContext(
      post.network,
      storageStateStr,
      post.accountId,
    );
    try {
      const verifiedUrl = await this.verifyPublishedPost(post, context, post.postUrl);
      if (!verifiedUrl) {
        return { success: false, error: "Post verification failed", retryable: true };
      }

      await this.postsService.updateStatus(post.id, {
        status: PostStatus.VERIFIED,
        postUrl: verifiedUrl,
      });
      this.emitPostVerified(post, verifiedUrl);

      return { success: true, url: verifiedUrl };
    } finally {
      if (context) {
        this.browser.releaseContext(post.network, context, post.accountId);
      }
    }
  }

  /**
   * H2: universal "is this content already published?" check, used before any (re)post.
   * Scrapes our own public profile (via the per-network poster's verifyPosted) and returns
   * a *valid* post URL if a post with this content is already live, else null. Shared by the
   * pre-retry guard (avoid a duplicate when a network error strikes after submit) and the
   * session-expiry self-recovery loop. Best-effort + fail-safe: any error → null (caller posts).
   */
  async findLivePostUrl(
    post: { network: SocialNetwork; content: string; contentType: ContentType },
    context: BrowserContext,
  ): Promise<string | null> {
    const { network, content, contentType } = post;
    const poster = this.posterRegistry.getPoster(network, contentType) as {
      verifyPosted?: (ctx: BrowserContext, content: string) => Promise<string | null>;
    } | null;
    if (!poster || typeof poster.verifyPosted !== "function") return null;
    const url = await poster.verifyPosted(context, content).catch(() => null);
    return url && this.isValidPostUrl(url, network) ? url : null;
  }
}
