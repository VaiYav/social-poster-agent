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
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { RepliesMonitorService } from './replies-monitor.service';
import { RepliesController } from './replies.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { SseModule } from '../../infrastructure/sse/sse.module';
import { QueueModule as QueueInfraModule } from '../../infrastructure/queue/queue.module';
import { FlowControlModule } from '../flow-control/flow-control.module';
import { IRepliesMonitorPort } from '../orchestrator/ports';

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
    FlowControlModule,
  ],
  providers: [
    RepliesMonitorService,
    {
      provide: IRepliesMonitorPort,
      useExisting: RepliesMonitorService,
    },
  ],
  controllers: [RepliesController],
  exports: [RepliesMonitorService, IRepliesMonitorPort],
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
        engagementModule,
        FlowControlModule,
      ],
      providers: [
        RepliesMonitorService,
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
