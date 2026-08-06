import 'reflect-metadata';
import { ModuleRef, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';

// Infrastructure
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';
import { LlmService } from '../../src/infrastructure/llm/llm.service';
import { LlmController } from '../../src/infrastructure/llm/llm.controller';
import { TokenBudgetService } from '../../src/infrastructure/llm/token-budget.service.js';
import { ContentReader } from '../../src/infrastructure/content/content-reader.js';
import { DbContentReader } from '../../src/infrastructure/content/db-content-reader.js';
import { ContentAdapterRegistry } from '../../src/infrastructure/content/adapters/content-adapter.registry.js';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service.js';
import { MetricsPublisher } from '../../src/modules/monitoring/metrics-publisher.js';
import { MonitoringController } from '../../src/modules/monitoring/monitoring.controller';
import { SseModule } from '../../src/infrastructure/sse/sse.module';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { RedisCheckpointSaver } from '../../src/infrastructure/checkpoint/redis-checkpoint.js';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service.js';
import { IndexNowService } from '../../src/infrastructure/indexnow/indexnow.service.js';
import { TelegramAdapter } from '../../src/infrastructure/telegram/telegram.adapter.js';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { EmailReaderService } from '../../src/infrastructure/email/email-reader.service.js';
import { LangfuseService } from '../../src/infrastructure/langfuse/langfuse.service.js';
import { DistributedLockService } from '../../src/infrastructure/multi-instance/distributed-lock.service.js';
import { InstanceHeartbeatService } from '../../src/infrastructure/multi-instance/instance-heartbeat.service.js';

// Modules
import { QueueModule } from '../../src/modules/queue/queue.module';
import { QueueService } from '../../src/modules/queue/queue.service';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { QueueTriageService } from '../../src/modules/queue/queue-triage.service.js';

// Accounts
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { AccountsController } from '../../src/modules/accounts/accounts.controller';

// Content source
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentSourceController } from '../../src/modules/content-source/content-source.controller';

// Generation
import { GenerationService } from '../../src/modules/generation/generation.service';
import { GenerationController } from '../../src/modules/generation/generation.controller';
import { CronService } from '../../src/modules/generation/cron.service';

// Posts
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { PostingWindowService } from '../../src/modules/orchestrator/posting-window.service.js';

// Posting
import { PostingService } from '../../src/modules/posting/posting.service';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';

import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { BlueskyPoster } from '../../src/modules/posting/posters/bluesky.poster.js';
import { MastodonPoster } from '../../src/modules/posting/posters/mastodon.poster.js';
import { LinkedinSocialPoster } from '../../src/modules/posting/posters/linkedin-social.poster.js';

// Sessions
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';

// Rate limit
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';

// Engagement
import { EngagementService } from '../../src/modules/engagement/engagement.service';
import { EngagementController } from '../../src/modules/engagement/engagement.controller';
import { EngagementDecisionService } from '../../src/modules/engagement/engagement-decision.service';
import { BrowsingSessionService } from '../../src/modules/engagement/browsing-session.service';
import { XEngager } from '../../src/modules/engagement/engagers/x.engager';
import { ThreadsEngager } from '../../src/modules/engagement/engagers/threads.engager';
import { FacebookEngager } from '../../src/modules/engagement/engagers/facebook.engager';
import { HumanBehaviorEngine } from '../../src/modules/engagement/human-behavior-engine.js';
import { TargetingService } from '../../src/modules/engagement/targeting.service';
import { EngagementSchedulerService } from '../../src/modules/engagement/engagement-scheduler.service';

// Flow control / Autonomy
import { FlowControlService } from '../../src/modules/flow-control/flow-control.service';
import { FlowControlController } from '../../src/modules/flow-control/flow-control.controller';
import { AutoCheckService } from '../../src/modules/autonomy/auto-check.service';
import { AutoApproveService } from '../../src/modules/autonomy/auto-approve.service';
import { AutonomousRunnerService } from '../../src/modules/autonomy/autonomous-runner.service';

// Events
import { SseController } from '../../src/modules/sse/sse.controller';
import { AutoApproveListener } from '../../src/modules/autonomy/auto-approve.listener';
import { SseEventListener } from '../../src/events/listeners/sse-event.listener';
import { IndexNowListener } from '../../src/events/listeners/indexnow.listener.js';
import { SocialPromoListener } from '../../src/events/listeners/social-promo.listener.js';

// Health
import { HealthController } from '../../src/modules/health/health.controller';
import { HealthMonitorService } from '../../src/modules/health-monitor/health-monitor.service.js';
import { HealthMonitorController } from '../../src/modules/health-monitor/health-monitor.controller.js';

// Trending
import { TrendingService } from '../../src/modules/trending/trending.service';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { TrendingController } from '../../src/modules/trending/trending.controller';

// Replies
import { RepliesMonitorService } from '../../src/modules/replies/replies-monitor.service';
import { RepliesController } from '../../src/modules/replies/replies.controller';
import { QuestionClassifierService } from '../../src/modules/replies/question-classifier.service.js';
import { DialogueService } from '../../src/modules/replies/dialogue.service.js';

// Content enhancements
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service.js';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator.js';
import { ABVariantService } from '../../src/modules/content-enhancements/ab-variant.service.js';
import { ThreadDepthService } from '../../src/modules/content-enhancements/thread-depth.service.js';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker.js';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank.js';

// Orchestrator
import { HardRulesService } from '../../src/modules/orchestrator/hard-rules.service.js';
import { GuardrailsService } from '../../src/modules/orchestrator/guardrails.service.js';
import { NetworkSelector } from '../../src/modules/orchestrator/network-selector.js';
import { LlmDecisionService } from '../../src/modules/orchestrator/llm-decision.service.js';
import { PostingWindowService } from '../../src/modules/orchestrator/posting-window.service.js';
import { RulesEngine } from '../../src/modules/orchestrator/rules-engine.js';
import { DecisionEngineService } from '../../src/modules/orchestrator/decision-engine.service.js';
import { ActionExecutorService } from '../../src/modules/orchestrator/action-executor.service.js';
import {
  GenerateTopicsHandler,
  GeneratePostsHandler,
  PostHandler,
  BrowseHandler,
  RecoverSessionHandler,
  CheckRepliesHandler,
  RefreshTrendsHandler,
  HealthCheckHandler,
  ReconcileHandler,
  ScrapeMetricsHandler,
  RecycleContentHandler,
  AggregateHooksHandler,
} from '../../src/modules/orchestrator/action-handlers.js';

// Sprint O / New features
import { CaptchaSolverService } from '../../src/infrastructure/captcha/captcha-solver.service';
import { ProxyRotationService } from '../../src/infrastructure/proxy/proxy-rotation.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { AnalyticsController } from '../../src/modules/analytics/analytics.controller';
import { MetricsScraperService } from '../../src/modules/analytics/metrics-scraper.service';
import { ABTestService } from '../../src/modules/analytics/ab-test.service';
import { RecyclingService } from '../../src/modules/recycling/recycling.service';
import { RecyclingController } from '../../src/modules/recycling/recycling.controller';
import { QuoteCardService } from '../../src/modules/quote-cards/quote-card.service';
import { QuoteCardController } from '../../src/modules/quote-cards/quote-card.controller';

// Auth
import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { JwtAuthGuard } from '../../src/modules/auth/jwt-auth.guard';
import { AdminGuard } from '../../src/modules/auth/admin.guard';
import { LoginRateLimitGuard } from '../../src/modules/auth/login-rate-limit.guard';
import { LocalhostGuard } from '../../src/infrastructure/guards/localhost.guard';

/**
 * Set `design:paramtypes` metadata for a class. Vitest transforms source with
 * esbuild, which strips TypeScript decorator metadata. NestJS uses this
 * metadata to resolve class-typed constructor parameters, so we restore it
 * explicitly for tests.
 *
 * For parameters decorated with `@Inject(TOKEN)` or `@Optional()` we use the
 * metadata set by the decorator at runtime; the `Object` placeholders here are
 * only for length/sparse slots and are overridden by the decorator metadata.
 */
export function defineParamtypes(target: unknown, types: unknown[]): void {
  Reflect.defineMetadata('design:paramtypes', types, target);
}

/**
 * Restore `design:paramtypes` for every injectable/controller/module in the
 * backend. Call this once in a `beforeAll` (or at the top of a test file) before
 * `Test.createTestingModule` to make NestJS DI work under vitest/esbuild.
 *
 * Always overwrites — older/stale metadata from previous test files would
 * otherwise win and cause `undefined` injection.
 */
export function restoreAllDesignParamtypes(): void {
  // ── Infrastructure ───────────────────────────────────────────────────────
  defineParamtypes(PrismaService, [ConfigService]);
  defineParamtypes(LlmService, [ConfigService, Object, Object]); // Object = SHARED_REDIS, Object = IPromptPort (@Optional @Inject)
  defineParamtypes(TokenBudgetService, [ConfigService, Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(LlmController, [LlmService]);
  defineParamtypes(ContentReader, [ConfigService]);
  defineParamtypes(DbContentReader, [PrismaService]);
  defineParamtypes(ContentAdapterRegistry, [ConfigService, Object]); // Object = CONTENT_ADAPTERS (@Inject)
  defineParamtypes(BrowserFactory, [ConfigService]);
  defineParamtypes(SseService, [ConfigService, Object, Object]); // Object = SHARED_REDIS_SUBSCRIBER / PUBLISHER
  defineParamtypes(MetricsPublisher, [ConfigService, SseService, Object]); // Object = @Inject(IMetricsCollector)
  defineParamtypes(MonitoringController, [MetricsPublisher]);
  defineParamtypes(RedisCheckpointSaver, [ConfigService, Object]); // Object = SHARED_REDIS
  defineParamtypes(QueueFactory, [ConfigService, DiscordNotificationService, Object, Object]); // Object = @Optional() @Inject(SHARED_REDIS), Object = @Optional() @Inject(SHARED_REDIS_SUBSCRIBER)
  defineParamtypes(EncryptionService, [ConfigService]);
  defineParamtypes(DiscordNotificationService, [ConfigService]);
  defineParamtypes(IndexNowService, [ConfigService]);
  defineParamtypes(TelegramAdapter, [ConfigService]);
  defineParamtypes(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService, Object]); // Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(EmailReaderService, [ConfigService]);
  defineParamtypes(LangfuseService, [Object, ConfigService]); // Object = LANGFUSE_PROMPT_BREAKER
  defineParamtypes(DistributedLockService, [Object]); // Object = SHARED_REDIS
  defineParamtypes(InstanceHeartbeatService, [ConfigService, Object]); // Object = SHARED_REDIS

  // ── Module classes with constructor DI ───────────────────────────────────
  defineParamtypes(SseModule, [SseService]);
  defineParamtypes(QueueModule, [QueueFactory, PostingService, PostingWindowService, ModuleRef, ConfigService]);

  // ── Accounts ─────────────────────────────────────────────────────────────
  defineParamtypes(AccountsService, [PrismaService, ConfigService, Object]); // Object = @Optional() WarmupService
  defineParamtypes(AccountsController, [AccountsService]);

  // ── Content source ───────────────────────────────────────────────────────
  defineParamtypes(ContentSourceService, [Object]); // Object = @Inject(IContentPort)
  defineParamtypes(ContentSourceController, [ContentSourceService]);

  // ── Generation ───────────────────────────────────────────────────────────
  // 18 params: 8 required + 10 @Optional()
  defineParamtypes(GenerationService, [
    Object, // @Inject(ILlmPort)
    ContentSourceService,
    AccountsService,
    PostsService,
    PrismaService,
    RedisCheckpointSaver,
    SseService,
    ConfigService,
    Object, // @Optional() TrendingService
    Object, // @Optional() TrendingScraperService
    Object, // @Optional() ContentPillarTracker
    Object, // @Optional() HookPerformanceBank
    Object, // @Optional() VisualConceptService
    Object, // @Optional() ThreadDepthService
    Object, // @Optional() ABVariantGenerator
    Object, // @Optional() ABVariantService
    LangfuseService, // @Optional() langfuse
    Object, // @Optional() @Inject(IPromptPort)
  ]);
  defineParamtypes(GenerationController, [GenerationService]);
  defineParamtypes(CronService, [GenerationService, AccountsService, ConfigService]);

  // ── Posts ────────────────────────────────────────────────────────────────
  defineParamtypes(PostsService, [PrismaService, EventEmitter2]);
  defineParamtypes(PostsController, [PostsService, Object, PostingWindowService]); // Object = @Inject(IPostingQueuePort)

  // ── Posting ──────────────────────────────────────────────────────────────
  defineParamtypes(ThreadProgressService, [PrismaService]);
  defineParamtypes(PostingService, [
    Object, // @Inject(IBrowserPort)
    AccountsService,
    SessionsService,
    WarmupService,
    PostsService,
    RateLimitService,
    EventEmitter2,
    ThreadProgressService,
    XPoster,
    ThreadsPoster,
    FacebookPoster,
    ConfigService,
    ModuleRef,
    Object, // @Optional() QueueFactory
    Object, // @Optional() FlowControlService
    Object, // @Optional() ContentPillarTracker
    Object, // @Optional() ABVariantService
    BlueskyPoster, // @Optional()
    MastodonPoster, // @Optional()
    LinkedinSocialPoster, // @Optional()
    TelegramAdapter, // @Optional()
  ]);
  defineParamtypes(PostingController, [PostingService]);
  defineParamtypes(XPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(ThreadsPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(FacebookPoster, [Object, ConfigService]); // @Inject(IBrowserPort)
  defineParamtypes(BlueskyPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(MastodonPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(LinkedinSocialPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)

  // ── Sessions ─────────────────────────────────────────────────────────────
  defineParamtypes(SessionsService, [
    PrismaService,
    AccountsService,
    Object, // @Inject(IBrowserPort)
    ConfigService,
    EncryptionService,
    DiscordNotificationService,
    Object, // @Inject(SHARED_REDIS)
    EmailReaderService,
    SchedulerRegistry,
  ]);
  defineParamtypes(WarmupService, [PrismaService, ConfigService]);
  defineParamtypes(SessionsController, [SessionsService]);

  // ── Rate limit ───────────────────────────────────────────────────────────
  defineParamtypes(RateLimitService, [ConfigService, Object]); // Object = @Inject(SHARED_REDIS)

  // ── Engagement ───────────────────────────────────────────────────────────
  defineParamtypes(XEngager, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(ThreadsEngager, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(FacebookEngager, [Object, ConfigService]); // @Inject(IBrowserPort)
  defineParamtypes(BrowsingSessionService, [
    PrismaService,
    SessionsService,
    Object, // @Inject(IBrowserPort)
    ConfigService,
    SseService,
    RateLimitService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
    HumanBehaviorEngine,
    TargetingService,
    Object, // @Inject(DISTRIBUTED_LOCK_SERVICE)
    Object, // @Optional() WarmupService
  ]);
  defineParamtypes(EngagementService, [
    PrismaService,
    SessionsService,
    Object, // @Inject(IBrowserPort)
    SseService,
    RateLimitService,
    FlowControlService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
  ]);
  defineParamtypes(EngagementController, [EngagementService]);
  defineParamtypes(HumanBehaviorEngine, [PrismaService, Object, SseService, RateLimitService, Object]); // Object = IBrowserPort, IEngagementDecisionPort
  defineParamtypes(EngagementDecisionService, [Object, ConfigService, Object]); // Object = @Inject(ILlmPort), Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(TargetingService, [ConfigService]);
  defineParamtypes(EngagementSchedulerService, [ConfigService, QueueFactory, SchedulerRegistry]);

  // ── Flow control / Autonomy ──────────────────────────────────────────────
  defineParamtypes(FlowControlService, [Object, SseService]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(FlowControlController, [FlowControlService]);
  defineParamtypes(AutoCheckService, [PrismaService]);
  defineParamtypes(AutoApproveService, [ConfigService, PrismaService, SseService, AutoCheckService]);
  defineParamtypes(AutonomousRunnerService, [
    ConfigService,
    PrismaService,
    SseService,
    FlowControlService,
    AutoApproveService,
    ModuleRef,
    Object, // @Inject(IPostingQueuePort)
    SchedulerRegistry,
  ]);

  // ── Events ───────────────────────────────────────────────────────────────
  defineParamtypes(SseController, [SseService]);
  defineParamtypes(AutoApproveListener, [PrismaService, ModuleRef, ConfigService, Object]); // Object = @Inject(IPostingQueuePort)
  defineParamtypes(SseEventListener, [SseService]);
  defineParamtypes(IndexNowListener, [ConfigService, PrismaService, IndexNowService]);
  defineParamtypes(SocialPromoListener, [ConfigService, PrismaService, GenerationService]);

  // ── Queue ────────────────────────────────────────────────────────────────
  defineParamtypes(QueueService, [QueueFactory]);
  defineParamtypes(QueueController, [QueueService]);
  defineParamtypes(QueueTriageService, [
    QueueFactory,
    PrismaService,
    ConfigService,
    Object, // @Optional() @Inject(ILlmPort)
    Object, // @Optional() @Inject(IPromptPort)
    Object, // @Optional() SseService
    Object, // @Optional() FlowControlService
  ]);

  // ── Health ───────────────────────────────────────────────────────────────
  defineParamtypes(HealthController, [PrismaService, Object, ConfigService, QueueFactory]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(HealthMonitorService, [PrismaService, SseService, DiscordNotificationService, QueueService, QueueFactory, ConfigService, SchedulerRegistry]);
  defineParamtypes(HealthMonitorController, [HealthMonitorService]);

  // ── Trending ─────────────────────────────────────────────────────────────
  defineParamtypes(TrendingService, []);
  defineParamtypes(TrendingScraperService, [
    ConfigService,
    SchedulerRegistry,
    Object, // @Optional() LlmService
    Object, // @Optional() @Inject(IBrowserPort)
    SessionsService, // @Optional()
    Object, // @Optional() @Inject(IPromptPort)
  ]);
  defineParamtypes(TrendingController, [TrendingService, TrendingScraperService]);

  // ── Replies ──────────────────────────────────────────────────────────────
  defineParamtypes(RepliesMonitorService, [
    PrismaService,
    ConfigService,
    AccountsService,
    SessionsService,
    SchedulerRegistry,
    DiscordNotificationService,
    SseService,
    DialogueService,
    Object, // @Optional() @Inject(ILlmPort)
    Object, // @Optional() @Inject(IBrowserPort)
    EngagementService, // @Optional()
    QueueFactory, // @Optional()
    FlowControlService, // @Optional()
    Object, // @Optional() @Inject(IPromptPort)
  ]);
  defineParamtypes(QuestionClassifierService, [Object, ConfigService, Object]); // Object = @Inject(ILlmPort), Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(DialogueService, [
    Object, // @Inject(ILlmPort)
    QuestionClassifierService,
    PrismaService,
    ConfigService,
    Object, // @Optional() @Inject(IPromptPort)
  ]);
  defineParamtypes(RepliesController, [RepliesMonitorService, PrismaService]);

  // ── Content Enhancements ─────────────────────────────────────────────────
  defineParamtypes(VisualConceptService, [ConfigService, Object]); // Object = @Optional() ILlmPort
  defineParamtypes(ABVariantGenerator, [ConfigService, Object]); // Object = @Optional() ILlmPort
  defineParamtypes(ThreadDepthService, [ConfigService, Object]); // Object = @Optional() ILlmPort
  defineParamtypes(ContentPillarTracker, [Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(ABVariantService, [ConfigService, PrismaService]);
  defineParamtypes(HookPerformanceBank, [ConfigService, Object, PrismaService]); // Object = @Inject(SHARED_REDIS), PrismaService @Optional()

  // ── Orchestrator ─────────────────────────────────────────────────────────
  defineParamtypes(HardRulesService, [Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(GuardrailsService, [ConfigService, NetworkSelector]);
  defineParamtypes(LlmDecisionService, [ConfigService, Object, LangfuseService, Object]); // Object = ILlmPort, IPromptPort
  defineParamtypes(PostingWindowService, [PrismaService, ConfigService, Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(DecisionEngineService, [
    ConfigService,
    Object, // @Inject(SHARED_REDIS)
    PostingWindowService,
    HardRulesService,
    LlmDecisionService,
    GuardrailsService,
    RulesEngine,
  ]);
  defineParamtypes(GenerateTopicsHandler, [ConfigService, ModuleRef, PrismaService]);
  defineParamtypes(GeneratePostsHandler, [ConfigService, ModuleRef, PrismaService]);
  defineParamtypes(PostHandler, [ConfigService, ModuleRef, PrismaService]);
  defineParamtypes(BrowseHandler, [ConfigService, Object]); // Object = @Optional() @Inject(IBrowsingSessionPort)
  defineParamtypes(RecoverSessionHandler, [ModuleRef]);
  defineParamtypes(CheckRepliesHandler, [Object]); // Object = @Optional() @Inject(IRepliesMonitorPort)
  defineParamtypes(RefreshTrendsHandler, [ModuleRef]);
  defineParamtypes(HealthCheckHandler, [ModuleRef]);
  defineParamtypes(ReconcileHandler, [ModuleRef]);
  defineParamtypes(ScrapeMetricsHandler, [ModuleRef]);
  defineParamtypes(RecycleContentHandler, [ModuleRef]);
  defineParamtypes(AggregateHooksHandler, [ModuleRef]);
  defineParamtypes(ActionExecutorService, [
    GenerateTopicsHandler,
    GeneratePostsHandler,
    PostHandler,
    BrowseHandler,
    RecoverSessionHandler,
    CheckRepliesHandler,
    RefreshTrendsHandler,
    HealthCheckHandler,
    ReconcileHandler,
    ScrapeMetricsHandler,
    RecycleContentHandler,
    AggregateHooksHandler,
  ]);

  // ── Sprint O / New Features ──────────────────────────────────────────────
  defineParamtypes(CaptchaSolverService, [ConfigService]);
  defineParamtypes(ProxyRotationService, [ConfigService]);
  defineParamtypes(AnalyticsService, [PrismaService]);
  defineParamtypes(ABTestService, [PrismaService]);
  defineParamtypes(AnalyticsController, [AnalyticsService, MetricsScraperService, ABTestService, Object]); // Object = @Optional() HookPerformanceBank
  defineParamtypes(MetricsScraperService, [ConfigService, PrismaService, SseService, SchedulerRegistry, Object, Object, Object]); // Object = @Optional() @Inject(IBrowserPort), Object = @Optional() ABVariantService, Object = @Optional() @Inject(SHARED_REDIS)
  defineParamtypes(RecyclingService, [ConfigService, PrismaService, GenerationService, SchedulerRegistry]);
  defineParamtypes(RecyclingController, [RecyclingService]);
  defineParamtypes(QuoteCardService, [ConfigService]);
  defineParamtypes(QuoteCardController, [QuoteCardService]);

  // ── Auth ─────────────────────────────────────────────────────────────────
  defineParamtypes(AuthService, [PrismaService, JwtService, ConfigService]);
  defineParamtypes(AuthController, [AuthService, ConfigService]);
  defineParamtypes(JwtAuthGuard, [JwtService, ConfigService, Reflector]);
  defineParamtypes(AdminGuard, [ConfigService]);
  defineParamtypes(LoginRateLimitGuard, [ConfigService, Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(LocalhostGuard, [ConfigService]);
}
