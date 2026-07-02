import { Injectable, Logger } from '@nestjs/common';
import { QueueFactory } from '../../infrastructure/queue/queue.factory';
import { SocialNetwork } from '@prisma/client';

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

  async enqueuePosting(postId: string, network: SocialNetwork): Promise<void> {
    await this.queueFactory.enqueuePosting(postId, network);
  }

  async getJobCounts(network: SocialNetwork) {
    return this.queueFactory.getJobCounts(network);
  }

  async getFailedJobs(network: SocialNetwork) {
    return this.queueFactory.getFailedJobs(network);
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
   */
  async retryAllFailed(network: SocialNetwork): Promise<number> {
    const failed = await this.queueFactory.getFailedJobs(network);
    let retried = 0;
    for (const job of failed) {
      try {
        if (job.id) {
          await this.queueFactory.retryFailedJob(network, job.id);
          retried++;
        }
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
}
