import type { SocialNetwork } from '@prisma/client';

/**
 * A5: DI token + interface for enqueuing a post onto the BullMQ posting queue.
 *
 * Lets PostsController (and other consumers) enqueue without importing QueueModule — which would
 * create the PostsModule → QueueModule → PostingModule → PostsModule cycle that previously forced a
 * `moduleRef.get(QueueService)` lazy-resolution hack. The port is bound in the cycle-free
 * QueueInfraModule (it depends only on QueueFactory), so any module can import it safely.
 */
export const IPostingQueuePort = Symbol('IPostingQueuePort');

export interface IPostingQueuePort {
  enqueuePosting(
    postId: string,
    network: SocialNetwork,
    opts?: { priority?: number; delay?: number },
  ): Promise<void>;
}
