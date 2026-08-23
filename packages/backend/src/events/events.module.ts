/**
 * Sprint O: EDA Events Module — registers EventEmitter2 for internal domain events.
 *
 * This module is imported by AppModule and provides the EventEmitter2
 * instance that other modules use to emit and listen to domain events.
 * The SseEventListener bridges domain events to SSE for real-time UI updates.
 */
import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ConfigModule } from "@nestjs/config";
import { SseModule } from "../infrastructure/sse/sse.module.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { PostsModule } from "../modules/posts/posts.module.js";
import { QueueInfraModule } from "../infrastructure/queue/queue.module.js";
import { GenerationModule } from "../modules/generation/generation.module.js";
import { SseEventListener } from "./listeners/sse-event.listener.js";
import { SocialPromoListener } from "./listeners/social-promo.listener.js";
import { IndexNowListener } from "./listeners/indexnow.listener.js";
import { IndexNowService } from "../infrastructure/indexnow/indexnow.service.js";

@Module({
  imports: [
    EventEmitterModule.forRoot({
      // Enable wildcard events (allows listening to 'post.*' etc.)
      wildcard: true,
      // Use '.' as delimiter (e.g., 'post.approved')
      delimiter: ".",
      // Don't throw if no listeners — events are fire-and-forget
      ignoreErrors: true,
    }),
    ConfigModule,
    SseModule,
    PrismaModule,
    PostsModule,
    QueueInfraModule,
    GenerationModule,
  ],
  providers: [SseEventListener, SocialPromoListener, IndexNowListener, IndexNowService],
  exports: [EventEmitterModule],
})
export class EventsEdaModule {}
