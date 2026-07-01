import { Module, type OnModuleInit, type DynamicModule, Logger } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { SentryModule } from '@sentry/nestjs/setup';
import { validateEnv } from './infrastructure/config/env.validation';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { NotificationsModule } from './infrastructure/notifications/notifications.module';
import { AppClsModule } from './infrastructure/cls/cls.module';
import { LoggingModule } from './infrastructure/logging/logging.module';
import { FiltersModule } from './infrastructure/filters/filters.module';
import { CryptoModule } from './infrastructure/crypto/crypto.module';
import { HealthModule } from './modules/health/health.module';
import { PostsModule } from './modules/posts/posts.module';
import { GenerationModule } from './modules/generation/generation.module';
import { PostingModule } from './modules/posting/posting.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { ContentSourceModule } from './modules/content-source/content-source.module';
import { BrowserModule } from './infrastructure/browser/browser.module';
import { LlmModule } from './infrastructure/llm/llm.module';
import { PromptRegistryModule } from './infrastructure/llm/prompt-registry.module';
import { ContentModule } from './infrastructure/content/content.module';
import { QueueModule } from './modules/queue/queue.module';
import { QueueModule as QueueInfraModule } from './infrastructure/queue/queue.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { EventsModule } from './modules/events/events.module';
import { EngagementModule } from './modules/engagement/engagement.module';
import { HealthMonitorModule } from './modules/health-monitor/health-monitor.module';
import { TrendingModule } from './modules/trending/trending.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { RecyclingModule } from './modules/recycling/recycling.module';
import { QuoteCardModule } from './modules/quote-cards/quote-card.module';
import { RepliesModule } from './modules/replies/replies.module';
import { FlowControlModule } from './modules/flow-control/flow-control.module';
import { AutonomyModule } from './modules/autonomy/autonomy.module';
import { CaptchaModule } from './infrastructure/captcha/captcha.module';
import { ProxyModule } from './infrastructure/proxy/proxy.module';
import { EventsEdaModule } from './events/events.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { EmailModule } from './infrastructure/email/email.module';
import { parseBool } from './infrastructure/config/parse-bool';

/**
 * F1 Engagement module is experimental (Phase 2-3).
 * Gated behind ENGAGEMENT_ENABLED env var (default: false).
 * When disabled, routes are not registered — no engagement endpoints exposed.
 */
const engagementImports = parseBool(process.env.ENGAGEMENT_ENABLED) ? [EngagementModule] : [];

/**
 * Sprint O: Feature-flagged modules.
 * Each is gated behind its own env var (default: false).
 * When disabled, the module is not registered — no services or routes exposed.
 */
const captchaImports = parseBool(process.env.CAPTCHA_SOLVER_ENABLED) ? [CaptchaModule] : [];
const proxyImports = parseBool(process.env.PROXY_ROTATION_ENABLED) ? [ProxyModule] : [];
const quoteCardImports = parseBool(process.env.QUOTE_CARDS_ENABLED) ? [QuoteCardModule] : [];
const repliesImports =
  parseBool(process.env.REPLIES_ENABLED)
    ? [parseBool(process.env.ENGAGEMENT_ENABLED) ? RepliesModule.withEngagement(EngagementModule) : RepliesModule]
    : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    RedisModule, // Sprint L: Shared Redis connection pooling
    EmailModule, // IMAP email reader for auto-verification codes
    AppClsModule, // G-6: correlationId via CLS
    LoggingModule, // G-7: RedactInterceptor (global)
    FiltersModule, // GAP-001: ZodValidationFilter → 400 instead of 500 + SentryGlobalFilter
    SentryModule.forRoot(), // Sentry NestJS integration (initialized via instrument.ts)
    CryptoModule, // P0-H3: AES-256-GCM encryption for storageState
    PrismaModule,
    NotificationsModule, // Discord webhook alerts (DLQ, health, captcha)
    AuthModule, // JWT cookie auth for UI (admin login, JwtAuthGuard)
    BrowserModule,
    LlmModule,
    PromptRegistryModule, // Sprint P: Versioned prompt templates (audit finding)
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
    ...engagementImports, // F1: Phase 2-3 — gated by ENGAGEMENT_ENABLED
    HealthMonitorModule, // F21: Account Health Monitor + B3: Reconciliation cron
    TrendingModule, // F22: Trending Topic Detection (astro events calendar)
    EventsEdaModule, // Sprint O: EventEmitter2 for internal domain events
    AnalyticsModule, // Sprint O / F6: Analytics dashboard (read-only, always available)
    RecyclingModule, // Sprint O / F13: Content recycling (manual trigger)
    ...captchaImports, // Sprint O: Captcha solver — gated by CAPTCHA_SOLVER_ENABLED
    ...proxyImports, // Sprint O: Proxy rotation — gated by PROXY_ROTATION_ENABLED
    ...quoteCardImports, // Sprint O / F19: Quote cards — gated by QUOTE_CARDS_ENABLED
    ...repliesImports, // Sprint O / F4: Adaptive replies — gated by REPLIES_ENABLED
    FlowControlModule, // ADR-006: Flow control (pause/resume, crisis mode)
    AutonomyModule, // ADR-006: Auto-check, auto-approve, autonomous runner
  ],
  providers: [
    // Global JWT auth guard (gated by AUTH_ENABLED; /auth/login and /health stay public).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  onModuleInit(): void {
    // P1-3: Validate env vars at startup (manual validation, not ConfigModule.validationSchema
    // — which would overwrite process.env with Joi defaults and break tests)
    try {
      validateEnv();
      this.logger.log('Environment variables validated successfully');
    } catch (err) {
      this.logger.error((err as Error).message);
      throw err;
    }
  }
}
