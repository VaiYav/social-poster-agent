import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { AccountsService } from '../accounts/accounts.service';
import { SessionsService } from '../sessions/sessions.service';
import { WarmupService } from '../sessions/warmup.service.js';
import { PostsService } from '../posts/posts.service';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { XPoster } from './posters/x.poster';
import { ThreadsPoster } from './posters/threads.poster';
import { FacebookPoster } from './posters/facebook.poster';
import { PostStatus, SocialNetwork } from '@prisma/client';

/**
 * Posting service — orchestrates browser-based posting.
 *
 * Flow: load approved post → rate limit check → get/create session →
 *       open browser → post → update status → SSE event → record rate
 *
 * Rate limiting (G-3): Redis sliding window per network.
 *   checkRateLimit() before posting, recordPost() after success.
 *   If rate limited → defer (BullMQ will retry with backoff).
 *
 * SSE events (G-4): publish post_status on every status transition.
 *   Events: POSTING, POSTED, FAILED — UI receives via /events/sse.
 *
 * Idempotent: checks post status before posting (won't double-post).
 * With BullMQ: enqueue() adds job to queue, worker calls postById().
 */
@Injectable()
export class PostingService {
  private readonly logger = new Logger(PostingService.name);

  constructor(
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly accountsService: AccountsService,
    private readonly sessionsService: SessionsService,
    private readonly warmupService: WarmupService,
    private readonly postsService: PostsService,
    private readonly rateLimitService: RateLimitService,
    private readonly sseService: SseService,
    private readonly xPoster: XPoster,
    private readonly threadsPoster: ThreadsPoster,
    private readonly facebookPoster: FacebookPoster,
  ) {}

  async postById(postId: string): Promise<{ success: boolean; url?: string; error?: string }> {
    const post = await this.postsService.findById(postId);

    // Idempotent — don't post if already posted/posting
    if (post.status === PostStatus.POSTED) {
      return { success: true, url: post.postUrl ?? undefined };
    }
    if (post.status === PostStatus.POSTING) {
      return { success: false, error: 'Post is already being posted' };
    }
    if (post.status !== PostStatus.APPROVED) {
      throw new NotFoundException(`Post ${postId} is not approved (status: ${post.status})`);
    }

    // G-3: Rate limit check — if not allowed, defer (throw for BullMQ retry)
    const networkKey = post.network as string;
    const rateCheck = await this.rateLimitService.checkRateLimit(networkKey);
    if (!rateCheck.allowed) {
      this.logger.warn(`Rate limited for ${networkKey}: ${rateCheck.reason}`);
      // Throw so BullMQ retries with backoff — the rate window will have passed by then
      throw new Error(`Rate limited: ${rateCheck.reason}`);
    }

    // F20: Warm-up check — skip posting if account is in browse-only warm-up phase
    const canPost = await this.warmupService.canPost(post.accountId);
    if (!canPost) {
      this.logger.warn(`Account ${post.accountId} is in warm-up (browse-only) — deferring post ${postId}`);
      throw new Error('Account in warm-up phase (browse-only) — posting deferred');
    }

    // Mark as POSTING
    await this.postsService.updateStatus(postId, { status: PostStatus.POSTING });

    // G-4: SSE event — POSTING
    await this.sseService.publish({
      type: 'post_status',
      postId,
      status: 'POSTING',
      network: networkKey,
    });

    try {
      // Get or create session (auto-login if needed — OQ-8)
      const session = await this.sessionsService.getOrCreateSession(post.network);
      if (!session) {
        throw new Error(`No active session for ${post.network} — auto-login failed`);
      }

      // Create browser context with saved storageState
      const storageState = session.storageState ? JSON.stringify(session.storageState) : undefined;
      const context = await this.browser.createContext(post.network, storageState);

      // Post via the appropriate poster
      let result: { url?: string; error?: string };
      switch (post.network) {
        case SocialNetwork.X:
          result = await this.xPoster.post(context, this.browser, post.content);
          break;
        case SocialNetwork.THREADS:
          result = await this.threadsPoster.post(context, this.browser, post.content);
          break;
        case SocialNetwork.FACEBOOK:
          result = await this.facebookPoster.post(context, this.browser, post.content);
          break;
        default:
          throw new Error(`Unknown network: ${post.network as string}`);
      }

      // Save updated session state
      const updatedState = await this.browser.saveStorageState(context);
      await this.sessionsService.updateStorageState(session.id, updatedState);
      await context.close();

      if (result.error) {
        await this.postsService.updateStatus(postId, {
          status: PostStatus.FAILED,
          errorMessage: result.error,
        });

        // G-4: SSE event — FAILED
        await this.sseService.publish({
          type: 'post_status',
          postId,
          status: 'FAILED',
          network: networkKey,
          error: result.error,
        });

        return { success: false, error: result.error };
      }

      // Validate post URL — reject homepage URLs (post likely didn't publish correctly)
      if (result.url) {
        const isValidUrl = this.isValidPostUrl(result.url, post.network);
        if (!isValidUrl) {
          const errorMsg = `Post URL validation failed: ${result.url} is not a valid post URL (likely homepage)`;
          this.logger.error(errorMsg);
          await this.postsService.updateStatus(postId, {
            status: PostStatus.FAILED,
            errorMessage: errorMsg,
            postUrl: result.url,
          });

          await this.sseService.publish({
            type: 'post_status',
            postId,
            status: 'FAILED',
            network: networkKey,
            error: errorMsg,
          });

          return { success: false, error: errorMsg };
        }
      }

      await this.postsService.updateStatus(postId, {
        status: PostStatus.POSTED,
        postUrl: result.url,
      });

      // G-3: Record successful post for rate limiting
      await this.rateLimitService.recordPost(networkKey);

      // G-4: SSE event — POSTED
      await this.sseService.publish({
        type: 'post_status',
        postId,
        status: 'POSTED',
        network: networkKey,
        url: result.url,
      });

      this.logger.log(`Post ${postId} posted successfully to ${post.network as string}`);
      return { success: true, url: result.url };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Posting failed for ${postId}: ${message}`);
      await this.postsService.updateStatus(postId, {
        status: PostStatus.FAILED,
        errorMessage: message,
      });

      // G-4: SSE event — FAILED
      await this.sseService.publish({
        type: 'post_status',
        postId,
        status: 'FAILED',
        network: networkKey,
        error: message,
      });

      return { success: false, error: message };
    }
  }

  /**
   * Validate that a URL is a real post URL, not a homepage.
   * Each network has a different post URL pattern:
   *   X: https://x.com/{user}/status/{digits}
   *   Threads: https://www.threads.com/@{user}/post/{id}
   *   Facebook: https://www.facebook.com/{page}/posts/{digits} or /permalink/{id}
   */
  private isValidPostUrl(url: string, network: SocialNetwork): boolean {
    if (!url || url.trim() === '') return false;

    // Reject obvious homepage URLs
    const homepagePatterns: Record<SocialNetwork, RegExp[]> = {
      [SocialNetwork.X]: [/^https?:\/\/(www\.)?x\.com\/?$/, /^https?:\/\/(www\.)?x\.com\/home\/?$/],
      [SocialNetwork.THREADS]: [/^https?:\/\/(www\.)?threads\.com\/?$/, /^https?:\/\/(www\.)?threads\.com\/@[^/]+\/?$/],
      [SocialNetwork.FACEBOOK]: [/^https?:\/\/(www\.)?facebook\.com\/?$/, /^https?:\/\/(www\.)?facebook\.com\/[^/]+\/?$/],
    };

    for (const pattern of homepagePatterns[network]) {
      if (pattern.test(url)) return false;
    }

    // Check for post-specific patterns
    const postPatterns: Record<SocialNetwork, RegExp> = {
      [SocialNetwork.X]: /\/status\/[A-Za-z0-9]+/,
      [SocialNetwork.THREADS]: /\/@[^/]+\/post\/[A-Za-z0-9_-]+/,
      [SocialNetwork.FACEBOOK]: /\/(posts|permalink|photos)\/\d+/,
    };

    return postPatterns[network].test(url);
  }

  /**
   * Post all approved posts (batch mode).
   * D1 fix: handles rate-limit and warm-up gracefully (skip instead of throw).
   */
  async postAllApproved(): Promise<{ posted: number; failed: number; skipped: number }> {
    const { posts } = await this.postsService.findMany({
      status: PostStatus.APPROVED,
      limit: 50,
      offset: 0,
    });

    let posted = 0;
    let failed = 0;
    let skipped = 0;

    for (const post of posts) {
      try {
        const result = await this.postById(post.id);
        if (result.success) {
          posted++;
        } else {
          failed++;
        }
      } catch (err) {
        // D1: Rate-limited or warm-up posts are skipped, not failed
        const msg = (err as Error).message;
        if (msg.includes('Rate limited') || msg.includes('warm-up')) {
          this.logger.warn(`Skipping post ${post.id}: ${msg}`);
          skipped++;
        } else {
          this.logger.error(`Failed to post ${post.id}: ${msg}`);
          failed++;
        }
      }
      // Human-like delay between posts (CONSTITUTION §9)
      await this.browser.randomDelay(10000, 30000);
    }

    this.logger.log(`Batch posting: ${posted} posted, ${failed} failed, ${skipped} skipped`);
    return { posted, failed, skipped };
  }
}
