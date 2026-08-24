import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowsingSessionStatus,
  InteractionType,
  PostStatus,
  SessionStatus,
  SocialNetwork,
} from "../../../src/generated/prisma/client.js";
import { StateCollectorService } from "../../../src/modules/orchestrator/state-collector.service.js";

type MockConfig = {
  get: ReturnType<typeof vi.fn>;
};

type MockDependencies = {
  prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  config: MockConfig;
  rateLimitService: { getStatus: ReturnType<typeof vi.fn> };
  flowControlService: { getStatus: ReturnType<typeof vi.fn> };
  queueFactory: {
    getJobCounts: ReturnType<typeof vi.fn>;
    getFailedJobs: ReturnType<typeof vi.fn>;
  };
  accountsService: { findFirstActiveByNetwork: ReturnType<typeof vi.fn> };
};

const originalEnabledNetworks = process.env.ENABLED_NETWORKS;

function modelMock() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
}

function buildService(overrides: Partial<MockDependencies> = {}): {
  service: StateCollectorService;
  deps: MockDependencies;
} {
  const config: MockConfig = {
    get: vi.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        TOPIC_POOL_MIN: "4",
        F1_BROWSING_SESSIONS_PER_DAY: "2",
        F1_COMMENTS_MAX_PER_DAY: "3",
        F1_LIKES_MAX_PER_DAY: "4",
        F1_BROWSING_SESSION_MINUTES: "15",
        BAN_DETECTION_WINDOW_HOURS: "2",
      };
      return key in values ? values[key] : fallback;
    }),
  };

  const deps: MockDependencies = {
    prisma: {
      topic: modelMock(),
      post: modelMock(),
      socialAccount: modelMock(),
      session: modelMock(),
      postMetrics: modelMock(),
      browsingSession: modelMock(),
      incomingComment: modelMock(),
      interaction: modelMock(),
    },
    config,
    rateLimitService: { getStatus: vi.fn() },
    flowControlService: { getStatus: vi.fn() },
    queueFactory: {
      getJobCounts: vi.fn(),
      getFailedJobs: vi.fn(),
    },
    accountsService: { findFirstActiveByNetwork: vi.fn() },
    ...overrides,
  };

  const service = new StateCollectorService(
    deps.prisma as never,
    deps.config as never,
    {} as never,
    deps.rateLimitService as never,
    deps.flowControlService as never,
    deps.queueFactory as never,
    deps.accountsService as never,
  );

  return { service, deps };
}

function account(id: string, network: SocialNetwork, handle: string) {
  const now = Date.now();
  return {
    id,
    network,
    handle,
    displayName: `${network} ${handle}`,
    priority: 0,
    active: true,
    warmupEnabled: false,
    warmupStartedAt: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

function invokePrivate<T>(service: StateCollectorService, method: string, ...args: unknown[]) {
  return (service as unknown as Record<string, (...params: unknown[]) => Promise<T>>)[method](
    ...args,
  );
}

describe("StateCollectorService", () => {
  beforeEach(() => {
    process.env.ENABLED_NETWORKS = "X,THREADS";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnabledNetworks === undefined) delete process.env.ENABLED_NETWORKS;
    else process.env.ENABLED_NETWORKS = originalEnabledNetworks;
  });

  it("builds a complete WorldState from content, account, queue, health, and engagement sources", async () => {
    const now = Date.now();
    const xAccount = account("acc-x", SocialNetwork.X, "x_writer");
    const threadsAccount = account("acc-threads", SocialNetwork.THREADS, "threads_writer");
    const accounts = [xAccount, threadsAccount];
    const { service, deps } = buildService();

    deps.prisma.topic.count.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
      args.where?.sourceType === "trending" ? 2 : 5,
    );
    deps.prisma.topic.findFirst.mockImplementation(
      async (args: { where?: Record<string, unknown> }) => ({
        createdAt:
          args.where?.sourceType === "trending"
            ? new Date(now - 30 * 60 * 1000)
            : new Date(now - 2 * 60 * 60 * 1000),
      }),
    );
    deps.prisma.post.count.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      switch (args.where?.status) {
        case PostStatus.DRAFT:
          return 3;
        case PostStatus.APPROVED:
          return args.where.network === undefined
            ? 2
            : args.where.network === SocialNetwork.X
              ? 2
              : 1;
        case PostStatus.REJECTED:
          return 1;
        case PostStatus.POSTING:
          return 2;
        default:
          return 0;
      }
    });
    deps.prisma.socialAccount.findMany.mockResolvedValue(accounts);
    deps.prisma.session.findMany.mockResolvedValue([
      {
        accountId: xAccount.id,
        status: SessionStatus.ACTIVE,
        lastHealthCheck: new Date(now - 1000),
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      },
    ]);
    deps.prisma.post.findMany.mockImplementation(
      async (args: { where?: Record<string, unknown> }) =>
        args.where?.accountId
          ? [{ accountId: xAccount.id, status: PostStatus.COMPLETED }]
          : Array.from({ length: 5 }, () => ({ status: PostStatus.FAILED })),
    );
    deps.prisma.postMetrics.findMany.mockImplementation(
      async (args: { where?: { post?: { network?: SocialNetwork } } }) =>
        args.where?.post?.network === SocialNetwork.X
          ? [
              {
                likes: 2,
                comments: 1,
                shares: 0,
                impressions: 100,
                collectedAt: new Date(now),
                post: { postedAt: new Date("2026-08-23T09:00:00.000Z") },
              },
              {
                likes: 1,
                comments: 0,
                shares: 1,
                impressions: null,
                collectedAt: new Date(now - 60_000),
                post: { postedAt: new Date("2026-08-23T11:00:00.000Z") },
              },
            ]
          : [],
    );
    deps.prisma.browsingSession.findFirst.mockResolvedValue({
      startedAt: new Date(now - 6 * 60 * 60 * 1000),
      endedAt: new Date(now - 5 * 60 * 60 * 1000),
      status: BrowsingSessionStatus.COMPLETED,
      interactionsCount: 7,
    });
    deps.prisma.browsingSession.count.mockResolvedValue(1);
    deps.prisma.incomingComment.count.mockResolvedValue(3);
    deps.prisma.interaction.count.mockImplementation(
      async (args: { where?: { type?: InteractionType } }) =>
        args.where?.type === InteractionType.COMMENT ? 4 : 7,
    );
    deps.rateLimitService.getStatus.mockImplementation(
      async (_network: SocialNetwork, accountId?: string) => ({
        dailyCount: accountId === xAccount.id ? 1 : 0,
        dailyLimit: 2,
        weeklyCount: accountId === xAccount.id ? 2 : 0,
        weeklyLimit: 5,
        minIntervalMs: 300_000,
        lastPostAt: accountId === xAccount.id ? now - 10_000 : null,
      }),
    );
    deps.queueFactory.getJobCounts.mockImplementation(
      async (_network: SocialNetwork, _action: string, accountId?: string) =>
        accountId
          ? { waiting: accountId === xAccount.id ? 2 : 1, active: 0, delayed: 0 }
          : {
              waiting: 3,
              active: 1,
              delayed: 0,
            },
    );
    deps.queueFactory.getFailedJobs.mockResolvedValue([
      { failedReason: "Rate limited: retry later" },
      { failedReason: "browser crashed" },
    ]);
    deps.accountsService.findFirstActiveByNetwork.mockImplementation(
      async (network: SocialNetwork) => (network === SocialNetwork.X ? xAccount : threadsAccount),
    );
    deps.flowControlService.getStatus.mockResolvedValue({
      pauseAll: false,
      flows: {
        generation: true,
        posting: false,
        engagement: true,
        replies: false,
        llm_triage: true,
        auto_approve: false,
      },
    });

    const snapshot = await service.collectWorldState();

    expect(snapshot.topicPool).toMatchObject({ count: 5, threshold: 4 });
    expect(snapshot.topicPool.oldestAgeMs).toBeGreaterThan(60 * 60 * 1000);
    expect(snapshot.drafts).toEqual({
      pending: 3,
      approved: 2,
      rejected: 1,
      approvedByNetwork: { X: 2, THREADS: 1 },
    });
    expect(snapshot.queueDepth).toEqual({ X: 4, THREADS: 4 });
    expect(snapshot.queueDepthByAccount).toEqual({ "X:acc-x": 2, "THREADS:acc-threads": 1 });
    expect(snapshot.sessions.X).toMatchObject({
      status: SessionStatus.ACTIVE,
      circuitBreaker: "closed",
    });
    expect(snapshot.rateLimits.X).toMatchObject({
      dailyRemaining: 1,
      weeklyRemaining: 3,
      lastPostMs: now - 10_000,
    });
    expect(snapshot.performance.X).toMatchObject({
      recentAvgEngagement: 4,
      bestHours: [9, 11],
      lastPostMetrics: { impressions: 100, likes: 2, comments: 1, shares: 0 },
    });
    expect(snapshot.engagement).toMatchObject({
      uncheckedReplies: 3,
      engagementDebt: 2,
      commentsTargetToday: 6,
      commentsActualToday: 4,
      likesTargetToday: 8,
      likesActualToday: 7,
      debt: 2,
    });
    expect(snapshot.health).toEqual({
      bans: 2,
      dlqDepth: 2,
      stuckPosting: 2,
      stuckBrowsingSessions: 1,
      orphanedPosts: 0,
      killSwitch: false,
    });
    expect(snapshot.flowControl).toEqual({
      pauseAll: false,
      pauseGeneration: true,
      pausePosting: false,
      pauseEngagement: true,
      pauseReplies: false,
      pauseLlmTriage: true,
      pauseAutoApprove: false,
    });
    expect(snapshot.trends).toMatchObject({ count: 2 });
    expect(snapshot._degraded).toEqual([]);
    expect(snapshot._collectedAt).toBeGreaterThan(0);
  });

  it("keeps OBSERVE alive with explicit degraded fields when critical sources fail", async () => {
    const resilience = {
      runDueProbes: vi.fn().mockRejectedValue(new Error("probe unavailable")),
    };
    const feedbackSync = {
      syncIfDue: vi.fn().mockRejectedValue(new Error("sync unavailable")),
    };
    const { deps } = buildService();
    deps.prisma.topic.count.mockRejectedValue(new Error("topic db down"));
    deps.prisma.topic.findFirst.mockRejectedValue(new Error("topic db down"));
    deps.prisma.post.count.mockRejectedValue(new Error("post db down"));
    deps.prisma.socialAccount.findMany.mockRejectedValue(new Error("account db down"));
    deps.flowControlService.getStatus.mockRejectedValue(new Error("flow state unavailable"));

    const service = new StateCollectorService(
      deps.prisma as never,
      deps.config as never,
      {} as never,
      deps.rateLimitService as never,
      deps.flowControlService as never,
      deps.queueFactory as never,
      deps.accountsService as never,
      resilience as never,
      feedbackSync as never,
    );

    const snapshot = await service.collectWorldState();

    expect(resilience.runDueProbes).toHaveBeenCalledOnce();
    expect(feedbackSync.syncIfDue).toHaveBeenCalledOnce();
    expect(snapshot._degraded).toEqual(
      expect.arrayContaining(["topicPool", "drafts", "queueDepth", "rateLimits", "flowControl"]),
    );
    expect(snapshot.topicPool).toEqual({ count: 0, threshold: 4, oldestAgeMs: 0 });
    expect(snapshot.drafts).toMatchObject({ pending: 0, approved: 0, rejected: 0 });
    expect(snapshot.queueDepth).toEqual({});
    expect(snapshot.rateLimits).toEqual({});
    expect(snapshot.flowControl).toEqual({
      pauseAll: false,
      pauseGeneration: false,
      pausePosting: false,
      pauseEngagement: false,
      pauseReplies: false,
      pauseLlmTriage: false,
      pauseAutoApprove: false,
    });
  });

  it("uses network-level rate limits and queue counts when no account is active", async () => {
    const { service, deps } = buildService();
    deps.prisma.socialAccount.findMany.mockResolvedValue([]);
    deps.queueFactory.getJobCounts.mockResolvedValue({ waiting: 1, active: 2, delayed: 3 });
    deps.rateLimitService.getStatus.mockResolvedValue({
      dailyCount: 2,
      dailyLimit: 5,
      weeklyCount: 4,
      weeklyLimit: 10,
      minIntervalMs: 300_000,
      lastPostAt: 123,
    });

    const queue = await invokePrivate<Record<string, unknown>>(service, "collectQueueDepth", ["X"]);
    const limits = await invokePrivate<Record<string, unknown>>(service, "collectRateLimits", [
      "X",
    ]);

    expect(queue).toEqual({ byNetwork: { X: 6 }, byAccount: {} });
    expect(limits).toEqual({
      byNetwork: {
        X: {
          dailyRemaining: 3,
          weeklyRemaining: 6,
          dailyLimit: 5,
          weeklyLimit: 10,
          minIntervalMs: 300_000,
          lastPostMs: 123,
        },
      },
      byAccount: {},
    });
    expect(deps.rateLimitService.getStatus).toHaveBeenCalledWith("X");
  });

  it("fails closed for isolated collector errors and filters terminal rate-limit jobs", async () => {
    const { service, deps } = buildService();
    deps.prisma.postMetrics.findMany.mockRejectedValue(new Error("metrics unavailable"));
    deps.prisma.browsingSession.findFirst.mockRejectedValue(new Error("session unavailable"));
    deps.prisma.incomingComment.count.mockRejectedValue(new Error("comments unavailable"));
    deps.prisma.interaction.count.mockRejectedValue(new Error("interactions unavailable"));
    deps.queueFactory.getFailedJobs.mockResolvedValue([
      { failedReason: "Rate limited: daily cap" },
      { failedReason: "unexpected browser error" },
    ]);
    deps.prisma.post.findMany.mockResolvedValue([]);

    const performance = await invokePrivate<Record<string, unknown>>(
      service,
      "collectPerformance",
      [SocialNetwork.X],
    );
    const engagement = await invokePrivate<Record<string, unknown>>(service, "collectEngagement", [
      SocialNetwork.X,
    ]);
    const health = await invokePrivate<Record<string, unknown>>(service, "collectHealth", [
      SocialNetwork.X,
    ]);

    expect(performance).toEqual({ X: { recentAvgEngagement: 0, bestHours: [] } });
    expect(engagement).toMatchObject({
      uncheckedReplies: 0,
      lastBrowseMs: { X: 0 },
      warmupPhase: { X: "unknown" },
      debt: 6,
    });
    expect(health).toMatchObject({ bans: 0, dlqDepth: 1 });
  });
});
