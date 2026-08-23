import { Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  LangfuseService,
  type LangfuseScoreInput,
} from "../../infrastructure/langfuse/langfuse.service.js";
import { isOrchestratorEnabled } from "../../domain/feature-flags.js";

const SCORE_PREFIX = "spa-review:";

export interface FeedbackSyncResult {
  examined: number;
  synced: number;
  failed: number;
  skipped: number;
}

/**
 * Reconciles durable PostgreSQL review truth to Langfuse scores.
 * PostgreSQL remains authoritative: a Langfuse outage changes only sync state,
 * never the already-committed operator decision.
 */
@Injectable()
export class FeedbackSyncService implements OnModuleInit {
  private readonly logger = new Logger(FeedbackSyncService.name);
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly orchestratorIntervalMs: number;
  private nextOrchestratorRunAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly langfuse: LangfuseService,
    private readonly configService: ConfigService,
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
  ) {
    this.batchSize = Math.max(
      1,
      this.configService.get<number>("REVIEW_FEEDBACK_SYNC_BATCH_SIZE", 50),
    );
    this.maxAttempts = Math.max(
      1,
      this.configService.get<number>("REVIEW_FEEDBACK_SYNC_MAX_ATTEMPTS", 8),
    );
    this.orchestratorIntervalMs = Math.max(
      1_000,
      this.configService.get<number>("REVIEW_FEEDBACK_SYNC_ORCHESTRATOR_INTERVAL_MS", 300_000),
    );
  }

  /** Called by the orchestrator OBSERVE cycle when its cron path is disabled. */
  async syncIfDue(): Promise<FeedbackSyncResult | null> {
    if (!this.langfuse.isEnabled || Date.now() < this.nextOrchestratorRunAt) return null;
    this.nextOrchestratorRunAt = Date.now() + this.orchestratorIntervalMs;
    return this.syncPending();
  }

  onModuleInit(): void {
    if (isOrchestratorEnabled()) {
      this.logger.log("Orchestrator is enabled — review feedback sync cron NOT registered");
      return;
    }
    const expression = this.configService.get<string>("REVIEW_FEEDBACK_SYNC_CRON", "*/5 * * * *");
    const job = new CronJob(expression, () => {
      void this.syncPending();
    });
    if (!this.schedulerRegistry) {
      this.logger.warn("SchedulerRegistry unavailable — review feedback sync will be manual");
      return;
    }
    try {
      this.schedulerRegistry.addCronJob("review-feedback-sync", job);
      job.start();
      this.logger.log(`Review feedback sync cron registered: ${expression}`);
    } catch {
      this.logger.warn("SchedulerRegistry unavailable — review feedback sync will be manual");
    }
  }

  async syncPending(limit = this.batchSize): Promise<FeedbackSyncResult> {
    if (!this.langfuse.isEnabled) {
      return { examined: 0, synced: 0, failed: 0, skipped: 0 };
    }

    const rows = await this.prisma.postReviewDecision.findMany({
      where: {
        syncStatus: { in: ["PENDING", "FAILED"] },
        syncAttempts: { lt: this.maxAttempts },
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(limit, this.batchSize)),
    });
    const result: FeedbackSyncResult = { examined: rows.length, synced: 0, failed: 0, skipped: 0 };

    for (const row of rows) {
      const outcome = await this.syncOne(row);
      result[outcome] += 1;
    }
    return result;
  }

  private async syncOne(row: {
    id: string;
    syncStatus: string;
    syncAttempts: number;
    langfuseTraceId: string | null;
    langfuseObservationId: string | null;
    decision: string;
    reasonCodes: unknown;
    rubric: unknown;
    comment: string | null;
    normalizedEditDistance: number | null;
  }): Promise<"synced" | "failed" | "skipped"> {
    const claimed = await this.prisma.postReviewDecision.updateMany({
      where: {
        id: row.id,
        syncStatus: { in: ["PENDING", "FAILED"] },
        syncAttempts: { lt: this.maxAttempts },
      },
      data: { syncStatus: "SYNCING", syncAttempts: { increment: 1 } },
    });
    if (claimed.count === 0) return "skipped";

    if (!row.langfuseTraceId && !row.langfuseObservationId) {
      await this.prisma.postReviewDecision.update({
        where: { id: row.id },
        data: { syncStatus: "SKIPPED", lastSyncError: "No Langfuse trace or observation id" },
      });
      return "skipped";
    }

    try {
      for (const score of this.buildScores(row)) {
        const sent = await this.langfuse.createScore(score);
        if (!sent) throw new Error(`Langfuse rejected score ${score.name}`);
      }
      await this.prisma.postReviewDecision.update({
        where: { id: row.id },
        data: {
          syncStatus: "SYNCED",
          lastSyncError: null,
          langfuseSyncedAt: new Date(),
        },
      });
      return "synced";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.postReviewDecision.update({
        where: { id: row.id },
        data: { syncStatus: "FAILED", lastSyncError: message.slice(0, 1000) },
      });
      this.logger.warn(`Review ${row.id} Langfuse sync failed: ${message}`);
      return "failed";
    }
  }

  private buildScores(row: {
    id: string;
    langfuseTraceId: string | null;
    langfuseObservationId: string | null;
    decision: string;
    reasonCodes: unknown;
    rubric: unknown;
    comment: string | null;
    normalizedEditDistance: number | null;
  }): LangfuseScoreInput[] {
    const target = row.langfuseObservationId
      ? { observationId: row.langfuseObservationId }
      : { traceId: row.langfuseTraceId! };
    const reasonCodes = Array.isArray(row.reasonCodes)
      ? row.reasonCodes.filter((value): value is string => typeof value === "string")
      : [];
    const comment = [
      `decision=${row.decision}`,
      reasonCodes.length > 0 ? `reason_codes=${reasonCodes.join(",")}` : "reason_codes=none",
      row.comment ? `note_present=true; note=${redactComment(row.comment)}` : "note_present=false",
    ].join("; ");
    const scores: LangfuseScoreInput[] = [
      {
        ...target,
        id: `${SCORE_PREFIX}${row.id}:human-review-decision`,
        name: "human-review-decision",
        value: decisionValue(row.decision),
        dataType: "CATEGORICAL",
        comment,
      },
    ];
    if (row.normalizedEditDistance !== null) {
      scores.push({
        ...target,
        id: `${SCORE_PREFIX}${row.id}:human-edit-distance`,
        name: "human-edit-distance",
        value: row.normalizedEditDistance,
        dataType: "NUMERIC",
      });
    }
    if (row.rubric && typeof row.rubric === "object" && !Array.isArray(row.rubric)) {
      for (const [field, value] of Object.entries(row.rubric)) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2) {
          continue;
        }
        scores.push({
          ...target,
          id: `${SCORE_PREFIX}${row.id}:human-${field}`,
          name: `human-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
          value,
          dataType: "NUMERIC",
        });
      }
    }
    return scores;
  }
}

function decisionValue(decision: string): number {
  if (decision === "APPROVE_UNCHANGED") return 1;
  if (decision === "APPROVE_EDITED") return 0.5;
  return 0;
}

function redactComment(comment: string): string {
  return comment
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .slice(0, 500);
}
