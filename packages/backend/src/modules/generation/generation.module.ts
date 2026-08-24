import { Module } from "@nestjs/common";
import { LlmModule } from "../../infrastructure/llm/llm.module.js";
import { CheckpointModule } from "../../infrastructure/checkpoint/checkpoint.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";
import { ContentSourceModule } from "../content-source/content-source.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { PostsModule } from "../posts/posts.module.js";
import { TrendingModule } from "../trending/trending.module.js";
import { ContentEnhancementsModule } from "../content-enhancements/content-enhancements.module.js";
import { GenerationService } from "./generation.service.js";
import { GenerationPersistenceService } from "./generation-persistence.service.js";
import { PostFactory } from "./post.factory.js";
import { GenerationRunLifecycleService } from "./generation-run-lifecycle.service.js";
import { ReviewResumeService } from "./review-resume.service.js";
import { GenerationController } from "./generation.controller.js";
import { CronService } from "./cron.service.js";
import { EvaluationModule } from "../evaluation/evaluation.module.js";
import { PersonaModule } from "../persona/persona.module.js";

@Module({
  imports: [
    LlmModule,
    CheckpointModule,
    SseModule,
    ContentSourceModule,
    AccountsModule,
    PostsModule,
    TrendingModule,
    ContentEnhancementsModule,
    EvaluationModule,
    PersonaModule,
  ],
  providers: [
    GenerationService,
    GenerationPersistenceService,
    PostFactory,
    GenerationRunLifecycleService,
    ReviewResumeService,
    GenerationController,
    CronService,
  ],
  controllers: [GenerationController],
  exports: [GenerationService],
})
export class GenerationModule {}
