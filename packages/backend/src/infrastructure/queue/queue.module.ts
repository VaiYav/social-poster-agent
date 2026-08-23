import { Module } from "@nestjs/common";
import { QueueFactory } from "./queue.factory.js";
import { IPostingQueuePort } from "../../domain/ports/posting-queue.port.js";

/**
 * A5: also binds IPostingQueuePort (a thin wrapper over QueueFactory.enqueuePosting) so consumers
 * like PostsController can enqueue without importing the worker-facing queue module and creating a
 * dependency cycle. This module depends only on QueueFactory, so it is safe to import from anywhere.
 *
 * Named `QueueInfraModule` (REFACTOR-100) to remove the `QueueModule` name collision with the
 * operator-facing `modules/queue` module.
 */
@Module({
  providers: [
    QueueFactory,
    {
      provide: IPostingQueuePort,
      useFactory: (queueFactory: QueueFactory): IPostingQueuePort => ({
        enqueuePosting: (postId, network, opts, accountId) =>
          queueFactory.enqueuePosting(postId, network, opts, accountId),
      }),
      inject: [QueueFactory],
    },
  ],
  exports: [QueueFactory, IPostingQueuePort],
})
export class QueueInfraModule {}
