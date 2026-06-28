/**
 * Sprint O / F4 / Sprint Q: Replies Module — monitor and respond to comments.
 *
 * Provides:
 * - RepliesService: decision logic and reply tracking (original)
 * - RepliesMonitorService: cron-based comment scraping + LLM reply generation + auto-posting
 * - RepliesController: REST API for viewing pending human-review comments and manual reply
 */
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { RepliesService } from './replies.service';
import { RepliesMonitorService } from './replies-monitor.service';
import { RepliesController } from './replies.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { SessionsModule } from '../sessions/sessions.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { LlmModule } from '../../infrastructure/llm/llm.module';
import { SseModule } from '../../infrastructure/sse/sse.module';

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
  ],
  providers: [RepliesService, RepliesMonitorService],
  controllers: [RepliesController],
  exports: [RepliesService, RepliesMonitorService],
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
        engagementModule,
      ],
      providers: [RepliesService, RepliesMonitorService],
      controllers: [RepliesController],
      exports: [RepliesService, RepliesMonitorService],
    };
  }
}
