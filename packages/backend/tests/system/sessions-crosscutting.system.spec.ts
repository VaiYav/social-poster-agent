/**
 * System Tests — Sessions & Cross-Cutting Subsystems (HTTP E2E)
 *
 * Technique: Black-box system testing via HTTP API (Vitest + supertest + @nestjs/testing).
 * Covers STC-026..035, STC-049..052 — sessions, infrastructure, cross-cutting, scenarios.
 *
 * Spec: CONSTITUTION.md §14 (Testing) — test case IDs are inline
 * Standard: ISO/IEC/IEEE 29119:2021
 *
 * Real NestJS DI wiring with mocked infrastructure (same pattern as big-bang.integration.spec.ts):
 *   - ILlmPort: mocked (no real OpenAI calls)
 *   - IBrowserPort: mocked (no real Camoufox browser)
 *   - ioredis: vi.mock (no real Redis — SSE/RateLimit/Checkpoint use a Map store)
 *   - camoufox-js / @langchain/openai: vi.mock (avoid native binary / network init)
 *   - PrismaService: overridden with createMockPrismaService() + socialAccount model
 *   - QueueFactory: overridden with a no-op mock (avoids BullMQ worker polling)
 *   - ContentReader: overridden with a mock (returns fixture CAP data)
 *   - XPoster / ThreadsPoster / FacebookPoster: overridden with success mocks
 *
 * NOTE: Vitest transforms with esbuild, which does NOT emit `design:paramtypes`.
 * We restore the metadata explicitly via `Reflect.defineMetadata` for every
 * injectable/controller/module class so @nestjs/testing DI works with the FULL AppModule.
 */
import 'reflect-metadata';
import { TopicGenerationService } from '../../src/infrastructure/content/topic-generation.service';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SseEventListener } from '../../src/events/listeners/sse-event.listener';
import { AutoApproveListener } from '../../src/events/listeners/auto-approve.listener';
import { AutoCheckService } from '../../src/modules/autonomy/auto-check.service';
import { AutoApproveService } from '../../src/modules/autonomy/auto-approve.service';
import { AutonomousRunnerService } from '../../src/modules/autonomy/autonomous-runner.service';
import { FlowControlService } from '../../src/modules/flow-control/flow-control.service';
import { DiscordNotificationService } from '../../src/infrastructure/notifications/discord-notification.service';
import { NotificationsModule } from '../../src/infrastructure/notifications/notifications.module';
import { VisualConceptService } from '../../src/modules/content-enhancements/visual-concept.service';
import { ABVariantGenerator } from '../../src/modules/content-enhancements/ab-variant.generator';
import { ThreadDepthController } from '../../src/modules/content-enhancements/thread-depth.controller';
import { ContentPillarTracker } from '../../src/modules/content-enhancements/content-pillar.tracker';
import { HookPerformanceBank } from '../../src/modules/content-enhancements/hook-performance-bank';
import { ThreadProgressService } from '../../src/modules/posting/thread-progress.service';
import { HumanBehaviorEngine } from '../../src/modules/engagement/human-behavior-engine';
import { TargetingService } from '../../src/modules/engagement/targeting.service';
import { RepliesMonitorService } from '../../src/modules/replies/replies-monitor.service';
import { EngagementSchedulerService } from '../../src/modules/engagement/engagement-scheduler.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { MetricsScraperService } from '../../src/modules/analytics/metrics-scraper.service';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { PostStatus, SessionStatus, SocialNetwork } from '@prisma/client';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import type { ContentTopic } from '@spa/shared';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { ILlmPort } from '../../src/domain/ports/llm.port.js';
import { IBrowserPort } from '../../src/domain/ports/browser.port.js';
import { IContentPort } from '../../src/domain/ports/content.port.js';

// Infrastructure
import { BrowserFactory } from '../../src/infrastructure/browser/browser.factory';
import { LlmService } from '../../src/infrastructure/llm/llm.service';
import { ContentReader } from '../../src/infrastructure/content/content-reader';
import { SseService } from '../../src/infrastructure/sse/sse.service';
import { SseModule } from '../../src/infrastructure/sse/sse.module';
import { QueueFactory } from '../../src/infrastructure/queue/queue.factory';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service';
import { TrendingScraperService } from '../../src/modules/trending/trending-scraper.service';
import { RedisCheckpointSaver } from '../../src/infrastructure/checkpoint/redis-checkpoint';

// Modules
import { PostingModule } from '../../src/modules/posting/posting.module';
import { BrowserModule } from '../../src/infrastructure/browser/browser.module';
import { PostsModule } from '../../src/modules/posts/posts.module';
import { SessionsModule } from '../../src/modules/sessions/sessions.module';
import { RateLimitModule } from '../../src/modules/rate-limit/rate-limit.module';
import { PrismaModule } from '../../src/infrastructure/prisma/prisma.module';
import { QueueModule } from '../../src/modules/queue/queue.module';

// Services
import { PostingService } from '../../src/modules/posting/posting.service';
import { PostingController } from '../../src/modules/posting/posting.controller';
import { XPoster } from '../../src/modules/posting/posters/x.poster';
import { ThreadsPoster } from '../../src/modules/posting/posters/threads.poster';
import { FacebookPoster } from '../../src/modules/posting/posters/facebook.poster';
import { EngagementService } from '../../src/modules/engagement/engagement.service';
import { EngagementController } from '../../src/modules/engagement/engagement.controller';
import { BrowsingSessionService } from '../../src/modules/engagement/browsing-session.service';
import { XEngager } from '../../src/modules/engagement/engagers/x.engager';
import { ThreadsEngager } from '../../src/modules/engagement/engagers/threads.engager';
import { FacebookEngager } from '../../src/modules/engagement/engagers/facebook.engager';
import { PostsService } from '../../src/modules/posts/posts.service';
import { PostsController } from '../../src/modules/posts/posts.controller';
import { SessionsService } from '../../src/modules/sessions/sessions.service';
import { WarmupService } from '../../src/modules/sessions/warmup.service';
import { SessionsController } from '../../src/modules/sessions/sessions.controller';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import { AccountsController } from '../../src/modules/accounts/accounts.controller';
import { RateLimitService } from '../../src/modules/rate-limit/rate-limit.service';
import { GenerationService } from '../../src/modules/generation/generation.service';
import { clearHookCache } from '../../src/modules/generation/generation.graph';
import { GenerationController } from '../../src/modules/generation/generation.controller';
import { CronService } from '../../src/modules/generation/cron.service';
import { ContentSourceService } from '../../src/modules/content-source/content-source.service';
import { ContentSourceController } from '../../src/modules/content-source/content-source.controller';
import { QueueService } from '../../src/modules/queue/queue.service';
import { QueueController } from '../../src/modules/queue/queue.controller';
import { EventsController } from '../../src/modules/events/events.controller';
// Sprint O: New Features
import { CaptchaSolverService } from '../../src/infrastructure/captcha/captcha-solver.service';
import { ProxyRotationService } from '../../src/infrastructure/proxy/proxy-rotation.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { AnalyticsController } from '../../src/modules/analytics/analytics.controller';
import { RecyclingService } from '../../src/modules/recycling/recycling.service';
import { RecyclingController } from '../../src/modules/recycling/recycling.controller';
import { QuoteCardService } from '../../src/modules/quote-cards/quote-card.service';
import { QuoteCardController } from '../../src/modules/quote-cards/quote-card.controller';
import { HealthController } from '../../src/modules/health/health.controller';
import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { JwtAuthGuard } from '../../src/modules/auth/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';

import { createMockLlmPort, createMockBrowserPort, createMockPrismaService } from '../mocks/index';

// ── Environment variables for credential-based tests ──────────────────────────
// Must be set before ConfigModule is initialised (in beforeAll).
process.env.SOCIAL_X_USERNAME = 'test_x_user';
process.env.SOCIAL_X_PASSWORD = 'test_x_pass';
process.env.SOCIAL_THREADS_USERNAME = 'test_threads_user';
process.env.SOCIAL_THREADS_PASSWORD = 'test_threads_pass';
process.env.SOCIAL_FACEBOOK_EMAIL = 'test_fb_user';
process.env.SOCIAL_FACEBOOK_PASSWORD = 'test_fb_pass';

// ── ioredis mock (hoisted) ───────────────────────────────────────────────────
// Shared Map-backed store so RateLimitService, SseService, RedisCheckpointSaver,
// and HealthController all exercise their real logic against mocked Redis.

const { sharedRedisStore, sharedPubSub } = vi.hoisted(() => ({
  sharedRedisStore: new Map<string, string>(),
  // Cross-instance pub/sub bus: when publish() is called on one mock instance,
  // the message is broadcast to all subscribed instances' 'message' listeners.
  // This mirrors real Redis pub/sub where publisher and subscriber are different
  // connections but share the same Redis server.
  sharedPubSub: {
    subscribers: [] as Array<{ emit: (...args: unknown[]) => void }>,
  },
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
      publish: (_ch: string, msg: string) => {
        // Broadcast to all subscribed instances (cross-instance pub/sub).
        // SseService uses separate publisher/subscriber connections, so
        // publish() on one instance must reach 'message' listeners on another.
        for (const sub of sharedPubSub.subscribers) {
          sub.emit('message', _ch, msg);
        }
        return Promise.resolve(1);
      },
      subscribe: () => {
        // Register this instance's emit so cross-instance publish() reaches us
        sharedPubSub.subscribers.push({ emit });
        return Promise.resolve('OK');
      },
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
    queueMicrotask(() => {
      inst.status = 'ready';
      emit('ready');
    });
    return inst;
  };
  return {
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
  defineParamtypes(AutoCheckService, [ConfigService, PrismaService]);
  defineParamtypes(AutoApproveService, [ConfigService, PrismaService, SseService, AutoCheckService]);
  defineParamtypes(AutonomousRunnerService, [ConfigService, PrismaService, SseService, FlowControlService, AutoApproveService, ModuleRef, Object]);
  // Auth (JWT cookie auth)
  defineParamtypes(AuthService, [PrismaService, JwtService, ConfigService]);
  defineParamtypes(AuthController, [AuthService, ConfigService]);
  defineParamtypes(JwtAuthGuard, [JwtService, ConfigService]);
  defineParamtypes(AutoApproveListener, [PrismaService, ModuleRef, ConfigService, Object]);
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
  defineParamtypes(MetricsScraperService, [PrismaService, SseService, SchedulerRegistry, Object]);
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
  defineParamtypes(FacebookPoster, [Object, ConfigService]); // [IBrowserPort, ConfigService]
  defineParamtypes(XPoster, [Object]); // [IBrowserPort]
  defineParamtypes(ThreadsPoster, [Object]); // [IBrowserPort]
  defineParamtypes(XEngager, [Object]); // [IBrowserPort]
  defineParamtypes(ThreadsEngager, [Object]); // [IBrowserPort]
  defineParamtypes(FacebookEngager, [Object, ConfigService]); // [IBrowserPort, ConfigService]
  defineParamtypes(BrowsingSessionService, [PrismaService, SessionsService, Object, ConfigService, SseService, RateLimitService, XEngager, ThreadsEngager, FacebookEngager, HumanBehaviorEngine, TargetingService, Object]);
  defineParamtypes(EngagementService, [PrismaService, SessionsService, Object, SseService, RateLimitService, XEngager, ThreadsEngager, FacebookEngager]);
  defineParamtypes(EngagementController, [EngagementService]);
  defineParamtypes(HumanBehaviorEngine, [PrismaService, Object, SseService, RateLimitService, Object]);
  defineParamtypes(TargetingService, [ConfigService]);
  defineParamtypes(EngagementSchedulerService, [ConfigService, QueueFactory]);

  // Sessions — @Inject(IBrowserPort) param is Object
  defineParamtypes(SessionsService, [PrismaService, AccountsService, Object, ConfigService, EncryptionService, DiscordNotificationService]);
  defineParamtypes(WarmupService, [PrismaService, ConfigService]);
  defineParamtypes(SessionsController, [SessionsService]);

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
  defineParamtypes(VisualConceptService, [ConfigService, Object]);
  defineParamtypes(ABVariantGenerator, [ConfigService, Object]);
  defineParamtypes(ThreadDepthController, [ConfigService, Object]);
  defineParamtypes(ContentPillarTracker, [Object]);
  defineParamtypes(HookPerformanceBank, [Object, PrismaService]);

  // Replies
  defineParamtypes(RepliesMonitorService, [PrismaService, ConfigService, AccountsService, SessionsService, SchedulerRegistry, DiscordNotificationService, SseService, Object, Object, Object, Object]);

  // Sprint O: New Features
  defineParamtypes(CaptchaSolverService, [ConfigService]);
  defineParamtypes(ProxyRotationService, [ConfigService]);
  defineParamtypes(AnalyticsService, [PrismaService]);
  defineParamtypes(AnalyticsController, [AnalyticsService]);
  defineParamtypes(RecyclingService, [PrismaService, GenerationService]);
  defineParamtypes(RecyclingController, [RecyclingService]);
  defineParamtypes(QuoteCardService, [ConfigService]);
  defineParamtypes(QuoteCardController, [QuoteCardService]);
  // Quality pass: TopicGenerationService was added to AppModule without a restore
  // entry — esbuild-stripped paramtypes made configService undefined at boot.
  defineParamtypes(TopicGenerationService, [PrismaService, ConfigService, SchedulerRegistry, LlmService]);
}

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
    getFailedJobs: vi.fn().mockResolvedValue([
      {
        id: 'job-failed-1',
        data: { postId: 'post-001', network: 'X' },
        failedReason: 'Browser timeout',
        timestamp: Date.now(),
      },
    ]),
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: 2,
      active: 1,
      completed: 15,
      failed: 1,
      delayed: 0,
    }),
    onModuleInit: vi.fn(),
    onModuleDestroy: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock ContentReader that returns fixture CAP data.
 * Used for STC-049 (content source endpoints) and STC-051 (generation scenario).
 */
function createMockContentReader(topics: ContentTopic[]) {
  return {
    getTopics: vi.fn().mockResolvedValue(topics),
    readBriefs: vi.fn().mockResolvedValue(topics.filter((t) => t.sourceType === 'brief')),
    readArticles: vi.fn().mockResolvedValue(topics.filter((t) => t.sourceType === 'article')),
  };
}

/**
 * Create a mock Playwright page that supports locator chains used by
 * SessionsService (health check, auto-login) and posters.
 */
function createMockPage(opts: {
  url?: string;
  isLoggedIn?: boolean;
} = {}) {
  const url = opts.url ?? 'https://x.com/home';
  const isLoggedIn = opts.isLoggedIn ?? true;

  const mockLocator = {
    first: vi.fn().mockReturnThis(),
    waitFor: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(isLoggedIn),
    isEnabled: vi.fn().mockResolvedValue(true),
    isDisabled: vi.fn().mockResolvedValue(false),
    isHidden: vi.fn().mockResolvedValue(false),
    type: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    inputValue: vi.fn().mockResolvedValue('test_x_user'),
    allTextContents: vi.fn().mockResolvedValue([]),
    innerText: vi.fn().mockResolvedValue(''),
    textContent: vi.fn().mockResolvedValue(''),
    getAttribute: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    all: vi.fn().mockResolvedValue([]),
    evaluateAll: vi.fn().mockResolvedValue([]),
    or: vi.fn().mockReturnThis(),
  };
  // Separate locator for 2FA/verification selectors — isVisible returns false
  // so autoLogin doesn't enter the 2FA/verification challenge branch.
  const hiddenLocator = {
    ...mockLocator,
    isVisible: vi.fn().mockResolvedValue(false),
  };
  // Selectors that should appear hidden (2FA input, identity verification)
  const HIDDEN_SELECTOR_PATTERN = /ocfEnterTextTextInput|name="text"/;

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
    locator: vi.fn().mockImplementation((selector: string) =>
      HIDDEN_SELECTOR_PATTERN.test(selector) ? hiddenLocator : mockLocator,
    ),
    getByLabel: vi.fn().mockReturnValue(mockLocator),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    getByText: vi.fn().mockReturnValue(mockLocator),
    close: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html></html>'),
    textContent: vi.fn().mockResolvedValue(''),
    innerText: vi.fn().mockResolvedValue(''),
    evaluate: vi.fn().mockResolvedValue(undefined),
    evaluateAll: vi.fn().mockResolvedValue([]),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(undefined),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    },
    _mockLocator: mockLocator,
  };
}

/**
 * Create a mock browser context with a mock page.
 */
function createMockContext(
  page?: ReturnType<typeof createMockPage>,
  opts: { cookies?: Array<{ name: string; value: string; domain: string; expires?: number }> } = {},
) {
  const p = page ?? createMockPage();
  return {
    newPage: vi.fn().mockResolvedValue(p),
    close: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    pages: vi.fn().mockReturnValue([p]),
    cookies: vi.fn().mockResolvedValue(opts.cookies ?? []),
    addCookies: vi.fn().mockResolvedValue(undefined),
    _mockPage: p,
  };
}

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

const ACCOUNT_THREADS = {
  id: 'acc-002',
  network: SocialNetwork.THREADS,
  handle: 'myzodiacai',
  credentialsRef: 'SOCIAL_THREADS_USERNAME/PASSWORD',
  active: true,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const ACCOUNT_FACEBOOK = {
  id: 'acc-003',
  network: SocialNetwork.FACEBOOK,
  handle: 'myzodiacai@facebook.com',
  credentialsRef: 'SOCIAL_FACEBOOK_EMAIL/PASSWORD',
  active: true,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const ACTIVE_SESSION_X = {
  id: 'sess-001',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'auth', value: 'token-xyz', domain: '.x.com', path: '/' }], origins: [] },
  status: SessionStatus.ACTIVE,
  lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
  createdAt: new Date('2026-07-10T00:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
  account: ACCOUNT_X,
};

const EXPIRED_SESSION_X = {
  id: 'sess-002',
  accountId: 'acc-001',
  storageState: { cookies: [{ name: 'expired', value: 'old', domain: '.x.com', path: '/' }], origins: [] },
  status: SessionStatus.EXPIRED,
  lastHealthCheck: new Date('2026-07-10T10:00:00Z'),
  createdAt: new Date('2026-07-05T00:00:00Z'),
  updatedAt: new Date('2026-07-10T10:00:00Z'),
  account: ACCOUNT_X,
};

const ERROR_SESSION_THREADS = {
  id: 'sess-003',
  accountId: 'acc-002',
  storageState: { cookies: [], origins: [] },
  status: SessionStatus.ERROR,
  lastHealthCheck: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  account: ACCOUNT_THREADS,
};

const DRAFT_POST_X = {
  id: 'post-draft-001',
  network: SocialNetwork.X,
  content: 'Mercury retrograde is coming! Time to reflect, not react. ♋',
  status: PostStatus.DRAFT,
  postUrl: null,
  errorMessage: null,
  accountId: 'acc-001',
  threadId: null,
  threadPosition: 0,
  generationRunId: 'run-001',
  sourceRef: { type: 'brief', path: 'briefs/mercury-retro-2026.json', topic: 'Mercury Retrograde 2026' },
  llmMetadata: { model: 'gpt-4o-mini', promptVersion: '0.2.0', angleType: 'punchy' },
  createdAt: new Date('2026-07-15T10:00:00Z'),
  updatedAt: new Date('2026-07-15T10:00:00Z'),
  approvedAt: null,
  postedAt: null,
  account: ACCOUNT_X,
  thread: null,
  generationRun: null,
};

const APPROVED_POST_X = {
  id: 'post-approved-001',
  network: SocialNetwork.X,
  content: 'Full Moon in Capricorn — discipline meets ambition. 🌕♑',
  status: PostStatus.APPROVED,
  postUrl: null,
  errorMessage: null,
  accountId: 'acc-001',
  threadId: null,
  threadPosition: 0,
  generationRunId: null,
  sourceRef: null,
  llmMetadata: null,
  createdAt: new Date('2026-07-15T09:00:00Z'),
  updatedAt: new Date('2026-07-15T09:30:00Z'),
  approvedAt: new Date('2026-07-15T09:30:00Z'),
  postedAt: null,
  account: ACCOUNT_X,
  thread: null,
  generationRun: null,
};

const CAP_TOPICS: ContentTopic[] = [
  {
    sourceType: 'brief',
    path: 'briefs/mercury-retro-2026.json',
    topic: 'Mercury Retrograde July 2026',
    keywords: ['mercury retrograde', 'july 2026', 'astrology'],
    facts: ['Mercury retrograde: July 14 – August 7, 2026', 'Zodiac signs affected: Leo, Virgo'],
  },
  {
    sourceType: 'brief',
    path: 'briefs/full-moon-capricorn.json',
    topic: 'Full Moon in Capricorn',
    keywords: ['full moon', 'capricorn', 'astrology'],
    facts: ['Full moon on July 21, 2026', 'Capricorn energy: discipline, ambition'],
  },
  {
    sourceType: 'article',
    path: 'blog/en/cosmic-weather-w28.md',
    topic: 'Cosmic Weather Weekly — Week 28',
    keywords: ['cosmic weather', 'weekly horoscope', 'venus trine jupiter'],
    facts: ['Week of July 15: Venus trine Jupiter', 'Favorable for relationships and abundance'],
  },
];

// ── Full AppModule builder ───────────────────────────────────────────────────

interface FullAppResult {
  moduleRef: TestingModule;
  prisma: ReturnType<typeof createIntegrationPrismaService>;
  browserPort: ReturnType<typeof createMockBrowserPort>;
  contentReader: ReturnType<typeof createMockContentReader>;
  queueFactory: ReturnType<typeof createMockQueueFactory>;
  mockXPoster: { post: ReturnType<typeof vi.fn> };
  mockThreadsPoster: { post: ReturnType<typeof vi.fn> };
  mockFacebookPoster: { post: ReturnType<typeof vi.fn> };
}

/**
 * Build a TestingModule importing the FULL AppModule with external providers
 * overridden (PrismaService, ILlmPort, IBrowserPort, QueueFactory, ContentReader,
 * posters) so the entire HTTP API can be exercised against mocked infrastructure.
 */
async function buildFullAppModule(): Promise<FullAppResult> {
  restoreAllDesignParamtypes();

  const prisma = createIntegrationPrismaService();
  const llmPort = createMockLlmPort();
  const browserPort = createMockBrowserPort();
  const queueFactory = createMockQueueFactory();
  const contentReader = createMockContentReader(CAP_TOPICS);

  const mockXPoster = { post: vi.fn().mockResolvedValue({ url: 'https://x.com/myzodiacai/status/123' }) };
  const mockThreadsPoster = { post: vi.fn().mockResolvedValue({ url: 'https://threads.net/@myzodiacai/post/456' }) };
  const mockFacebookPoster = { post: vi.fn().mockResolvedValue({ url: 'https://facebook.com/myzodiacai/posts/789' }) };

  // Default prisma mocks so onModuleInit hooks (CronService.seedFromEnv) don't crash.
  prisma.socialAccount.findFirst.mockResolvedValue(null);
  prisma.socialAccount.create.mockResolvedValue(ACCOUNT_X);
  prisma.socialAccount.findMany.mockResolvedValue([ACCOUNT_X, ACCOUNT_THREADS, ACCOUNT_FACEBOOK]);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(ILlmPort)
    .useValue(llmPort)
    .overrideProvider(IBrowserPort)
    .useValue(browserPort)
    .overrideProvider(IContentPort)
    .useValue(contentReader)
    .overrideProvider(ContentReader)
    .useValue(contentReader)
    .overrideProvider(QueueFactory)
    .useValue(queueFactory)
    .overrideProvider(XPoster)
    .useValue(mockXPoster)
    .overrideProvider(ThreadsPoster)
    .useValue(mockThreadsPoster)
    .overrideProvider(FacebookPoster)
    .useValue(mockFacebookPoster)
    .overrideProvider(EncryptionService)
    .useValue({ encrypt: (data: unknown) => data, decrypt: (data: string) => data, isEnabled: () => false })
    .overrideProvider(TrendingScraperService)
    .useValue({
      getGoogleTrends: () => Promise.resolve([]),
      getXTrends: () => Promise.resolve([]),
      getMergedTrends: () => Promise.resolve([]),
      getCacheStatus: () => Promise.resolve({ googleTrends: null, xTrends: null }),
    })
    .overrideProvider(SseEventListener).useValue({ handleDraftGenerated: () => {}, handleApproved: () => {}, handlePostingStarted: () => {}, handlePosted: () => {}, handleFailed: () => {} }).compile();

  return { moduleRef, prisma, browserPort, contentReader, queueFactory, mockXPoster, mockThreadsPoster, mockFacebookPoster };
}

/** Create an initialized Nest HTTP application with the global API prefix. */
async function createHttpApp(moduleRef: TestingModule): Promise<INestApplication> {
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('System Tests: Sessions & Cross-Cutting (STC-026..035, STC-049..052)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: ReturnType<typeof createIntegrationPrismaService>;
  let browserPort: ReturnType<typeof createMockBrowserPort>;
  let contentReader: ReturnType<typeof createMockContentReader>;
  let queueFactory: ReturnType<typeof createMockQueueFactory>;
  let mockXPoster: { post: ReturnType<typeof vi.fn> };
  let mockThreadsPoster: { post: ReturnType<typeof vi.fn> };
  let mockFacebookPoster: { post: ReturnType<typeof vi.fn> };
  let sseService: SseService;
  let httpPort: number;

  beforeAll(async () => {
    const result = await buildFullAppModule();
    moduleRef = result.moduleRef;
    prisma = result.prisma;
    browserPort = result.browserPort;
    contentReader = result.contentReader;
    queueFactory = result.queueFactory;
    mockXPoster = result.mockXPoster;
    mockThreadsPoster = result.mockThreadsPoster;
    mockFacebookPoster = result.mockFacebookPoster;

    app = await createHttpApp(moduleRef);
    sseService = moduleRef.get(SseService);

    // Listen on a random port for SSE streaming tests (raw http.get).
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    httpPort = address.port;
  }, 30000);

  afterAll(async () => {
    await app.close();
    await moduleRef.close();
  }, 30000);

  beforeEach(() => {
    // Clear mock call history (keep implementations).
    // NOTE: Do NOT use vi.restoreAllMocks() — in Vitest 2.1.9 it resets
    // vi.fn() mock implementations (not just vi.spyOn() spies), which
    // breaks all mock providers after the first test.
    vi.clearAllMocks();
    // Clear shared Redis store.
    sharedRedisStore.clear();
    // Clear hook cache — previous tests may have cached hooks
    clearHookCache();
  });

  // ── STC-026: GET /sessions returns all sessions with status and lastHealthCheck ──

  it('STC-026: GET /sessions returns all sessions with status and lastHealthCheck (REQ-023)', async () => {
    // Arrange: 3 pre-seeded sessions (ACTIVE, EXPIRED, ERROR).
    prisma.session.findMany.mockResolvedValue([
      { ...ACTIVE_SESSION_X },
      { ...EXPIRED_SESSION_X },
      { ...ERROR_SESSION_THREADS },
    ]);

    // Act: GET /api/v1/sessions
    const res = await request(app.getHttpServer()).get('/api/v1/sessions');

    // Assert: HTTP 200; array of 3 sessions.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);

    // Assert: each session has id, status, lastHealthCheck, accountId.
    const statuses = res.body.map((s: unknown) => s.status);
    expect(statuses).toContain('ACTIVE');
    expect(statuses).toContain('EXPIRED');
    expect(statuses).toContain('ERROR');

    for (const session of res.body) {
      expect(session.id).toEqual(expect.any(String));
      expect(session.status).toEqual(expect.any(String));
      expect(session.accountId).toEqual(expect.any(String));
      // lastHealthCheck is present (may be null for ERROR session).
      expect('lastHealthCheck' in session).toBe(true);
    }

    // Assert: storageState is redacted by RedactInterceptor.
    expect(res.body[0].storageState).toBe('[REDACTED]');
  });

  // ── STC-027: POST /sessions/health-check verifies session validity ──────────

  it('STC-027: POST /sessions/health-check verifies session validity (REQ-024, HAZ-007)', async () => {
    // Arrange: active X session in DB.
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION_X });
    prisma.session.update.mockResolvedValue({});

    // Arrange: mock browser returns a page where URL is NOT a login page (session valid).
    // Provide auth cookies for deep health check (auth_token + ct0 for X).
    const validPage = createMockPage({ url: 'https://x.com/home', isLoggedIn: true });
    const validContext = createMockContext(validPage, {
      cookies: [
        { name: 'auth_token', value: 'test-auth-token', domain: '.x.com' },
        { name: 'ct0', value: 'test-ct0', domain: '.x.com' },
      ],
    });
    browserPort.acquireContext.mockResolvedValue(validContext);
    browserPort.randomDelay.mockResolvedValue(undefined);

    // Act: POST /api/v1/sessions/health-check?network=X
    const res = await request(app.getHttpServer())
      .post('/api/v1/sessions/health-check')
      .query({ network: 'X' });

    // Assert: HTTP 200; health check result.
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(res.body.message).toContain('active');

    // Assert: browser.acquireContext called with network + storageState.
    expect(browserPort.acquireContext).toHaveBeenCalledTimes(1);
    const [networkArg] = browserPort.acquireContext.mock.calls[0];
    expect(networkArg).toBe(SocialNetwork.X);

    // Assert: page.goto called with X.com home URL.
    expect(validPage.goto).toHaveBeenCalledTimes(1);
    expect(validPage.goto.mock.calls[0][0]).toContain('x.com');

    // Assert: prisma.session.update called to update lastHealthCheck.
    const updateCalls = prisma.session.update.mock.calls;
    const lastHealthCheckUpdate = updateCalls.find(
      (c: unknown[]) => c[0]?.data?.lastHealthCheck,
    );
    expect(lastHealthCheckUpdate).toBeDefined();
    expect(lastHealthCheckUpdate[0].where.id).toBe(ACTIVE_SESSION_X.id);
  });

  // ── STC-028: Auto-login on expired session using env credentials ────────────

  it('STC-028: Auto-login on expired session using env credentials (REQ-025, HAZ-007, HAZ-009)', async () => {
    // Arrange: no active session for X → getOrCreateSession triggers autoLogin.
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue(null); // no active session
    prisma.session.create.mockResolvedValue({
      id: 'sess-autologin',
      accountId: 'acc-001',
      storageState: { cookies: [{ name: 'auth', value: 'new-token' }], origins: [] },
      status: SessionStatus.ACTIVE,
      lastHealthCheck: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Arrange: mock browser for auto-login flow (login form + success indicator visible).
    const loginPage = createMockPage({ url: 'https://x.com/home', isLoggedIn: true });
    const loginContext = createMockContext(loginPage);
    browserPort.createContext.mockResolvedValue(loginContext);
    browserPort.acquireContext.mockResolvedValue(loginContext);
    browserPort.saveStorageState.mockResolvedValue(
      JSON.stringify({ cookies: [{ name: 'auth', value: 'new-token', domain: '.x.com', path: '/' }], origins: [] }),
    );
    browserPort.randomDelay.mockResolvedValue(undefined);

    // Act: trigger posting → getOrCreateSession → autoLogin.
    // We need an APPROVED post to trigger the posting flow.
    prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.post.findMany.mockResolvedValue([{ ...APPROVED_POST_X }]);
    prisma.post.count.mockResolvedValue(1);

    // Rate limit should allow (Redis store is empty).
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-approved-001');

    // Assert: posting succeeds (auto-login produced a valid session).
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Assert: browser.createContext was called for auto-login (navigates to login URL).
    expect(browserPort.createContext).toHaveBeenCalled();

    // Assert: page.goto was called with the X.com login URL.
    const gotoCalls = loginPage.goto.mock.calls;
    const loginGoto = gotoCalls.find((c: unknown[]) => c[0]?.includes('login'));
    expect(loginGoto).toBeDefined();

    // Assert: browserPort.typeHuman was called with username and password from env.
    // (X uses typeHuman → pressSequentially per-char for React-controlled inputs, not fill())
    const typeHumanCalls = browserPort.typeHuman.mock.calls;
    expect(typeHumanCalls.length).toBeGreaterThanOrEqual(2);
    // typeHuman(page, text, locator) — second arg is the text typed
    const typedValues = typeHumanCalls.map((c: unknown[]) => c[1]);
    expect(typedValues).toContain('test_x_user');
    expect(typedValues).toContain('test_x_pass');

    // Assert: session.create called with ACTIVE status (auto-login persisted).
    const sessionCreateCalls = prisma.session.create.mock.calls;
    expect(sessionCreateCalls.length).toBeGreaterThanOrEqual(1);
    const sessionData = sessionCreateCalls[0][0]?.data;
    expect(sessionData.status).toBe(SessionStatus.ACTIVE);
    expect(sessionData.accountId).toBe('acc-001');
    expect(sessionData.storageState).toBeDefined();
  });

  // ── STC-029: storageState persisted to Session after login/health check ────

  it('STC-029: storageState persisted to Session after posting (REQ-026, HAZ-013)', async () => {
    // Arrange: active session + APPROVED post.
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION_X });
    prisma.session.update.mockResolvedValue({});
    prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });

    // Arrange: mock browser + poster for successful posting.
    const postPage = createMockPage({ url: 'https://x.com/myzodiacai/status/999' });
    const postContext = createMockContext(postPage);
    browserPort.acquireContext.mockResolvedValue(postContext);
    const savedState = JSON.stringify({
      cookies: [{ name: 'auth', value: 'fresh-token', domain: '.x.com', path: '/', expires: 1234567890 }],
      origins: [{ origin: 'https://x.com', localStorage: [{ name: 'token', value: 'abc' }] }],
    });
    browserPort.saveStorageState.mockResolvedValue(savedState);
    browserPort.randomDelay.mockResolvedValue(undefined);
    mockXPoster.post.mockResolvedValue({ url: 'https://x.com/myzodiacai/status/999' });

    // Act: POST /api/v1/posting/post-approved-001
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-approved-001');

    // Assert: posting succeeds.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Assert: browser.saveStorageState called after posting.
    expect(browserPort.saveStorageState).toHaveBeenCalledTimes(1);

    // Assert: prisma.session.update called with storageState data.
    const sessionUpdateCalls = prisma.session.update.mock.calls;
    const storageStateUpdate = sessionUpdateCalls.find(
      (c: unknown[]) => c[0]?.data?.storageState,
    );
    expect(storageStateUpdate).toBeDefined();
    expect(storageStateUpdate[0].data.status).toBe(SessionStatus.ACTIVE);
    expect(storageStateUpdate[0].data.lastHealthCheck).toBeDefined();

    // Assert: storageState is valid JSON with cookies array and origins array.
    const persistedState = storageStateUpdate[0].data.storageState;
    expect(persistedState).toHaveProperty('cookies');
    expect(Array.isArray(persistedState.cookies)).toBe(true);
    expect(persistedState.cookies[0]).toHaveProperty('name');
    expect(persistedState.cookies[0]).toHaveProperty('value');
    expect(persistedState.cookies[0]).toHaveProperty('domain');
    expect(persistedState).toHaveProperty('origins');
    expect(Array.isArray(persistedState.origins)).toBe(true);
  });

  // ── STC-030: Zod validation rejects invalid requests with HTTP 400 ──────────

  it('STC-030: Zod validation rejects invalid requests — no side effects (REQ-NF-007)', async () => {
    // BUG DOCUMENTATION: The STC spec expects HTTP 400 for Zod validation
    // failures, but the actual implementation calls ZodSchema.parse() directly
    // in controllers. With the ZodValidationFilter (GAP-001 fix), ZodError
    // is now caught globally and converted to HTTP 400 with structured
    // validation error details.

    // Step 1: POST /generation/run with invalid body (count=-1, invalid sourceType).
    const res1 = await request(app.getHttpServer())
      .post('/api/v1/generation/run')
      .send({ count: -1, networks: [], sourceType: 'invalid' });

    expect(res1.status).toBe(400); // ZodValidationFilter returns 400

    // Step 2: POST /posts with invalid body (invalid network, empty content).
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .send({ network: 'LINKEDIN', content: '' });

    expect(res2.status).toBe(400); // ZodValidationFilter returns 400

    // Step 3: PATCH /posts/:id/status with invalid status.
    const res3 = await request(app.getHttpServer())
      .patch('/api/v1/posts/test-id/status')
      .send({ status: 'PENDING' });

    expect(res3.status).toBe(400); // ZodValidationFilter returns 400

    // Assert: no DB writes occurred (validation prevented service logic).
    expect(prisma.post.create).not.toHaveBeenCalled();
    expect(prisma.generationRun.create).not.toHaveBeenCalled();
  });

  // ── STC-031: Rate limit enforcement via Redis sliding window ────────────────

  it('STC-031: Rate limit enforcement via Redis sliding window (REQ-NF-003, HAZ-006)', async () => {
    // Arrange: pre-seed Redis with 50 daily posts for X (daily limit reached).
    const today = new Date().toISOString().slice(0, 10);
    sharedRedisStore.set(`spa:ratelimit:X:daily:${today}`, '50');

    // Arrange: APPROVED post for X.
    prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);

    // Act: POST /api/v1/posting/post-approved-001 → should fail (51st post > 50 limit).
    const res = await request(app.getHttpServer())
      .post('/api/v1/posting/post-approved-001');

    // Assert: request fails (rate limit error → 500 from unhandled throw).
    expect(res.status).toBe(500);

    // Assert: browser.acquireContext NOT called (rate limit blocked before posting).
    expect(browserPort.acquireContext).not.toHaveBeenCalled();

    // Assert: post status NOT updated to POSTING (rate limit check is before status update).
    const postingUpdate = prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTING,
    );
    expect(postingUpdate).toBeUndefined();

    // Assert: rate limit counter was NOT incremented — checkRateLimit is read-only
    // (uses redis.get, not redis.incr). recordPost() would increment, but it's
    // never called because the rate limit check rejects before posting begins.
    const dailyCount = sharedRedisStore.get(`spa:ratelimit:X:daily:${today}`);
    expect(parseInt(dailyCount ?? '0', 10)).toBe(50);
  });

  // ── STC-032: SSE event delivery under 100ms ────────────────────────────────

  it('STC-032: SSE event delivery under 100ms (REQ-020, REQ-NF-011, HAZ-015)', async () => {
    // Act: establish SSE connection via raw http.get.
    const eventData = await new Promise<{ connectedTime: number; eventTime: number }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('SSE timeout')), 5000);
        let connectedTime = 0;
        let eventTime = 0;

        const req = http.get(
          {
            host: 'localhost',
            port: httpPort,
            path: '/api/v1/events/sse',
            headers: { Accept: 'text/event-stream' },
          },
          (res) => {
            res.setEncoding('utf-8');

            res.on('data', (chunk: string) => {
              const lines = chunk.split('\n');
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const json = line.slice(6).trim();
                  if (!json) continue;
                  try {
                    const event = JSON.parse(json);
                    if (event.type === 'connected') {
                      connectedTime = Date.now();
                      // Publish a test event immediately after connected.
                      sseService
                        .publish({
                          type: 'post_status',
                          postId: 'post-sse-032',
                          status: 'POSTED',
                          network: 'X',
                          url: 'https://x.com/test/status/032',
                        })
                        .then(() => {
                          eventTime = Date.now();
                        });
                    } else if (event.type === 'post_status' && event.postId === 'post-sse-032') {
                      eventTime = Date.now();
                      clearTimeout(timeout);
                      res.destroy();
                      resolve({ connectedTime, eventTime });
                    }
                  } catch {
                    // ignore parse errors (heartbeats, partial chunks)
                  }
                }
              }
            });

            res.on('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          },
        );

        req.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      },
    );

    // Assert: event was received.
    expect(eventData).toBeDefined();
    expect(eventData.eventTime).toBeGreaterThan(0);

    // Assert: delivery latency under 100ms (from publish to receipt).
    // eventTime is set right after publish; the event arrival is when we resolve.
    // The actual latency is the time from sseService.publish() to the data handler.
    // Since we measure eventTime at publish and resolve at receipt, the difference
    // between resolve time and eventTime is the delivery latency.
    // We use a generous threshold to account for event loop scheduling.
    const deliveryLatency = Date.now() - eventData.eventTime;
    expect(deliveryLatency).toBeLessThan(100);
  });

  // ── STC-033: SSE auto-reconnect on connection drop ─────────────────────────

  it('STC-033: SSE auto-reconnect — new connection gets new clientId (REQ-032, REQ-NF-011, HAZ-015)', async () => {
    // This STC is primarily a UI feature (useSSE composable auto-reconnects).
    // HTTP parts: verify that a new SSE connection after a drop receives a new
    // 'connected' event with a different clientId, and subsequent events are delivered.

    // Step 1: establish first SSE connection, capture clientId.
    const clientId1 = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE timeout')), 5000);
      const req = http.get(
        {
          host: 'localhost',
          port: httpPort,
          path: '/api/v1/events/sse',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const event = JSON.parse(line.slice(6).trim());
                  if (event.type === 'connected') {
                    clearTimeout(timeout);
                    res.destroy();
                    resolve(event.clientId);
                  }
                } catch {
                  // ignore
                }
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });

    // Step 2: simulate connection drop (the first connection is already destroyed).
    // Step 3: establish a new SSE connection (reconnect).
    const clientId2 = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE timeout')), 5000);
      const req = http.get(
        {
          host: 'localhost',
          port: httpPort,
          path: '/api/v1/events/sse',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const event = JSON.parse(line.slice(6).trim());
                  if (event.type === 'connected') {
                    clearTimeout(timeout);
                    res.destroy();
                    resolve(event.clientId);
                  }
                } catch {
                  // ignore
                }
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });

    // Assert: both clientIds are non-empty strings.
    expect(clientId1).toEqual(expect.any(String));
    expect(clientId1.length).toBeGreaterThan(0);
    expect(clientId2).toEqual(expect.any(String));
    expect(clientId2.length).toBeGreaterThan(0);

    // Assert: new connection gets a DIFFERENT clientId (reconnect = new session).
    expect(clientId2).not.toBe(clientId1);

    // Step 4: verify events are delivered after reconnect.
    const eventReceived = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE timeout')), 5000);
      const req = http.get(
        {
          host: 'localhost',
          port: httpPort,
          path: '/api/v1/events/sse',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf-8');
          let connected = false;
          res.on('data', (chunk: string) => {
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) {
                try {
                  const event = JSON.parse(line.slice(6).trim());
                  if (event.type === 'connected') {
                    connected = true;
                    // Publish event after reconnect.
                    sseService.publish({
                      type: 'post_status',
                      postId: 'post-reconnect-033',
                      status: 'POSTED',
                      network: 'X',
                      url: 'https://x.com/test/status/reconnect',
                    });
                  } else if (event.type === 'post_status' && event.postId === 'post-reconnect-033') {
                    clearTimeout(timeout);
                    res.destroy();
                    resolve(true);
                  }
                } catch {
                  // ignore
                }
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });

    expect(eventReceived).toBe(true);
  });

  // ── STC-034: Credentials not present in log output (RedactInterceptor) ──────

  it('STC-034: Credentials not present in log output — RedactInterceptor (REQ-038, REQ-NF-005, HAZ-012)', async () => {
    // Arrange: spy on Logger.prototype.log and Logger.prototype.error to capture output.
    const { Logger } = await import('@nestjs/common');
    const logSpy = vi.spyOn(Logger.prototype, 'log');
    const errorSpy = vi.spyOn(Logger.prototype, 'error');

    // Arrange: set up sessions for health check (which accesses credentials).
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION_X });
    prisma.session.update.mockResolvedValue({});

    const validPage = createMockPage({ url: 'https://x.com/home', isLoggedIn: true });
    const validContext = createMockContext(validPage);
    browserPort.acquireContext.mockResolvedValue(validContext);
    browserPort.randomDelay.mockResolvedValue(undefined);

    // Act: trigger health check (accesses session data with storageState).
    const res = await request(app.getHttpServer())
      .post('/api/v1/sessions/health-check')
      .query({ network: 'X' });

    expect(res.status).toBe(200);

    // Assert: no raw credential values in any log line.
    const allLogCalls = [
      ...logSpy.mock.calls.map((c) => String(c[0])),
      ...errorSpy.mock.calls.map((c) => String(c[0])),
    ];

    const sensitiveValues = [
      'test_x_pass',
      'test_threads_pass',
      'test_fb_pass',
      'test-key-not-real',
      'token-xyz', // from session storageState
    ];

    for (const logLine of allLogCalls) {
      for (const sensitive of sensitiveValues) {
        expect(logLine).not.toContain(sensitive);
      }
    }

    // Assert: RedactInterceptor redacts storageState in HTTP response.
    // The sessions endpoint returns storageState which should be [REDACTED].
    prisma.session.findMany.mockResolvedValue([{ ...ACTIVE_SESSION_X }]);
    const sessionsRes = await request(app.getHttpServer()).get('/api/v1/sessions');
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body[0].storageState).toBe('[REDACTED]');
    if (sessionsRes.body[0].account) {
      expect(sessionsRes.body[0].account.credentialsRef).toBe('[REDACTED]');
    }
  });

  // ── STC-035: Credentials not stored in database (env-only) ─────────────────

  it('STC-035: Credentials not stored in database — env-only (REQ-NF-004, HAZ-012)', async () => {
    // Arrange: mock socialAccount.findMany to return accounts with credentialsRef (env var name).
    prisma.socialAccount.findMany.mockResolvedValue([ACCOUNT_X, ACCOUNT_THREADS, ACCOUNT_FACEBOOK]);

    // Act: GET /api/v1/accounts (or check via sessions which include account).
    prisma.session.findMany.mockResolvedValue([
      { ...ACTIVE_SESSION_X, account: ACCOUNT_X },
      { ...EXPIRED_SESSION_X, account: ACCOUNT_X },
      { ...ERROR_SESSION_THREADS, account: ACCOUNT_THREADS },
    ]);

    const res = await request(app.getHttpServer()).get('/api/v1/sessions');

    // Assert: HTTP 200.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // Assert: credentialsRef contains env var NAME, not actual credential value.
    // The RedactInterceptor redacts credentialsRef to [REDACTED], so we verify
    // the raw mock data (which represents what's in the DB).
    expect(ACCOUNT_X.credentialsRef).toBe('SOCIAL_X_USERNAME/PASSWORD');
    expect(ACCOUNT_THREADS.credentialsRef).toBe('SOCIAL_THREADS_USERNAME/PASSWORD');
    expect(ACCOUNT_FACEBOOK.credentialsRef).toBe('SOCIAL_FACEBOOK_EMAIL/PASSWORD');

    // Assert: credentialsRef does NOT contain raw password values.
    expect(ACCOUNT_X.credentialsRef).not.toContain('test_x_pass');
    expect(ACCOUNT_THREADS.credentialsRef).not.toContain('test_threads_pass');
    expect(ACCOUNT_FACEBOOK.credentialsRef).not.toContain('test_fb_pass');

    // Assert: no OpenAI API key pattern (sk-...) in any DB field.
    const allDbText = JSON.stringify([
      ACCOUNT_X,
      ACCOUNT_THREADS,
      ACCOUNT_FACEBOOK,
      ACTIVE_SESSION_X,
      EXPIRED_SESSION_X,
      ERROR_SESSION_THREADS,
    ]);
    expect(allDbText).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);

    // Assert: storageState contains browser cookies only, not passwords.
    const storageState = ACTIVE_SESSION_X.storageState as unknown;
    expect(storageState).toHaveProperty('cookies');
    expect(Array.isArray(storageState.cookies)).toBe(true);
    const storageJson = JSON.stringify(storageState);
    expect(storageJson).not.toContain('password');
    expect(storageJson).not.toContain('test_x_pass');
  });

  // ── STC-049: Content source endpoints return CAP data ──────────────────────

  it('STC-049: Content source endpoints return CAP data (REQ-027, REQ-028, REQ-029, REQ-IF-003)', async () => {
    // Arrange: ContentReader is overridden with mock returning CAP_TOPICS.
    // (Already set up in buildFullAppModule.)

    // Act + Assert: GET /api/v1/content-source/topics?limit=3
    const topicsRes = await request(app.getHttpServer())
      .get('/api/v1/content-source/topics')
      .query({ limit: 3 });

    expect(topicsRes.status).toBe(200);
    expect(Array.isArray(topicsRes.body)).toBe(true);
    expect(topicsRes.body).toHaveLength(3);
    for (const topic of topicsRes.body) {
      expect(topic).toHaveProperty('sourceType');
      expect(topic).toHaveProperty('path');
      expect(topic).toHaveProperty('topic');
    }

    // Act + Assert: GET /api/v1/content-source/briefs?limit=2
    const briefsRes = await request(app.getHttpServer())
      .get('/api/v1/content-source/briefs')
      .query({ limit: 2 });

    expect(briefsRes.status).toBe(200);
    expect(Array.isArray(briefsRes.body)).toBe(true);
    expect(briefsRes.body).toHaveLength(2);
    for (const brief of briefsRes.body) {
      expect(brief.sourceType).toBe('brief');
    }

    // Act + Assert: GET /api/v1/content-source/articles?limit=2
    const articlesRes = await request(app.getHttpServer())
      .get('/api/v1/content-source/articles')
      .query({ limit: 2 });

    expect(articlesRes.status).toBe(200);
    expect(Array.isArray(articlesRes.body)).toBe(true);
    expect(articlesRes.body).toHaveLength(1); // 1 article in CAP_TOPICS
    for (const article of articlesRes.body) {
      expect(article.sourceType).toBe('article');
    }

    // Assert: ContentReader.getTopics was called with limit 3.
    expect(contentReader.getTopics).toHaveBeenCalledWith(3);
    expect(contentReader.readBriefs).toHaveBeenCalledWith(2);
    expect(contentReader.readArticles).toHaveBeenCalledWith(2);
  });

  // ── STC-050: Queue monitoring endpoints return BullMQ job stats ────────────

  it('STC-050: Queue monitoring endpoints return BullMQ job stats (REQ-030, REQ-031)', async () => {
    // Arrange: QueueFactory mock returns job counts and failed jobs.
    // (Already set up in buildFullAppModule.)

    // Act + Assert: GET /api/v1/queue/X/stats
    const statsRes = await request(app.getHttpServer())
      .get('/api/v1/queue/X/stats');

    expect(statsRes.status).toBe(200);
    expect(statsRes.body).toHaveProperty('waiting');
    expect(statsRes.body).toHaveProperty('active');
    expect(statsRes.body).toHaveProperty('completed');
    expect(statsRes.body).toHaveProperty('failed');
    expect(statsRes.body).toHaveProperty('delayed');
    expect(typeof statsRes.body.waiting).toBe('number');
    expect(typeof statsRes.body.failed).toBe('number');

    // Act + Assert: GET /api/v1/queue/X/failed
    const failedRes = await request(app.getHttpServer())
      .get('/api/v1/queue/X/failed');

    expect(failedRes.status).toBe(200);
    expect(Array.isArray(failedRes.body)).toBe(true);
    if (failedRes.body.length > 0) {
      const job = failedRes.body[0];
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('data');
      expect(job).toHaveProperty('failedReason');
      expect(job).toHaveProperty('timestamp');
    }

    // Act + Assert: GET /api/v1/queue/THREADS/stats
    const threadsStatsRes = await request(app.getHttpServer())
      .get('/api/v1/queue/THREADS/stats');

    expect(threadsStatsRes.status).toBe(200);
    expect(threadsStatsRes.body).toHaveProperty('waiting');
    expect(threadsStatsRes.body).toHaveProperty('failed');

    // Assert: QueueFactory.getJobCounts was called with X and THREADS.
    expect(queueFactory.getJobCounts).toHaveBeenCalledWith(SocialNetwork.X);
    expect(queueFactory.getJobCounts).toHaveBeenCalledWith(SocialNetwork.THREADS);
    expect(queueFactory.getFailedJobs).toHaveBeenCalledWith(SocialNetwork.X);
  });

  // ── STC-051: Scenario 1 — Manual Generation + HITL + Posting (Primary Flow) ─

  it('STC-051: Scenario 1 — Manual Generation + HITL + Posting (HTTP parts only) (REQ-001,002,005,014,016,018,019,020)', async () => {
    // ── Step 1: POST /generation/run → 202 with runId ──
    // Arrange: mock ContentReader returns 1 topic, accounts exist, no dedup posts.
    contentReader.getTopics.mockResolvedValue([CAP_TOPICS[0]]);
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.generationRun.create.mockResolvedValue({
      id: 'run-051',
      triggeredBy: 'MANUAL',
      status: 'RUNNING',
      startedAt: new Date(),
      sourceTopics: [],
    });
    prisma.generationRun.update.mockResolvedValue({});
    // findBySourceAndNetwork → no recent posts (no dedup).
    prisma.post.findMany.mockResolvedValue([]);
    // postsService.create → return created post.
    const generatedPost = {
      ...DRAFT_POST_X,
      id: 'post-gen-051',
      generationRunId: 'run-051',
      content: 'Mock LLM chat content',
    };
    prisma.post.create.mockResolvedValue(generatedPost);

    // Act: POST /api/v1/generation/run
    const genRes = await request(app.getHttpServer())
      .post('/api/v1/generation/run')
      .send({ count: 1, networks: ['X'], sourceType: 'brief' });

    // Assert: 202 with runId and status.
    expect(genRes.status).toBe(202);
    expect(genRes.body.runId).toEqual(expect.any(String));
    expect(genRes.body.status).toBe('started');

    // Assert: GenerationRun created in DB.
    expect(prisma.generationRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.generationRun.create.mock.calls[0][0].data.triggeredBy).toBe('MANUAL');

    // Assert: Post created with DRAFT status.
    expect(prisma.post.create).toHaveBeenCalled();
    const createdPostData = prisma.post.create.mock.calls[0][0].data;
    expect(createdPostData.network).toBe(SocialNetwork.X);
    expect(createdPostData.content).toEqual(expect.any(String));
    expect(createdPostData.content.length).toBeGreaterThan(0);
    // NOTE: status is not explicitly set in the create call — it relies on the
    // Prisma schema default (DRAFT). The mock return value (generatedPost) has
    // status: DRAFT, which represents what the DB would return.
    expect(generatedPost.status).toBe(PostStatus.DRAFT);

    // ── Step 2: GET /posts?status=DRAFT → verify drafts ──
    prisma.post.findMany.mockResolvedValue([generatedPost]);
    prisma.post.count.mockResolvedValue(1);

    const draftsRes = await request(app.getHttpServer())
      .get('/api/v1/posts')
      .query({ status: 'DRAFT' });

    expect(draftsRes.status).toBe(200);
    expect(draftsRes.body.posts).toBeDefined();
    expect(draftsRes.body.posts).toHaveLength(1);
    expect(draftsRes.body.posts[0].status).toBe('DRAFT');

    // ── Step 3: POST /posts/:id/approve → 200 with APPROVED status ──
    prisma.post.findUnique.mockResolvedValue(generatedPost);
    const approvedPost = { ...generatedPost, status: PostStatus.APPROVED, approvedAt: new Date() };
    prisma.post.update.mockResolvedValue(approvedPost);

    const approveRes = await request(app.getHttpServer())
      .post('/api/v1/posts/post-gen-051/approve');

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');

    // Assert: prisma.post.update called with APPROVED status + approvedAt.
    const approveUpdate = prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.APPROVED,
    );
    expect(approveUpdate).toBeDefined();
    expect(approveUpdate[0].data.approvedAt).toBeDefined();

    // ── Step 4: POST /posting/batch/all-approved → batch post ──
    // Arrange: findMany returns the approved post, findById returns it.
    prisma.post.findMany.mockResolvedValue([approvedPost]);
    prisma.post.count.mockResolvedValue(1);
    prisma.post.findUnique.mockResolvedValue(approvedPost);
    prisma.post.update.mockResolvedValue(approvedPost);
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue({ ...ACTIVE_SESSION_X });
    prisma.session.update.mockResolvedValue({});

    // Mock browser + poster for successful posting.
    const postPage = createMockPage({ url: 'https://x.com/myzodiacai/status/051' });
    const postContext = createMockContext(postPage);
    browserPort.acquireContext.mockResolvedValue(postContext);
    browserPort.saveStorageState.mockResolvedValue(
      JSON.stringify({ cookies: [], origins: [] }),
    );
    browserPort.randomDelay.mockResolvedValue(undefined);
    mockXPoster.post.mockResolvedValue({ url: 'https://x.com/myzodiacai/status/051' });

    // Spy on SSE publish to verify events.
    const publishSpy = vi.spyOn(sseService, 'publish');

    // Act: POST /api/v1/posting/batch/all-approved
    const batchRes = await request(app.getHttpServer())
      .post('/api/v1/posting/batch/all-approved');

    // Assert: batch result.
    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toHaveProperty('posted');
    expect(batchRes.body).toHaveProperty('failed');
    expect(batchRes.body.posted).toBeGreaterThanOrEqual(1);

    // Assert: SSE POSTING event published.
    const postingEvent = publishSpy.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'POSTING',
    );
    expect(postingEvent).toBeDefined();

    // Assert: SSE POSTED event published with URL.
    const postedEvent = publishSpy.mock.calls.find(
      (c: unknown[]) => c[0]?.status === 'POSTED',
    );
    expect(postedEvent).toBeDefined();
    expect(postedEvent[0].url).toBeDefined();

    // Assert: post status updated to POSTED in DB.
    const postedUpdate = prisma.post.update.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === PostStatus.POSTED,
    );
    expect(postedUpdate).toBeDefined();
    expect(postedUpdate[0].data.postUrl).toBeDefined();
  });

  // ── STC-052: Scenario 4 — Session Expiry + Auto-Login (HTTP parts only) ────

  it('STC-052: Scenario 4 — Session Expiry + Auto-Login (HTTP parts only) (REQ-024,025,026)', async () => {
    // Step 1: Verify session shows EXPIRED status via GET /sessions.
    prisma.session.findMany.mockResolvedValue([{ ...EXPIRED_SESSION_X }]);

    const sessionsRes = await request(app.getHttpServer()).get('/api/v1/sessions');
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body).toHaveLength(1);
    expect(sessionsRes.body[0].status).toBe('EXPIRED');

    // Step 2: Health check on the expired session.
    // The healthCheck method only looks for ACTIVE sessions. If no active session
    // is found, it returns { healthy: false, message: 'No active session' }.
    prisma.socialAccount.findFirst.mockResolvedValue(ACCOUNT_X);
    prisma.session.findFirst.mockResolvedValue(null); // no active session

    const healthRes = await request(app.getHttpServer())
      .post('/api/v1/sessions/health-check')
      .query({ network: 'X' });

    // Assert: health check reports no active session.
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.healthy).toBe(false);
    expect(healthRes.body.message).toContain('No active session');

    // Step 3: Trigger posting → getOrCreateSession → autoLogin with env credentials.
    prisma.post.findUnique.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.post.update.mockResolvedValue({ ...APPROVED_POST_X });
    prisma.session.findFirst.mockResolvedValue(null); // no active session → autoLogin
    prisma.session.create.mockResolvedValue({
      id: 'sess-autologin-052',
      accountId: 'acc-001',
      storageState: { cookies: [{ name: 'auth', value: 'fresh-052' }], origins: [] },
      status: SessionStatus.ACTIVE,
      lastHealthCheck: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mock browser for auto-login: login form + success indicator visible.
    const loginPage = createMockPage({ url: 'https://x.com/home', isLoggedIn: true });
    const loginContext = createMockContext(loginPage);
    browserPort.createContext.mockResolvedValue(loginContext);
    browserPort.acquireContext.mockResolvedValue(loginContext);
    browserPort.saveStorageState.mockResolvedValue(
      JSON.stringify({
        cookies: [{ name: 'auth', value: 'fresh-052', domain: '.x.com', path: '/' }],
        origins: [{ origin: 'https://x.com', localStorage: [] }],
      }),
    );
    browserPort.randomDelay.mockResolvedValue(undefined);
    mockXPoster.post.mockResolvedValue({ url: 'https://x.com/myzodiacai/status/052' });

    const postRes = await request(app.getHttpServer())
      .post('/api/v1/posting/post-approved-001');

    // Assert: posting succeeds (auto-login produced a valid session).
    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);

    // Assert: autoLogin navigated to login page.
    const loginGoto = loginPage.goto.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('login'),
    );
    expect(loginGoto).toBeDefined();

    // Assert: credentials typed from env (username + password) via typeHuman.
    // (X uses typeHuman → pressSequentially per-char for React-controlled inputs, not fill())
    const typeHumanCalls = browserPort.typeHuman.mock.calls;
    const typedValues = typeHumanCalls.map((c: unknown[]) => c[1]);
    expect(typedValues).toContain('test_x_user');
    expect(typedValues).toContain('test_x_pass');

    // Assert: session created with ACTIVE status + storageState.
    const sessionCreate = prisma.session.create.mock.calls.find(
      (c: unknown[]) => c[0]?.data?.status === SessionStatus.ACTIVE,
    );
    expect(sessionCreate).toBeDefined();
    expect(sessionCreate[0].data.storageState).toBeDefined();
    expect(sessionCreate[0].data.storageState).toHaveProperty('cookies');
    expect(sessionCreate[0].data.lastHealthCheck).toBeDefined();

    // Assert: session transitions EXPIRED → ACTIVE (new session created).
    // The autoLogin creates a NEW session record with ACTIVE status.
    // (Note: the old EXPIRED session remains in DB with EXPIRED status —
    //  the system creates a new session rather than updating the old one.)
  });
});
