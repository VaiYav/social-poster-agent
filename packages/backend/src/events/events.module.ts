/**
 * Sprint O: EDA Events Module — registers EventEmitter2 for internal domain events.
 *
 * This module is imported by AppModule and provides the EventEmitter2
 * instance that other modules use to emit and listen to domain events.
 * The SseEventListener bridges domain events to SSE for real-time UI updates.
 */
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from '@nestjs/config';
import { SseModule } from '../infrastructure/sse/sse.module';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { PostsModule } from '../modules/posts/posts.module';
import { QueueModule as QueueInfraModule } from '../infrastructure/queue/queue.module';
import { SseEventListener } from './listeners/sse-event.listener';
import { AutoApproveListener } from './listeners/auto-approve.listener';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      // Enable wildcard events (allows listening to 'post.*' etc.)
      wildcard: true,
      // Use '.' as delimiter (e.g., 'post.approved')
      delimiter: '.',
      // Don't throw if no listeners — events are fire-and-forget
      ignoreErrors: true,
    }),
    ConfigModule,
    SseModule,
    PrismaModule,
    PostsModule,
    QueueInfraModule, // A5: provides IPostingQueuePort for AutoApproveListener
  ],
  providers: [SseEventListener, AutoApproveListener],
  exports: [EventEmitterModule],
})
export class EventsEdaModule {}
