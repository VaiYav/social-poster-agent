import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { IBrowserPort, type IBrowserPort as BrowserPort } from "../../domain/ports/browser.port.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { PostsService } from "../posts/posts.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import type { PostResult } from "./posters/base.poster.js";
import { Post, PostStatus } from "../../generated/prisma/client.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { PostEvents } from "../../events/enums/post-events.enum.js";
import { withRetry } from "../../domain/retry.js";
import { CircuitOpenError } from "../../domain/circuit-breaker.js";
import { RetryableError, SpaError } from "../../domain/errors.js";
import { isNetworkEnabled } from "../../domain/enabled-networks.js";
import type {
  PostingStartedEvent,
  PostPostedEvent,
  PostVerifiedEvent,
  PostFailedEvent,
} from "@spa/shared";
import {
  IResiliencePort,
  type IResiliencePort as ResiliencePort,
} from "../../domain/ports/resilience.port.js";
import {
  IRuntimeActionAuthorizer,
  type AuthorizePlatformActionParams,
} from "../policy/policy.types.js";
import { PostingDispatcher } from "./poster-registry.service.js";
import {
  PostingGuardChain,
  PolicyAuthorizationError,
  type PostingResult,
} from "./posting-guards.service.js";
import { PostVerificationService } from "./post-verification.service.js";
import { ThreadOrchestrator } from "./thread-posting.service.js";
import { PostSideEffectsService } from "./post-side-effects.service.js";
import { CtaAttributionService } from "./cta-attribution.service.js";

/**
 * Posting orchestrator — REFACTOR-103 facade over the posting pipeline.
 *
 * Owns ONLY the parts that need shared mutable state across phases:
 *   - browser context lifecycle (acquire / crash-recovery / guaranteed release),
 *   - the transient-error retry loop and duplicate-publish guards,
 *   - session-expiry self-recovery,
 *   - status/SSE transitions for the root post.
 *
 * Everything else lives in a single-responsibility collaborator:
 *   - PostingGuardChain       pre-flight gates (network/flow/status/policy/rate/warm-up)
 *   - PostingDispatcher        network→poster dispatch (incl. lazy article posters)
 *   - ThreadOrchestrator       legacy + F2 multi-stage thread semantics
 *   - PostVerificationService URL validation, live-check, (re-)verification
 *   - PostSideEffectsService  pillar recording, A/B variant selection/recording
 */

function getImagePath(media: Prisma.JsonValue | null | undefined): string | undefined {
  if (!media || typeof media !== "object" || Array.isArray(media)) return undefined;
  const image = (media as Record<string, unknown>)["image"];
  if (image && typeof image === "object" && !Array.isArray(image)) {
    const path = (image as Record<string, unknown>)["path"];
    return typeof path === "string" && path.length > 0 ? path : undefined;
  }
  const path = (media as Record<string, unknown>)["path"];
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

interface PolicyDecisionShape {
  allowedMode: string;
  blockReasons: string[];
  policyHash: string;
}

@Injectable()
export class PostingService {
  private readonly logger = new Logger(PostingService.name);

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
    @Inject(IBrowserPort) private readonly browser: BrowserPort,
    private readonly sessionsService: SessionsService,
    private readonly postsService: PostsService,
    private readonly rateLimitService: RateLimitService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    // REFACTOR-103 collaborators
    private readonly guards: PostingGuardChain,
    private readonly posterRegistry: PostingDispatcher,
    private readonly verification: PostVerificationService,
    private readonly threads: ThreadOrchestrator,
    private readonly sideEffects: PostSideEffectsService,
    private readonly ctaAttribution: CtaAttributionService,
    @Optional() @Inject(IResiliencePort) private readonly resilience?: ResiliencePort,
    @Optional()
    @Inject(IRuntimeActionAuthorizer)
    private readonly actionAuthorizer?: {
      authorize(params: AuthorizePlatformActionParams): Promise<PolicyDecisionShape>;
      reauthorize(
        params: AuthorizePlatformActionParams,
        expectedPolicyHash: string,
      ): Promise<PolicyDecisionShape>;
    },
    @Optional() private readonly queueFactory?: QueueFactory,
    @Optional() private readonly flowControl?: FlowControlService,
  ) {}

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

  async postById(postId: string): Promise<PostingResult> {
    const post = await this.postsService.findById(postId);

    // ── Pre-flight guard chain (network gate, flow pause, status idempotency,
    // APPROVED requirement, POLICY-101 authorization).
    const guardOutcome = await this.guards.runPostGuards(post);
    if (guardOutcome.kind === "return") return guardOutcome.result;
    if (guardOutcome.kind === "throw") throw guardOutcome.error;
    if (guardOutcome.kind === "reverify") {
      return this.verification.reverifyPost(guardOutcome.post);
    }
    const { policyParams, policyDecision } = guardOutcome;

    // P7: A/B variant selection — before posting, decide which variant (a/b/default/custom)
    // goes live. Updates the post content if the post is still the original base text.
    post.content = await this.sideEffects.resolveVariant(postId, post.network, post.content);

    // F2: detect multi-stage threads (root + delayed continuations). Root posts
    // created by GenerationService now carry multiStage=true in llmMetadata.
    const llmMetadata =
      (post.llmMetadata as { multiStage?: boolean; threadDepth?: number } | null) ?? {};
    const isMultiStage = llmMetadata.multiStage === true;
    const imagePath = getImagePath(post.media);

    // G-3: Rate limit check — if not allowed, return a rate-limit result so the
    // queue worker can use BullMQ's RateLimitError (queue-wide delay) instead of
    // burning the retry budget on backoff loops.
    const networkKey = String(post.network);
    const rateCheck = await this.guards.checkRateLimit(post);
    if (!rateCheck.allowed) return rateCheck.result;

    // F20: Warm-up check — skip posting if account is in browse-only warm-up phase
    await this.guards.checkWarmup(post);

    // Mark as POSTING
    await this.postsService.updateStatus(postId, { status: PostStatus.POSTING });

    // G-4: SSE event — POSTING
    this.eventEmitter.emit(PostEvents.POSTING_STARTED, {
      postId,
      network: networkKey,
    } satisfies PostingStartedEvent);

    // P0-H1: Context leak fix — track context so it's always released in finally.
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

      // Threads: legacy items (+ per-reply progress init) or multi-stage log line.
      const plan = await this.threads.buildThreadPlan(post, isMultiStage);
      const { threadItems, threadPosts } = plan;

      // F2: For a continuation (position > 0) we need the root post URL to reply to.
      let rootPostForThread: { id: string; postUrl: string | null } | null = null;
      if (isMultiStage && post.threadPosition > 0) {
        rootPostForThread = await this.threads.resolveRootPostForContinuation(post.threadId);
      }

      // ── M2.1: lead-funnel CTA assignment ──
      // Root posts only (continuations never carry links). X/Threads get the
      // link delivered as an immediate first reply after verification; inline
      // networks get it appended to the content below. Never blocks posting:
      // assignForPost degrades to UTM fallback or no CTA.
      const isContinuation = isMultiStage && post.threadPosition > 0;
      const preparedCta = await this.ctaAttribution.prepare(post, isContinuation);

      let postAttempt = 0;
      const postFn = async (): Promise<PostResult> => {
        postAttempt++;
        if (this.actionAuthorizer && policyDecision) {
          const current = await this.actionAuthorizer.reauthorize(
            policyParams,
            policyDecision.policyHash,
          );
          if (current.allowedMode !== "APPROVED_AUTOMATION") {
            throw new PolicyAuthorizationError(
              `Policy changed before posting side effect: ${current.blockReasons.join("; ")}`,
            );
          }
        }
        // H2: a network error (Timeout / net::ERR) can strike AFTER the post was already
        // submitted — e.g. while navigating to the profile to capture the permalink. Without
        // this guard, withRetry would re-run postFn and submit a DUPLICATE. On any retry,
        // first verify the previous attempt didn't already publish; if it did, return that
        // URL instead of re-posting. Single posts only — threads have their own per-reply
        // ThreadProgress idempotency, and a partial-thread re-post must not be short-circuited.
        if (postAttempt > 1 && context && threadItems.length === 0) {
          const live = await this.verification.findLivePostUrl(post, context);
          if (live) {
            this.logger.warn(
              `Pre-retry verify: post ${postId} already live (${live}) — skipping duplicate re-submit`,
            );
            return { url: live };
          }
        }

        // F2: multi-stage continuation posts as a reply to the root thread.
        if (isContinuation) {
          return this.threads.postMultiStageContinuation(context!, post, rootPostForThread);
        }

        return this.posterRegistry.dispatch(post, context!, this.browser, {
          content: preparedCta.content,
          threadItems,
          imagePath,
        });
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
          this.eventEmitter.emit("circuit.open", {
            name: `posting:${post.network}`,
            message: retryErr.message,
            postId,
            network: post.network,
          });
          throw retryErr;
        }
        const message = (retryErr as Error).message;
        this.logger.error(`Posting failed after retries for ${postId}: ${message}`);
        throw retryErr;
      }

      result = await this.recoverFromSessionExpiryIfNeeded(
        post,
        result,
        {
          contextRef: () => context,
          setContext: (c) => {
            context = c;
          },
          lastSessionId: session.id,
        },
        postFn,
      );

      // Save updated session state (context may be null if self-recovery released it)
      if (context) {
        await this.persistSessionState(context, session.id, postId);
      }

      if (result.error) {
        return this.handlePosterError(post, result, session.id);
      }

      // Validate post URL — reject homepage URLs (post likely didn't publish correctly)
      if (result.url && !this.verification.isValidPostUrl(result.url, post.network)) {
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

      await this.postsService.updateStatus(postId, {
        status: PostStatus.POSTED,
        postUrl: result.url,
      });

      // ── M2.3: first-reply link delivery (X/Threads) ──
      // Fire after the root is POSTED; failure must never fail the job — the
      // post is live, only the CTA reply would be missing (logged for retry).
      if (preparedCta.replyLinkUrl && result.url && context) {
        await this.ctaAttribution.deliverFirstReply(
          post,
          policyParams,
          context,
          result.url,
          preparedCta.replyLinkUrl,
        );
      }

      // P7: Record the selected variant's outcome timestamp.
      await this.sideEffects.recordVariantPosted(postId);

      // 2.8.2: Record the root post against its pillar (only after POSTED).
      await this.sideEffects.recordPostPillar(post);

      // P0-H2/F2: mark legacy-thread continuations per reply outcome.
      await this.threads.markContinuationOutcomes(
        post,
        result as PostResult & { threadReplyResults?: Array<{ success: boolean; error?: string }> },
        plan,
      );

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
      // social posts are validated by URL pattern. If it fails we keep POSTED and let
      // BullMQ retry via `reverifyPost`.
      if (result.url && context) {
        const verifiedUrl = await this.verification.verifyPublishedPost(post, context, result.url);
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
        await this.threads.scheduleNextContinuation(post, result.url ?? null).catch((e) => {
          this.logger.warn(
            `F2: Failed to schedule next continuation after ${postId}: ${(e as Error).message}`,
          );
        });
      }

      this.logger.log(`Post ${postId} posted successfully to ${post.network as string}`);
      void this.resilience
        ?.reportHealth(`posting:${post.accountId}`, "HEALTHY")
        .catch(() => void 0);
      return { success: true, url: result.url };
    } catch (err) {
      if (err instanceof PolicyAuthorizationError) {
        await this.postsService
          .updateStatus(postId, { status: PostStatus.APPROVED })
          .catch(() => {});
        this.logger.warn(`Posting authorization changed for ${postId}: ${err.message}`);
        return { success: false, error: err.message, retryable: false };
      }
      // P0-H1: Preserve SpaError retry semantics — don't wrap in generic Error.
      const retryable = this.isRetryableError(err);
      const message = (err as Error).message;
      this.logger.error(`Posting failed for ${postId}: ${message}`);
      void this.resilience
        ?.reportHealth(`posting:${post.accountId}`, retryable ? "DEGRADED" : "CRITICAL", message)
        .catch(() => void 0);

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
   * ── Self-recovery on session expiry ──
   * If the poster returned a "Not logged in" error (session expired mid-post),
   * attempt re-login and retry the posting operation with exponential backoff.
   *
   * Two-phase recovery:
   *   Phase 1: 3 immediate attempts with 5s/10s/20s delays (fast retry)
   *   Phase 2: If all 3 fail, throw a retryable error so BullMQ re-queues the job
   *            with exponential backoff (default 60s → 120s → 240s...).
   *            The post stays in POSTING status (not FAILED) so it gets retried
   *            instead of being abandoned. After BullMQ exhausts its retries
   *            (default 8), the job goes to DLQ and the post is marked FAILED
   *            by the queue error handler.
   */
  private async recoverFromSessionExpiryIfNeeded(
    post: Post,
    initialResult: PostResult,
    ctxState: {
      contextRef: () => Awaited<ReturnType<IBrowserPort["acquireContext"]>> | null;
      setContext: (c: Awaited<ReturnType<IBrowserPort["acquireContext"]>> | null) => void;
      lastSessionId: string;
    },
    postFn: () => Promise<PostResult>,
  ): Promise<PostResult> {
    let result = initialResult;
    if (!(result.error && /not logged in|session expired|relogin/i.test(result.error))) {
      return result;
    }

    const maxRecoveryAttempts = 3;
    let recoverySucceeded = false;
    let lastRecoveryError = result.error;
    let lastSessionId = ctxState.lastSessionId;

    for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt++) {
      const delayMs = 5000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
      this.logger.warn(
        `Session expired for ${post.network} post ${post.id} — self-recovery attempt ${attempt}/${maxRecoveryAttempts} (waiting ${delayMs}ms)`,
      );
      await this.browser.randomDelay(delayMs, delayMs * 2);

      try {
        // Release the expired context
        const currentCtx = ctxState.contextRef();
        if (currentCtx) {
          try {
            this.browser.releaseContext(post.network, currentCtx, post.accountId);
          } catch {
            // non-blocking
          }
          ctxState.setContext(null);
        }
        // Mark the last session as EXPIRED so getOrCreateSession creates a fresh one
        await this.sessionsService.markSessionExpired(post.network, lastSessionId).catch(() => {});
        // Force re-login (getOrCreateSession will auto-login if no active session)
        const freshSession = await this.sessionsService.getOrCreateSession(
          post.accountId,
          post.network,
        );
        if (!freshSession || freshSession.id === lastSessionId) {
          this.logger.error(
            `Self-recovery attempt ${attempt} failed for ${post.id} — could not create fresh session`,
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
        const freshCtx = await this.browser.acquireContext(
          post.network,
          freshStorage,
          post.accountId,
        );
        ctxState.setContext(freshCtx);

        // M1/P3 + H2: before re-posting, verify the original attempt didn't already
        // publish — skip the re-post to avoid a duplicate (success-detection can misfire
        // into a "session expired"-looking error). Shared guard with the pre-retry path.
        const existingUrl = await this.verification.findLivePostUrl(post, freshCtx);
        if (existingUrl) {
          this.logger.warn(
            `Self-recovery: post ${post.id} is already live (${existingUrl}) — skipping re-post to avoid a duplicate`,
          );
          await this.persistSessionState(freshCtx, freshSession.id, post.id);
          result = { url: existingUrl };
          recoverySucceeded = true;
          break;
        }

        // Retry posting with fresh context
        result = await postFn();
        if (result.error) {
          lastRecoveryError = result.error;
          this.logger.error(
            `Self-recovery attempt ${attempt} still failed for ${post.id}: ${result.error}`,
          );
        } else {
          this.logger.log(
            `Self-recovery succeeded on attempt ${attempt} for ${post.id} — post published`,
          );
          await this.persistSessionState(freshCtx, freshSession.id, post.id);
          recoverySucceeded = true;
          break;
        }
      } catch (recoveryErr) {
        lastRecoveryError = (recoveryErr as Error).message;
        this.logger.error(
          `Self-recovery error on attempt ${attempt} for ${post.id}: ${lastRecoveryError}`,
        );
      }
    }

    if (!recoverySucceeded) {
      // Phase 2: throw a retryable error so BullMQ re-queues with backoff.
      // The post stays in POSTING status — BullMQ will retry the job later.
      // This gives the session time to recover (cookies refresh, rate limits clear, etc.)
      this.logger.warn(
        `All ${maxRecoveryAttempts} immediate self-recovery attempts exhausted for ${post.id} — ` +
          `throwing for BullMQ deferred retry (will retry with exponential backoff)`,
      );
      // Release context before throwing (finally block will also try, but context may be null here)
      const currentCtx = ctxState.contextRef();
      if (currentCtx) {
        try {
          this.browser.releaseContext(post.network, currentCtx, post.accountId);
        } catch {
          /* non-blocking */
        }
        ctxState.setContext(null);
      }
      // Reset status to APPROVED so the retry can pick it up cleanly
      await this.postsService
        .updateStatus(post.id, { status: PostStatus.APPROVED })
        .catch(() => {});
      throw new RetryableError(
        post.network,
        `Session expired — deferred retry pending: ${lastRecoveryError}`,
      );
    }

    return result;
  }

  /** Classify a terminal poster error: ban detection, status transition, SSE. */
  private async handlePosterError(
    post: Post,
    result: PostResult,
    sessionId: string,
  ): Promise<PostingResult> {
    const retryable = this.isRetryableError(undefined, result);

    // Retryable poster errors (e.g. transient network failures) must not mark the
    // post FAILED and must not reject the caller: revert to APPROVED so the next
    // BullMQ attempt retries cleanly, emit the FAILED(retryable) SSE event here,
    // and return the deferred result directly (no throw — the outer catch would
    // just re-classify it back into the same outcome).
    if (retryable) {
      await this.postsService.updateStatus(post.id, { status: PostStatus.APPROVED });
      // G-4: SSE event — FAILED (retryable flag tells UI this will be retried)
      this.eventEmitter.emit(PostEvents.FAILED, {
        postId: post.id,
        network: String(post.network),
        error: result.error!,
        retryable: true,
      } satisfies PostFailedEvent);
      return { success: false, error: result.error!, retryable: true };
    }

    // Permanent account restrictions (WAF/graduated-access blocks, suspensions,
    // permanent locks) should mark the session as BANNED so the orchestrator
    // stops scheduling posting for that network. Temporary restrictions
    // (e.g. "temporarily limited") are intentionally excluded so the account
    // can recover and post again once the restriction clears.
    const error = result.error!;
    const isPermanentRestriction =
      /Account suspended|Account locked|We blocked an attempt to access your account|graduated-access|has_graduated_access/i.test(
        error,
      ) ||
      (/(Account restricted|is restricted|is locked|is suspended)/i.test(error) &&
        !/temporarily|sensitive content/i.test(error));
    if (isPermanentRestriction) {
      await this.sessionsService.markSessionBanned(post.network, sessionId, error).catch(() => {});
    }

    await this.postsService.updateStatus(post.id, {
      status: PostStatus.FAILED,
      errorMessage: error,
    });

    // G-4: SSE event — FAILED (terminal)
    this.eventEmitter.emit(PostEvents.FAILED, {
      postId: post.id,
      network: String(post.network),
      error,
      retryable: false,
    } satisfies PostFailedEvent);

    return { success: false, error, retryable: false };
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
   * Delegates to ThreadOrchestrator (kept as public API for PostingController).
   */
  async scheduleMultiStagePosting(
    rootPostId: string,
  ): Promise<{ scheduled: number; immediate: boolean }> {
    return this.threads.scheduleMultiStagePosting(rootPostId, (id) => this.postById(id));
  }
}
