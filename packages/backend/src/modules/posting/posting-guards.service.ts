import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Post, PostStatus, SocialNetwork } from "../../generated/prisma/client.js";
import { RetryableError } from "../../domain/errors.js";
import { isNetworkEnabled } from "../../domain/enabled-networks.js";
import {
  IRuntimeActionAuthorizer,
  type AuthorizePlatformActionParams,
  type PlatformAuthorizationDecision,
} from "../policy/policy.types.js";
import { PostsService } from "../posts/posts.service.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { WarmupService } from "../sessions/warmup.service.js";

/** Result shape of PostingService.postById — shared with guards/verification. */
export interface PostingResult {
  success: boolean;
  url?: string;
  error?: string;
  retryable?: boolean;
  rateLimit?: boolean;
  retryAfterMs?: number;
}

export class PolicyAuthorizationError extends Error {
  readonly retryable = false;
}

export type PostingGuardOutcome =
  | { kind: "return"; result: PostingResult }
  | { kind: "throw"; error: Error }
  /** POSTED with a URL — re-verify instead of re-posting (P1-04a). */
  | { kind: "reverify"; post: Post }
  | {
      kind: "proceed";
      policyParams: AuthorizePlatformActionParams;
      policyDecision?: PlatformAuthorizationDecision;
    };

/**
 * REFACTOR-103: pre-flight guard chain extracted from the former 1000-line
 * postById. Deterministic checks run in a fixed order and short-circuit; each
 * outcome tells the orchestrating service exactly what to do next. Guards never
 * mutate post content and never touch the browser.
 *
 * Order matters (do not reorder without checking queue-worker retry semantics):
 *   network gate → flow-control pause → status idempotency gates →
 *   APPROVED requirement → POLICY-101 authorization.
 */
@Injectable()
export class PostingGuardChain {
  private readonly logger = new Logger(PostingGuardChain.name);

  constructor(
    private readonly postsService: PostsService,
    private readonly rateLimitService: RateLimitService,
    private readonly warmupService: WarmupService,
    @Optional() private readonly flowControl?: FlowControlService,
    @Optional()
    @Inject(IRuntimeActionAuthorizer)
    private readonly actionAuthorizer?: {
      authorize(params: AuthorizePlatformActionParams): Promise<PlatformAuthorizationDecision>;
      reauthorize(
        params: AuthorizePlatformActionParams,
        expectedPolicyHash: string,
      ): Promise<PlatformAuthorizationDecision>;
    },
  ) {}

  async runPostGuards(post: Post): Promise<PostingGuardOutcome> {
    // Network gating — skip posts for disabled networks (e.g. Facebook)
    if (!isNetworkEnabled(post.network)) {
      this.logger.warn(
        `Post ${post.id} is for ${post.network} — network disabled, marking as SKIPPED`,
      );
      await this.postsService
        .updateStatus(post.id, {
          status: PostStatus.FAILED,
          errorMessage: `Network ${post.network} is disabled (ENABLED_NETWORKS)`,
        })
        .catch(() => {});
      // Config-level, not transient — retrying can never succeed, so don't burn the
      // full postingMaxRetries budget on it (see queue.module.ts worker).
      return {
        kind: "return",
        result: { success: false, error: `Network ${post.network} is disabled`, retryable: false },
      };
    }

    // ADR-006: Flow control — skip if posting is paused (crisis mode)
    if (this.flowControl && (await this.flowControl.isPaused("posting", post.accountId))) {
      this.logger.warn(`Posting flow is paused — deferring post ${post.id}`);
      return {
        kind: "throw",
        error: new RetryableError(
          post.network,
          "Posting flow is paused — job will retry when resumed",
        ),
      };
    }

    // Idempotent — don't post if already verified
    if (post.status === PostStatus.VERIFIED) {
      return { kind: "return", result: { success: true, url: post.postUrl ?? undefined } };
    }

    // P1-04a: A POSTED post that hasn't been verified yet can be re-verified on a
    // retry. This avoids the case where a publish succeeds but verification fails,
    // leaving the post stuck in POSTED and never emitting POST_VERIFIED.
    if (post.status === PostStatus.POSTED) {
      if (post.postUrl) {
        return { kind: "reverify", post };
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
        `Post ${post.id} is already POSTING — not retrying (likely orphaned by a worker restart)`,
      );
      return {
        kind: "return",
        result: { success: false, error: "Post is already being posted", retryable: false },
      };
    }
    // FAILED/REJECTED are terminal — a prior attempt already resolved this post, and
    // retrying postById() on the same postId (BullMQ jobId = postId) will hit this exact
    // branch every time forever.
    if (post.status === PostStatus.FAILED || post.status === PostStatus.REJECTED) {
      this.logger.warn(`Post ${post.id} is already ${post.status} — not retrying`);
      return {
        kind: "return",
        result: {
          success: false,
          error: `Post ${post.id} is ${post.status}, not retryable`,
          retryable: false,
        },
      };
    }
    if (post.status !== PostStatus.APPROVED) {
      return {
        kind: "throw",
        error: new NotFoundException(`Post ${post.id} is not approved (status: ${post.status})`),
      };
    }

    const policyParams: AuthorizePlatformActionParams = {
      accountId: post.accountId,
      network: post.network,
      action: "POST",
      transport: post.network === SocialNetwork.TELEGRAM ? "OFFICIAL_API" : "BROWSER",
      targetRelationship: "OWN_POST",
      contentRiskTier: "LOW",
      requestedMode: "APPROVED_AUTOMATION",
    };
    const policyDecision = this.actionAuthorizer
      ? await this.actionAuthorizer.authorize(policyParams)
      : undefined;
    if (policyDecision && policyDecision.allowedMode !== "APPROVED_AUTOMATION") {
      const error = `Policy mode ${policyDecision.allowedMode}: ${policyDecision.blockReasons.join("; ")}`;
      this.logger.warn(`Policy blocked posting ${post.id}: ${error}`);
      return { kind: "return", result: { success: false, error, retryable: false } };
    }

    return { kind: "proceed", policyParams, policyDecision };
  }

  /**
   * G-3 rate-limit check — kept separate from runPostGuards because it runs AFTER
   * A/B variant resolution in the original order (variant selection persists DB
   * state that must not diverge from the original sequence).
   */
  async checkRateLimit(
    post: Post,
  ): Promise<{ allowed: true } | { allowed: false; result: PostingResult }> {
    const rateCheck = await this.rateLimitService.checkRateLimit(
      String(post.network),
      post.accountId,
    );
    if (rateCheck.allowed) return { allowed: true };
    this.logger.warn(`Rate limited for ${String(post.network)}: ${rateCheck.reason}`);
    return {
      allowed: false,
      result: {
        success: false,
        error: rateCheck.reason,
        retryable: false,
        rateLimit: true,
        retryAfterMs: rateCheck.retryAfterMs,
      },
    };
  }

  /**
   * F20 warm-up gate — browse-only accounts defer posting via RetryableError.
   */
  async checkWarmup(post: Post): Promise<void> {
    const canPost = await this.warmupService.canPost(post.accountId);
    if (!canPost) {
      this.logger.warn(
        `Account ${post.accountId} is in warm-up (browse-only) — deferring post ${post.id}`,
      );
      throw new RetryableError(
        post.network,
        "Account in warm-up phase (browse-only) — posting deferred",
      );
    }
  }
}

