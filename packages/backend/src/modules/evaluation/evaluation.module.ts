import { Global, Module } from "@nestjs/common";
import { LangfuseModule } from "../../infrastructure/langfuse/langfuse.module.js";
import { FeedbackSyncService } from "./feedback-sync.service.js";
import { OnlineEvaluationService } from "./online-evaluation.service.js";

@Global()
@Module({
  imports: [LangfuseModule],
  providers: [FeedbackSyncService, OnlineEvaluationService],
  exports: [FeedbackSyncService, OnlineEvaluationService],
})
export class EvaluationModule {}
