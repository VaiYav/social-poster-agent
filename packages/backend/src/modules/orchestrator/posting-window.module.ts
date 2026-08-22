import { Module } from "@nestjs/common";
import { PostingWindowService } from "./posting-window.service.js";

/**
 * PostingWindowModule — provides PostingWindowService for use inside and outside
 * the orchestrator. Kept separate from OrchestratorModule so the queue flow can
 * use posting windows even when ORCHESTRATOR_ENABLED=false.
 */
@Module({
  providers: [PostingWindowService],
  exports: [PostingWindowService],
})
export class PostingWindowModule {}
