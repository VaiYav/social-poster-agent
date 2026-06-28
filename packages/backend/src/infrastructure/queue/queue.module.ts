import { Module } from '@nestjs/common';
import { QueueFactory } from './queue.factory';
import { IPostingQueuePort } from '../../domain/ports/posting-queue.port';

/**
 * A5: also binds IPostingQueuePort (a thin wrapper over QueueFactory.enqueuePosting) so consumers
 * like PostsController can enqueue without importing QueueModule and creating a dependency cycle.
 * This module depends only on QueueFactory, so it is safe to import from anywhere.
 */
@Module({
  providers: [
    QueueFactory,
    {
      provide: IPostingQueuePort,
      useFactory: (queueFactory: QueueFactory): IPostingQueuePort => ({
        enqueuePosting: (postId, network, opts) => queueFactory.enqueuePosting(postId, network, opts),
      }),
      inject: [QueueFactory],
    },
  ],
  exports: [QueueFactory, IPostingQueuePort],
})
export class QueueModule {}
