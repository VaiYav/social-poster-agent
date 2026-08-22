import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ModuleRef } from "@nestjs/core";
import { IBrowserPort } from "../../domain/ports/browser.port.js";
import { AccountsService } from "../accounts/accounts.service";
import { SessionsService } from "../sessions/sessions.service";
import { WarmupService } from "../sessions/warmup.service.js";
import { PostsService } from "../posts/posts.service";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { ThreadProgressService } from "./thread-progress.service.js";
import { LinkAttributionService } from "../link-attribution/link-attribution.service";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import { XPoster } from "./posters/x.poster";
import { ThreadsPoster } from "./posters/threads.poster";
import { FacebookPoster } from "./posters/facebook.poster";
import type { PostResult } from "./posters/base.poster.js";
import { Post, PostStatus, SocialNetwork, ContentType } from "../../generated/prisma/client";
import { PostEvents } from "../../events/enums/post-events.enum.js";
import { withRetry } from "../../domain/retry.js";
import { CircuitBreakerRegistry, CircuitOpenError } from "../../domain/circuit-breaker.js";
import { DevtoPoster } from "./posters/devto.poster.js";
import { HashnodePoster } from "./posters/hashnode.poster.js";
import { LinkedinPoster } from "./posters/linkedin.poster.js";
import { BlueskyPoster } from "./posters/bluesky.poster.js";
import { MastodonPoster } from "./posters/mastodon.poster.js";
import { LinkedinSocialPoster } from "./posters/linkedin-social.poster.js";
import { TelegramAdapter } from "../../infrastructure/telegram/telegram.adapter.js";
import { RetryableError, SpaError } from "../../domain/errors.js";
import { isNetworkEnabled } from "../../domain/enabled-networks.js";
import { ContentPillarTracker } from "../content-enhancements/content-pillar.tracker.js";
import { ABVariantService } from "../content-enhancements/ab-variant.service.js";
import type {
  SourceRef,
  PostingStartedEvent,
  PostPostedEvent,
  PostVerifiedEvent,
  PostFailedEvent,
} from "@spa/shared";

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

/** Networks that emit a POST_VERIFIED event after a successful publish. */
const VERIFIABLE_NETWORKS = new Set<SocialNetwork>([
  SocialNetwork.X,
  SocialNetwork.THREADS,
  SocialNetwork.FACEBOOK,
  SocialNetwork.DEVTO,
  SocialNetwork.HASHNODE,
  SocialNetwork.LINKEDIN,
  SocialNetwork.BLUESKY,
  SocialNetwork.MASTODON,
  SocialNetwork.TELEGRAM,
]);

@Injectable()
export class PostingService {
  private readonly logger = new Logger(PostingService.name);
  private readonly circuitBreakers: CircuitBreakerRegistry = new CircuitBreakerRegistry();

  /**
   * Determine whether a posting failure should be retried by the queue worker.
   * Respects explicit `retryable` flags on SpaErrors/PostResults, falls back to
   * false for generic Errors, and treats known transient deferrals
   * (rate limits, warm-up, paused flow, session recovery) as retryable.
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
    private readonly eventEmitter: EventEmitter2,
    private readonly threadProgressService: ThreadProgressService,
    private readonly xPoster: XPoster,
    private readonly threadsPoster: ThreadsPoster,
    private readonly facebookPoster: FacebookPoster,
    private readonly configService: ConfigService,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly queueFactory?: QueueFactory,
    @Optional() private readonly flowControl?: FlowControlService,
    @Optional() private readonly pillarTracker?: ContentPillarTracker,
    @Optional() private readonly abVariantService?: ABVariantService,
    @Optional() private readonly blueskyPoster?: BlueskyPoster,
    @Optional() private readonly mastodonPoster?: MastodonPoster,
    @Optional() private readonly linkedinSocialPoster?: LinkedinSocialPoster,
    @Optional() private readonly telegramAdapter?: TelegramAdapter,
    // M2.1: lead-funnel CTA assignment (zodiac short link / UTM fallback)
    @Optional() private readonly linkAttribution?: LinkAttributionService,
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

  /**
   * P7: Resolve the A/B variant that should be used for a post. Returns the
   * selected content and records the selection in PostVariant. Non-blocking.
   */
  private async resolveVariant(
    postId: string,
    network: SocialNetwork,
    content: string,
  ): Promise<string> {
    if (!this.abVariantService) return content;
    try {
      const selected = await this.abVariantService.selectAndApplyVariant(postId, network, content);
      return selected.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`A/B variant resolution failed for ${postId}: ${message}`);
      return content;
    }
  }

  private async recordVariantPosted(postId: string): Promise<void> {
    if (!this.abVariantService) return;
    await this.abVariantService.recordPosted(postId, new Date()).catch(() => {});
  }

  /**
   * P0-H4: Persist session state (cookies/localStorage) after a successful post.
   * Best-effort: if the browser context has already crashed/closed, storageState()
   * can throw "browserContext.storageState: Target page, context or browser has been
   * closed". In that case the post itself is already live, so we must NOT mark it
   * FAILED just because we could not save the session. We log the degradation and
   * continue — the next post will re-login if needed.
   */
  private async persistSessionState(
    context: Awaited<ReturnType<IBrowserPort["acquireContext"]>>,
    sessionId: string,
    postId: string,
  ): Promise<void> {
    try {
      const state = await this.browser.saveStorageState(context);
      await this.sessionsService.updateStorageState(sessionId, state);
    } catch (err) {
      this.logger.warn(
        `Failed to persist session state for post ${postId}: ${(err as Error).message}`,
      );
    }
  }

  async postById(postId: string): Promise<{
    success: boolean;
    url?: string;
    error?: string;
    retryable?: boolean;
    rateLimit?: boolean;
    retryAfterMs?: number;
  }> {
    const post = await this.postsService.findById(postId);

    // Network gating — skip posts for disabled networks (e.g. Facebook)
    if (!isNetworkEnabled(post.network)) {
      this.logger.warn(
        `Post ${postId} is for ${post.network} — network disabled, marking as SKIPPED`,
      );
      await this.postsService
        .updateStatus(postId, {
          status: PostStatus.FAILED,
          errorMessage: `Network ${post.network} is disabled (ENABLED_NETWORKS)`,
        })
        .catch(() => {});
      // Config-level, not transient — retrying can never succeed, so don't burn the
      // full postingMaxRetries budget on it (see queue.module.ts worker).
      return { success: false, error: `Network ${post.network} is disabled`, retryable: false };
    }

    // ADR-006: Flow control — skip if posting is paused (crisis mode)
    if (this.flowControl && (await this.flowControl.isPaused("posting"))) {
      this.logger.warn(`Posting flow is paused — deferring post ${postId}`);
      throw new RetryableError(
        post.network,
        "Posting flow is paused — job will retry when resumed",
      );
    }

    // Idempotent — don't post if already verified
    if (post.status === PostStatus.VERIFIED) {
      return { success: true, url: post.postUrl ?? undefined };
    }

    // P1-04a: A POSTED post that hasn't been verified yet can be re-verified on a
    // retry. This avoids the case where a publish succeeds but verification fails,
    // leaving the post stuck in POSTED and never emitting POST_VERIFIED.
    if (post.status === PostStatus.POSTED) {
      if (post.postUrl) {
        return this.reverifyPost(post);
      }
      // POSTED with no URL is an inconsistent state — proceed to post again.
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
      this.logger.warn(
        `Post ${postId} is already POSTING — not retrying (likely orphaned by a worker restart)`,
      );
      return { success: false, error: "Post is already being posted", retryable: false };
    }
    // FAILED/REJECTED are terminal — a prior attempt already resolved this post, and
    // retrying postById() on the same postId (BullMQ jobId = postId) will hit this exact
    // branch every time forever. Confirmed live: jobs kept throwing and burning through
    // the full postingMaxRetries budget (8 attempts) after a post was marked FAILED by an
    // earlier posting error, identical to the disabled-network case above.
    if (post.status === PostStatus.FAILED || post.status === PostStatus.REJECTED) {
      this.logger.warn(`Post ${postId} is already ${post.status} — not retrying`);
      return {
        success: false,
        error: `Post ${postId} is ${post.status}, not retryable`,
        retryable: false,
      };
    }
    if (post.status !== PostStatus.APPROVED) {
      throw new NotFoundException(`Post ${postId} is not approved (status: ${post.status})`);
    }

    // P7: A/B variant selection — before posting, decide which variant (a/b/default/custom)
    // goes live. Updates the post content if the post is still the original base text.
    post.content = await this.resolveVariant(postId, post.network, post.content);

    // F2: detect multi-stage threads (root + delayed continuations). Root posts
    // created by GenerationService now carry multiStage=true in llmMetadata.
    const llmMetadata =
      (post.llmMetadata as { multiStage?: boolean; threadDepth?: number } | null) ?? {};
    const isMultiStage = llmMetadata.multiStage === true;

    // G-3: Rate limit check — if not allowed, return a rate-limit result so the
    // queue worker can use BullMQ's RateLimitError (queue-wide delay) instead of
    // burning the retry budget on backoff loops.
    const networkKey = String(post.network);
    const rateCheck = await this.rateLimitService.checkRateLimit(networkKey, post.accountId);
    if (!rateCheck.allowed) {
      this.logger.warn(`Rate limited for ${networkKey}: ${rateCheck.reason}`);
      return {
        success: false,
        error: rateCheck.reason,
        retryable: false,
        rateLimit: true,
        retryAfterMs: rateCheck.retryAfterMs,
      };
    }

    // F20: Warm-up check — skip posting if account is in browse-only warm-up phase
    const canPost = await this.warmupService.canPost(post.accountId);
    if (!canPost) {
      this.logger.warn(
        `Account ${post.accountId} is in warm-up (browse-only) — deferring post ${postId}`,
      );
      throw new RetryableError(
        post.network,
        "Account in warm-up phase (browse-only) — posting deferred",
      );
    }

    // Mark as POSTING
    await this.postsService.updateStatus(postId, { status: PostStatus.POSTING });

    // G-4: SSE event — POSTING
    this.eventEmitter.emit(PostEvents.POSTING_STARTED, {
      postId,
      network: networkKey,
    } satisfies PostingStartedEvent);

    // P0-H1: Context leak fix — track context so it's always released in finally.
    // Sprint K: Use context pool (acquireContext/releaseContext) instead of
    // createContext/context.close — enables parallel posting across networks
    // with shared browser instance and context reuse.
    let context: Awaited<ReturnType<IBrowserPort["acquireContext"]>> | null = null;

    try {
      // Get or create session (auto-login if needed — OQ-8).
      // SE1: defer inline username/password form login off the posting path when
      // SESSION_DEFERRED_LOGIN is on — return null → retry while the out-of-band
      // refreshSessionsCron performs the controlled re-login.
      const session = await this.sessionsService.getOrCreateSession(post.accountId, post.network, {
        deferFormLogin: true,
      });
      if (!session) {
        throw new RetryableError(
          post.network,
          `No active session for ${post.network} — auto-login deferred or failed (will retry)`,
        );
      }

      // Acquire browser context from pool (reuses idle contexts, waits if at capacity)
      // P0-H3: Decrypt storageState if encrypted (v1: prefix).
      const storageStateStr = session.storageState
        ? this.sessionsService.decryptStorageState(session)
        : undefined;
      context = await this.browser.acquireContext(post.network, storageStateStr, post.accountId);

      // P0-2 fix: If this is a root post (threadPosition=0) with a threadId,
      // load continuation posts (position > 0) and pass them as threadItems.
      // This enables multi-stage posting (F2) — hook + continuation as a thread.
      // P0-H2: Load full post objects (not just content) for per-reply tracking.
      // P0-H2: Persist per-reply progress to ThreadProgress table so a crash
      // mid-thread leaves a recoverable record of which replies were posted.
      //
      // F2: For multi-stage threads the continuations are NOT posted in the same
      // browser session; they are enqueued 30 minutes apart. We therefore only
      // load thread items for legacy (immediate) threads.
      const threadItems: string[] = [];
      let threadPosts: Post[] = [];
      if (post.threadId && post.threadPosition === 0) {
        if (isMultiStage) {
          this.logger.log(
            `F2: Post ${postId} is root of multi-stage thread ${post.threadId} — continuations will be scheduled`,
          );
        } else {
          threadPosts = await this.postsService.findThreadContinuations(post.threadId);
          threadItems.push(...threadPosts.map((p) => p.content));
          if (threadItems.length > 0) {
            this.logger.log(
              `P0-2: Post ${postId} is root of thread ${post.threadId} with ${threadItems.length} continuation(s)`,
            );
            // P0-H2: Initialize persistent per-reply tracking (idempotent — safe to call on resume)
            await this.threadProgressService.initThread(
              postId,
              threadPosts.map((p) => ({ id: p.id, threadPosition: p.threadPosition })),
            );
          }
        }
      }

      // Post via the appropriate poster — with retry on transient/network errors.
      // Only retry for NetworkError (transient). SelectorNotFoundError, ValidationError,
      // AccountRestrictedError, etc. are NOT retried (need code fix or manual intervention).
      // Reference: twscrape retries network errors infinitely, locks on unknown errors.
      // F2: For a continuation (position > 0) we need the root post URL to reply to.
      let rootPostForThread: { id: string; postUrl: string | null } | null = null;
      const threadId = post.threadId;
      if (isMultiStage && post.threadPosition > 0 && threadId) {
        rootPostForThread = await this.postsService
          .findThreadRoot(threadId)
          .then((p) => (p ? { id: p.id, postUrl: p.postUrl } : null));
      }

      // ── M2.1: lead-funnel CTA assignment ──
      // Root posts only (continuations never carry links). X/Threads get the
      // link delivered as an immediate first reply after verification; inline
      // networks get it appended to the content below. Never blocks posting:
      // assignForPost degrades to UTM fallback or no CTA.
      const isContinuation = isMultiStage && post.threadPosition > 0;
      let ctaContent = post.content;
      let replyLinkUrl: string | undefined;
      if (!isContinuation && !post.ctaUrl) {
        const cta = await this.linkAttribution?.assignForPost(post);
        if (cta) {
          if (cta.mode === "inline") {
            ctaContent = LinkAttributionService.appendInline(post.content, cta.ctaUrl);
          } else {
            replyLinkUrl = cta.ctaUrl;
          }
          if (cta.source === "utm-fallback") {
            this.logger.warn(
              `Post ${postId} ships with a direct UTM CTA (zodiac unreachable) — attribution limited to clicks`,
            );
          }
        }
      }

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
          const live = await this.findLivePostUrl(post, context);
          if (live) {
            this.logger.warn(
              `Pre-retry verify: post ${postId} already live (${live}) — skipping duplicate re-submit`,
            );
            return { url: live };
          }
        }

        // F2: multi-stage continuation posts as a reply to the root thread.
        if (
          isMultiStage &&
          post.threadPosition > 0 &&
          (post.network === SocialNetwork.X || post.network === SocialNetwork.THREADS)
        ) {
          if (!rootPostForThread?.postUrl) {
            throw new RetryableError(
              post.network,
              `Root post not yet published for continuation ${postId} — will retry`,
            );
          }
          if (!threadId) {
            throw new RetryableError(
              post.network,
              `Thread not available for continuation ${postId} — will retry`,
            );
          }

          // Ensure the immediately previous stage has been posted before we reply,
          // otherwise the thread order will be out of sequence on the platform.
          if (post.threadPosition > 1) {
            const previous = await this.postsService.findByThreadPosition(
              threadId,
              post.threadPosition - 1,
            );
            if (!previous || previous.status !== PostStatus.POSTED) {
              throw new RetryableError(
                post.network,
                `Previous continuation (position ${post.threadPosition - 1}) not yet posted for ${postId} — will retry`,
              );
            }
          }

          const poster = post.network === SocialNetwork.X ? this.xPoster : this.threadsPoster;
          return poster.postThreadReply(context!, rootPostForThread.postUrl, post.content);
        }

        switch (post.network) {
          case SocialNetwork.X:
            return this.xPoster.post(
              context!,
              this.browser,
              ctaContent,
              threadItems.length > 0 ? threadItems : undefined,
            );
          case SocialNetwork.THREADS:
            return this.threadsPoster.post(
              context!,
              this.browser,
              ctaContent,
              threadItems.length > 0 ? threadItems : undefined,
            );
          case SocialNetwork.FACEBOOK:
            return this.facebookPoster.post(context!, this.browser, ctaContent);
          case SocialNetwork.BLUESKY:
            if (!this.blueskyPoster) {
              throw new Error("BlueskyPoster is not available — check PostingModule providers");
            }
            return this.blueskyPoster.post(context!, this.browser, post.content);
          case SocialNetwork.MASTODON:
            if (!this.mastodonPoster) {
              throw new Error("MastodonPoster is not available — check PostingModule providers");
            }
            return this.mastodonPoster.post(context!, this.browser, post.content);
          case SocialNetwork.TELEGRAM:
            if (!this.telegramAdapter) {
              throw new Error("TelegramAdapter is not available — check PostingModule providers");
            }
            return this.telegramAdapter.postMessage(post.content);
          case SocialNetwork.DEVTO:
          case SocialNetwork.HASHNODE:
            return this.postArticle(context!, post);
          case SocialNetwork.LINKEDIN:
            // LinkedIn has two posters: long-form articles (SyndicationModule) and
            // short social updates (LinkedinSocialPoster, in PostingModule).
            if (post.contentType === ContentType.ARTICLE) {
              return this.postArticle(context!, post);
            }
            if (!this.linkedinSocialPoster) {
              throw new Error(
                "LinkedinSocialPoster is not available — check PostingModule providers",
              );
            }
            return this.linkedinSocialPoster.post(context!, this.browser, post.content);
          default: {
            // Unimplemented syndication networks (Phase 3+)
            throw new Error(`Posting not yet implemented for network: ${post.network}`);
          }
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
              msg.includes("net::ERR") ||
              msg.includes("ECONNREFUSED") ||
              msg.includes("ETIMEDOUT") ||
              msg.includes("Timeout") ||
              msg.includes("Navigation failed") ||
              // Browser/context crash — Camoufox pages close unexpectedly under load.
              // Retry with a fresh context (onRetry re-acquires below).
              msg.includes("Target page, context or browser has been closed") ||
              msg.includes("Page is closed") ||
              msg.includes("browserContext.storageState") ||
              msg.includes("Target page, context or browser")
            );
          },
          onRetry: async (attempt, delayMs, err) => {
            this.logger.warn(
              `Posting retry ${attempt} for ${postId} after ${(err as Error).message} — waiting ${delayMs}ms`,
            );
            // Browser crash recovery: release the dead context and acquire a fresh one.
            // The old context's pages are closed — reusing it would fail immediately.
            const errMsg = (err as Error).message ?? "";
            const isBrowserCrash =
              errMsg.includes("Target page, context or browser has been closed") ||
              errMsg.includes("Page is closed") ||
              errMsg.includes("browserContext.storageState");
            if (isBrowserCrash && context) {
              this.logger.warn(
                `Browser crash detected — releasing dead context and acquiring fresh one for ${postId}`,
              );
              try {
                this.browser.releaseContext(post.network, context, post.accountId);
              } catch {
                /* dead context */
              }
              context = null;
              try {
                context = await this.browser.acquireContext(
                  post.network,
                  storageStateStr,
                  post.accountId,
                );
                this.logger.log(`Fresh context acquired for retry ${attempt} of ${postId}`);
              } catch (acquireErr) {
                this.logger.error(
                  `Failed to acquire fresh context for retry: ${(acquireErr as Error).message}`,
                );
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
                this.browser.releaseContext(post.network, context, post.accountId);
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
            const freshSession = await this.sessionsService.getOrCreateSession(
              post.accountId,
              post.network,
            );
            if (!freshSession || freshSession.id === lastSessionId) {
              this.logger.error(
                `Self-recovery attempt ${attempt} failed for ${postId} — could not create fresh session`,
              );
              continue;
            }
            lastSessionId = freshSession.id;
            this.logger.log(
              `Self-recovery attempt ${attempt}: new session ${freshSession.id} created for ${post.network}`,
            );
            const freshStorage = freshSession.storageState
              ? this.sessionsService.decryptStorageState(freshSession)
              : undefined;
            context = await this.browser.acquireContext(post.network, freshStorage, post.accountId);

            // M1/P3 + H2: before re-posting, verify the original attempt didn't already
            // publish — skip the re-post to avoid a duplicate (success-detection can misfire
            // into a "session expired"-looking error). Shared guard with the pre-retry path.
            const existingUrl = await this.findLivePostUrl(post, context);
            if (existingUrl) {
              this.logger.warn(
                `Self-recovery: post ${postId} is already live (${existingUrl}) — skipping re-post to avoid a duplicate`,
              );
              await this.persistSessionState(context, freshSession.id, postId);
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
              this.logger.log(
                `Self-recovery succeeded on attempt ${attempt} for ${postId} — post published`,
              );
              await this.persistSessionState(context, freshSession.id, postId);
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
            try {
              this.browser.releaseContext(post.network, context, post.accountId);
            } catch {
              /* non-blocking */
            }
            context = null;
          }
          // Reset status to APPROVED so the retry can pick it up cleanly
          await this.postsService
            .updateStatus(postId, { status: PostStatus.APPROVED })
            .catch(() => {});
          throw new RetryableError(
            post.network,
            `Session expired — deferred retry pending: ${lastRecoveryError}`,
          );
        }
      }

      // Save updated session state (context may be null if self-recovery released it)
      if (context) {
        await this.persistSessionState(context, session.id, postId);
      }

      if (result.error) {
        const retryable = this.isRetryableError(undefined, result);

        // Retryable poster errors (e.g. transient network failures) must not mark the
        // post FAILED. Revert to APPROVED so the next BullMQ attempt can retry cleanly.
        if (retryable) {
          await this.postsService.updateStatus(postId, { status: PostStatus.APPROVED });
          throw new RetryableError(post.network, result.error);
        }

        // Permanent account restrictions (WAF/graduated-access blocks, suspensions,
        // permanent locks) should mark the session as BANNED so the orchestrator
        // stops scheduling posting for that network. Temporary restrictions
        // (e.g. "temporarily limited") are intentionally excluded so the account
        // can recover and post again once the restriction clears.
        const error = result.error;
        const isPermanentRestriction =
          /Account suspended|Account locked|We blocked an attempt to access your account|graduated-access|has_graduated_access/i.test(
            error,
          ) ||
          (/(Account restricted|is restricted|is locked|is suspended)/i.test(error) &&
            !/temporarily|sensitive content/i.test(error));
        if (isPermanentRestriction) {
          await this.sessionsService
            .markSessionBanned(post.network, session.id, error)
            .catch(() => {});
        }

        await this.postsService.updateStatus(postId, {
          status: PostStatus.FAILED,
          errorMessage: result.error,
        });

        // G-4: SSE event — FAILED (terminal)
        this.eventEmitter.emit(PostEvents.FAILED, {
          postId,
          network: networkKey,
          error: result.error,
          retryable: false,
        } satisfies PostFailedEvent);

        return { success: false, error: result.error, retryable: false };
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

          this.eventEmitter.emit(PostEvents.FAILED, {
            postId,
            network: networkKey,
            error: errorMsg,
            retryable: false,
          } satisfies PostFailedEvent);

          return { success: false, error: errorMsg, retryable: false };
        }
      }

      await this.postsService.updateStatus(postId, {
        status: PostStatus.POSTED,
        postUrl: result.url,
      });

      // ── M2.3: first-reply link delivery (X/Threads) ──
      // Fire after the root is POSTED; failure must never fail the job — the
      // post is live, only the CTA reply would be missing (logged for retry).
      if (replyLinkUrl && result.url && context) {
        const linkReplyPoster =
          post.network === SocialNetwork.X ? this.xPoster : this.threadsPoster;
        try {
          await linkReplyPoster.postThreadReply(context!, result.url, replyLinkUrl);
          this.logger.log(`CTA reply with ${replyLinkUrl} posted under ${result.url}`);
        } catch (err) {
          this.logger.warn(
            `CTA reply failed for ${postId} (${err instanceof Error ? err.message : String(err)}) — post is live, CTA missing`,
          );
        }
      }

      // P7: Record the selected variant's outcome timestamp.
      await this.recordVariantPosted(postId);

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
            await this.resolveVariant(cp.id, post.network, cp.content);
            await this.postsService.updateStatus(cp.id, {
              status: PostStatus.POSTED,
              postUrl: result.url,
            });
            await this.recordVariantPosted(cp.id);
            this.eventEmitter.emit(PostEvents.POSTED, {
              postId: cp.id,
              network: networkKey,
              postUrl: result.url,
            } satisfies PostPostedEvent);
            // P1-04a: Mark successful reply as verified and emit POST_VERIFIED.
            if (result.url && VERIFIABLE_NETWORKS.has(post.network)) {
              await this.postsService.updateStatus(cp.id, {
                status: PostStatus.VERIFIED,
                postUrl: result.url,
              });
              this.eventEmitter.emit(PostEvents.VERIFIED, {
                postId: cp.id,
                network: networkKey,
                postUrl: result.url,
                canonicalUrl: cp.canonicalUrl ?? post.canonicalUrl ?? undefined,
                syndicatedUrl: result.url,
                contentType: cp.contentType ?? post.contentType,
              } satisfies PostVerifiedEvent);
            }
            // P0-H2: Persist per-reply success for crash recovery
            await this.threadProgressService.markReplyPosted(postId, cp.id, result.url ?? "");
            // 2.8.2: Record continuation post against its pillar (only after POSTED).
            await this.recordPostPillar(cp);
          } else {
            // P0-H2: Mark failed replies individually
            const replyError = replyResult?.error ?? "Thread reply failed";
            await this.postsService.updateStatus(cp.id, {
              status: PostStatus.FAILED,
              errorMessage: replyError,
            });
            this.eventEmitter.emit(PostEvents.FAILED, {
              postId: cp.id,
              network: networkKey,
              error: replyError,
              retryable: false,
            } satisfies PostFailedEvent);
            // P0-H2: Persist per-reply failure for crash recovery
            await this.threadProgressService.markReplyFailed(postId, cp.id, replyError);
          }
        }
        const succeededCount = result.threadReplyResults.filter(
          (r: { success: boolean }) => r.success,
        ).length;
        const failedCount = result.threadReplyResults.filter(
          (r: { success: boolean }) => !r.success,
        ).length;
        this.logger.log(
          `P0-H2: Thread ${post.threadId}: ${succeededCount} replies POSTED, ${failedCount} FAILED`,
        );
      } else if (threadItems.length > 0 && post.threadId) {
        // Fallback: no per-reply results (shouldn't happen with updated posters)
        const continuationPosts = await this.postsService.findThreadContinuations(post.threadId);
        for (const cp of continuationPosts) {
          await this.resolveVariant(cp.id, post.network, cp.content);
          await this.postsService.updateStatus(cp.id, {
            status: PostStatus.POSTED,
            postUrl: result.url,
          });
          await this.recordVariantPosted(cp.id);
          this.eventEmitter.emit(PostEvents.POSTED, {
            postId: cp.id,
            network: networkKey,
            postUrl: result.url,
          } satisfies PostPostedEvent);
          // P1-04a: Mark continuation as verified and emit POST_VERIFIED.
          if (result.url && VERIFIABLE_NETWORKS.has(post.network)) {
            await this.postsService.updateStatus(cp.id, {
              status: PostStatus.VERIFIED,
              postUrl: result.url,
            });
            this.eventEmitter.emit(PostEvents.VERIFIED, {
              postId: cp.id,
              network: networkKey,
              postUrl: result.url,
              canonicalUrl: cp.canonicalUrl ?? post.canonicalUrl ?? undefined,
              syndicatedUrl: result.url,
              contentType: cp.contentType ?? post.contentType,
            } satisfies PostVerifiedEvent);
          }
          // P0-H2: Persist per-reply success for crash recovery
          await this.threadProgressService.markReplyPosted(postId, cp.id, result.url ?? "");
          // 2.8.2: Record continuation post against its pillar (only after POSTED).
          await this.recordPostPillar(cp);
        }
        this.logger.log(
          `P0-2: Marked ${continuationPosts.length} continuation post(s) as POSTED for thread ${post.threadId}`,
        );
      }

      // G-3: Record successful post for rate limiting
      await this.rateLimitService.recordPost(networkKey, post.accountId);

      // G-4: SSE event — POSTED
      this.eventEmitter.emit(PostEvents.POSTED, {
        postId,
        network: networkKey,
        postUrl: result.url,
      } satisfies PostPostedEvent);

      // P1-04a: Verify the published post and emit POST_VERIFIED.
      // Verification is network-specific: article posters re-open the published URL,
      // social posters run a profile/URL check. If it fails we keep POSTED and let
      // BullMQ retry via `reverifyPost`.
      if (result.url && context) {
        const verifiedUrl = await this.verifyPublishedPost(post, context, result.url);
        if (verifiedUrl) {
          await this.postsService.updateStatus(postId, {
            status: PostStatus.VERIFIED,
            postUrl: verifiedUrl,
          });
          this.eventEmitter.emit(PostEvents.VERIFIED, {
            postId,
            network: networkKey,
            postUrl: verifiedUrl,
            canonicalUrl: post.canonicalUrl ?? undefined,
            syndicatedUrl: verifiedUrl,
            contentType: post.contentType,
          } satisfies PostVerifiedEvent);
        } else {
          this.logger.warn(`Post ${postId} published but verification failed — will retry`);
          return { success: false, error: "Post verification failed", retryable: true };
        }
      }

      // F2: For multi-stage threads, schedule the next continuation after success.
      // The delay is configured via THREAD_CONTINUATION_DELAY_MS (default 30 minutes).
      if (isMultiStage && post.threadId) {
        await this.scheduleNextContinuation(post, result.url ?? null).catch((e) => {
          this.logger.warn(
            `F2: Failed to schedule next continuation after ${postId}: ${(e as Error).message}`,
          );
        });
      }

      this.logger.log(`Post ${postId} posted successfully to ${post.network as string}`);
      return { success: true, url: result.url };
    } catch (err) {
      // P0-H1: Preserve SpaError retry semantics — don't wrap in generic Error.
      // Previously all errors became generic Error, losing SpaError retry info.
      const retryable = this.isRetryableError(err);
      const message = (err as Error).message;
      this.logger.error(`Posting failed for ${postId}: ${message}`);

      // Terminal failures mark the post FAILED; retryable deferrals revert to APPROVED
      // so the next BullMQ attempt can reprocess cleanly. In both cases we emit a FAILED
      // event with retryable in the payload so the UI can distinguish terminal vs. retry.
      if (retryable) {
        await this.postsService
          .updateStatus(postId, { status: PostStatus.APPROVED })
          .catch(() => {});
      } else {
        await this.postsService
          .updateStatus(postId, {
            status: PostStatus.FAILED,
            errorMessage: message,
          })
          .catch(() => {});
      }

      // G-4: SSE event — FAILED (retryable flag tells UI whether this will be retried)
      this.eventEmitter.emit(PostEvents.FAILED, {
        postId,
        network: networkKey,
        error: message,
        retryable,
      } satisfies PostFailedEvent);

      return { success: false, error: message, retryable };
    } finally {
      // Sprint K: Release context back to pool for reuse (instead of closing).
      // P0-H1: Guaranteed cleanup regardless of outcome — prevents context leaks.
      if (context) {
        this.browser.releaseContext(post.network, context, post.accountId);
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

    // Check for post-specific patterns
    const postPatterns: Partial<Record<SocialNetwork, RegExp>> = {
      [SocialNetwork.X]: /\/status\/[A-Za-z0-9]+/,
      [SocialNetwork.THREADS]: /(?:\/@[^/]+\/post\/|\/t\/)[A-Za-z0-9_-]+/,
      [SocialNetwork.FACEBOOK]: /\/(posts|permalink|photos)\/\d+/,
      [SocialNetwork.BLUESKY]: /\/profile\/[^/]+\/post\/[^/]+/,
      [SocialNetwork.MASTODON]:
        /(?:\/users\/[^/]+\/statuses\/[^/]+|\/statuses\/[^/]+|\/@[^/]+\/\d+)/,
      [SocialNetwork.TELEGRAM]: /\/[^/]+\/\d+$/,
      [SocialNetwork.LINKEDIN]:
        /(?:\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+|\/posts\/[^/]+\/\d+)/,
      [SocialNetwork.DEVTO]: /\/dev\.to\/[^/]+\/[\w-]+(?:-[a-z0-9]+)?$/,
      [SocialNetwork.HASHNODE]: /\.hashnode\.dev\/[\w-]+$/,
    };

    const postPattern = postPatterns[network];
    return postPattern ? postPattern.test(url) : false;
  }

  /** Resolve the concrete poster for a network (used for verification + posting). */
  private getPoster(network: SocialNetwork, contentType: ContentType) {
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
   * P1-04: Post an article to a syndication platform (Dev.to, Hashnode, LinkedIn).
   *
   * Article posters are resolved lazily via ModuleRef because they depend on
   * BrowserAgentService + CanonicalUrlService, which are only registered when
   * SYNDICATION_ENABLED=true. This avoids a hard dependency from PostingModule
   * to SyndicationModule.
   *
   * The post's content is expected to be JSON-serialized ArticleContent
   * (title, bodyMarkdown, slug, tags, excerpt).
   */
  private async postArticle(
    context: import("../../domain/ports/browser-primitives.js").BrowserContext,
    post: Post,
  ): Promise<PostResult> {
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
  private async resolveArticlePoster(
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
      return new Error(
        `Article poster for ${post.network} not available — is SYNDICATION_ENABLED=true?`,
      );
    }
  }

  /**
   * P1-04a: Verify a published post is actually live before emitting POST_VERIFIED.
   *
   * - Article posts (Dev.to, Hashnode, LinkedIn long-form): article poster navigates
   *   to the published URL and uses LLM-in-the-loop to confirm the article is visible.
   * - X/Threads/Facebook: uses the existing `verifyPosted` profile check.
   * - Other networks: URL-pattern validation is treated as the verification.
   *
   * Returns the verified URL on success, or null if verification fails (caller should
   * retry the job without re-posting).
   */
  private isArticleNetwork(post: Post): boolean {
    return (
      post.network === SocialNetwork.DEVTO ||
      post.network === SocialNetwork.HASHNODE ||
      (post.network === SocialNetwork.LINKEDIN && post.contentType === ContentType.ARTICLE)
    );
  }

  private async verifyPublishedPost(
    post: Post,
    context: Awaited<ReturnType<IBrowserPort["acquireContext"]>>,
    url: string,
  ): Promise<string | null> {
    const network = post.network;

    // Article networks: re-open the published URL and ask the LLM to confirm it is live.
    if (this.isArticleNetwork(post)) {
      const poster = await this.resolveArticlePoster(post);
      if (poster instanceof Error) {
        this.logger.warn(`Cannot verify article: ${poster.message}`);
        return null;
      }
      return poster.verifyPosted(context, url);
    }

    // Social/short-form networks: the poster already extracted a permalink after publish.
    // URL-pattern validation is the verification step here.
    if (this.isValidPostUrl(url, network)) {
      return url;
    }

    return null;
  }

  /**
   * P1-04a: Re-verify a POSTED post without re-publishing it.
   * Used when a prior verification attempt failed and BullMQ re-dispatches the job.
   */
  private emitPostVerified(post: Post, verifiedUrl: string): void {
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
   * P1-04a: Re-verify a POSTED post without re-publishing it.
   * Used when a prior verification attempt failed and BullMQ re-dispatches the job.
   */
  private async reverifyPost(post: Post): Promise<{
    success: boolean;
    url?: string;
    error?: string;
    retryable?: boolean;
    rateLimit?: boolean;
    retryAfterMs?: number;
  }> {
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
  private async findLivePostUrl(
    post: { network: SocialNetwork; content: string; contentType: ContentType },
    context: Awaited<ReturnType<IBrowserPort["acquireContext"]>>,
  ): Promise<string | null> {
    const { network, content, contentType } = post;
    const poster = this.getPoster(network, contentType);
    if (!poster || typeof poster.verifyPosted !== "function") return null;
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
        } else if (result.rateLimit) {
          // D1: Rate-limited posts are deferred, not failed
          this.logger.warn(`Skipping post ${post.id}: ${result.error}`);
          skipped++;
        } else {
          failed++;
        }
      } catch (err) {
        // D1: Rate-limited or warm-up posts are skipped, not failed
        const msg = (err as Error).message;
        if (msg.includes("Rate limited") || msg.includes("warm-up")) {
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
  async scheduleMultiStagePosting(
    rootPostId: string,
  ): Promise<{ scheduled: number; immediate: boolean }> {
    const rootPost = await this.postsService.findById(rootPostId);
    if (!rootPost.threadId || rootPost.threadPosition !== 0) {
      throw new Error(
        `Post ${rootPostId} is not a thread root (threadId missing or threadPosition != 0)`,
      );
    }

    // Get all continuations sorted by position
    const continuations = await this.postsService.findThreadContinuations(rootPost.threadId);
    // Only schedule APPROVED continuations
    const approvedConts = continuations.filter((p) => p.status === PostStatus.APPROVED);

    if (!this.queueFactory) {
      // No queue — post root immediately, skip delayed scheduling
      this.logger.warn(
        `F2: No QueueFactory available — posting root ${rootPostId} immediately (no delayed continuations)`,
      );
      await this.postById(rootPostId);
      return { scheduled: 0, immediate: true };
    }

    // Enqueue root post immediately (priority 1 = high)
    await this.queueFactory.enqueuePosting(rootPostId, rootPost.network, { priority: 1 });
    this.logger.log(`F2: Enqueued root post ${rootPostId} → ${rootPost.network} (immediate)`);

    // Enqueue continuations with delay = position × delayMs
    const delayMs = parseInt(
      this.configService.get<string>("THREAD_CONTINUATION_DELAY_MS", "1800000"),
      10,
    ); // default 30 min
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

    this.logger.log(
      `F2: Multi-stage thread scheduled — root ${rootPostId} + ${scheduled} continuations (delay: ${delayMs / 60000}min apart)`,
    );
    return { scheduled, immediate: false };
  }

  /**
   * F2: schedule the next APPROVED continuation in a multi-stage thread.
   * Called by postById() after the root or a continuation has been posted.
   * If a queue is not available (e.g. dry-run) the next continuation will not
   * be scheduled — use scheduleMultiStagePosting() or the /posting/multi-stage
   * endpoint for manual dry-run threads.
   */
  private async scheduleNextContinuation(post: Post, rootPostUrl: string | null): Promise<void> {
    if (!post.threadId || !this.queueFactory) return;

    const delayMs = parseInt(
      this.configService.get<string>("THREAD_CONTINUATION_DELAY_MS", "1800000"),
      10,
    ); // default 30 min
    const nextPosition = post.threadPosition + 1;
    const continuations = await this.postsService.findThreadContinuations(post.threadId);
    const next = continuations.find((p) => p.threadPosition === nextPosition);
    if (!next) return;

    // F2: a continuation must not run until its root has been posted and has a URL.
    if (post.threadPosition === 0 && !rootPostUrl) {
      this.logger.warn(
        `F2: Root ${post.id} has no postUrl — cannot schedule continuation ${next.id}`,
      );
      return;
    }

    await this.queueFactory.enqueuePosting(next.id, post.network, {
      priority: 5,
      delay: delayMs,
    });
    this.logger.log(
      `F2: Scheduled continuation ${next.id} (position ${nextPosition}) → ${post.network} (delay: ${Math.round(delayMs / 60000)}min)`,
    );
  }

  private delayBetweenStages(): number {
    return parseInt(this.configService.get<string>("THREAD_CONTINUATION_DELAY_MS", "1800000"), 10);
  }
}
