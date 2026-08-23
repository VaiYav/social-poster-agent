/**
 * QueueTriageService — LLM-in-the-loop triage for failed posting jobs.
 *
 * Collects a batch of failed BullMQ jobs, builds a context prompt, calls the
 * LLM with the 'utility' role (cheap analytical model), and applies the
 * returned decisions:
 *   - RETRY        → move job from failed back to waiting
 *   - REQUEUE_DELAY → remove failed job and schedule a fresh delayed job
 *   - REJECT       → mark Post as FAILED and remove the dead job
 *   - ESCALATE     → emit an alert and leave the job for human review
 *
 * Feature flag: LLM_QUEUE_TRIAGE_ENABLED (default false).
 */
import { Injectable, Logger, Inject, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PostStatus, SocialNetwork } from "../../generated/prisma/client.js";
import type { Job } from "bullmq";
import { z } from "zod";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";
import { ILlmPort, type LlmResponse } from "../../domain/ports/llm.port.js";
import { IPromptPort } from "../../domain/ports/prompt.port.js";
import { parseBool } from "../../infrastructure/config/parse-bool.js";
import { getEnabledNetworks } from "../../domain/enabled-networks.js";
import { interpolate } from "../../domain/prompt-interpolation.js";
import {
  QUEUE_TRIAGE_FALLBACK,
  QUEUE_TRIAGE_SYSTEM_PROMPT,
  QUEUE_TRIAGE_USER_PROMPT_TEMPLATE,
} from "./prompts/queue-triage-prompt.js";

export type TriageDecision = "RETRY" | "REQUEUE_DELAY" | "REJECT" | "ESCALATE";

export interface TriageDecisionItem {
  postId: string;
  decision: TriageDecision;
  delayMinutes?: number;
  reason: string;
}

export interface TriageResult {
  network: string;
  examined: number;
  retried: number;
  requeuedDelayed: number;
  rejected: number;
  escalated: number;
  skipped: number;
  errors: number;
  decisions: TriageDecisionItem[];
  /** When true, this is a dry-run: decisions were proposed, not applied. */
  dryRun?: boolean;
}

interface JobContext {
  postId: string;
  jobId: string | number;
  network: string;
  failedReason: string;
  attemptsMade: number;
  totalAttempts: number;
  postStatus?: string;
  postApprovedAt?: string;
  postContent?: string;
  postErrorMessage?: string;
}

const TriageOutputSchema = z.object({
  decisions: z.array(
    z.object({
      postId: z.string(),
      decision: z.enum(["RETRY", "REQUEUE_DELAY", "REJECT", "ESCALATE"]),
      delayMinutes: z.number().int().min(0).optional(),
      reason: z.string(),
    }),
  ),
});

@Injectable()
export class QueueTriageService {
  private readonly logger = new Logger(QueueTriageService.name);
  private readonly enabled: boolean;
  private readonly maxJobs: number;
  private readonly maxTokens: number;

  constructor(
    private readonly queueFactory: QueueFactory,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() @Inject(ILlmPort) private readonly llm?: ILlmPort,
    @Optional() @Inject(IPromptPort) private readonly promptPort?: IPromptPort,
    @Optional() private readonly sseService?: SseService,
    @Optional() private readonly flowControl?: FlowControlService,
  ) {
    this.enabled = parseBool(this.configService.get<string>("LLM_QUEUE_TRIAGE_ENABLED", "false"));
    const rawMaxJobs = Number(this.configService.get<string>("LLM_QUEUE_TRIAGE_MAX_JOBS", "20"));
    this.maxJobs = Number.isFinite(rawMaxJobs) && rawMaxJobs > 0 ? Math.floor(rawMaxJobs) : 20;
    const rawMaxTokens = Number(
      this.configService.get<string>("LLM_QUEUE_TRIAGE_MAX_TOKENS", "800"),
    );
    this.maxTokens =
      Number.isFinite(rawMaxTokens) && rawMaxTokens > 0 ? Math.floor(rawMaxTokens) : 800;
  }

  /**
   * Triage all enabled networks in sequence. Returns per-network results.
   */
  async triageAll(options?: { dryRun?: boolean }): Promise<TriageResult[]> {
    if (this.flowControl && (await this.flowControl.isPaused("llm_triage"))) {
      this.logger.warn("LLM queue triage is paused via flow:pause_llm_triage — skipping");
      return [];
    }
    if (!this.enabled) {
      this.logger.warn(
        "LLM queue triage is disabled — set LLM_QUEUE_TRIAGE_ENABLED=true to enable",
      );
      return [];
    }
    if (!this.llm) {
      this.logger.warn("No LLM port available — cannot triage queue");
      return [];
    }

    const networks = getEnabledNetworks();
    const results: TriageResult[] = [];
    for (const network of networks) {
      results.push(await this.triageNetwork(network, options));
    }
    return results;
  }

  /**
   * Triage failed jobs for a single network.
   */
  async triageNetwork(
    network: SocialNetwork,
    options?: { dryRun?: boolean },
  ): Promise<TriageResult> {
    if (this.flowControl && (await this.flowControl.isPaused("llm_triage"))) {
      this.logger.warn(`LLM queue triage paused for ${network} — flow:pause_llm_triage`);
      return {
        network,
        examined: 0,
        retried: 0,
        requeuedDelayed: 0,
        rejected: 0,
        escalated: 0,
        skipped: 0,
        errors: 0,
        decisions: [],
      };
    }
    const result: TriageResult = {
      network,
      examined: 0,
      retried: 0,
      requeuedDelayed: 0,
      rejected: 0,
      escalated: 0,
      skipped: 0,
      errors: 0,
      decisions: [],
      dryRun: options?.dryRun,
    };

    if (!this.enabled || !this.llm) {
      return result;
    }

    const failedJobs = await this.queueFactory.getFailedJobs(network);
    const jobs = failedJobs.slice(0, this.maxJobs);
    result.examined = jobs.length;

    if (jobs.length === 0) {
      return result;
    }

    const contexts = await this.buildContexts(jobs, network);

    // P1 hard-filters: some failures are obvious without asking the LLM.
    const prefiltered: TriageDecisionItem[] = [];
    const forLlm: JobContext[] = [];
    for (const ctx of contexts) {
      const pre = this.preFilterDecision(ctx);
      if (pre) {
        prefiltered.push(pre);
      } else {
        forLlm.push(ctx);
      }
    }

    const decisions = prefiltered.concat(forLlm.length > 0 ? await this.askLlm(forLlm) : []);
    result.decisions = decisions;

    if (options?.dryRun) {
      this.logger.log(
        `Queue triage dry-run for ${network}: ${decisions.length} proposed decisions`,
      );
      return result;
    }

    for (const decision of decisions) {
      try {
        await this.applyDecision(network, decision, result);
      } catch (err) {
        this.logger.error(
          `Queue triage: failed to apply decision for ${decision.postId}: ${(err as Error).message}`,
        );
        result.errors += 1;
      }
    }

    return result;
  }

  private async buildContexts(jobs: Job[], network: SocialNetwork): Promise<JobContext[]> {
    const postIds = jobs
      .map((job) => (job.data as { postId?: string } | undefined)?.postId ?? job.id)
      .filter((id): id is string => typeof id === "string");

    const posts = await this.prisma.post.findMany({
      where: { id: { in: postIds } },
      select: {
        id: true,
        status: true,
        approvedAt: true,
        content: true,
        errorMessage: true,
        network: true,
        accountId: true,
      },
    });
    const postById = new Map(posts.map((p) => [p.id, p]));

    return jobs.map((job) => {
      const postId = String((job.data as { postId?: string } | undefined)?.postId ?? job.id ?? "");
      const post = postById.get(postId);
      return {
        postId,
        jobId: job.id ?? postId,
        network,
        failedReason: job.failedReason ?? "(no error message)",
        attemptsMade: job.attemptsMade ?? 0,
        totalAttempts: job.opts?.attempts ?? 1,
        postStatus: post?.status,
        postApprovedAt: post?.approvedAt?.toISOString(),
        postContent: post?.content ? String(post.content).slice(0, 200) : undefined,
        postErrorMessage: post?.errorMessage ?? undefined,
      };
    });
  }

  private async askLlm(contexts: JobContext[]): Promise<TriageDecisionItem[]> {
    const batch = contexts
      .map(
        (ctx) =>
          `- postId: ${ctx.postId}\n  network: ${ctx.network}\n  failedReason: ${ctx.failedReason}\n  attempts: ${ctx.attemptsMade}/${ctx.totalAttempts}\n  postStatus: ${ctx.postStatus ?? "unknown"}\n  approvedAt: ${ctx.postApprovedAt ?? "unknown"}\n  contentPreview: ${ctx.postContent ?? "n/a"}`,
      )
      .join("\n\n");

    const compiled = this.promptPort
      ? await this.promptPort.getCompiledChat(
          "queue-triage",
          { batch, utcTime: new Date().toISOString() },
          QUEUE_TRIAGE_FALLBACK,
        )
      : {
          systemPrompt: interpolate(QUEUE_TRIAGE_SYSTEM_PROMPT, {}),
          userPrompt: interpolate(QUEUE_TRIAGE_USER_PROMPT_TEMPLATE, {
            batch,
            utcTime: new Date().toISOString(),
          }),
        };

    const response: LlmResponse = await this.llm!.generateChat(
      compiled.systemPrompt,
      compiled.userPrompt,
      { temperature: 0.1, maxTokens: this.maxTokens, role: "utility" },
    );

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON in LLM triage response");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validated = TriageOutputSchema.parse(parsed);
    return validated.decisions;
  }

  /**
   * P1 hard-filters: deterministic triage decisions that do not need an LLM.
   *   - rate-limit → REQUEUE_DELAY
   *   - post already terminal (REJECTED/FAILED/POSTED) or missing → REJECT (clear stale job)
   *   - permanent failure (banned/suspended/disabled/deleted) → REJECT
   *   - transient error with retries remaining → RETRY
   * Returns null when the LLM should decide.
   */
  private preFilterDecision(ctx: JobContext): TriageDecisionItem | null {
    const reason = ctx.failedReason.toLowerCase();

    if (this.isRateLimit(reason)) {
      return {
        postId: ctx.postId,
        decision: "REQUEUE_DELAY",
        delayMinutes: this.deriveDelayMinutes(reason),
        reason: "Hard-filter: rate-limit error",
      };
    }

    // Post is already terminal or missing — the posting job is stale.
    if (!ctx.postStatus || ["REJECTED", "FAILED", "POSTED"].includes(ctx.postStatus)) {
      return {
        postId: ctx.postId,
        decision: "REJECT",
        reason: `Hard-filter: post status ${ctx.postStatus ?? "missing"}`,
      };
    }

    if (this.isPermanentFailure(reason)) {
      return {
        postId: ctx.postId,
        decision: "REJECT",
        reason: "Hard-filter: permanent failure (banned/disabled/deleted)",
      };
    }

    if (ctx.attemptsMade < ctx.totalAttempts && this.isRetriableTransient(reason)) {
      return {
        postId: ctx.postId,
        decision: "RETRY",
        reason: "Hard-filter: transient error with retries remaining",
      };
    }

    return null;
  }

  private isRateLimit(reason: string): boolean {
    return /rate.?limit|daily limit|weekly limit|too many requests|429/.test(reason);
  }

  private isPermanentFailure(reason: string): boolean {
    return /banned|suspended|locked|disabled|not found|deleted|forbidden|unauthorized|invalid credentials|wrong password|account.*closed|post.*deleted|network.*disabled/.test(
      reason,
    );
  }

  private isRetriableTransient(reason: string): boolean {
    return /timeout|connection|network|temporary|session expired|element not found|context or browser|econnrefused|socket|reset|aborted|too busy|busy/.test(
      reason,
    );
  }

  private deriveDelayMinutes(reason: string): number {
    const daily = /daily limit|rate.?limit.*day/.test(reason);
    const weekly = /weekly limit|rate.?limit.*week/.test(reason);
    if (daily) return 60; // 1 hour, often enough for short windows
    if (weekly) return 360; // 6 hours
    return 15; // generic 429
  }

  private async applyDecision(
    network: SocialNetwork,
    decision: TriageDecisionItem,
    result: TriageResult,
  ): Promise<void> {
    const post = await this.prisma.post.findUnique({
      where: { id: decision.postId },
      select: { id: true, status: true, network: true, accountId: true },
    });

    // REJECT is allowed for terminal/missing posts so we can clear stale dead jobs.
    if (!post) {
      if (decision.decision === "REJECT") {
        result.decisions.push(decision);
        await this.applyReject(network, decision, result, undefined);
      } else {
        this.logger.warn(`Queue triage: post ${decision.postId} not found — skipping`);
        result.skipped += 1;
      }
      return;
    }

    if (post.network !== network) {
      this.logger.warn(
        `Queue triage: post ${decision.postId} network mismatch (${post.network} vs ${network}) — skipping`,
      );
      result.skipped += 1;
      return;
    }

    if (decision.decision === "REJECT") {
      result.decisions.push(decision);
      await this.applyReject(network, decision, result, post.status);
      return;
    }

    if (post.status !== PostStatus.APPROVED) {
      this.logger.warn(
        `Queue triage: post ${decision.postId} is ${post.status}, not APPROVED — skipping`,
      );
      result.skipped += 1;
      return;
    }

    result.decisions.push(decision);

    switch (decision.decision) {
      case "RETRY":
        await this.applyRetry(network, decision, result);
        break;
      case "REQUEUE_DELAY":
        await this.applyRequeueDelay(network, decision, result, post.accountId);
        break;
      case "ESCALATE":
        await this.applyEscalate(network, decision, result);
        break;
    }
  }

  private async applyRetry(
    network: SocialNetwork,
    decision: TriageDecisionItem,
    result: TriageResult,
  ): Promise<void> {
    await this.queueFactory.retryFailedJob(network, decision.postId);
    this.logger.log(`Queue triage: RETRY ${decision.postId} — ${decision.reason}`);
    result.retried += 1;
  }

  private async applyRequeueDelay(
    network: SocialNetwork,
    decision: TriageDecisionItem,
    result: TriageResult,
    accountId?: string,
  ): Promise<void> {
    const delayMinutes = decision.delayMinutes ?? 60;
    const delayMs = delayMinutes * 60 * 1000;
    await this.queueFactory.enqueuePosting(decision.postId, network, { delay: delayMs }, accountId);
    this.logger.log(
      `Queue triage: REQUEUE_DELAY ${decision.postId} for ${delayMinutes}min — ${decision.reason}`,
    );
    result.requeuedDelayed += 1;
  }

  private async applyReject(
    network: SocialNetwork,
    decision: TriageDecisionItem,
    result: TriageResult,
    postStatus?: PostStatus,
  ): Promise<void> {
    // Only move APPROVED/POSTING posts to FAILED. Terminal or missing posts
    // should still have their stale job removed, but we should not overwrite
    // a POSTED/REJECTED status.
    if (postStatus === PostStatus.APPROVED || postStatus === PostStatus.POSTING) {
      await this.prisma.post.update({
        where: { id: decision.postId },
        data: {
          status: PostStatus.FAILED,
          errorMessage: `LLM triage REJECT: ${decision.reason}`,
        },
      });
    } else if (!postStatus) {
      this.logger.warn(
        `Queue triage: REJECT ${decision.postId} — post record not found, removing stale job only`,
      );
    } else {
      this.logger.warn(
        `Queue triage: REJECT ${decision.postId} — post is ${postStatus}, removing stale job only`,
      );
    }

    const queue = this.queueFactory.getQueue(network, "posting");
    const job = await queue.getJob(decision.postId);
    if (job) {
      await job.remove();
    }

    this.logger.log(`Queue triage: REJECT ${decision.postId} — ${decision.reason}`);
    result.rejected += 1;
  }

  private async applyEscalate(
    network: SocialNetwork,
    decision: TriageDecisionItem,
    result: TriageResult,
  ): Promise<void> {
    const message = `Queue triage ESCALATE for post ${decision.postId} (${network}): ${decision.reason}`;
    this.logger.warn(message);
    await this.sseService?.publish({
      type: "health_alert",
      severity: "warning",
      error: message,
    });
    result.escalated += 1;
  }
}
