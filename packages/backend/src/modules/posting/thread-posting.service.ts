import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { BrowserContext } from "../../domain/ports/browser-primitives.js";
import { Post, PostStatus, SocialNetwork } from "../../generated/prisma/client.js";
import { RetryableError } from "../../domain/errors.js";
import type { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { PostEvents } from "../../events/enums/post-events.enum.js";
import type { PostFailedEvent, PostPostedEvent, PostVerifiedEvent } from "@spa/shared";
import type { PostsService } from "../posts/posts.service.js";
import type { ThreadProgressService } from "./thread-progress.service.js";
import type { PostingDispatcher } from "./poster-registry.service.js";
import type { PostSideEffectsService } from "./post-side-effects.service.js";

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

export interface ThreadPlan {
  /** Legacy (immediate) thread continuation texts for the poster. */
  threadItems: string[];
  /** Legacy thread continuation posts (for per-reply outcome marking). */
  threadPosts: Post[];
}

/**
 * REFACTOR-103: all thread semantics in one service —
 *   - legacy immediate threads (load continuations, per-reply ThreadProgress),
 *   - F2 multi-stage threads (delayed continuations, ordering guards),
 *   - post-success continuation scheduling and outcome marking.
 */
@Injectable()
export class ThreadOrchestrator {
  private readonly logger = new Logger(ThreadOrchestrator.name);

  constructor(
    private readonly postsService: PostsService,
    private readonly threadProgressService: ThreadProgressService,
    private readonly posterRegistry: PostingDispatcher,
    private readonly sideEffects: PostSideEffectsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    @Optional() private readonly queueFactory?: QueueFactory,
  ) {}

  /**
   * Build the thread plan for a root post before dispatch:
   * legacy threads load continuations immediately (+ persistent per-reply
   * tracking); F2 multi-stage threads only log — their continuations are
   * enqueued with delays instead.
   */
  async buildThreadPlan(post: Post, isMultiStage: boolean): Promise<ThreadPlan> {
    const threadItems: string[] = [];
    let threadPosts: Post[] = [];
    if (post.threadId && post.threadPosition === 0 && !isMultiStage) {
      threadPosts = await this.postsService.findThreadContinuations(post.threadId);
      threadItems.push(...threadPosts.map((p) => p.content));
      if (threadItems.length > 0) {
        this.logger.log(
          `P0-2: Post ${post.id} is root of thread ${post.threadId} with ${threadItems.length} continuation(s)`,
        );
        // P0-H2: Initialize persistent per-reply tracking (idempotent — safe to call on resume)
        await this.threadProgressService.initThread(
          post.id,
          threadPosts.map((p) => ({ id: p.id, threadPosition: p.threadPosition })),
        );
      }
    }
    return { threadItems, threadPosts };
  }

  /** F2: resolve the root post a multi-stage continuation must reply to. */
  async resolveRootPostForContinuation(
    threadId: string | null,
  ): Promise<{ id: string; postUrl: string | null } | null> {
    if (!threadId) return null;
    return this.postsService
      .findThreadRoot(threadId)
      .then((p) => (p ? { id: p.id, postUrl: p.postUrl } : null));
  }

  /**
   * F2: post a multi-stage continuation as a reply to its root. Enforces the
   * ordering guard (previous stage must already be POSTED).
   */
  async postMultiStageContinuation(
    context: BrowserContext,
    post: Post,
    rootPostForThread: { id: string; postUrl: string | null } | null,
  ): Promise<import("./posters/base.poster.js").PostResult> {
    if (!rootPostForThread?.postUrl) {
      throw new RetryableError(
        post.network,
        `Root post not yet published for continuation ${post.id} — will retry`,
      );
    }

    // Ensure the immediately previous stage has been posted before we reply,
    // otherwise the thread order will be out of sequence on the platform.
    if (post.threadPosition > 1) {
      const previous = await this.postsService.findByThreadPosition(
        post.threadId!,
        post.threadPosition - 1,
      );
      if (!previous || previous.status !== PostStatus.POSTED) {
        throw new RetryableError(
          post.network,
          `Previous continuation (position ${post.threadPosition - 1}) not yet posted for ${post.id} — will retry`,
        );
      }
    }

    const poster = this.posterRegistry.getReplyCapablePoster(post.network);
    if (!poster) {
      throw new RetryableError(
        post.network,
        `Network ${post.network} does not support threaded replies for continuation ${post.id}`,
      );
    }
    return poster.postThreadReply(context, rootPostForThread.postUrl, post.content);
  }

  /**
   * P0-H2/F2: mark legacy-thread continuations individually based on per-reply
   * results (or the POSTED fallback when a poster returns no per-reply data).
   */
  async markContinuationOutcomes(
    post: Post,
    result: import("./posters/base.poster.js").PostResult & {
      threadReplyResults?: Array<{ success: boolean; error?: string }>;
    },
    plan: ThreadPlan,
  ): Promise<void> {
    const networkKey = String(post.network);
    const { threadItems, threadPosts } = plan;

    const markVerifiedContinuation = async (cp: Post, url: string): Promise<void> => {
      // P1-04a: Mark successful reply as verified and emit POST_VERIFIED.
      if (!VERIFIABLE_NETWORKS.has(post.network)) return;
      await this.postsService.updateStatus(cp.id, {
        status: PostStatus.VERIFIED,
        postUrl: url,
      });
      this.eventEmitter.emit(PostEvents.VERIFIED, {
        postId: cp.id,
        network: networkKey,
        postUrl: url,
        canonicalUrl: cp.canonicalUrl ?? post.canonicalUrl ?? undefined,
        syndicatedUrl: url,
        contentType: cp.contentType ?? post.contentType,
      } satisfies PostVerifiedEvent);
    };

    if (threadPosts.length > 0 && post.threadId && result.threadReplyResults) {
      for (let i = 0; i < threadPosts.length; i++) {
        const cp = threadPosts[i];
        if (!cp) continue;
        const replyResult = result.threadReplyResults[i];
        if (replyResult?.success) {
          await this.sideEffects.resolveVariant(cp.id, post.network, cp.content);
          await this.postsService.updateStatus(cp.id, {
            status: PostStatus.POSTED,
            postUrl: result.url,
          });
          await this.sideEffects.recordVariantPosted(cp.id);
          this.eventEmitter.emit(PostEvents.POSTED, {
            postId: cp.id,
            network: networkKey,
            postUrl: result.url,
          } satisfies PostPostedEvent);
          if (result.url) await markVerifiedContinuation(cp, result.url);
          // P0-H2: Persist per-reply success for crash recovery
          await this.threadProgressService.markReplyPosted(post.id, cp.id, result.url ?? "");
          // 2.8.2: Record continuation post against its pillar (only after POSTED).
          await this.sideEffects.recordPostPillar(cp);
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
          await this.threadProgressService.markReplyFailed(post.id, cp.id, replyError);
        }
      }
      const succeededCount = result.threadReplyResults.filter((r) => r.success).length;
      const failedCount = result.threadReplyResults.filter((r) => !r.success).length;
      this.logger.log(
        `P0-H2: Thread ${post.threadId}: ${succeededCount} replies POSTED, ${failedCount} FAILED`,
      );
    } else if (threadItems.length > 0 && post.threadId) {
      // Fallback: no per-reply results (shouldn't happen with updated posters)
      const continuationPosts = await this.postsService.findThreadContinuations(post.threadId);
      for (const cp of continuationPosts) {
        await this.sideEffects.resolveVariant(cp.id, post.network, cp.content);
        await this.postsService.updateStatus(cp.id, {
          status: PostStatus.POSTED,
          postUrl: result.url,
        });
        await this.sideEffects.recordVariantPosted(cp.id);
        this.eventEmitter.emit(PostEvents.POSTED, {
          postId: cp.id,
          network: networkKey,
          postUrl: result.url,
        } satisfies PostPostedEvent);
        if (result.url) await markVerifiedContinuation(cp, result.url);
        // P0-H2: Persist per-reply success for crash recovery
        await this.threadProgressService.markReplyPosted(post.id, cp.id, result.url ?? "");
        // 2.8.2: Record continuation post against its pillar (only after POSTED).
        await this.sideEffects.recordPostPillar(cp);
      }
      this.logger.log(
        `P0-2: Marked ${continuationPosts.length} continuation post(s) as POSTED for thread ${post.threadId}`,
      );
    }
  }

  /**
   * F2: Schedule multi-stage thread posting with delayed continuations.
   *
   * Root post (threadPosition=0) is enqueued immediately.
   * Each continuation (threadPosition=1,2,...) is enqueued with a delay of
   *   position × THREAD_CONTINUATION_DELAY_MS (default: 30 minutes).
   *
   * Requires QueueFactory — if not available (e.g. synchronous mode), falls
   * back to immediate posting through `postById` callback for the root only.
   */
  async scheduleMultiStagePosting(
    rootPostId: string,
    postById: (postId: string) => Promise<unknown>,
  ): Promise<{ scheduled: number; immediate: boolean }> {
    const rootPost = await this.postsService.findById(rootPostId);
    if (!rootPost.threadId || rootPost.threadPosition !== 0) {
      throw new Error(
        `Post ${rootPostId} is not a thread root (threadId missing or threadPosition != 0)`,
      );
    }

    // Get all continuations sorted by position; only schedule APPROVED ones.
    const continuations = await this.postsService.findThreadContinuations(rootPost.threadId);
    const approvedConts = continuations.filter((p) => p.status === PostStatus.APPROVED);

    if (!this.queueFactory) {
      // No queue — post root immediately, skip delayed scheduling
      this.logger.warn(
        `F2: No QueueFactory available — posting root ${rootPostId} immediately (no delayed continuations)`,
      );
      await postById(rootPostId);
      return { scheduled: 0, immediate: true };
    }

    // Enqueue root post immediately (priority 1 = high)
    await this.queueFactory.enqueuePosting(
      rootPostId,
      rootPost.network,
      { priority: 1 },
      rootPost.accountId,
    );
    this.logger.log(`F2: Enqueued root post ${rootPostId} → ${rootPost.network} (immediate)`);

    // Enqueue continuations with delay = position × delayMs
    const delayMs = this.delayBetweenStages();
    let scheduled = 0;
    for (const cont of approvedConts) {
      const delay = cont.threadPosition * delayMs;
      await this.queueFactory.enqueuePosting(
        cont.id,
        rootPost.network,
        {
          priority: 5, // lower priority than root
          delay,
        },
        rootPost.accountId,
      );
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
   * Called after the root or a continuation has been posted.
   * If a queue is not available (e.g. dry-run) the next continuation will not
   * be scheduled — use scheduleMultiStagePosting() or the /posting/multi-stage
   * endpoint for manual dry-run threads.
   */
  async scheduleNextContinuation(post: Post, rootPostUrl: string | null): Promise<void> {
    if (!post.threadId || !this.queueFactory) return;

    const delayMs = this.delayBetweenStages();
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

    await this.queueFactory.enqueuePosting(
      next.id,
      post.network,
      {
        priority: 5,
        delay: delayMs,
      },
      post.accountId,
    );
    this.logger.log(
      `F2: Scheduled continuation ${next.id} (position ${nextPosition}) → ${post.network} (delay: ${Math.round(delayMs / 60000)}min)`,
    );
  }

  private delayBetweenStages(): number {
    return parseInt(this.configService.get<string>("THREAD_CONTINUATION_DELAY_MS", "1800000"), 10); // default 30 min
  }
}

