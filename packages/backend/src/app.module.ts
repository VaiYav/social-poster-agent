import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AppClsModule } from './infrastructure/cls/cls.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { FiltersModule } from './infrastructure/filters/filters.module';
import { MonitoringModule } from './infrastructure/monitoring/monitoring.module';
import { HealthModule } from './modules/health/health.module';
import { PostsModule } from './modules/posts/posts.module';
import { GenerationModule } from './modules/generation/generation.module';
import { PostingModule } from './modules/posting/posting.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { ContentSourceModule } from './modules/content-source/content-source.module';
import { BrowserModule } from './infrastructure/browser/browser.module';
import { LlmModule } from './infrastructure/llm/llm.module';
import { ContentModule } from './infrastructure/content/content.module';
import { QueueModule } from './modules/queue/queue.module';
import { QueueModule as QueueInfraModule } from './infrastructure/queue/queue.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { EventsModule } from './modules/events/events.module';
import { EngagementModule } from './modules/engagement/engagement.module';
import { HealthMonitorModule } from './modules/health-monitor/health-monitor.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    AppClsModule, // G-6: correlationId via CLS
    LoggingModule, // G-7: RedactInterceptor (global)
    FiltersModule, // GAP-001: ZodValidationFilter → 400 instead of 500
    MonitoringModule, // Sentry error tracking (env-gated)
    PrismaModule,
    BrowserModule,
    LlmModule,
    ContentModule,
    QueueInfraModule,
    HealthModule,
    AccountsModule,
    ContentSourceModule,
    GenerationModule,
    PostsModule,
    PostingModule,
    SessionsModule,
    QueueModule,
    RateLimitModule,
    EventsModule,
    EngagementModule, // Phase 2-3: likes, comments, browsing sessions
    HealthMonitorModule, // F21: Account Health Monitor + B3: Reconciliation cron
  ],
})
export class AppModule {}
