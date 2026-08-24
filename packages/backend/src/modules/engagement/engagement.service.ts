// Engagement service — orchestrates individual engagement actions (like, comment, follow).
// Unlike browsing sessions (which are autonomous), these are explicit API-triggered actions.

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { WarmupService } from "../sessions/warmup.service.js";
import { AccountsService } from "../accounts/accounts.service.js";
import { IBrowserPort } from "../../domain/ports/browser.port.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import { EngagementSafetyService } from "./engagement-safety.service.js";
import {
  InteractionStatus,
  InteractionType,
  SocialNetwork,
  type Prisma,
} from "../../generated/prisma/client.js";
import type { Page } from "../../domain/ports/browser-primitives.js";
import type { BaseEngager } from "./engagers/base.engager.js";
import { XEngager } from "./engagers/x.engager.js";
import { ThreadsEngager } from "./engagers/threads.engager.js";
import { FacebookEngager } from "./engagers/facebook.engager.js";
import type { EngagementResult } from "../posting/posters/base.poster.js";
import { isNetworkEnabled } from "../../domain/enabled-networks.js";
import type { IEngagementPort } from "../orchestrator/ports.js";
import {
  IRuntimeActionAuthorizer,
  type AuthorizePlatformActionParams,
  type PlatformAuthorizationDecision,
} from "../policy/policy.types.js";

@Injectable()
export class EngagementService implements IEngagementPort {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsService: SessionsService,
    @Inject(IBrowserPort) private readonly browser: IBrowserPort,
    private readonly sseService: SseService,
    private readonly rateLimitService: RateLimitService,
    private readonly flowControlService: FlowControlService,
    private readonly xEngager: XEngager,
    private readonly threadsEngager: ThreadsEngager,
    private readonly facebookEngager: FacebookEngager,
    @Optional() private readonly accountsService?: AccountsService,
    @Optional() private readonly warmupService?: WarmupService,
    private readonly engagementSafetyService: EngagementSafetyService = new EngagementSafetyService(),
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

  /**
   * Like a post on the given network.
   */
  async like(
    network: SocialNetwork,
    postUrl: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.LIKE,
      postUrl,
      undefined,
      (engager, page) => engager.like(page, postUrl),
    );
  }

  /**
   * Comment on a post on the given network.
   */
  async comment(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.COMMENT,
      postUrl,
      text,
      (engager, page) => engager.comment(page, postUrl, text),
    );
  }

  /**
   * Follow a user/page on the given network.
   */
  async follow(
    network: SocialNetwork,
    handleOrUrl: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.FOLLOW,
      undefined,
      undefined,
      (engager, page) => engager.follow(page, handleOrUrl),
      handleOrUrl,
    );
  }

  /**
   * Reply to a post on the given network.
   */
  async reply(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(network, InteractionType.REPLY, postUrl, text, (engager, page) =>
      engager.reply(page, postUrl, text),
    );
  }

  /**
   * Repost a post on the given network.
   */
  async repost(
    network: SocialNetwork,
    postUrl: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(
      network,
      InteractionType.REPOST,
      postUrl,
      undefined,
      (engager, page) => engager.repost(page, postUrl),
    );
  }

  /**
   * Quote a post on the given network.
   */
  async quote(
    network: SocialNetwork,
    postUrl: string,
    text: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    return this.performInteraction(network, InteractionType.QUOTE, postUrl, text, (engager, page) =>
      engager.quote(page, postUrl, text),
    );
  }

  /**
   * Core method for performing a single engagement interaction.
   * Creates an Interaction record, performs the action, updates the record.
   */
  private async performInteraction(
    network: SocialNetwork,
    type: InteractionType,
    targetUrl: string | undefined,
    content: string | undefined,
    performAction: (
      engager: BaseEngager,
      page: import("playwright-core").Page,
    ) => Promise<EngagementResult>,
    targetHandle?: string,
  ): Promise<EngagementResult & { interactionId: string }> {
    if (!isNetworkEnabled(network)) {
      this.logger.warn(`Interaction ${type} requested for disabled network ${network} — skipping`);
      return {
        success: false,
        error: `Network ${network as string} is disabled`,
        interactionId: "",
      };
    }

    // ADR-006: respect flow control — direct API actions should also pause when
    // engagement is paused, so an operator can stop all engagement without restarting.
    if (await this.flowControlService.isPaused("engagement")) {
      this.logger.warn(`Engagement flow paused — skipping ${type} on ${network}`);
      return {
        success: false,
        error: "Engagement flow paused",
        interactionId: "",
      };
    }

    // F1 safety: only allow target URLs that belong to the selected network.
    if (targetUrl) {
      const urlCheck = this.engagementSafetyService.validateUrl(network, targetUrl);
      if (!urlCheck.allowed) {
        this.logger.warn(`Engagement safety: ${urlCheck.reason}`);
        return { success: false, error: urlCheck.reason, interactionId: "" };
      }
    }
    if (targetHandle && targetHandle.toLowerCase().startsWith("http")) {
      const urlCheck = this.engagementSafetyService.validateUrl(network, targetHandle);
      if (!urlCheck.allowed) {
        this.logger.warn(`Engagement safety: ${urlCheck.reason}`);
        return { success: false, error: urlCheck.reason, interactionId: "" };
      }
    }

    // F1 safety: block unsafe user-supplied or LLM-generated text.
    if (content) {
      const contentCheck = this.engagementSafetyService.checkContentSafety(content);
      if (!contentCheck.safe) {
        this.logger.warn(`Engagement safety: ${contentCheck.reason}`);
        return { success: false, error: contentCheck.reason, interactionId: "" };
      }
    }

    // Get or create session for an account on this network
    let accountId: string | undefined;
    if (this.accountsService) {
      const account = await this.accountsService.getNextAccountForNetwork(network);
      accountId = account?.id;
    }

    if (accountId && (await this.flowControlService.isPaused("engagement", accountId))) {
      this.logger.warn(`Engagement flow paused for account ${accountId} — skipping ${type}`);
      return { success: false, error: "Engagement flow paused for account", interactionId: "" };
    }

    const policyAction = type === InteractionType.COMMENT ? "REPLY" : (type as string);
    const policyParams: AuthorizePlatformActionParams | undefined = accountId
      ? {
          accountId,
          network,
          action: policyAction as AuthorizePlatformActionParams["action"],
          transport: "BROWSER",
          targetRelationship: "UNKNOWN",
          contentRiskTier: "LOW",
          requestedMode: "APPROVED_AUTOMATION",
        }
      : undefined;
    let policyDecision: PlatformAuthorizationDecision | undefined;
    if (this.actionAuthorizer) {
      if (!policyParams) {
        return {
          success: false,
          error: "Policy authorization requires a selected account",
          interactionId: "",
        };
      }
      policyDecision = await this.actionAuthorizer.authorize(policyParams);
      if (policyDecision.allowedMode !== "APPROVED_AUTOMATION") {
        this.logger.warn(
          `Policy blocked ${type} on ${network}: ${policyDecision.blockReasons.join("; ")}`,
        );
        return {
          success: false,
          error: `Policy mode ${policyDecision.allowedMode}: ${policyDecision.blockReasons.join("; ")}`,
          interactionId: "",
        };
      }
    }

    // Rate limit check — per network, account, and action so multi-account
    // setups don't share a single counter.
    const action = type.toLowerCase();
    const rateCheck = await this.rateLimitService.checkRateLimit(
      network as string,
      accountId,
      action,
    );
    if (!rateCheck.allowed) {
      this.logger.warn(`Rate limited for ${network} ${action}: ${rateCheck.reason}`);
      return {
        success: false,
        error: `Rate limited: ${rateCheck.reason}`,
        interactionId: "",
      };
    }

    const session = accountId
      ? await this.sessionsService.getOrCreateSession(accountId, network)
      : await this.sessionsService.getOrCreateSession(network);
    if (!session) {
      return {
        success: false,
        error: `No active session for ${network} — auto-login failed`,
        interactionId: "",
      };
    }

    // Warm-up gating — API-triggered actions must respect the account's interaction phase.
    if (this.warmupService && !(await this.warmupService.canInteract(session.accountId))) {
      this.logger.warn(
        `Account ${session.accountId} is in browse-only warm-up — skipping ${type} on ${network}`,
      );
      return {
        success: false,
        error: "Account is in warm-up browse-only phase",
        interactionId: "",
      };
    }

    // Create interaction record
    const interaction = await this.prisma.interaction.create({
      data: {
        accountId: session.accountId,
        type,
        status: InteractionStatus.IN_PROGRESS,
        targetUrl,
        targetHandle,
        content,
      },
    });

    // SSE event
    await this.sseService.publish({
      type: "interaction_started",
      interactionId: interaction.id,
      interactionType: type,
      network: network as string,
      targetUrl,
    });

    const engager = this.getEngager(network);

    // Acquire pooled/persistent browser context — decrypt storage state if encrypted (v1: prefix)
    const storageState = session.storageState
      ? this.sessionsService.decryptStorageState(session)
      : undefined;

    let context: Awaited<ReturnType<IBrowserPort["acquireContext"]>> | null = null;
    let page: Page | null = null;
    let result: EngagementResult | null = null;

    try {
      context = await this.browser.acquireContext(network, storageState, accountId);
      page = await context.newPage();

      // ADR-012: reauthorize immediately before the browser side effect. A
      // source expiry, operator pause or policy revision must win a cached
      // decision and fail closed.
      if (this.actionAuthorizer && policyParams && policyDecision) {
        const current = await this.actionAuthorizer.reauthorize(
          policyParams,
          policyDecision.policyHash,
        );
        if (current.allowedMode !== "APPROVED_AUTOMATION") {
          result = {
            success: false,
            error: `Policy changed before side effect: ${current.blockReasons.join("; ")}`,
          };
        } else {
          result = await performAction(engager, page);
        }
      } else {
        result = await performAction(engager, page);
      }

      // Save updated session state
      const updatedState = await this.browser.saveStorageState(context);
      await this.sessionsService.updateStorageState(session.id, updatedState);
    } catch (err) {
      const errorMsg = (err as Error).message;
      this.logger.error(`Interaction ${type} failed on ${network}: ${errorMsg}`);
      result = { success: false, error: errorMsg };
    } finally {
      if (page) {
        await page.close().catch(() => void 0);
      }
      if (context) {
        // Return the context to the pool (or no-op for persistent contexts) instead of closing it.
        this.browser.releaseContext(network, context, accountId);
      }
    }

    if (result) {
      // Update interaction record
      await this.prisma.interaction.update({
        where: { id: interaction.id },
        data: {
          status: result.success ? InteractionStatus.COMPLETED : InteractionStatus.FAILED,
          errorMessage: result.error,
          screenshotPath: result.screenshotPath,
          completedAt: new Date(),
        },
      });

      // Only count rate limit when we actually performed the action, not when we
      // skipped because it was already done (e.g., already liked).
      if (result.success && !result.alreadyLiked && !result.alreadyReposted) {
        await this.rateLimitService.recordPost(network as string, accountId, action);
      }

      // SSE event
      await this.sseService.publish({
        type: result.success ? "interaction_completed" : "interaction_failed",
        interactionId: interaction.id,
        interactionType: type,
        network: network as string,
        targetUrl,
        error: result.error,
      });

      this.logger.log(
        `Interaction ${type} on ${network}: ${result.success ? "success" : "failed"}`,
      );

      return { ...result, interactionId: interaction.id };
    }

    // Defensive fallback (should never reach here)
    return { success: false, error: "Unknown interaction error", interactionId: interaction.id };
  }

  /**
   * Get the appropriate engager for the network.
   */
  private getEngager(network: SocialNetwork): BaseEngager {
    switch (network) {
      case SocialNetwork.X:
        return this.xEngager;
      case SocialNetwork.THREADS:
        return this.threadsEngager;
      case SocialNetwork.FACEBOOK:
        return this.facebookEngager;
      default:
        throw new Error(`Unknown network: ${network as string}`);
    }
  }

  /**
   * Get engagement statistics.
   */
  async getStats(network?: SocialNetwork): Promise<{
    total: number;
    completed: number;
    failed: number;
    byType: Record<string, number>;
  }> {
    const where: Prisma.InteractionWhereInput = {};
    if (network) {
      where.account = { network };
    }

    const [total, completed, failed, byTypeRaw] = await Promise.all([
      this.prisma.interaction.count({ where }),
      this.prisma.interaction.count({ where: { ...where, status: InteractionStatus.COMPLETED } }),
      this.prisma.interaction.count({ where: { ...where, status: InteractionStatus.FAILED } }),
      this.prisma.interaction.groupBy({
        by: ["type"],
        where,
        _count: true,
      }),
    ]);

    const byType: Record<string, number> = {};
    for (const item of byTypeRaw) {
      byType[item.type] = item._count;
    }

    return { total, completed, failed, byType };
  }
}
