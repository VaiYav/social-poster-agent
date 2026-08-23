/**
 * Sprint O / F4 / Sprint Q: Replies Module — monitor and respond to comments.
 *
 * Provides:
 * - RepliesMonitorService: cron-based comment scraping + LLM reply generation + auto-posting
 * - RepliesController: REST API for viewing pending human-review comments and manual reply
 *
 * ALL reply content is LLM-generated — no template fallback. When all LLM providers
 * fail, comments are skipped (stay NEW) and retried in the next monitoring cycle.
 */
import { Module, type DynamicModule, type Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { RepliesMonitorService } from "./replies-monitor.service.js";
import { RepliesController } from "./replies.controller.js";
import { QuestionClassifierService } from "./question-classifier.service.js";
import { DialogueService } from "./dialogue.service.js";
import { CommentSafetyClassifierService } from "./comment-safety-classifier.service.js";
import { ToneAnalyzerService } from "./tone-analyzer.service.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { LlmModule } from "../../infrastructure/llm/llm.module.js";
import { SseModule } from "../../infrastructure/sse/sse.module.js";
import { QueueInfraModule } from "../../infrastructure/queue/queue.module.js";
import { RedisModule } from "../../infrastructure/redis/redis.module.js";
import { FlowControlModule } from "../flow-control/flow-control.module.js";
import { IRepliesMonitorPort } from "../orchestrator/ports.js";

@Module({
  imports: [
    ConfigModule,
    ScheduleModule, // Required for SchedulerRegistry used by RepliesMonitorService cron
    AccountsModule,
    SessionsModule,
    PrismaModule,
    BrowserModule,
    LlmModule,
    SseModule,
    QueueInfraModule, // RP1: QueueFactory for scheduling delayed auto-reply jobs
    RedisModule, // F4: daily reply rate-limit counters
    FlowControlModule,
  ],
  providers: [
    RepliesMonitorService,
    QuestionClassifierService,
    DialogueService,
    CommentSafetyClassifierService,
    ToneAnalyzerService,
    {
      provide: IRepliesMonitorPort,
      useExisting: RepliesMonitorService,
    },
  ],
  controllers: [RepliesController],
  exports: [
    RepliesMonitorService,
    IRepliesMonitorPort,
    CommentSafetyClassifierService,
    ToneAnalyzerService,
  ],
})
export class RepliesModule {
  // Allow conditional registration with engagement module
  static withEngagement(engagementModule: Type<unknown> | DynamicModule): DynamicModule {
    return {
      module: RepliesModule,
      imports: [
        ConfigModule,
        ScheduleModule,
        AccountsModule,
        SessionsModule,
        PrismaModule,
        BrowserModule,
        LlmModule,
        SseModule,
        QueueInfraModule, // RP1: QueueFactory for scheduling delayed auto-reply jobs
        RedisModule, // F4: daily reply rate-limit counters
        engagementModule,
        FlowControlModule,
      ],
      providers: [
        RepliesMonitorService,
        QuestionClassifierService,
        DialogueService,
        CommentSafetyClassifierService,
        ToneAnalyzerService,
        {
          provide: IRepliesMonitorPort,
          useExisting: RepliesMonitorService,
        },
      ],
      controllers: [RepliesController],
      exports: [RepliesMonitorService, IRepliesMonitorPort],
    };
  }
}
