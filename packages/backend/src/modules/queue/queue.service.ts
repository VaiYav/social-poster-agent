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
}
