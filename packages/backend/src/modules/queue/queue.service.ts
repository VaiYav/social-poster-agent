import { Injectable, Logger } from "@nestjs/common";
import { QueueFactory } from "../../infrastructure/queue/queue.factory.js";
import { SocialNetwork } from "../../generated/prisma/client.js";
import type { Job } from "bullmq";

/**
 * Serializable view of a failed/queued job for the REST API.
 * Exposes the fields the UI needs without leaking the full BullMQ Job object.
 */
export interface QueueJobDto {
  id?: string | number;
  name: string;
  data: unknown;
  failedReason?: string;
  attemptsMade: number;
  totalAttempts: number;
  status: "failed" | "completed" | "waiting" | "active" | "delayed" | "unknown";
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnValue?: unknown;
}

/**
 * Queue service — enqueue posting jobs to BullMQ.
 * Called by PostingController when operator approves a post.
 *
 * With queue: approve → enqueue → worker picks up → postById() → auto-retry on failure.
 * Without queue (fallback): approve → postById() directly (synchronous).
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(private readonly queueFactory: QueueFactory) {}

  async enqueuePosting(
    postId: string,
    network: SocialNetwork,
    opts?: { delay?: number },
    accountId?: string,
  ): Promise<void> {
    await this.queueFactory.enqueuePosting(postId, network, opts, accountId);
  }

  async getJobCounts(network: SocialNetwork) {
    return this.queueFactory.getJobCounts(network);
  }

  async getFailedJobs(network: SocialNetwork): Promise<QueueJobDto[]> {
    const jobs = await this.queueFactory.getFailedJobs(network);
    return jobs.map((job) => this.toJobDto(job, "failed"));
  }

  async pauseQueue(network: SocialNetwork): Promise<void> {
    await this.queueFactory.pauseQueue(network);
  }

  async resumeQueue(network: SocialNetwork): Promise<void> {
    await this.queueFactory.resumeQueue(network);
  }

  async isQueuePaused(network: SocialNetwork): Promise<boolean> {
    return this.queueFactory.isQueuePaused(network);
  }

  /**
   * Sprint Q: Retry all failed jobs in a network's posting queue.
   * Returns the number of jobs that were successfully retried.
   *
   * We skip jobs whose failure is a rate-limit exhaustion: retrying those
   * immediately wastes the full retry budget and spams the logs. They will
   * be naturally re-enqueued by the orchestrator once the rate window resets.
   */
  async retryAllFailed(network: SocialNetwork): Promise<number> {
    const failed = await this.queueFactory.getFailedJobs(network);
    let retried = 0;
    for (const job of failed) {
      try {
        if (!job.id) continue;
        if (/rate.limit|daily limit reached|weekly limit reached/i.test(job.failedReason ?? "")) {
          continue;
        }
        await this.queueFactory.retryFailedJob(network, job.id);
        retried++;
      } catch {
        // Skip individual retry failures — continue with the rest
      }
    }
    return retried;
  }

  /**
   * Clear completed jobs from a network's posting queue.
   * Needed because BullMQ dedup: queue.add() with same jobId no-ops if job exists
   * in completed/failed set. Clearing completed allows re-enqueueing the same postId.
   */
  async clearCompleted(network: SocialNetwork): Promise<number> {
    return this.queueFactory.clearCompletedJobs(network);
  }

  private toJobDto(job: Job, status: QueueJobDto["status"]): QueueJobDto {
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade ?? 0,
      totalAttempts: job.opts?.attempts ?? 1,
      status,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      returnValue: job.returnvalue,
    };
  }
}
