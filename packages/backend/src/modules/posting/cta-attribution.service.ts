import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { IBrowserPort } from "../../domain/ports/browser.port.js";
import { SocialNetwork, type Post } from "../../generated/prisma/client.js";
import {
  IRuntimeActionAuthorizer,
  type AuthorizePlatformActionParams,
} from "../policy/policy.types.js";
import { LinkAttributionService } from "../link-attribution/link-attribution.service.js";
import type { PostingDispatcher } from "./poster-registry.service.js";

interface PolicyDecisionShape {
  allowedMode: string;
  blockReasons: string[];
  policyHash: string;
}

export interface ResolvedCta {
  /** Content to publish (CTA appended inline when applicable). */
  content: string;
  /** Set when the CTA ships as a first reply after verification (X/Threads). */
  replyLinkUrl?: string;
}

/**
 * REFACTOR-103: lead-funnel CTA handling (M2.1/M2.3) in one place.
 *
 * - Root posts only — continuations never carry links.
 * - X/Threads deliver the link as a first reply after verification;
 *   inline networks get it appended below the content.
 * - Never blocks posting: every failure degrades to "post live, CTA missing".
 */
@Injectable()
export class CtaAttributionService {
  private readonly logger = new Logger(CtaAttributionService.name);

  constructor(
    private readonly dispatcher: PostingDispatcher,
    @Optional() private readonly linkAttribution?: LinkAttributionService,
    @Optional()
    @Inject(IRuntimeActionAuthorizer)
    private readonly actionAuthorizer?: {
      authorize(params: AuthorizePlatformActionParams): Promise<PolicyDecisionShape>;
      reauthorize(
        params: AuthorizePlatformActionParams,
        expectedPolicyHash: string,
      ): Promise<PolicyDecisionShape>;
    },
  ) {}

  /**
   * M2.1: assign a trackable CTA for a root post before publishing.
   * Continuations (F2) and posts that already carry a ctaUrl are passed through
   * untouched. Degrades to UTM fallback or no CTA; never throws.
   */
  async prepare(post: Post, isContinuation: boolean): Promise<ResolvedCta> {
    if (isContinuation || post.ctaUrl) {
      return { content: post.content };
    }

    let content = post.content;
    let replyLinkUrl: string | undefined;

    const cta = await this.linkAttribution?.assignForPost(post);
    if (cta) {
      if (cta.mode === "inline") {
        content = LinkAttributionService.appendInline(post.content, cta.ctaUrl);
      } else {
        replyLinkUrl = cta.ctaUrl;
      }
      if (cta.source === "utm-fallback") {
        this.logger.warn(
          `Post ${post.id} ships with a direct UTM CTA (attribution provider unreachable) — attribution limited to clicks`,
        );
      }
    }
    return { content, replyLinkUrl };
  }

  /**
   * M2.3: first-reply link delivery (X/Threads). Fire after the root is POSTED;
   * failure must never fail the job — the post is live, only the CTA reply would
   * be missing (logged for retry).
   */
  async deliverFirstReply(
    post: Post,
    basePolicyParams: AuthorizePlatformActionParams,
    context: NonNullable<Awaited<ReturnType<IBrowserPort["acquireContext"]>>>,
    rootUrl: string,
    replyLinkUrl: string,
  ): Promise<void> {
    const poster = this.dispatcher.getReplyCapablePoster(post.network);
    if (!poster) {
      this.logger.warn(
        `CTA first-reply requested for ${post.id} but ${post.network as string} has no reply-capable poster`,
      );
      return;
    }
    try {
      const replyPolicyParams: AuthorizePlatformActionParams = {
        ...basePolicyParams,
        action: "REPLY",
        targetRelationship: "OWN_POST",
      };
      const replyDecision = this.actionAuthorizer
        ? await this.actionAuthorizer.authorize(replyPolicyParams)
        : undefined;
      if (replyDecision && replyDecision.allowedMode !== "APPROVED_AUTOMATION") {
        this.logger.warn(
          `Policy skipped CTA reply for ${post.id}: ${replyDecision.blockReasons.join("; ")}`,
        );
        return;
      }
      if (this.actionAuthorizer && replyDecision) {
        const current = await this.actionAuthorizer.reauthorize(
          replyPolicyParams,
          replyDecision.policyHash,
        );
        if (current.allowedMode !== "APPROVED_AUTOMATION") {
          this.logger.warn(
            `Policy changed before CTA reply for ${post.id}: ${current.blockReasons.join("; ")}`,
          );
          return;
        }
      }
      await poster.postThreadReply(context, rootUrl, replyLinkUrl);
      this.logger.log(`CTA reply with ${replyLinkUrl} posted under ${rootUrl}`);
    } catch (err) {
      this.logger.warn(
        `CTA reply failed for ${post.id} (${err instanceof Error ? err.message : String(err)}) — post is live, CTA missing`,
      );
    }
  }

  /** Networks whose posters can post threaded replies (used by tests/telemetry). */
  supportsFirstReply(network: SocialNetwork): boolean {
    return this.dispatcher.getReplyCapablePoster(network) !== null;
  }
}
