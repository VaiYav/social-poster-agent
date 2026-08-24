import { Injectable, Logger } from "@nestjs/common";
import type { LlmAttemptTelemetry } from "../../domain/ports/llm.port.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class LlmUsageLedgerService {
  private readonly logger = new Logger(LlmUsageLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordAttempts(
    attempts: readonly LlmAttemptTelemetry[],
    context: { accountId?: string; postId?: string; runId?: string },
  ): Promise<void> {
    if (attempts.length === 0) return;
    try {
      await this.prisma.$transaction(
        attempts.map((attempt) =>
          this.prisma.llmUsageEvent.create({
            data: {
              accountId: context.accountId,
              postId: context.postId,
              runId: context.runId,
              provider: attempt.provider_actual,
              model: attempt.model_actual,
              role: attempt.llm_role,
              tokensIn: attempt.input_tokens ?? 0,
              tokensOut: attempt.output_tokens ?? 0,
              costUsd: attempt.cost_usd ?? 0,
              cached: attempt.cache_hit || attempt.outcome === "cache_hit",
              durationMs: attempt.latency_ms,
              outcome: attempt.outcome,
              costSource: attempt.cost_source,
            },
          }),
        ),
      );
    } catch (error) {
      // Accounting must not turn a successful provider response into an LLM outage.
      this.logger.warn(
        `LLM usage ledger write skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
