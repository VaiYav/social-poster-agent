import { Injectable, Logger } from "@nestjs/common";
import { GenerationRunStatus, GenerationTrigger } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { RedisCheckpointSaver } from "../../infrastructure/checkpoint/redis-checkpoint.js";
import { SseService } from "../../infrastructure/sse/sse.service.js";

@Injectable()
export class GenerationRunLifecycleService {
  private readonly logger = new Logger(GenerationRunLifecycleService.name);
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseService: SseService,
    private readonly checkpointSaver: RedisCheckpointSaver,
  ) {}

  async start(triggeredBy: GenerationTrigger, count: number) {
    const run = await this.prisma.generationRun.create({
      data: { triggeredBy, sourceTopics: [] },
    });
    await this.sseService.publish({ type: "generation_started", runId: run.id, count });
    return run;
  }

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    return controller;
  }

  remove(runId: string): void {
    this.activeRuns.delete(runId);
  }

  async markCompleted(runId: string, topics: string[], errorMessage?: string): Promise<void> {
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: errorMessage ? GenerationRunStatus.FAILED : GenerationRunStatus.COMPLETED,
        completedAt: new Date(),
        sourceTopics: topics,
        errorMessage,
      },
    });

    if (!errorMessage && topics.length > 0) {
      try {
        await this.checkpointSaver.deleteRunCheckpoints(runId);
      } catch (error) {
        this.logger.warn(
          `Checkpoint cleanup for ${runId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async markFailed(runId: string, errorMessage: string): Promise<void> {
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: GenerationRunStatus.FAILED,
        completedAt: new Date(),
        errorMessage,
      },
    });
    await this.sseService.publish({ type: "generation_failed", runId, error: errorMessage });
  }

  async pause(runId: string): Promise<{ runId: string; status: string }> {
    const controller = this.activeRuns.get(runId);
    controller?.abort();
    this.remove(runId);
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: GenerationRunStatus.PAUSED,
        completedAt: new Date(),
        errorMessage: "Paused by operator",
      },
    });
    await this.sseService.publish({ type: "generation_paused", runId });
    return { runId, status: "paused" };
  }

  async prepareResume(runId: string) {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error(`Generation run ${runId} not found`);

    await this.prisma.generationRun.update({
      where: { id: runId },
      data: { status: GenerationRunStatus.RUNNING, completedAt: null, errorMessage: null },
    });
    await this.sseService.publish({ type: "generation_resumed", runId });
    return run;
  }
}
