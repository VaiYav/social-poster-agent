import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { QueueModule as QueueInfraModule } from "../../infrastructure/queue/queue.module";
import { PostingWindowModule } from "../orchestrator/posting-window.module.js";
import { PostsService } from "./posts.service";
import { PostsController } from "./posts.controller";

@Module({
  // A5: QueueInfraModule provides IPostingQueuePort so PostsController can enqueue without the
  // PostsModule → QueueModule → PostingModule → PostsModule cycle (no ModuleRef hack).
  imports: [EventEmitterModule, QueueInfraModule, PostingWindowModule],
  providers: [PostsService],
  controllers: [PostsController],
  exports: [PostsService],
})
export class PostsModule {}
