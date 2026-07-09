/**
 * Big-Bang Integration Tests — Social Poster Agent (SPA)
 *
 * Technique: Big-Bang (all modules integrated simultaneously).
 * Interfaces: INT-01..INT-18 (all), with focus on:
 *   - INT-17: AppModule → ClsModule (CLS correlationId middleware)
 *   - INT-18: AppModule → LoggingModule (RedactInterceptor global interceptor)
 *
 * Test cases:
 *   ITC-017 — Full AppModule integration (all modules wired, DI resolves)
 *   ITC-018 — CLS correlationId propagation (unique per request, 'spa-' format)
 *   ITC-019 — RedactInterceptor redacts sensitive fields in HTTP responses
 *   ITC-020 — Posting → Browser + SSE (full posting flow: browser context → post → SSE events)
 *   ITC-035 — CLS + RedactInterceptor together (correlationId in logs + redacted data)
 *
 * Spec: CONSTITUTION.md §14 (Testing) — test case IDs are inline
 * Standard: ISO/IEC/IEEE 29119:2021
 *
 * Real NestJS DI wiring with mocked infrastructure:
 *   - ILlmPort: mocked (no real OpenAI calls)
 *   - IBrowserPort: mocked (no real Camoufox browser)
 *   - ioredis: vi.mock (no real Redis — SSE/RateLimit/Checkpoint use a Map store)
 *   - camoufox-js / @langchain/openai: vi.mock (avoid native binary / network init)
 *   - PrismaService: overridden with createMockPrismaService()
 *   - QueueFactory: overridden with a no-op mock (avoids BullMQ worker polling)
 *
 * NOTE: Vitest transforms with esbuild, which does NOT emit
 * `design:paramtypes` decorator metadata. Nest DI relies on that metadata
 * to resolve type-injected constructor params. The `@Inject(TOKEN)` params
 * survive (separate metadata key), but class-typed params come back as
 * `undefined`. We restore the metadata explicitly via `Reflect.defineMetadata`
 * for every injectable/controller/module class in the project so that
 * @nestjs/testing DI works as intended with the FULL AppModule.
 */
import 'reflect-metadata';
import { restoreAllDesignParamtypes, defineParamtypes } from '../helpers/restore-paramtypes';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get, Logger } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { ClsService } from 'nestjs-cls';
import { PostStatus, SessionStatus, SocialNetwork } from '@prisma/client';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { ILlmPort } from '../../src/domain/ports/llm.port.js';
import { IBrowserPort } from '../../src/domain/ports/browser.port.js';

// Infrastructure
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';
import { LlmService } from '../../src/infrastructure/llm/llm.service';
import { ContentReader } from '../../src/infrastructure/content/content-reader';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service.js';
import { SseModule } from '../../src/infrastructure/sse/sse.module';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { RedisCheckpointSaver } from '../../src/infrastructure/checkpoint/redis-checkpoint';

// Modules (for ITC-020 subset wiring)
import { PostingModule } from '../../src/modules/posting/posting.module';
import { BrowserModule } from '../../src/infrastructure/browser/browser.module';
import { PostsModule } from '../../src/modules/posts/posts.module';
import { SessionsModule } from '../../src/modules/sessions/sessions.module';
import { RateLimitModule } from '../../src/modules/rate-limit/rate-limit.module';
import { PrismaModule } from '../../src/infrastructure/prisma/prisma.module';
import { ScheduleModule } from '@nestjs/schedule';

// Services
import { PostingService } from '../../src/modules/posting/posting.service';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { AccountsController } from '../../src/modules/accounts/accounts.controller';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { GenerationService } from '../../src/modules/generation/generation.service';
import { GenerationController } from '../../src/modules/generation/generation.controller';
import { CronService } from '../../src/modules/generation/cron.service';
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentSourceController } from '../../src/modules/content-source/content-source.controller';
import { QueueService } from '../../src/modules/queue/queue.service';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { QueueModule } from '../../src/modules/queue/queue.module';
import { EventsController } from '../../src/modules/events/events.controller';
import { AutoApproveListener } from '../../src/events/listeners/auto-approve.listener';
import { SseEventListener } from '../../src/events/listeners/sse-event.listener';
import { HealthController } from '../../src/modules/health/health.controller';
import { EngagementService } from '../../src/modules/engagement/engagement.service';
import { EngagementController } from '../../src/modules/engagement/engagement.controller';
import { BrowsingSessionService } from '../../src/modules/engagement/browsing-session.service';
import { XEngager } from '../../src/modules/engagement/engagers/x.engager';
import { ThreadsEngager } from '../../src/modules/engagement/engagers/threads.engager';
import { FacebookEngager } from '../../src/modules/engagement/engagers/facebook.engager';

// Sprint O: New Features
import { CaptchaSolverService } from '../../src/infrastructure/captcha/captcha-solver.service';
import { ProxyRotationService } from '../../src/infrastructure/proxy/proxy-rotation.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { AnalyticsController } from '../../src/modules/analytics/analytics.controller';
import { MetricsScraperService } from '../../src/modules/analytics/metrics-scraper.service';
import { RecyclingService } from '../../src/modules/recycling/recycling.service';
import { RecyclingController } from '../../src/modules/recycling/recycling.controller';
import { QuoteCardService } from '../../src/modules/quote-cards/quote-card.service';
import { QuoteCardController } from '../../src/modules/quote-cards/quote-card.controller';
import { RepliesMonitorService } from '../../src/modules/replies/replies-monitor.service';
import { HumanBehaviorEngine } from '../../src/modules/engagement/human-behavior-engine';
import { TargetingService } from '../../src/modules/engagement/targeting.service';
import { EngagementSchedulerService } from '../../src/modules/engagement/engagement-scheduler.service';
import { FlowControlService } from '../../src/modules/flow-control/flow-control.service';
import { FlowControlController } from '../../src/modules/flow-control/flow-control.controller';
import { AutoCheckService } from '../../src/modules/autonomy/auto-check.service';
import { AutoApproveService } from '../../src/modules/autonomy/auto-approve.service';
import { AutonomousRunnerService } from '../../src/modules/autonomy/autonomous-runner.service';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { NotificationsModule } from '../../src/infrastructure/notifications/notifications.module';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator';
import { ThreadDepthController } from '../../src/modules/content-enhancements/thread-depth.controller';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank';
import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { JwtAuthGuard } from '../../src/modules/auth/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

// Orchestrator services (esbuild strips design:paramtypes; restore below)
import { HardRulesService } from '../../src/modules/orchestrator/hard-rules.service.js';
import { GuardrailsService } from '../../src/modules/orchestrator/guardrails.service.js';
import { LlmDecisionService } from '../../src/modules/orchestrator/llm-decision.service.js';
import { PostingWindowService } from '../../src/modules/orchestrator/posting-window.service.js';
import { DecisionEngineService } from '../../src/modules/orchestrator/decision-engine.service.js';
import { EmailReaderService } from '../../src/infrastructure/email/email-reader.service.js';

import { createMockLlmPort, createMockBrowserPort, createMockPrismaService } from '../mocks/index';
import { RedisModule } from '../../src/infrastructure/redis/redis.module';

// ── ioredis mock (hoisted) ───────────────────────────────────────────────────
// A shared Map-backed store so RateLimitService.checkRateLimit / recordPost
// and SseService.publish exercise their real logic against mocked Redis.
// The mock constructor returns an EventEmitter-like client supporting the
// methods used by SseService, RateLimitService, RedisCheckpointSaver, and
// HealthController. BullMQ is avoided by overriding QueueFactory.

const { sharedRedisStore } = vi.hoisted(() => ({
  sharedRedisStore: new Map<string, string>(),
}));

vi.mock('ioredis', () => {
  const createMockRedis = () => {
    const store = sharedRedisStore;
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const on = (ev: string, cb: (...args: unknown[]) => void) => {
      (listeners[ev] ??= []).push(cb);
      return inst;
    };
    const off = (ev: string, cb: (...args: unknown[]) => void) => {
      listeners[ev] = (listeners[ev] ?? []).filter((l) => l !== cb);
      return inst;
    };
    const once = (ev: string, cb: (...args: unknown[]) => void) => {
      const wrap = (...a: unknown[]) => {
        off(ev, wrap);
        cb(...a);
      };
      return on(ev, wrap);
    };
    const emit = (ev: string, ...args: unknown[]) => {
      (listeners[ev] ?? []).forEach((l) => l(...args));
      return inst;
    };
    const inst: Record<string, unknown> = {
      status: 'ready',
      on,
      off,
      once,
      emit,
      removeAllListeners: (ev?: string) => {
        if (ev) listeners[ev] = [];
        else for (const k in listeners) listeners[k] = [];
        return inst;
      },
      get: (k: string) => Promise.resolve(store.get(k) ?? null),
      set: (k: string, v: unknown) => {
        store.set(k, String(v));
        return Promise.resolve('OK');
      },
      setex: (k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      },
      psetex: (k: string, _t: number, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      },
      incr: (k: string) => {
        const v = parseInt(store.get(k) ?? '0', 10) + 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      decr: (k: string) => {
        const v = parseInt(store.get(k) ?? '0', 10) - 1;
        store.set(k, String(v));
        return Promise.resolve(v);
      },
      expire: () => Promise.resolve(1),
      pexpire: () => Promise.resolve(1),
      del: (k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      },
      unlink: (k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      },
      exists: (k: string) => Promise.resolve(store.has(k) ? 1 : 0),
      ping: () => Promise.resolve('PONG'),
      // publish emits 'message' on the same instance so SseService broadcast works
      publish: (_ch: string, msg: string) => {
        emit('message', _ch, msg);
        return Promise.resolve(1);
      },
      subscribe: () => Promise.resolve('OK'),
      unsubscribe: () => Promise.resolve('OK'),
      psubscribe: () => Promise.resolve('OK'),
      connect: () => Promise.resolve(undefined),
      disconnect: () => undefined,
      close: () => Promise.resolve(undefined),
      quit: () => Promise.resolve(undefined),
      duplicate: () => createMockRedis(),
      keys: (pat: string) => {
        const prefix = pat.replace(/\*$/, '');
        const out: string[] = [];
        for (const k of store.keys()) if (k.startsWith(prefix)) out.push(k);
        return Promise.resolve(out);
      },
      scan: () => Promise.resolve(['0', []]),
      hget: () => Promise.resolve(null),
      hset: () => Promise.resolve(1),
      hgetall: () => Promise.resolve({}),
      hdel: () => Promise.resolve(1),
      hlen: () => Promise.resolve(0),
      type: () => Promise.resolve('none'),
      eval: () => Promise.resolve(undefined),
      evalsha: () => Promise.resolve(undefined),
      multi: () => createMockRedis(),
      pipeline: () => createMockRedis(),
      batch: () => createMockRedis(),
      exec: () => Promise.resolve([]),
      rpush: () => Promise.resolve(1),
      lrange: () => Promise.resolve([]),
      llen: () => Promise.resolve(0),
      info: () => Promise.resolve(''),
      client: () => Promise.resolve('OK'),
      defineCommand: () => undefined,
      time: () => Promise.resolve(['0', '0']),
      wait: () => Promise.resolve(0),
    };
    // Emit 'ready' asynchronously so ioredis clients think they're connected.
    queueMicrotask(() => {
      inst.status = 'ready';
      emit('ready');
    });
    return inst;
  };
  return {
    // Constructor returning an object wins over `this` when invoked with `new`.
    default: function MockIORedis(..._args: unknown[]) {
      return createMockRedis();
    },
    __esModule: true,
  };
});

// camoufox-js — avoid launching a real browser binary during tests.
vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn().mockResolvedValue(null),
  __esModule: true,
}));

// @langchain/openai — avoid real OpenAI client instantiation.
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({ content: 'mock' }),
    temperature: 0.7,
  })),
  __esModule: true,
}));

// ── Metadata restoration (esbuild compatibility) ────────────────────────────
// esbuild does not emit `design:paramtypes`; restore it for every project
// class that has constructor DI so @nestjs/testing can wire the FULL AppModule.

/* esbuild metadata is now restored from ../helpers/restore-paramtypes
function defineParamtypes(target: unknown, types: unknown[]): void {
  // Always set — esbuild doesn't emit design:paramtypes, and we need the
  // latest constructor signature even if a previous test file set older metadata
  Reflect.defineMetadata('design:paramtypes', types, target);
}

function restoreAllDesignParamtypes(): void {
  // Infrastructure
  defineParamtypes(LlmService, [ConfigService]);
  defineParamtypes(ContentReader, [ConfigService]);
  defineParamtypes(BrowserFactory, [ConfigService]);
  defineParamtypes(SseService, [ConfigService, Object, Object]);
  defineParamtypes(RedisCheckpointSaver, [ConfigService, Object]);
  defineParamtypes(QueueFactory, [ConfigService, DiscordNotificationService]);
  defineParamtypes(EncryptionService, [ConfigService]);
  defineParamtypes(DiscordNotificationService, [ConfigService]);

  // Module classes with constructor DI
  defineParamtypes(SseModule, [SseService]);
  defineParamtypes(QueueModule, [QueueFactory, PostingService, ModuleRef, ConfigService]);

  // Accounts
  defineParamtypes(AccountsService, [PrismaService, ConfigService, WarmupService]);
  defineParamtypes(AccountsController, [AccountsService]);

  // Content source
  defineParamtypes(ContentSourceService, [ContentReader]);
  defineParamtypes(ContentSourceController, [ContentSourceService]);
  defineParamtypes(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService]);

  // Generation — 14 params: 7 required + 7 @Optional()
  defineParamtypes(GenerationService, [
    Object, // @Inject(ILlmPort)
    ContentSourceService,
    AccountsService,
    PostsService,
    PrismaService,
    RedisCheckpointSaver,
    SseService,
    Object, // @Optional() TrendingService
    Object, // @Optional() TrendingScraperService
    Object, // @Optional() ContentPillarTracker
    Object, // @Optional() HookPerformanceBank
    Object, // @Optional() VisualConceptService
    Object, // @Optional() ThreadDepthController
    Object, // @Optional() ABVariantGenerator
  ]);
  defineParamtypes(GenerationController, [GenerationService]);
  defineParamtypes(CronService, [GenerationService, AccountsService, ConfigService]);

  // Posts
  defineParamtypes(PostsService, [PrismaService, EventEmitter2]);
  defineParamtypes(PostsController, [PostsService, Object]);

  // Posting — @Inject(IBrowserPort) param is Object
  defineParamtypes(PostingService, [
    Object,
    AccountsService,
    SessionsService,
    WarmupService,
    PostsService,
    RateLimitService,
    SseService,
    ThreadProgressService,
    XPoster,
    ThreadsPoster,
    FacebookPoster,
    Object, // @Optional() QueueFactory
  ]);
  defineParamtypes(PostingController, [PostingService]);
  defineParamtypes(XPoster, [Object]); // [IBrowserPort]
  defineParamtypes(ThreadsPoster, [Object]); // [IBrowserPort]
  defineParamtypes(FacebookPoster, [Object, ConfigService]); // [IBrowserPort, ConfigService]

  // Engagement — engagers take IBrowserPort (Object in test DI)
  defineParamtypes(XEngager, [Object]); // [IBrowserPort]
  defineParamtypes(ThreadsEngager, [Object]); // [IBrowserPort]
  defineParamtypes(FacebookEngager, [Object, ConfigService]); // [IBrowserPort, ConfigService]
  defineParamtypes(BrowsingSessionService, [
    PrismaService,
    SessionsService,
    Object, // IBrowserPort
    ConfigService,
    SseService,
    RateLimitService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
    HumanBehaviorEngine, // HumanBehaviorEngine
    TargetingService, // TargetingService
    Object, // @Optional() WarmupService
  ]);
  defineParamtypes(EngagementService, [
    PrismaService,
    SessionsService,
    Object, // IBrowserPort
    SseService,
    RateLimitService,
    XEngager,
    ThreadsEngager,
    FacebookEngager,
  ]);
  defineParamtypes(EngagementController, [EngagementService]);

  // Sessions — @Inject(IBrowserPort) and @Inject(SHARED_REDIS) params are Object
  defineParamtypes(SessionsService, [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService, Object, EmailReaderService, SchedulerRegistry]);
  defineParamtypes(WarmupService, [PrismaService, ConfigService]);
  defineParamtypes(SessionsController, [SessionsService]);

  // Orchestrator (esbuild strips design:paramtypes for these new services too)
  defineParamtypes(HardRulesService, [Object]); // @Inject(SHARED_REDIS)
  defineParamtypes(GuardrailsService, []);
  defineParamtypes(LlmDecisionService, [ConfigService, Object]); // @Optional() @Inject(ILlmPort)
  defineParamtypes(PostingWindowService, [PrismaService, ConfigService, Object]); // @Inject(SHARED_REDIS)
  defineParamtypes(DecisionEngineService, [ConfigService, Object, PostingWindowService, HardRulesService, LlmDecisionService, GuardrailsService]); // @Inject(SHARED_REDIS)

  // Rate limit
  defineParamtypes(RateLimitService, [ConfigService, Object]);

  // Events
  defineParamtypes(EventsController, [SseService]);
  defineParamtypes(AutoApproveListener, [PrismaService, ModuleRef, ConfigService, Object]);
  defineParamtypes(SseEventListener, [SseService]);

  // Queue
  defineParamtypes(QueueService, [QueueFactory]);
  defineParamtypes(QueueController, [QueueService]);

  // Health
  defineParamtypes(HealthController, [PrismaService, Object]);

  // Content Enhancements
  defineParamtypes(VisualConceptService, [ConfigService, Object]); // @Optional() ILlmPort
  defineParamtypes(ABVariantGenerator, [ConfigService, Object]); // @Optional() ILlmPort
  defineParamtypes(ThreadDepthController, [ConfigService, Object]); // @Optional() ILlmPort
  defineParamtypes(ContentPillarTracker, [Object]); // @Inject(SHARED_REDIS)
  defineParamtypes(HookPerformanceBank, [Object, PrismaService]); // @Inject(SHARED_REDIS), @Optional() Prisma

  // Sprint O: New Features
  defineParamtypes(CaptchaSolverService, [ConfigService]);
  defineParamtypes(ProxyRotationService, [ConfigService]);
  defineParamtypes(AnalyticsService, [PrismaService]);
  defineParamtypes(AnalyticsController, [AnalyticsService]);
  defineParamtypes(MetricsScraperService, [PrismaService, SseService, SchedulerRegistry, Object]);
  defineParamtypes(RecyclingService, [PrismaService, GenerationService]);
  defineParamtypes(RecyclingController, [RecyclingService]);
  defineParamtypes(QuoteCardService, [ConfigService]);
  defineParamtypes(QuoteCardController, [QuoteCardService]);
  defineParamtypes(RepliesMonitorService, [PrismaService, ConfigService, AccountsService, SessionsService, SchedulerRegistry, DiscordNotificationService, SseService, LlmService, Object, EngagementService, Object, Object, Object]);
  defineParamtypes(HumanBehaviorEngine, [PrismaService, Object, SseService, RateLimitService, Object]);
  defineParamtypes(TargetingService, [ConfigService]);
  defineParamtypes(EngagementSchedulerService, [ConfigService, QueueFactory]);

  // ADR-006: Flow Control & Autonomy
  defineParamtypes(FlowControlService, [Object, SseService]); // @Inject(SHARED_REDIS), SseService
  defineParamtypes(FlowControlController, [FlowControlService]);
  defineParamtypes(AutoCheckService, [ConfigService, PrismaService]);
  defineParamtypes(AutoApproveService, [ConfigService, PrismaService, SseService, AutoCheckService]);
  defineParamtypes(AutonomousRunnerService, [ConfigService, PrismaService, SseService, FlowControlService, AutoApproveService, ModuleRef, Object]);

  // Auth (JWT cookie auth) — AuthService(Prisma, Jwt, Config), AuthController(Auth, Config), JwtAuthGuard(Jwt, Config)
  defineParamtypes(AuthService, [PrismaService, JwtService, ConfigService]);
  defineParamtypes(AuthController, [AuthService, ConfigService]);
  defineParamtypes(JwtAuthGuard, [JwtService, ConfigService]);
} */

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Extend createMockPrismaService() with the `socialAccount` model
 * (AccountsService uses prisma.socialAccount, not prisma.account).
 */
function createIntegrationPrismaService() {
  const prisma = createMockPrismaService();
  (prisma as unknown).socialAccount = {
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };
  return prisma;
}

/** No-op QueueFactory mock — avoids BullMQ worker polling during tests. */
function createMockQueueFactory() {
  return {
    enqueuePosting: vi.fn().mockResolvedValue(undefined),
    registerWorker: vi.fn(),
    getQueue: vi.fn(),
    getFailedJobs: vi.fn().mockResolvedValue([]),
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }),
    onModuleInit: vi.fn(),
    onModuleDestroy: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Test controller (CLS + Redact verification) ──────────────────────────────

/**
 * Test-only controller that exposes CLS correlationId and returns sensitive
 * data, so ITC-018 and ITC-035 can verify CLS + RedactInterceptor via HTTP.
 * Registered alongside the full AppModule in the TestingModule.
 */
@Controller('test')
class TestController {
  constructor(private readonly cls: ClsService) {}

  @Get('cls-id')
  getClsId() {
    return { correlationId: this.cls.getId() };
  }

  @Get('combined')
  getCombined() {
    const correlationId = this.cls.getId();
    // Log with the correlationId so ITC-035 can verify it appears in logs.
    new Logger('TestController').log(
      `correlationId=${correlationId} GET /test/combined`,
    );
    // Return sensitive fields that RedactInterceptor must redact.
    return {
      correlationId,
      storageState: 'secret-cookies-and-tokens',
      password: 'hunter2',
      apiKey: 'sk-test-123',
      safe: 'ok',
    };
  }
}
// esbuild does not emit paramtypes for the test controller either.
defineParamtypes(TestController, [ClsService]);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_X = {
  id: 'acc-001',
  network: SocialNetwork.X,
  handle: 'myzodiacai',
  credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
  active: true,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const ACTIVE_SESSION = {
  id: 'sess-001',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'auth', value: 'token' }], origins: [] },
  status: SessionStatus.ACTIVE,
  lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
  createdAt: new Date('2026-07-10T00:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
};

const APPROVED_POST_X = {
  id: 'post-020',
  network: SocialNetwork.X,
  content: 'Mercury retrograde is coming! Time to reflect, not react.',
  status: PostStatus.APPROVED,
  postUrl: null,
  errorMessage: null,
  accountId: 'acc-001',
  threadId: null,
  threadPosition: 0,
  generationRunId: null,
  sourceRef: null,
  llmMetadata: null,
  createdAt: new Date('2026-07-15T10:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
  approvedAt: new Date('2026-07-15T10:00:00Z'),
  postedAt: null,
  account: ACCOUNT_X,
  thread: null,
  generationRun: null,
};

// ── Full AppModule builder ───────────────────────────────────────────────────

interface FullAppResult {
  moduleRef: TestingModule;
  prisma: ReturnType<typeof createIntegrationPrismaService>;
}

/**
 * Build a TestingModule importing the FULL AppModule with external providers
 * overridden (PrismaService, ILlmPort, IBrowserPort, QueueFactory) and extra
 * controllers registered (e.g. TestController for CLS/Redact verification).
 */
async function buildFullAppModule(
  extraControllers: Array<new (...args: unknown[]) => unknown> = [],
): Promise<FullAppResult> {
  restoreAllDesignParamtypes();

  const prisma = createIntegrationPrismaService();
  const llmPort = createMockLlmPort();
  const browserPort = createMockBrowserPort();
  const queueFactory = createMockQueueFactory();

  const mockSharedRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ping: vi.fn().mockResolvedValue('PONG'),
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
    publish: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
    rpush: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(ILlmPort)
    .useValue(llmPort)
    .overrideProvider(IBrowserPort)
    .useValue(browserPort)
    .overrideProvider(QueueFactory)
    .useValue(queueFactory)
    .overrideProvider(EncryptionService)
    .useValue({ encrypt: (data: unknown) => JSON.stringify(data), decrypt: (data: string) => JSON.parse(data), isEnabled: () => false, isEncrypted: (s: string) => s.startsWith('v1:') })
    .overrideProvider(TrendingScraperService)
    .useValue({
      getGoogleTrends: vi.fn().mockResolvedValue([]),
      getXTrends: vi.fn().mockResolvedValue([]),
      getMergedTrends: vi.fn().mockResolvedValue([]),
      getCacheStatus: vi.fn().mockResolvedValue({ googleTrends: null, xTrends: null }),
    })
    .compile();

  return { moduleRef, prisma };
}

/** Create an initialized Nest HTTP application with the global API prefix. */
async function createHttpApp(moduleRef: TestingModule): Promise<INestApplication> {
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Big-Bang Integration: Full AppModule (ITC-017..020, ITC-035)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sharedRedisStore.clear();
  });

  // ── ITC-017: Full AppModule Integration ─────────────────────────────────────

  it(
    'ITC-017: full AppModule instantiates — all 16 modules wired, DI resolves every dependency (HAZ-005)',
    async () => {
      // Arrange + Act: compile the full AppModule with external providers mocked.
      // compile() triggers onModuleInit/onApplicationBootstrap lifecycle hooks,
      // so a successful compile proves every module instantiates without error.
      const { moduleRef } = await buildFullAppModule();

      try {
        // Assert: key services from every module are resolvable via DI.
        expect(moduleRef.get(GenerationService)).toBeDefined();
        expect(moduleRef.get(PostsService)).toBeDefined();
        expect(moduleRef.get(PostingService)).toBeDefined();
        expect(moduleRef.get(SessionsService)).toBeDefined();
        expect(moduleRef.get(AccountsService)).toBeDefined();
        expect(moduleRef.get(RateLimitService)).toBeDefined();
        expect(moduleRef.get(SseService)).toBeDefined();
        expect(moduleRef.get(ContentSourceService)).toBeDefined();
        expect(moduleRef.get(QueueService)).toBeDefined();
        expect(moduleRef.get(HealthController)).toBeDefined();

        // Assert: overridden infrastructure providers resolve to the mocks.
        const llm = moduleRef.get<ReturnType<typeof createMockLlmPort>>(ILlmPort);
        const browser = moduleRef.get<ReturnType<typeof createMockBrowserPort>>(IBrowserPort);
        const prisma = moduleRef.get(PrismaService);
        const queueFactory = moduleRef.get(QueueFactory);
        expect(llm).toBeDefined();
        expect(typeof llm.generateChat).toBe('function');
        expect(browser).toBeDefined();
        expect(typeof browser.createContext).toBe('function');
        expect(prisma).toBeDefined();
        expect(prisma.post).toBeDefined();
        expect((prisma as unknown).socialAccount).toBeDefined();
        expect(queueFactory).toBeDefined();
        expect(typeof (queueFactory as unknown).registerWorker).toBe('function');

        // Assert: global ClsService is provided by AppClsModule (INT-17).
        const cls = moduleRef.get(ClsService);
        expect(cls).toBeDefined();
        expect(typeof cls.getId).toBe('function');
      } finally {
        await moduleRef.close();
      }
    },
    30000,
  );

  // ── ITC-018: CLS CorrelationId Propagation ──────────────────────────────────

  it(
    'ITC-018: CLS middleware generates a unique correlationId per request in "spa-" format (INT-17, REQ-037)',
    async () => {
      const { moduleRef } = await buildFullAppModule([TestController]);
      const app = await createHttpApp(moduleRef);

      try {
        // Act: make two HTTP requests to the test endpoint that reads ClsService.getId().
        const res1 = await request(app.getHttpServer()).get('/api/v1/test/cls-id');
        const res2 = await request(app.getHttpServer()).get('/api/v1/test/cls-id');

        // Assert: both requests succeed.
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        const id1 = res1.body.correlationId;
        const id2 = res2.body.correlationId;

        // Assert: each correlationId is a non-empty string in the 'spa-' format.
        expect(id1).toEqual(expect.any(String));
        expect(id1.startsWith('spa-')).toBe(true);
        expect(id2).toEqual(expect.any(String));
        expect(id2.startsWith('spa-')).toBe(true);

        // Assert: the two correlationIds are different (unique per request).
        expect(id1).not.toBe(id2);
      } finally {
        await app.close();
        await moduleRef.close();
      }
    },
    30000,
  );

  // ── ITC-019: RedactInterceptor Integration ──────────────────────────────────

  it(
    'ITC-019: RedactInterceptor redacts sensitive fields (storageState, credentialsRef) in HTTP responses (INT-18, HAZ-012)',
    async () => {
      const { moduleRef, prisma } = await buildFullAppModule();
      const app = await createHttpApp(moduleRef);

      try {
        // Arrange: mock prisma.session.findMany to return a session with
        // sensitive storageState + an account with credentialsRef.
        prisma.session.findMany.mockResolvedValue([
          {
            id: 'sess-019',
            accountId: 'acc-001',
            storageState: { cookies: [{ name: 'auth', value: 'secret-token' }] },
            status: 'ACTIVE',
            lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
            createdAt: new Date('2026-07-10T00:00:00Z'),
            updatedAt: new Date('2026-07-15T10:00:00Z'),
            account: {
              id: 'acc-001',
              network: 'X',
              handle: 'myzodiacai',
              credentialsRef: 'SOCIAL_X_USERNAME/PASSWORD',
              active: true,
            },
          },
        ]);

        // Act: GET /api/v1/sessions — response passes through the global RedactInterceptor.
        const res = await request(app.getHttpServer()).get('/api/v1/sessions');

        // Assert: request succeeds.
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(1);

        const session = res.body[0];

        // Assert: sensitive fields are redacted in the response body.
        expect(session.storageState).toBe('[REDACTED]');
        expect(session.account.credentialsRef).toBe('[REDACTED]');

        // Assert: non-sensitive fields are intact (redaction is field-specific).
        expect(session.id).toBe('sess-019');
        expect(session.status).toBe('ACTIVE');
        expect(session.account.handle).toBe('myzodiacai');
        expect(session.account.network).toBe('X');
      } finally {
        await app.close();
        await moduleRef.close();
      }
    },
    30000,
  );

  // ── ITC-020: Posting → Browser + SSE (Full Posting Flow) ────────────────────

  it(
    'ITC-020: full posting flow — browser context → post → SSE POSTING + POSTED events (INT-05+09, HAZ-008)',
    async () => {
      restoreAllDesignParamtypes();

      const prisma = createIntegrationPrismaService();
      const browserPort = createMockBrowserPort();

      // Mock browser context (close resolves so PostingService can clean up).
      const mockContext = {
        newPage: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
        storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
      };
      browserPort.createContext.mockResolvedValue(mockContext);
      browserPort.saveStorageState.mockResolvedValue(
        JSON.stringify({ cookies: [], origins: [] }),
      );
      browserPort.randomDelay.mockResolvedValue(undefined);

      // Override posters with success mocks (browser automation is mocked).
      const mockXPoster = { post: vi.fn().mockResolvedValue({ url: 'https://x.com/user/status/123' }) };
      const mockThreadsPoster = { post: vi.fn().mockResolvedValue({ url: 'https://www.threads.com/@user/post/abc123' }) };
      const mockFacebookPoster = { post: vi.fn().mockResolvedValue({ url: 'https://www.facebook.com/myzodiacai/posts/789' }) };

      const mockSharedRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        ping: vi.fn().mockResolvedValue('PONG'),
        subscribe: vi.fn().mockResolvedValue(1),
        unsubscribe: vi.fn().mockResolvedValue(1),
        on: vi.fn(),
        publish: vi.fn().mockResolvedValue(1),
        keys: vi.fn().mockResolvedValue([]),
        rpush: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        incr: vi.fn().mockResolvedValue(1),
        quit: vi.fn().mockResolvedValue('OK'),
        disconnect: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
      } as unknown;

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true }),
          // PrismaModule is @Global — importing it makes the overridden
          // PrismaService (mock) available to every module in this subset.
          PrismaModule,
          RedisModule, // Sprint L: Global module — provides SHARED_REDIS tokens via mocked ioredis
          NotificationsModule, // Global — provides DiscordNotificationService for QueueFactory
          EventEmitterModule.forRoot(), // EDA: PostsService emits domain events
          ScheduleModule.forRoot(), // provides SchedulerRegistry for SessionsService
          PostingModule,
          BrowserModule,
          SseModule,
          PostsModule,
          SessionsModule,
          RateLimitModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(IBrowserPort)
        .useValue(browserPort)
        .overrideProvider(XPoster)
        .useValue(mockXPoster)
        .overrideProvider(ThreadsPoster)
        .useValue(mockThreadsPoster)
        .overrideProvider(FacebookPoster)
        .useValue(mockFacebookPoster)
        .compile();

      try {
        const postingService = moduleRef.get(PostingService);
        const sseService = moduleRef.get(SseService);

        // Arrange prisma mocks for the posting flow.
        // findById (findUnique) is called multiple times by postsService —
        // always return the APPROVED post.
        prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
        prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });
        prisma.post.findMany.mockResolvedValue([{ ...APPROVED_POST_X }]);
        prisma.post.count.mockResolvedValue(1);
        prisma.socialAccount.findFirst.mockResolvedValue({ ...ACCOUNT_X });
        prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION });
        prisma.session.update.mockResolvedValue({});

        // Spy on the real SseService.publish to capture SSE events.
        const publishSpy = vi.spyOn(sseService, 'publish');

        // Act: run the full posting flow.
        const result = await postingService.postById('post-020');

        // Assert: success returned with the post URL from the mock poster.
        expect(result.success).toBe(true);
        expect(result.url).toBe('https://x.com/user/status/123');

        // Assert: IBrowserPort.acquireContext called with network + storageState.
        expect(browserPort.acquireContext).toHaveBeenCalledTimes(1);
        const [networkArg, storageStateArg] = browserPort.acquireContext.mock.calls[0];
        expect(networkArg).toBe(SocialNetwork.X);
        expect(storageStateArg).toBe(JSON.stringify(ACTIVE_SESSION.storageState));

        // Assert: IBrowserPort.saveStorageState called after posting.
        expect(browserPort.saveStorageState).toHaveBeenCalledTimes(1);

        // Assert: SSE POSTING event published before the post.
        const postingEvent = publishSpy.mock.calls.find(
          (c: unknown[]) => c[0]?.status === 'POSTING',
        );
        expect(postingEvent).toBeDefined();
        expect(postingEvent[0]).toMatchObject({
          type: 'post_status',
          postId: 'post-020',
          status: 'POSTING',
          network: 'X',
        });

        // Assert: SSE POSTED event published after success, with the URL.
        const postedEvent = publishSpy.mock.calls.find(
          (c: unknown[]) => c[0]?.status === 'POSTED',
        );
        expect(postedEvent).toBeDefined();
        expect(postedEvent[0]).toMatchObject({
          type: 'post_status',
          postId: 'post-020',
          status: 'POSTED',
          network: 'X',
          url: 'https://x.com/user/status/123',
        });

        // Assert: correct sequence — POSTING event before POSTED event.
        const postingOrder = publishSpy.mock.invocationCallOrder[
          publishSpy.mock.calls.findIndex((c: unknown[]) => c[0]?.status === 'POSTING')
        ];
        const postedOrder = publishSpy.mock.invocationCallOrder[
          publishSpy.mock.calls.findIndex((c: unknown[]) => c[0]?.status === 'POSTED')
        ];
        expect(postingOrder).toBeLessThan(postedOrder);

        // Assert: post status updated to POSTED in DB with postUrl.
        const postedUpdate = prisma.post.update.mock.calls.find(
          (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTED,
        );
        expect(postedUpdate).toBeDefined();
        expect(postedUpdate[0].where.id).toBe('post-020');
        expect(postedUpdate[0].data.postUrl).toBe('https://x.com/user/status/123');

        // Assert: releaseContext called (context returned to pool, not closed).
        expect(browserPort.releaseContext).toHaveBeenCalledTimes(1);
      } finally {
        await moduleRef.close();
      }
    },
    30000,
  );

  // ── ITC-035: CLS + RedactInterceptor Together ───────────────────────────────

  it(
    'ITC-035: CLS + RedactInterceptor together — correlationId in logs AND sensitive data redacted in response (INT-17+18)',
    async () => {
      const { moduleRef } = await buildFullAppModule([TestController]);
      const app = await createHttpApp(moduleRef);

      try {
        // Arrange: spy on Logger.prototype.log to capture log output.
        const logSpy = vi.spyOn(Logger.prototype, 'log');

        // Act: request the combined endpoint — it logs the correlationId and
        // returns sensitive fields that RedactInterceptor must redact.
        const res = await request(app.getHttpServer()).get('/api/v1/test/combined');

        // Assert: request succeeds.
        expect(res.status).toBe(200);

        const correlationId = res.body.correlationId;

        // Assert: correlationId is present in the response (CLS context set).
        expect(correlationId).toEqual(expect.any(String));
        expect(correlationId.startsWith('spa-')).toBe(true);

        // Assert: sensitive fields are redacted in the response body.
        expect(res.body.storageState).toBe('[REDACTED]');
        expect(res.body.password).toBe('[REDACTED]');
        expect(res.body.apiKey).toBe('[REDACTED]');

        // Assert: non-sensitive fields are intact.
        expect(res.body.safe).toBe('ok');
        // correlationId is not a sensitive key, so it passes through.
        expect(res.body.correlationId).toBe(correlationId);

        // Assert: the correlationId appears in the captured log output.
        const loggedWithCorrelationId = logSpy.mock.calls.some((call) => {
          const msg = call[0];
          return typeof msg === 'string' && msg.includes(`correlationId=${correlationId}`);
        });
        expect(loggedWithCorrelationId).toBe(true);
      } finally {
        await app.close();
        await moduleRef.close();
      }
    },
    30000,
  );
});
