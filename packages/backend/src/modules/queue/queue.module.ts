import { Module, type OnModuleInit } from '@nestjs/common';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { QueueFactory } from '../../infrastructure/queue/queue.factory';
import { PostingModule } from '../posting/posting.module';
import { PostingService } from '../posting/posting.service';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { SocialNetwork } from '@prisma/client';

/**
 * Queue module — wires BullMQ workers to PostingService.
 *
 * On bootstrap, registers a worker per network (X, THREADS, FACEBOOK).
 * Each worker calls PostingService.postById() with auto-retry via BullMQ.
 *
 * Concurrency=1 per network queue (B9 mitigation — no parallel posts to same network).
 */
@Module({
  imports: [QueueInfraModule, PostingModule],
  providers: [QueueService, QueueController],
  controllers: [QueueController],
  exports: [QueueService],
})
export class QueueModule implements OnModuleInit {
  constructor(
    private readonly queueFactory: QueueFactory,
    private readonly postingService: PostingService,
  ) {}

  onModuleInit(): void {
    // Register a worker for each network
    for (const network of Object.values(SocialNetwork)) {
      this.queueFactory.registerWorker(network, async (job) => {
        const { postId } = job.data as { postId: string };
        const result = await this.postingService.postById(postId);
        if (!result.success) {
          throw new Error(result.error ?? 'Posting failed');
        }
      });
    }
  }
}
