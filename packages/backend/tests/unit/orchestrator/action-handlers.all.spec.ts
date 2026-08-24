import { describe, expect, it, vi } from "vitest";
import { ModuleRef } from "@nestjs/core";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import {
  AggregateHooksHandler,
  BrowseHandler,
  CheckRepliesHandler,
  GenerateTopicsHandler,
  HealthCheckHandler,
  PostHandler,
  ReconcileHandler,
  RecycleContentHandler,
  RecoverSessionHandler,
  RefreshTrendsHandler,
  ScrapeMetricsHandler,
  TriageQueueHandler,
} from "../../../src/modules/orchestrator/action-handlers.js";
import { TopicGenerationService } from "../../../src/infrastructure/content/topic-generation.service.js";
import { GenerationService } from "../../../src/modules/generation/generation.service.js";
import { AccountsService } from "../../../src/modules/accounts/accounts.service.js";
import { RateLimitService } from "../../../src/modules/rate-limit/rate-limit.service.js";
import { QueueService } from "../../../src/modules/queue/queue.service.js";
import { SessionsService } from "../../../src/modules/sessions/sessions.service.js";
import { HealthMonitorService } from "../../../src/modules/health-monitor/health-monitor.service.js";
import { TrendingScraperService } from "../../../src/modules/trending/trending-scraper.service.js";
import { MetricsScraperService } from "../../../src/modules/analytics/metrics-scraper.service.js";
import { RecyclingService } from "../../../src/modules/recycling/recycling.service.js";
import { HookPerformanceBank } from "../../../src/modules/content-enhancements/hook-performance-bank.js";
import { QueueTriageService } from "../../../src/modules/queue/queue-triage.service.js";
import { createMockConfigService } from "../../mocks/index.js";

function moduleRef(services: Map<unknown, unknown>): ModuleRef {
  return {
    get: vi.fn((token: unknown) => services.get(token) ?? null),
  } as unknown as ModuleRef;
}

function prisma(overrides: Record<string, unknown> = {}) {
  return {
    post: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      ...overrides,
    },
  } as never;
}

const noNetwork = {
  type: "GENERATE_TOPICS" as const,
  reason: "test",
  source: "hard_rule" as const,
};
const xAction = {
  type: "POST" as const,
  network: SocialNetwork.X,
  reason: "test",
  source: "hard_rule" as const,
};

describe("orchestrator action handlers — strategy contracts", () => {
  it("GenerateTopicsHandler delegates the configured batch size", async () => {
    const topicService = { generateBatch: vi.fn().mockResolvedValue(7) };
    const handler = new GenerateTopicsHandler(
      createMockConfigService({ TOPIC_BATCH_SIZE: "7" }),
      moduleRef(new Map([[TopicGenerationService, topicService]])),
      prisma(),
    );

    await expect(handler.execute(noNetwork)).resolves.toEqual({ topicsGenerated: 7 });
    expect(topicService.generateBatch).toHaveBeenCalledWith(7);
  });

  it("GenerateTopicsHandler fails closed when its optional service is absent", async () => {
    const handler = new GenerateTopicsHandler(
      createMockConfigService(),
      moduleRef(new Map()),
      prisma(),
    );
    await expect(handler.execute(noNetwork)).rejects.toThrow(
      "TopicGenerationService not available",
    );
  });

  it("PostHandler returns a no-op when no approved draft exists", async () => {
    const handler = new PostHandler(createMockConfigService(), moduleRef(new Map()), prisma());
    await expect(handler.execute(xAction)).resolves.toEqual({
      enqueued: false,
      reason: "No approved drafts for this network",
    });
  });

  it("PostHandler enqueues the oldest approved post with bounded delay", async () => {
    const post = { id: "post-1", accountId: "acc-1" };
    const queue = { enqueuePosting: vi.fn().mockResolvedValue(undefined) };
    const db = prisma({ findFirst: vi.fn().mockResolvedValue(post) });
    const handler = new PostHandler(
      createMockConfigService({
        AUTONOMOUS_POSTING_DELAY_MIN_MS: "100",
        AUTONOMOUS_POSTING_DELAY_MAX_MS: "200",
      }),
      moduleRef(new Map([[QueueService, queue]])),
      db,
    );
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    await expect(handler.execute(xAction)).resolves.toEqual({
      enqueued: true,
      postId: "post-1",
      delayMs: 150,
    });
    expect(queue.enqueuePosting).toHaveBeenCalledWith(
      "post-1",
      SocialNetwork.X,
      { delay: 150 },
      "acc-1",
    );
    vi.restoreAllMocks();
  });

  it("network handlers reject actions that omit their required network", async () => {
    const handlers = [
      new PostHandler(createMockConfigService(), moduleRef(new Map()), prisma()),
      new BrowseHandler(createMockConfigService()),
      new RecoverSessionHandler(moduleRef(new Map())),
    ];
    for (const handler of handlers) {
      await expect(handler.execute(noNetwork)).rejects.toThrow(/requires network/);
    }
  });

  it("BrowseHandler reports disabled engagement and delegates enabled browsing", async () => {
    const disabled = new BrowseHandler(createMockConfigService());
    await expect(
      disabled.execute({ type: "BROWSE", network: SocialNetwork.X, ...noNetwork }),
    ).resolves.toEqual({
      browsed: false,
      reason: "Engagement module not enabled",
    });

    const browsing = {
      runBrowsingSession: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-1", interactionsCount: 3 }),
    };
    const enabled = new BrowseHandler(
      createMockConfigService({ F1_BROWSING_SESSION_MINUTES: "2" }),
      browsing as never,
    );
    await expect(
      enabled.execute({ type: "BROWSE", network: SocialNetwork.X, ...noNetwork }),
    ).resolves.toEqual({
      browsed: true,
      sessionId: "session-1",
      interactions: 3,
    });
    expect(browsing.runBrowsingSession).toHaveBeenCalledWith(SocialNetwork.X, 120, undefined);
  });

  it("RecoverSessionHandler uses the account-aware recovery path when available", async () => {
    const sessions = { getOrCreateSession: vi.fn().mockResolvedValue({ status: "ACTIVE" }) };
    const accounts = { getNextAccountForNetwork: vi.fn().mockResolvedValue({ id: "acc-1" }) };
    const handler = new RecoverSessionHandler(
      moduleRef(
        new Map([
          [SessionsService, sessions],
          [AccountsService, accounts],
        ]),
      ),
    );

    await expect(
      handler.execute({ type: "RECOVER_SESSION", network: SocialNetwork.X, ...noNetwork }),
    ).resolves.toEqual({
      recovered: true,
      sessionStatus: "ACTIVE",
    });
    expect(sessions.getOrCreateSession).toHaveBeenCalledWith("acc-1", SocialNetwork.X, {
      deferFormLogin: true,
    });
  });

  it("CheckRepliesHandler reports disabled and enabled monitoring paths", async () => {
    const disabled = new CheckRepliesHandler();
    await expect(disabled.execute(noNetwork)).resolves.toEqual({
      checked: false,
      reason: "Replies module not enabled",
    });

    const monitor = {
      runMonitoringCycle: vi.fn().mockResolvedValue({
        postsChecked: 2,
        commentsScraped: 5,
        repliesPosted: 1,
        repliesScheduled: 2,
        humanReview: 1,
      }),
    };
    const enabled = new CheckRepliesHandler(monitor as never);
    await expect(enabled.execute(noNetwork)).resolves.toEqual({
      checked: true,
      postsChecked: 2,
      commentsScraped: 5,
      repliesPosted: 1,
      repliesScheduled: 2,
      humanReview: 1,
    });
  });

  it("RefreshTrendsHandler, ScrapeMetricsHandler, RecycleContentHandler and AggregateHooksHandler expose service results", async () => {
    const trends = {
      getGoogleTrends: vi.fn().mockResolvedValue([{}, {}]),
      getXTrends: vi.fn().mockResolvedValue([{}]),
    };
    const metrics = {
      collectMetrics: vi.fn().mockResolvedValue({ collected: 3, failed: 1, skipped: 2 }),
    };
    const recycling = { runRecycling: vi.fn().mockResolvedValue({ recycled: 4, skipped: 1 }) };
    const hookBank = { aggregateStats: vi.fn().mockResolvedValue(undefined) };
    const services = new Map([
      [TrendingScraperService, trends],
      [MetricsScraperService, metrics],
      [RecyclingService, recycling],
      [HookPerformanceBank, hookBank],
    ]);
    const ref = moduleRef(services);

    await expect(new RefreshTrendsHandler(ref).execute(noNetwork)).resolves.toEqual({
      refreshed: true,
      googleTrends: 2,
      xTrends: 1,
    });
    await expect(new ScrapeMetricsHandler(ref).execute(noNetwork)).resolves.toEqual({
      scraped: true,
      collected: 3,
      failed: 1,
      skipped: 2,
    });
    await expect(new RecycleContentHandler(ref).execute(noNetwork)).resolves.toEqual({
      recycled: 4,
      skipped: 1,
    });
    await expect(new AggregateHooksHandler(ref).execute(noNetwork)).resolves.toEqual({
      aggregated: true,
    });
    expect(hookBank.aggregateStats).toHaveBeenCalledOnce();
  });

  it("RefreshTrendsHandler degrades individual provider failures to empty counts", async () => {
    const trends = {
      getGoogleTrends: vi.fn().mockRejectedValue(new Error("google down")),
      getXTrends: vi.fn().mockResolvedValue([]),
    };
    const handler = new RefreshTrendsHandler(
      moduleRef(new Map([[TrendingScraperService, trends]])),
    );
    await expect(handler.execute(noNetwork)).resolves.toEqual({
      refreshed: true,
      googleTrends: 0,
      xTrends: 0,
    });
  });

  it("HealthCheckHandler and ReconcileHandler return monitor summaries", async () => {
    const health = {
      runHealthCheck: vi.fn().mockResolvedValue({ alerts: 2 }),
      runReconciliation: vi.fn().mockResolvedValue({ requeued: 3, skipped: 1, deduplicated: 2 }),
      reapStuckBrowsingSessions: vi.fn().mockResolvedValue({ reaped: 4 }),
      reapStuckPosting: vi.fn().mockResolvedValue({ reaped: 5 }),
    };
    const ref = moduleRef(new Map([[HealthMonitorService, health]]));
    await expect(new HealthCheckHandler(ref).execute(noNetwork)).resolves.toEqual({
      report: { alerts: 2 },
    });
    await expect(new ReconcileHandler(ref).execute(noNetwork)).resolves.toEqual({
      requeued: 3,
      skipped: 1,
      deduplicated: 2,
      reapedBrowsingSessions: 4,
      reapedStuckPosting: 5,
    });
  });

  it("TriageQueueHandler handles disabled, aggregate and error paths", async () => {
    const triage = {
      triageAll: vi.fn().mockResolvedValue([
        {
          examined: 2,
          retried: 1,
          requeuedDelayed: 0,
          rejected: 0,
          escalated: 1,
          skipped: 0,
          errors: 0,
        },
        {
          examined: 1,
          retried: 0,
          requeuedDelayed: 1,
          rejected: 1,
          escalated: 0,
          skipped: 1,
          errors: 1,
        },
      ]),
    };
    const disabled = new TriageQueueHandler(triage as never, createMockConfigService());
    await expect(disabled.execute(noNetwork)).resolves.toEqual({
      triaged: false,
      reason: "LLM_QUEUE_TRIAGE_ENABLED=false",
    });

    const enabled = new TriageQueueHandler(
      triage as never,
      createMockConfigService({ LLM_QUEUE_TRIAGE_ENABLED: "true" }),
    );
    const result = await enabled.execute(noNetwork);
    expect(result).toMatchObject({ triaged: true });
    expect(result.totals).toEqual({
      examined: 3,
      retried: 1,
      requeuedDelayed: 1,
      rejected: 1,
      escalated: 1,
      skipped: 1,
      errors: 1,
    });

    triage.triageAll.mockRejectedValue(new Error("triage down"));
    await expect(enabled.execute(noNetwork)).resolves.toEqual({
      triaged: false,
      reason: "triage down",
    });
  });
});
