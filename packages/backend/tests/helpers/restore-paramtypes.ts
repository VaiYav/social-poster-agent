import "reflect-metadata";
import { ModuleRef, Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { JwtService } from "@nestjs/jwt";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { PrismaService } from "../../src/infrastructure/prisma/prisma.service.js";

// Infrastructure
import { BrowserFactory } from "../../src/infrastructure/browser/browser.factory.js";
import { LlmService } from "../../src/infrastructure/llm/llm.service.js";
import { LlmController } from "../../src/infrastructure/llm/llm.controller.js";
import { TokenBudgetService } from "../../src/infrastructure/llm/token-budget.service.js";
import { ContentReader } from "../../src/infrastructure/content/content-reader.js";
import { DbContentReader } from "../../src/infrastructure/content/db-content-reader.js";
import { ContentAdapterRegistry } from "../../src/infrastructure/content/adapters/content-adapter.registry.js";
import { SseService } from "../../src/infrastructure/sse/sse.service.js";
import { EncryptionService } from "../../src/infrastructure/crypto/encryption.service.js";
import { MetricsPublisher } from "../../src/modules/monitoring/metrics-publisher.js";
import { MonitoringController } from "../../src/modules/monitoring/monitoring.controller.js";
import { SseModule } from "../../src/infrastructure/sse/sse.module.js";
import { QueueFactory } from "../../src/infrastructure/queue/queue.factory.js";
import { RedisCheckpointSaver } from "../../src/infrastructure/checkpoint/redis-checkpoint.js";
import { DiscordNotificationService } from "../../src/infrastructure/notifications/discord-notification.service.js";
import { IndexNowService } from "../../src/infrastructure/indexnow/indexnow.service.js";
import { TelegramAdapter } from "../../src/infrastructure/telegram/telegram.adapter.js";
import { ControlBotService } from "../../src/modules/control-bot/control-bot.service.js";
import { TopicGenerationService } from "../../src/infrastructure/content/topic-generation.service.js";
import { EmailReaderService } from "../../src/infrastructure/email/email-reader.service.js";
import { LangfuseService } from "../../src/infrastructure/langfuse/langfuse.service.js";
import { DistributedLockService } from "../../src/infrastructure/multi-instance/distributed-lock.service.js";
import { InstanceHeartbeatService } from "../../src/infrastructure/multi-instance/instance-heartbeat.service.js";

// Modules
import { QueueModule } from "../../src/modules/queue/queue.module.js";
import { QueueService } from "../../src/modules/queue/queue.service.js";
import { QueueController } from "../../src/modules/queue/queue.controller.js";
import { QueueTriageService } from "../../src/modules/queue/queue-triage.service.js";

// Accounts
import { AccountsService } from "../../src/modules/accounts/accounts.service.js";
import { AccountsController } from "../../src/modules/accounts/accounts.controller.js";

// Content source
import { ContentSourceService } from "../../src/modules/content-source/content-source.service.js";
import { ContentSourceController } from "../../src/modules/content-source/content-source.controller.js";

// Generation
import { GenerationService } from "../../src/modules/generation/generation.service.js";
import { GenerationPersistenceService } from "../../src/modules/generation/generation-persistence.service.js";
import { PostFactory } from "../../src/modules/generation/post.factory.js";
import { GenerationRunLifecycleService } from "../../src/modules/generation/generation-run-lifecycle.service.js";
import { ReviewResumeService } from "../../src/modules/generation/review-resume.service.js";
import { GenerationController } from "../../src/modules/generation/generation.controller.js";
import { CronService } from "../../src/modules/generation/cron.service.js";

// Posts
import { PostsService } from "../../src/modules/posts/posts.service.js";
import { PostsController } from "../../src/modules/posts/posts.controller.js";

// Posting
import { PostingService } from "../../src/modules/posting/posting.service.js";
import { PostingController } from "../../src/modules/posting/posting.controller.js";
import { ThreadProgressService } from "../../src/modules/posting/thread-progress.service.js";
import { PostingGuardChain } from "../../src/modules/posting/posting-guards.service.js";
import { PostingDispatcher } from "../../src/modules/posting/poster-registry.service.js";
import { PostVerificationService } from "../../src/modules/posting/post-verification.service.js";
import { ThreadOrchestrator } from "../../src/modules/posting/thread-posting.service.js";
import { PostSideEffectsService } from "../../src/modules/posting/post-side-effects.service.js";
import { CtaAttributionService } from "../../src/modules/posting/cta-attribution.service.js";

import { XPoster } from "../../src/modules/posting/posters/x.poster.js";
import { ThreadsPoster } from "../../src/modules/posting/posters/threads.poster.js";
import { FacebookPoster } from "../../src/modules/posting/posters/facebook.poster.js";
import { BlueskyPoster } from "../../src/modules/posting/posters/bluesky.poster.js";
import { MastodonPoster } from "../../src/modules/posting/posters/mastodon.poster.js";
import { BlueskyApiPoster } from "../../src/modules/posting/posters/bluesky-api.poster.js";
import { MastodonApiPoster } from "../../src/modules/posting/posters/mastodon-api.poster.js";
import { LinkedinSocialPoster } from "../../src/modules/posting/posters/linkedin-social.poster.js";

// Sessions
import { SessionsService } from "../../src/modules/sessions/sessions.service.js";
import { WarmupService } from "../../src/modules/sessions/warmup.service.js";
import { SessionsController } from "../../src/modules/sessions/sessions.controller.js";

// Rate limit
import { RateLimitService } from "../../src/modules/rate-limit/rate-limit.service.js";

// Engagement
import { EngagementService } from "../../src/modules/engagement/engagement.service.js";
import { EngagementController } from "../../src/modules/engagement/engagement.controller.js";
import { EngagementDecisionService } from "../../src/modules/engagement/engagement-decision.service.js";
import { EngagementSafetyService } from "../../src/modules/engagement/engagement-safety.service.js";
import { BrowsingSessionService } from "../../src/modules/engagement/browsing-session.service.js";
import { XEngager } from "../../src/modules/engagement/engagers/x.engager.js";
import { ThreadsEngager } from "../../src/modules/engagement/engagers/threads.engager.js";
import { FacebookEngager } from "../../src/modules/engagement/engagers/facebook.engager.js";
import { HumanBehaviorEngine } from "../../src/modules/engagement/human-behavior-engine.js";
import { TargetingService } from "../../src/modules/engagement/targeting.service.js";
import { EngagementSchedulerService } from "../../src/modules/engagement/engagement-scheduler.service.js";
import { EngagementCandidateScorer } from "../../src/modules/engagement/engagement-candidate-scorer.js";
import { EngagementSuggestionService } from "../../src/modules/engagement/engagement-suggestion.service.js";
import { EngagementSuggestionController } from "../../src/modules/engagement/engagement-suggestion.controller.js";

// Platform policy
import { PlatformPolicyService } from "../../src/modules/policy/platform-policy.service.js";
import { PlatformPolicyController } from "../../src/modules/policy/policy.controller.js";
import { ReputationService } from "../../src/modules/policy/reputation.service.js";
import { ReputationController } from "../../src/modules/policy/reputation.controller.js";
import { EditorialPortfolioPlanner } from "../../src/modules/persona/editorial-portfolio-planner.js";
import { EditorialPortfolioService } from "../../src/modules/persona/editorial-portfolio.service.js";
import { EditorialPortfolioController } from "../../src/modules/persona/editorial-portfolio.controller.js";
import { GroundingService } from "../../src/modules/persona/grounding.service.js";
import { GroundingController } from "../../src/modules/persona/grounding.controller.js";
import { PersonaProfileService } from "../../src/modules/persona/persona-profile.service.js";
import { DemandRadarService } from "../../src/modules/demand/demand-radar.service.js";
import { DemandRadarController } from "../../src/modules/demand/demand-radar.controller.js";
import { DemandSignalExtractor } from "../../src/modules/demand/demand-signal-extractor.js";
import { ImageQuotaService } from "../../src/modules/media/image-quota.service.js";
import { ImageGenerationService } from "../../src/modules/media/image-generation.service.js";
import { GeminiImageService } from "../../src/infrastructure/image/gemini-image.service.js";

// Flow control / Autonomy
import { FlowControlService } from "../../src/modules/flow-control/flow-control.service.js";
import { FlowControlController } from "../../src/modules/flow-control/flow-control.controller.js";
import { AutoCheckService } from "../../src/modules/autonomy/auto-check.service.js";
import { AutoApproveService } from "../../src/modules/autonomy/auto-approve.service.js";
import { AutonomousRunnerService } from "../../src/modules/autonomy/autonomous-runner.service.js";

// Events
import { SseController } from "../../src/modules/sse/sse.controller.js";
import { AutoApproveListener } from "../../src/modules/autonomy/auto-approve.listener.js";
import { SseEventListener } from "../../src/events/listeners/sse-event.listener.js";
import { IndexNowListener } from "../../src/events/listeners/indexnow.listener.js";
import { SocialPromoListener } from "../../src/events/listeners/social-promo.listener.js";
import { BrowserAgentService } from "../../src/modules/browser-agent/browser-agent.service.js";
import { CanonicalUrlService } from "../../src/modules/canonical/canonical-url.service.js";
import { DomainConfigService } from "../../src/domain/domain-config/domain-config.service.js";
import { ArticleGenerationCron } from "../../src/modules/syndication/article-generation.cron.js";

// Health
import { HealthController } from "../../src/modules/health/health.controller.js";
import { HealthMonitorService } from "../../src/modules/health-monitor/health-monitor.service.js";
import { HealthMonitorController } from "../../src/modules/health-monitor/health-monitor.controller.js";

// Trending
import { TrendingService } from "../../src/modules/trending/trending.service.js";
import { TrendingScraperService } from "../../src/modules/trending/trending-scraper.service.js";
import { TrendingController } from "../../src/modules/trending/trending.controller.js";

// Replies
import { RepliesMonitorService } from "../../src/modules/replies/replies-monitor.service.js";
import { RepliesController } from "../../src/modules/replies/replies.controller.js";
import { QuestionClassifierService } from "../../src/modules/replies/question-classifier.service.js";
import { DialogueService } from "../../src/modules/replies/dialogue.service.js";
import { CommentSafetyClassifierService } from "../../src/modules/replies/comment-safety-classifier.service.js";
import { ToneAnalyzerService } from "../../src/modules/replies/tone-analyzer.service.js";

// Content enhancements
import { VisualConceptService } from "../../src/modules/content-enhancements/visual-concept.service.js";
import { ABVariantGenerator } from "../../src/modules/content-enhancements/ab-variant.generator.js";
import { ABVariantService } from "../../src/modules/content-enhancements/ab-variant.service.js";
import { ThreadDepthService } from "../../src/modules/content-enhancements/thread-depth.service.js";
import { ContentPillarTracker } from "../../src/modules/content-enhancements/content-pillar.tracker.js";
import { HookPerformanceBank } from "../../src/modules/content-enhancements/hook-performance-bank.js";

// Orchestrator
import { HardRulesService } from "../../src/modules/orchestrator/hard-rules.service.js";
import { GuardrailsService } from "../../src/modules/orchestrator/guardrails.service.js";
import { NetworkSelector } from "../../src/modules/orchestrator/network-selector.js";
import { LlmDecisionService } from "../../src/modules/orchestrator/llm-decision.service.js";
import { PostingWindowService } from "../../src/modules/orchestrator/posting-window.service.js";
import { RulesEngine } from "../../src/modules/orchestrator/rules-engine.js";
import { DecisionEngineService } from "../../src/modules/orchestrator/decision-engine.service.js";
import { ActionExecutorService } from "../../src/modules/orchestrator/action-executor.service.js";
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
} from "../../src/modules/orchestrator/action-handlers.js";

// Sprint O / New features
import { CaptchaSolverService } from "../../src/infrastructure/captcha/captcha-solver.service.js";
import { ProxyRotationService } from "../../src/infrastructure/proxy/proxy-rotation.service.js";
import { AnalyticsService } from "../../src/modules/analytics/analytics.service.js";
import { AnalyticsController } from "../../src/modules/analytics/analytics.controller.js";
import { MetricsScraperService } from "../../src/modules/analytics/metrics-scraper.service.js";
import { ABTestService } from "../../src/modules/analytics/ab-test.service.js";
import { RecyclingService } from "../../src/modules/recycling/recycling.service.js";
import { RecyclingController } from "../../src/modules/recycling/recycling.controller.js";
import { QuoteCardService } from "../../src/modules/quote-cards/quote-card.service.js";
import { QuoteCardController } from "../../src/modules/quote-cards/quote-card.controller.js";

// Auth
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { AuthController } from "../../src/modules/auth/auth.controller.js";
import { JwtAuthGuard } from "../../src/modules/auth/jwt-auth.guard.js";
import { AdminGuard } from "../../src/modules/auth/admin.guard.js";
import { LoginRateLimitGuard } from "../../src/modules/auth/login-rate-limit.guard.js";
import { LocalhostGuard } from "../../src/infrastructure/guards/localhost.guard.js";

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
  Reflect.defineMetadata("design:paramtypes", types, target);
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
  defineParamtypes(LlmService, [ConfigService, Object, Object, Object, Object, Object, Object]); // Object = Redis, prompt, budget, resilience, usage ledger, compression
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
  defineParamtypes(QueueFactory, [
    ConfigService,
    DiscordNotificationService,
    Object,
    Object,
    Object,
    EventEmitter2,
  ]); // Object = Redis, subscriber, resilience
  defineParamtypes(EncryptionService, [ConfigService]);
  defineParamtypes(DiscordNotificationService, [ConfigService]);
  defineParamtypes(IndexNowService, [ConfigService]);
  defineParamtypes(TelegramAdapter, [ConfigService]);
  defineParamtypes(TopicGenerationService, [
    PrismaService,
    ConfigService,
    SchedulerRegistry,
    LlmService,
    Object,
  ]); // Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(EmailReaderService, [ConfigService]);
  defineParamtypes(LangfuseService, [Object, ConfigService]); // Object = LANGFUSE_PROMPT_BREAKER
  defineParamtypes(DistributedLockService, [Object]); // Object = SHARED_REDIS
  defineParamtypes(InstanceHeartbeatService, [ConfigService, Object]); // Object = SHARED_REDIS

  // ── Module classes with constructor DI ───────────────────────────────────
  defineParamtypes(SseModule, [SseService]);
  defineParamtypes(QueueModule, [
    QueueFactory,
    PostingService,
    PostingWindowService,
    ModuleRef,
    ConfigService,
  ]);

  // ── Accounts ─────────────────────────────────────────────────────────────
  defineParamtypes(AccountsService, [PrismaService, ConfigService, Object]); // Object = @Optional() WarmupService
  defineParamtypes(AccountsController, [AccountsService]);

  // ── Content source ───────────────────────────────────────────────────────
  defineParamtypes(ContentSourceService, [Object]); // Object = @Inject(IContentPort)
  defineParamtypes(ContentSourceController, [ContentSourceService]);

  // ── Generation ───────────────────────────────────────────────────────────
  // 26 params: 8 required + 18 @Optional()
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
    Object, // @Optional() DomainConfigService
    Object, // @Optional() AccountSettingsService
    Object, // @Optional() OnlineEvaluationService
    Object, // @Optional() @Inject(IAuthorContextPort)
    EditorialPortfolioService, // @Optional() portfolio dispatch/persistence
    GenerationPersistenceService, // @Optional() persistence seam
    GenerationRunLifecycleService, // @Optional() run lifecycle seam
    ReviewResumeService, // @Optional() HITL review-resume seam
  ]);
  defineParamtypes(GenerationPersistenceService, [PostsService, Object, Object, PostFactory]); // optional A/B, online evaluator and PostFactory
  defineParamtypes(PostFactory, [Object]); // Object = ILlmPort
  defineParamtypes(GenerationRunLifecycleService, [
    PrismaService,
    SseService,
    RedisCheckpointSaver,
  ]);
  defineParamtypes(ReviewResumeService, [
    AccountsService,
    SseService,
    GenerationPersistenceService,
  ]);
  defineParamtypes(GenerationController, [GenerationService]);
  defineParamtypes(CronService, [GenerationService, AccountsService, ConfigService]);

  // ── Posts ────────────────────────────────────────────────────────────────
  defineParamtypes(PostsService, [PrismaService, EventEmitter2, ConfigService]);
  defineParamtypes(PostsController, [PostsService, Object, PostingWindowService, ConfigService]); // Object = @Inject(IPostingQueuePort)

  // ── Posting ──────────────────────────────────────────────────────────────
  defineParamtypes(ThreadProgressService, [PrismaService]);
  defineParamtypes(PostingService, [
    Object, // @Inject(IBrowserPort)
    SessionsService,
    PostsService,
    RateLimitService,
    EventEmitter2,
    ConfigService,
    PostingGuardChain,
    PostingDispatcher,
    PostVerificationService,
    ThreadOrchestrator,
    PostSideEffectsService,
    CtaAttributionService,
    Object, // @Optional() @Inject(IResiliencePort)
    Object, // @Optional() @Inject(IRuntimeActionAuthorizer)
    Object, // @Optional() QueueFactory
    Object, // @Optional() FlowControlService
  ]);
  defineParamtypes(PostingController, [PostingService]);
  defineParamtypes(XPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(ThreadsPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(FacebookPoster, [Object, ConfigService]); // @Inject(IBrowserPort)
  defineParamtypes(BlueskyPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(MastodonPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(LinkedinSocialPoster, [Object, ConfigService]); // @Inject(IBrowserPort), @Inject(ConfigService)
  defineParamtypes(PostingGuardChain, [
    PostsService,
    RateLimitService,
    WarmupService,
    Object,
    Object,
  ]);
  defineParamtypes(PostingDispatcher, [
    XPoster,
    ThreadsPoster,
    FacebookPoster,
    ConfigService,
    ModuleRef,
    BlueskyPoster,
    MastodonPoster,
    LinkedinSocialPoster,
    TelegramAdapter,
    BlueskyApiPoster,
    MastodonApiPoster,
  ]);
  defineParamtypes(PostVerificationService, [
    PostsService,
    SessionsService,
    PostingDispatcher,
    EventEmitter2,
    Object,
  ]);
  defineParamtypes(ThreadOrchestrator, [
    PostsService,
    ThreadProgressService,
    PostingDispatcher,
    PostSideEffectsService,
    EventEmitter2,
    ConfigService,
    Object,
  ]);
  defineParamtypes(PostSideEffectsService, [Object, Object]);
  defineParamtypes(CtaAttributionService, [PostingDispatcher, Object, Object]);

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
    Object, // @Optional() @Inject(IResiliencePort)
    EventEmitter2,
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
    EngagementSafetyService,
    Object, // @Optional() @Inject(IRuntimeActionAuthorizer)
  ]);
  defineParamtypes(EngagementController, [
    EngagementService,
    BrowsingSessionService,
    EngagementSchedulerService,
  ]);
  defineParamtypes(EngagementCandidateScorer, [EngagementSafetyService]);
  defineParamtypes(EngagementSuggestionService, [PrismaService, EngagementSafetyService]);
  defineParamtypes(EngagementSuggestionController, [EngagementSuggestionService]);
  defineParamtypes(HumanBehaviorEngine, [
    PrismaService,
    Object,
    SseService,
    RateLimitService,
    Object,
    Object, // @Optional() @Inject(IRuntimeActionAuthorizer)
    EngagementCandidateScorer,
    EngagementSuggestionService,
    Object, // @Optional() @Inject(IAuthorContextPort)
  ]); // Object = IBrowserPort, IEngagementDecisionPort
  defineParamtypes(EngagementDecisionService, [
    Object,
    ConfigService,
    Object,
    EngagementSafetyService,
  ]); // Object = @Inject(ILlmPort), Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(TargetingService, [ConfigService]);
  defineParamtypes(EngagementSchedulerService, [ConfigService, QueueFactory, SchedulerRegistry]);

  // ── Flow control / Autonomy ──────────────────────────────────────────────
  defineParamtypes(FlowControlService, [Object, SseService]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(FlowControlController, [FlowControlService]);
  defineParamtypes(PlatformPolicyService, [PrismaService, FlowControlService, Object]);
  defineParamtypes(PlatformPolicyController, [PlatformPolicyService]);
  defineParamtypes(ReputationService, [PrismaService, FlowControlService]);
  defineParamtypes(ReputationController, [ReputationService]);
  defineParamtypes(EditorialPortfolioPlanner, []);
  defineParamtypes(EditorialPortfolioService, [PrismaService, EditorialPortfolioPlanner]);
  defineParamtypes(EditorialPortfolioController, [EditorialPortfolioService]);
  defineParamtypes(GroundingService, [PrismaService]);
  defineParamtypes(GroundingController, [GroundingService]);
  defineParamtypes(PersonaProfileService, [PrismaService, ConfigService, Object, Object]);
  defineParamtypes(DemandRadarService, [PrismaService]);
  defineParamtypes(DemandRadarController, [DemandRadarService, DemandSignalExtractor]);
  defineParamtypes(ImageQuotaService, [Object, ConfigService]);
  defineParamtypes(ImageGenerationService, [
    PrismaService,
    ConfigService,
    ImageQuotaService,
    Object,
    Object,
  ]);
  defineParamtypes(GeminiImageService, [ConfigService]);
  defineParamtypes(AutoCheckService, [PrismaService]);
  defineParamtypes(AutoApproveService, [
    ConfigService,
    PrismaService,
    SseService,
    AutoCheckService,
  ]);
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
  defineParamtypes(IndexNowListener, [ConfigService, IndexNowService]);
  defineParamtypes(SocialPromoListener, [ConfigService, PrismaService, GenerationService]);
  defineParamtypes(BrowserAgentService, [Object, ConfigService]); // Object = @Inject(ILlmPort)
  defineParamtypes(CanonicalUrlService, [PrismaService, ConfigService, Object]); // Object = @Optional() DomainConfigService
  defineParamtypes(DomainConfigService, [ConfigService]);
  defineParamtypes(ArticleGenerationCron, [
    GenerationService,
    Object, // Object = @Inject(IContentPort)
    AccountsService,
    PostsService,
    ConfigService,
    SchedulerRegistry,
  ]);

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
  defineParamtypes(HealthController, [PrismaService, Object, ConfigService, QueueFactory, Object]); // Object = Redis, resilience
  defineParamtypes(HealthMonitorService, [
    PrismaService,
    SseService,
    DiscordNotificationService,
    QueueService,
    QueueFactory,
    ConfigService,
    SchedulerRegistry,
    Object, // @Optional() @Inject(IResiliencePort)
  ]);
  defineParamtypes(HealthMonitorController, [HealthMonitorService]);

  // ── Trending ─────────────────────────────────────────────────────────────
  defineParamtypes(TrendingService, [ConfigService]);
  defineParamtypes(TrendingScraperService, [
    ConfigService,
    SchedulerRegistry,
    Object, // @Optional() LlmService
    Object, // @Optional() @Inject(IBrowserPort)
    SessionsService, // @Optional()
    Object, // @Optional() AccountsService
    Object, // @Optional() @Inject(IPromptPort)
    Object, // @Optional() DomainConfigService
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
    CommentSafetyClassifierService, // @Optional()
    Object, // @Optional() @Inject(SHARED_REDIS)
  ]);
  defineParamtypes(QuestionClassifierService, [Object, ConfigService, Object]); // Object = @Inject(ILlmPort), Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(DialogueService, [
    Object, // @Inject(ILlmPort)
    QuestionClassifierService,
    ToneAnalyzerService,
    PrismaService,
    ConfigService,
    Object, // @Optional() @Inject(IPromptPort)
  ]);
  defineParamtypes(CommentSafetyClassifierService, [Object, ConfigService, Object]); // Object = @Inject(ILlmPort), Object = @Optional() @Inject(IPromptPort)
  defineParamtypes(ToneAnalyzerService, []);
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
  defineParamtypes(AnalyticsController, [
    AnalyticsService,
    MetricsScraperService,
    ABTestService,
    Object,
    Object,
  ]); // Object = @Optional() HookPerformanceBank / OnlineEvaluationService
  defineParamtypes(MetricsScraperService, [
    ConfigService,
    PrismaService,
    SseService,
    SchedulerRegistry,
    Object,
    Object,
    Object,
  ]); // Object = @Optional() @Inject(IBrowserPort), Object = @Optional() ABVariantService, Object = @Optional() @Inject(SHARED_REDIS)
  defineParamtypes(RecyclingService, [
    ConfigService,
    PrismaService,
    GenerationService,
    SchedulerRegistry,
  ]);
  defineParamtypes(RecyclingController, [RecyclingService]);
  defineParamtypes(QuoteCardService, [ConfigService]);
  defineParamtypes(QuoteCardController, [QuoteCardService]);
  defineParamtypes(ControlBotService, [
    ConfigService,
    TelegramAdapter,
    PostsService,
    FlowControlService,
    Object, // @Optional() QueueFactory
    Object, // @Optional() PrismaService
    Object, // @Optional() @Inject(SHARED_REDIS)
  ]);

  // ── Auth ─────────────────────────────────────────────────────────────────
  defineParamtypes(AuthService, [PrismaService, JwtService, ConfigService]);
  defineParamtypes(AuthController, [AuthService, ConfigService]);
  defineParamtypes(JwtAuthGuard, [JwtService, ConfigService, Reflector]);
  defineParamtypes(AdminGuard, [ConfigService]);
  defineParamtypes(LoginRateLimitGuard, [ConfigService, Object]); // Object = @Inject(SHARED_REDIS)
  defineParamtypes(LocalhostGuard, [ConfigService]);
}
