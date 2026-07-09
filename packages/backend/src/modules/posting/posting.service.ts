import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { IBrowserPort } from '../../domain/ports/browser.port.js';
import { AccountsService } from '../accounts/accounts.service';
import { SessionsService } from '../sessions/sessions.service';
import { WarmupService } from '../sessions/warmup.service.js';
import { PostsService } from '../posts/posts.service';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { SseService } from '../../infrastructure/sse/sse.service.js';
import { QueueFactory } from '../../infrastructure/queue/queue.factory.js';
import { ThreadProgressService } from './thread-progress.service.js';
import { FlowControlService } from '../flow-control/flow-control.service.js';
import { XPoster } from './posters/x.poster';
import { ThreadsPoster } from './posters/threads.poster';
import { FacebookPoster } from './posters/facebook.poster';
import type { PostResult } from './posters/base.poster.js';
import { Post, PostStatus, SocialNetwork } from '@prisma/client';
import { withRetry } from '../../domain/retry.js';
import { CircuitBreakerRegistry, CircuitOpenError } from '../../domain/circuit-breaker.js';
import { SpaError } from '../../domain/errors.js';
import { isNetworkEnabled } from '../../domain/enabled-networks.js';
import { ContentPillarTracker } from '../content-enhancements/content-pillar.tracker.js';
import type { SourceRef } from '@spa/shared';

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
  private readonly circuitBreakers: CircuitBreakerRegistry = new CircuitBreakerRegistry();

  /**
   * Determine whether a posting failure should be retried by the queue worker.
   * Falls back to true for session-expiry/self-recovery signals, false for
   * generic Errors, and respects SpaError.retryable when available.
   */
  private isRetryableError(err: unknown, result?: PostResult): boolean {
    if (result?.retryable !== undefined) return result.retryable;
    if (err instanceof SpaError) return err.retryable;
    const message = (err as Error | undefined)?.message ?? String(err);
    if (/session expired.*deferred retry/i.test(message)) return true;
    return false;
  }

  constructor(
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly accountsService: AccountsService,
    private readonly sessionsService: SessionsService,
    private readonly warmupService: WarmupService,
    private readonly postsService: PostsService,
    private readonly rateLimitService: RateLimitService,
    private readonly sseService: SseService,
    private readonly threadProgressService: ThreadProgressService,
    private readonly xPoster: XPoster,
    private readonly threadsPoster: ThreadsPoster,
    private readonly facebookPoster: FacebookPoster,
    @Optional() private readonly queueFactory?: QueueFactory,
    @Optional() private readonly flowControl?: FlowControlService,
    @Optional() private readonly pillarTracker?: ContentPillarTracker,
  ) {}

  /**
   * 2.8.2: Record a successfully posted draft against its content pillar.
   * Non-blocking — pillar tracking is not a posting dependency.
   */
  private async recordPostPillar(post: { sourceRef: unknown; content: string }): Promise<void> {
    if (!this.pillarTracker) return;
    const sourceRef = post.sourceRef as SourceRef | null | undefined;
    const topic = sourceRef?.topic ?? sourceRef?.originalTopic ?? post.content;
    const keywords = sourceRef?.keywords ?? [];
    try {
      await this.pillarTracker.recordPost(topic, keywords);
    } catch (err) {
      this.logger.debug(`P6: Pillar recording failed (non-blocking): ${(err as Error).message}`);
    }
  }

  async postById(postId: string): Promise<{ success: boolean; url?: string; error?: string; retryable?: boolean }> {
    const post = await this.postsService.findById(postId);

    // Network gating — skip posts for disabled networks (e.g. Facebook)
    if (!isNetworkEnabled(post.network)) {
      this.logger.warn(`Post ${postId} is for ${post.network as string} — network disabled, marking as SKIPPED`);
      await this.postsService.updateStatus(postId, {
        status: PostStatus.FAILED,
        errorMessage: `Network ${post.network as string} is disabled (ENABLED_NETWORKS)`,
      }).catch(() => {});
      // Config-level, not transient — retrying can never succeed, so don't burn the
      // full postingMaxRetries budget on it (see queue.module.ts worker).
      return { success: false, error: `Network ${post.network as string} is disabled`, retryable: false };
    }

    // ADR-006: Flow control — skip if posting is paused (crisis mode)
    if (this.flowControl && await this.flowControl.isPaused('posting')) {
      this.logger.warn(`Posting flow is paused — deferring post ${postId}`);
      throw new Error('Posting flow is paused — job will retry when resumed');
    }

    // Idempotent — don't post if already posted/posting
    if (post.status === PostStatus.POSTED) {
      return { success: true, url: post.postUrl ?? undefined };
    }
    if (post.status === PostStatus.POSTING) {
      // With concurrency=1 and jobId=postId, the only way this branch is reached is
      // BullMQ's stalled-job recovery re-dispatching a job whose original worker died
      // mid-post (e.g. a redeploy) without ever transitioning the post out of POSTING.
      // Nothing will ever change that status from outside this method, so — same as
      // FAILED/REJECTED above — retrying just burns the full postingMaxRetries budget
      // returning this exact message every time. Confirmed live: job attempts 5/8 with
      // no progress. Not marking the post FAILED here (only stopping the retry): the
      // original invocation could still be genuinely in-flight, and writing FAILED from
      // this branch could race with its own eventual POSTED/FAILED update.
      this.logger.warn(`Post ${postId} is already POSTING — not retrying (likely orphaned by a worker restart)`);
      return { success: false, error: 'Post is already being posted', retryable: false };
    }
    // FAILED/REJECTED are terminal — a prior attempt already resolved this post, and
    // retrying postById() on the same postId (BullMQ jobId = postId) will hit this exact
    // branch every time forever. Confirmed live: jobs kept throwing and burning through
    // the full postingMaxRetries budget (8 attempts) after a post was marked FAILED by an
    // earlier posting error, identical to the disabled-network case above.
    if (post.status === PostStatus.FAILED || post.status === PostStatus.REJECTED) {
      this.logger.warn(`Post ${postId} is already ${post.status} — not retrying`);
      return { success: false, error: `Post ${postId} is ${post.status}, not retryable`, retryable: false };
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

    // P0-H1: Context leak fix — track context so it's always released in finally.
    // Sprint K: Use context pool (acquireContext/releaseContext) instead of
    // createContext/context.close — enables parallel posting across networks
    // with shared browser instance and context reuse.
    let context: Awaited<ReturnType<IBrowserPort['acquireContext']>> | null = null;

    try {
      // Get or create session (auto-login if needed — OQ-8).
      // SE1: defer inline username/password form login off the posting path when
      // SESSION_DEFERRED_LOGIN is on — return null → retry while the out-of-band
      // refreshSessionsCron performs the controlled re-login.
      const session = await this.sessionsService.getOrCreateSession(post.network, { deferFormLogin: true });
      if (!session) {
        throw new Error(`No active session for ${post.network} — auto-login deferred or failed (will retry)`);
      }

      // Acquire browser context from pool (reuses idle contexts, waits if at capacity)
      // P0-H3: Decrypt storageState if encrypted (v1: prefix).
      const storageStateStr = session.storageState
        ? this.sessionsService.decryptStorageState(session)
        : undefined;
      context = await this.browser.acquireContext(post.network, storageStateStr);

      // P0-2 fix: If this is a root post (threadPosition=0) with a threadId,
      // load continuation posts (position > 0) and pass them as threadItems.
      // This enables multi-stage posting (F2) — hook + continuation as a thread.
      // P0-H2: Load full post objects (not just content) for per-reply tracking.
      // P0-H2: Persist per-reply progress to ThreadProgress table so a crash
      // mid-thread leaves a recoverable record of which replies were posted.
      const threadItems: string[] = [];
      let threadPosts: Post[] = [];
      if (post.threadId && post.threadPosition === 0) {
        threadPosts = await this.postsService.findThreadContinuations(post.threadId);
        threadItems.push(...threadPosts.map((p) => p.content));
        if (threadItems.length > 0) {
          this.logger.log(`P0-2: Post ${postId} is root of thread ${post.threadId} with ${threadItems.length} continuation(s)`);
          // P0-H2: Initialize persistent per-reply tracking (idempotent — safe to call on resume)
          await this.threadProgressService.initThread(
            postId,
            threadPosts.map((p) => ({ id: p.id, threadPosition: p.threadPosition })),
          );
        }
      }

      // Post via the appropriate poster — with retry on transient/network errors.
      // Only retry for NetworkError (transient). SelectorNotFoundError, ValidationError,
      // AccountRestrictedError, etc. are NOT retried (need code fix or manual intervention).
      // Reference: twscrape retries network errors infinitely, locks on unknown errors.
      let postAttempt = 0;
      const postFn = async (): Promise<PostResult> => {
        postAttempt++;
        // H2: a network error (Timeout / net::ERR) can strike AFTER the post was already
        // submitted — e.g. while navigating to the profile to capture the permalink. Without
        // this guard, withRetry would re-run postFn and submit a DUPLICATE. On any retry,
        // first verify the previous attempt didn't already publish; if it did, return that
        // URL instead of re-posting. Single posts only — threads have their own per-reply
        // ThreadProgress idempotency, and a partial-thread re-post must not be short-circuited.
        if (postAttempt > 1 && context && threadItems.length === 0) {
          const live = await this.findLivePostUrl(post.network, context, post.content);
          if (live) {
            this.logger.warn(
              `Pre-retry verify: post ${postId} already live (${live}) — skipping duplicate re-submit`,
            );
            return { url: live };
          }
        }
        switch (post.network) {
          case SocialNetwork.X:
            return this.xPoster.post(context!, this.browser, post.content, threadItems.length > 0 ? threadItems : undefined);
          case SocialNetwork.THREADS:
            return this.threadsPoster.post(context!, this.browser, post.content, threadItems.length > 0 ? threadItems : undefined);
          case SocialNetwork.FACEBOOK:
            return this.facebookPoster.post(context!, this.browser, post.content);
          default:
            throw new Error(`Unknown network: ${post.network as string}`);
        }
      };

      let result: PostResult;
      try {
        result = await withRetry(postFn, {
          maxRetries: 2,
          baseDelayMs: 5000,
          maxDelayMs: 30000,
          jitter: 0.25,
          retryable: (err) => {
            // Only retry transient/network errors
            if (err instanceof SpaError) {
              return err.retryable;
            }
            const msg = (err as Error).message ?? String(err);
            return (
              msg.includes('net::ERR') ||
              msg.includes('ECONNREFUSED') ||
              msg.includes('ETIMEDOUT') ||
              msg.includes('Timeout') ||
              msg.includes('Navigation failed') ||
              // Browser/context crash — Camoufox pages close unexpectedly under load.
              // Retry with a fresh context (onRetry re-acquires below).
              msg.includes('Target page, context or browser has been closed') ||
              msg.includes('Page is closed') ||
              msg.includes('browserContext.storageState') ||
              msg.includes('Target page, context or browser')
            );
          },
          onRetry: async (attempt, delayMs, err) => {
            this.logger.warn(
              `Posting retry ${attempt} for ${postId} after ${(err as Error).message} — waiting ${delayMs}ms`,
            );
            // Browser crash recovery: release the dead context and acquire a fresh one.
            // The old context's pages are closed — reusing it would fail immediately.
            const errMsg = (err as Error).message ?? '';
            const isBrowserCrash =
              errMsg.includes('Target page, context or browser has been closed') ||
              errMsg.includes('Page is closed') ||
              errMsg.includes('browserContext.storageState');
            if (isBrowserCrash && context) {
              this.logger.warn(`Browser crash detected — releasing dead context and acquiring fresh one for ${postId}`);
              try { this.browser.releaseContext(post.network, context); } catch { /* dead context */ }
              context = null;
              try {
                context = await this.browser.acquireContext(post.network, storageStateStr);
                this.logger.log(`Fresh context acquired for retry ${attempt} of ${postId}`);
              } catch (acquireErr) {
                this.logger.error(`Failed to acquire fresh context for retry: ${(acquireErr as Error).message}`);
              }
            }
          },
        });
      } catch (retryErr) {
        // All retries exhausted — classify and return error
        if (retryErr instanceof CircuitOpenError) {
          throw retryErr;
        }
        const message = (retryErr as Error).message;
        this.logger.error(`Posting failed after retries for ${postId}: ${message}`);
        throw retryErr;
      }

      // ── Self-recovery on session expiry ──
      // If the poster returned a "Not logged in" error (session expired mid-post),
      // attempt re-login and retry the posting operation with exponential backoff.
      //
      // Two-phase recovery:
      //   Phase 1: 3 immediate attempts with 5s/10s/20s delays (fast retry)
      //   Phase 2: If all 3 fail, throw a retryable error so BullMQ re-queues the job
      //            with exponential backoff (default 60s → 120s → 240s...).
      //            The post stays in POSTING status (not FAILED) so it gets retried
      //            instead of being abandoned. After BullMQ exhausts its retries
      //            (default 8), the job goes to DLQ and the post is marked FAILED
      //            by the queue error handler.
      if (result.error && /not logged in|session expired|relogin/i.test(result.error)) {
        const maxRecoveryAttempts = 3;
        let recoverySucceeded = false;
        let lastRecoveryError = result.error;
        let lastSessionId = session.id;

        for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt++) {
          const delayMs = 5000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
          this.logger.warn(
            `Session expired for ${post.network} post ${postId} — self-recovery attempt ${attempt}/${maxRecoveryAttempts} (waiting ${delayMs}ms)`,
          );
          await this.browser.randomDelay(delayMs, delayMs * 2);

          try {
            // Release the expired context
            if (context) {
              try {
                this.browser.releaseContext(post.network, context);
              } catch {
                // non-blocking
              }
              context = null;
            }
            // Mark the last session as EXPIRED so getOrCreateSession creates a fresh one
            await this.sessionsService
              .markSessionExpired(post.network, lastSessionId)
              .catch(() => {});
            // Force re-login (getOrCreateSession will auto-login if no active session)
            const freshSession = await this.sessionsService.getOrCreateSession(post.network);
            if (!freshSession || freshSession.id === lastSessionId) {
              this.logger.error(
                `Self-recovery attempt ${attempt} failed for ${postId} — could not create fresh session`,
              );
              continue;
            }
            lastSessionId = freshSession.id;
            this.logger.log(`Self-recovery attempt ${attempt}: new session ${freshSession.id} created for ${post.network}`);
            const freshStorage = freshSession.storageState
              ? this.sessionsService.decryptStorageState(freshSession)
              : undefined;
            context = await this.browser.acquireContext(post.network, freshStorage);

            // M1/P3 + H2: before re-posting, verify the original attempt didn't already
            // publish — skip the re-post to avoid a duplicate (success-detection can misfire
            // into a "session expired"-looking error). Shared guard with the pre-retry path.
            const existingUrl = await this.findLivePostUrl(post.network, context, post.content);
            if (existingUrl) {
              this.logger.warn(
                `Self-recovery: post ${postId} is already live (${existingUrl}) — skipping re-post to avoid a duplicate`,
              );
              const recoveredState = await this.browser.saveStorageState(context);
              await this.sessionsService.updateStorageState(freshSession.id, recoveredState);
              result = { url: existingUrl };
              recoverySucceeded = true;
              break;
            }

            // Retry posting with fresh context
            result = await postFn();
            if (result.error) {
              lastRecoveryError = result.error;
              this.logger.error(
                `Self-recovery attempt ${attempt} still failed for ${postId}: ${result.error}`,
              );
            } else {
              this.logger.log(`Self-recovery succeeded on attempt ${attempt} for ${postId} — post published`);
              // Save fresh session state
              const updatedState = await this.browser.saveStorageState(context);
              await this.sessionsService.updateStorageState(freshSession.id, updatedState);
              recoverySucceeded = true;
              break;
            }
          } catch (recoveryErr) {
            lastRecoveryError = (recoveryErr as Error).message;
            this.logger.error(
              `Self-recovery error on attempt ${attempt} for ${postId}: ${lastRecoveryError}`,
            );
          }
        }

        if (!recoverySucceeded) {
          // Phase 2: throw a retryable error so BullMQ re-queues with backoff.
          // The post stays in POSTING status — BullMQ will retry the job later.
          // This gives the session time to recover (cookies refresh, rate limits clear, etc.)
          this.logger.warn(
            `All ${maxRecoveryAttempts} immediate self-recovery attempts exhausted for ${postId} — ` +
            `throwing for BullMQ deferred retry (will retry with exponential backoff)`,
          );
          // Release context before throwing (finally block will also try, but context may be null here)
          if (context) {
            try { this.browser.releaseContext(post.network, context); } catch { /* non-blocking */ }
            context = null;
          }
          // Reset status to APPROVED so the retry can pick it up cleanly
          await this.postsService.updateStatus(postId, { status: PostStatus.APPROVED }).catch(() => {});
          throw new Error(`Session expired — deferred retry pending: ${lastRecoveryError}`);
        }
      }

      // Save updated session state (context may be null if self-recovery released it)
      if (context) {
        const updatedState = await this.browser.saveStorageState(context);
        await this.sessionsService.updateStorageState(session.id, updatedState);
      }

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

        return { success: false, error: result.error, retryable: this.isRetryableError(undefined, result) };
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

          return { success: false, error: errorMsg, retryable: false };
        }
      }

      await this.postsService.updateStatus(postId, {
        status: PostStatus.POSTED,
        postUrl: result.url,
      });

      // 2.8.2: Record the root post against its pillar (only after POSTED).
      await this.recordPostPillar(post);

      // P0-H2: If this was a thread root with continuations, mark them individually
      // based on per-reply results. Previously all continuations were marked POSTED
      // atomically — but if some replies failed, those should be marked FAILED.
      if (threadPosts.length > 0 && post.threadId && result.threadReplyResults) {
        for (let i = 0; i < threadPosts.length; i++) {
          const cp = threadPosts[i];
          if (!cp) continue;
          const replyResult = result.threadReplyResults[i];
          if (replyResult?.success) {
            await this.postsService.updateStatus(cp.id, {
              status: PostStatus.POSTED,
              postUrl: result.url,
            });
            await this.sseService.publish({
              type: 'post_status',
              postId: cp.id,
              status: 'POSTED',
              network: networkKey,
              url: result.url,
            });
            // P0-H2: Persist per-reply success for crash recovery
            await this.threadProgressService.markReplyPosted(postId, cp.id, result.url ?? '');
            // 2.8.2: Record continuation post against its pillar (only after POSTED).
            await this.recordPostPillar(cp);
          } else {
            // P0-H2: Mark failed replies individually
            const replyError = replyResult?.error ?? 'Thread reply failed';
            await this.postsService.updateStatus(cp.id, {
              status: PostStatus.FAILED,
              errorMessage: replyError,
            });
            await this.sseService.publish({
              type: 'post_status',
              postId: cp.id,
              status: 'FAILED',
              network: networkKey,
              error: replyError,
            });
            // P0-H2: Persist per-reply failure for crash recovery
            await this.threadProgressService.markReplyFailed(postId, cp.id, replyError);
          }
        }
        const succeededCount = result.threadReplyResults.filter((r: { success: boolean }) => r.success).length;
        const failedCount = result.threadReplyResults.filter((r: { success: boolean }) => !r.success).length;
        this.logger.log(
          `P0-H2: Thread ${post.threadId}: ${succeededCount} replies POSTED, ${failedCount} FAILED`,
        );
      } else if (threadItems.length > 0 && post.threadId) {
        // Fallback: no per-reply results (shouldn't happen with updated posters)
        const continuationPosts = await this.postsService.findThreadContinuations(post.threadId);
        for (const cp of continuationPosts) {
          await this.postsService.updateStatus(cp.id, {
            status: PostStatus.POSTED,
            postUrl: result.url,
          });
          await this.sseService.publish({
            type: 'post_status',
            postId: cp.id,
            status: 'POSTED',
            network: networkKey,
            url: result.url,
          });
          // P0-H2: Persist per-reply success for crash recovery
          await this.threadProgressService.markReplyPosted(postId, cp.id, result.url ?? '');
          // 2.8.2: Record continuation post against its pillar (only after POSTED).
          await this.recordPostPillar(cp);
        }
        this.logger.log(`P0-2: Marked ${continuationPosts.length} continuation post(s) as POSTED for thread ${post.threadId}`);
      }

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
      // P0-H1: Preserve SpaError retry semantics — don't wrap in generic Error.
      // Previously all errors became generic Error, losing SpaError retry info.
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

      return { success: false, error: message, retryable: this.isRetryableError(err) };
    } finally {
      // Sprint K: Release context back to pool for reuse (instead of closing).
      // P0-H1: Guaranteed cleanup regardless of outcome — prevents context leaks.
      if (context) {
        this.browser.releaseContext(post.network, context);
      }
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
      [SocialNetwork.THREADS]: /(?:\/@[^/]+\/post\/|\/t\/)[A-Za-z0-9_-]+/,
      [SocialNetwork.FACEBOOK]: /\/(posts|permalink|photos)\/\d+/,
    };

    return postPatterns[network].test(url);
  }

  /** Resolve the concrete poster for a network (used for verification + posting). */
  private getPoster(network: SocialNetwork) {
    switch (network) {
      case SocialNetwork.X:
        return this.xPoster;
      case SocialNetwork.THREADS:
        return this.threadsPoster;
      case SocialNetwork.FACEBOOK:
        return this.facebookPoster;
      default:
        throw new Error(`Unknown network: ${network as string}`);
    }
  }

  /**
   * H2: universal "is this content already published?" check, used before any (re)post.
   * Scrapes our own public profile (via the per-network poster's verifyPosted) and returns
   * a *valid* post URL if a post with this content is already live, else null. Shared by the
   * pre-retry guard (avoid a duplicate when a network error strikes after submit) and the
   * session-expiry self-recovery loop. Best-effort + fail-safe: any error → null (caller posts).
   */
  private async findLivePostUrl(
    network: SocialNetwork,
    context: Awaited<ReturnType<IBrowserPort['acquireContext']>>,
    content: string,
  ): Promise<string | null> {
    const poster = this.getPoster(network);
    if (typeof poster.verifyPosted !== 'function') return null;
    const url = await poster.verifyPosted(context, content).catch(() => null);
    return url && this.isValidPostUrl(url, network) ? url : null;
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
      // Skip disabled networks
      if (!isNetworkEnabled(post.network)) {
        this.logger.debug(`Skipping post ${post.id} — ${post.network as string} is disabled`);
        skipped++;
        continue;
      }
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

  /**
   * F2: Schedule multi-stage thread posting with delayed continuations.
   *
   * Root post (threadPosition=0) is enqueued immediately.
   * Each continuation (threadPosition=1,2,...) is enqueued with a delay of
   *   position × THREAD_CONTINUATION_DELAY_MS (default: 30 minutes).
   *
   * This creates a natural, human-like cadence between thread replies rather
   * than posting all replies in a single browser session.
   *
   * Requires QueueFactory — if not available (e.g. synchronous mode), falls
   * back to immediate postById() for the root only.
   *
   * @param rootPostId The root post ID (threadPosition=0)
   * @returns { scheduled: number; immediate: boolean } summary
   */
  async scheduleMultiStagePosting(rootPostId: string): Promise<{ scheduled: number; immediate: boolean }> {
    const rootPost = await this.postsService.findById(rootPostId);
    if (!rootPost.threadId || rootPost.threadPosition !== 0) {
      throw new Error(`Post ${rootPostId} is not a thread root (threadId missing or threadPosition != 0)`);
    }

    // Get all continuations sorted by position
    const continuations = await this.postsService.findThreadContinuations(rootPost.threadId);
    // Only schedule APPROVED continuations
    const approvedConts = continuations.filter((p) => p.status === PostStatus.APPROVED);

    if (!this.queueFactory) {
      // No queue — post root immediately, skip delayed scheduling
      this.logger.warn(`F2: No QueueFactory available — posting root ${rootPostId} immediately (no delayed continuations)`);
      await this.postById(rootPostId);
      return { scheduled: 0, immediate: true };
    }

    // Enqueue root post immediately (priority 1 = high)
    await this.queueFactory.enqueuePosting(rootPostId, rootPost.network, { priority: 1 });
    this.logger.log(`F2: Enqueued root post ${rootPostId} → ${rootPost.network} (immediate)`);

    // Enqueue continuations with delay = position × delayMs
    const delayMs = parseInt(process.env.THREAD_CONTINUATION_DELAY_MS ?? '1800000', 10); // default 30 min
    let scheduled = 0;
    for (const cont of approvedConts) {
      const delay = cont.threadPosition * delayMs;
      await this.queueFactory.enqueuePosting(cont.id, rootPost.network, {
        priority: 5, // lower priority than root
        delay,
      });
      scheduled++;
      this.logger.log(
        `F2: Enqueued continuation ${cont.id} (position ${cont.threadPosition}) → ${rootPost.network} (delay: ${Math.round(delay / 60000)}min)`,
      );
    }

    // SSE event — multi-stage scheduled
    await this.sseService.publish({
      type: 'post_status',
      postId: rootPostId,
      status: 'APPROVED',
      network: rootPost.network,
    });

    this.logger.log(
      `F2: Multi-stage thread scheduled — root ${rootPostId} + ${scheduled} continuations (delay: ${delayMs / 60000}min apart)`,
    );
    return { scheduled, immediate: false };
  }
}
