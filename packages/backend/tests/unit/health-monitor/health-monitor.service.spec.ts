/**
 * F21: HealthMonitorService unit tests.
 *
 * Tests ban detection, reconciliation (B3), DLQ health, health check,
 * and ban recovery (Sprint K).
 *
 * Source: packages/backend/src/modules/health-monitor/health-monitor.service.ts
 * Traces to: REQ-F21, REQ-B3
 *
 * Mocked dependencies:
 *   - PrismaService (post, session models)
 *   - SseService (publish)
 *   - QueueService (enqueuePosting, getJobCounts)
 *   - QueueFactory (getQueue → BullMQ Queue with getJob)
 *   - ConfigService (ban threshold, schedules)
 *   - SchedulerRegistry (addCronJob)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PostStatus, SessionStatus, SocialNetwork } from '@prisma/client';

import { HealthMonitorService } from '../../../src/modules/health-monitor/health-monitor.service';

// ── Mock Factories ───────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    post: {
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    session: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
}

function createMockSseService() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDiscordNotificationService() {
  return {
    sendAlert: vi.fn().mockResolvedValue(undefined),
    sendCritical: vi.fn().mockResolvedValue(undefined),
    critical: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockQueueService() {
  return {
    enqueuePosting: vi.fn().mockResolvedValue(undefined),
    getJobCounts: vi.fn(),
  };
}

function createMockQueue() {
  return {
    getJob: vi.fn(),
  };
}

function createMockQueueFactory(queue: ReturnType<typeof createMockQueue>) {
  return {
    getQueue: vi.fn().mockReturnValue(queue),
  };
}

function createMockSchedulerRegistry() {
  return {
    addCronJob: vi.fn(),
  };
}

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    HEALTH_MONITOR_BAN_THRESHOLD: 5,
    HEALTH_MONITOR_SCHEDULE: '0 * * * *',
    RECONCILIATION_SCHEDULE: '30 * * * *',
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

// ── Test Context ─────────────────────────────────────────────────────────────

interface TestContext {
  service: HealthMonitorService;
  configService: ConfigService;
  prisma: ReturnType<typeof createMockPrisma>;
  sseService: ReturnType<typeof createMockSseService>;
  discord: ReturnType<typeof createMockDiscordNotificationService>;
  queueService: ReturnType<typeof createMockQueueService>;
  queue: ReturnType<typeof createMockQueue>;
  queueFactory: ReturnType<typeof createMockQueueFactory>;
  schedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>;
}

function buildContext(overrides?: Record<string, unknown>): TestContext {
  const prisma = createMockPrisma();
  const sseService = createMockSseService();
  const discord = createMockDiscordNotificationService();
  const queueService = createMockQueueService();
  const queue = createMockQueue();
  const queueFactory = createMockQueueFactory(queue);
  const schedulerRegistry = createMockSchedulerRegistry();
  const configService = createMockConfigService(overrides);

  const service = new HealthMonitorService(
    prisma as never,
    sseService as never,
    discord as never,
    queueService as never,
    queueFactory as never,
    configService,
    schedulerRegistry as never,
  );

  return {
    service,
    configService,
    prisma,
    sseService,
    discord,
    queueService,
    queue,
    queueFactory,
    schedulerRegistry,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A post count mock that resolves every call to 0. */
function postCountAllZero(prisma: ReturnType<typeof createMockPrisma>) {
  prisma.post.count.mockResolvedValue(0);
}

/** A post count mock that inspects the `where.status` clause to return per-status counts. */
function postCountByStatus(prisma: ReturnType<typeof createMockPrisma>, map: Partial<Record<PostStatus, number>>) {
  prisma.post.count.mockImplementation((args: { where: { status: PostStatus; approvedAt?: unknown } }) => {
    if (args.where.approvedAt) {
      // stuckPosting query — always 0 unless explicitly overridden via 'stuckPosting' key
      return Promise.resolve(0);
    }
    return Promise.resolve(map[args.where.status] ?? 0);
  });
}

/** Set up queueService.getJobCounts to return per-network counts. */
function queueCountsByNetwork(
  queueService: ReturnType<typeof createMockQueueService>,
  map: Partial<Record<SocialNetwork, { failed: number; active: number; waiting: number }>>,
) {
  queueService.getJobCounts.mockImplementation((network: SocialNetwork) =>
    Promise.resolve(map[network] ?? { failed: 0, active: 0, waiting: 0 }),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HealthMonitorService (F21 — Health Monitor + B3 Reconciliation)', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = buildContext();
  });

  // ── B3: Reconciliation ─────────────────────────────────────────────────────

  it('B3-001: runReconciliation() returns empty result when no APPROVED posts', async () => {
    ctx.prisma.post.findMany.mockResolvedValue([]);

    const result = await ctx.service.runReconciliation();

    expect(result).toEqual({ requeued: 0, skipped: 0, deduplicated: 0 });
    expect(ctx.queueService.enqueuePosting).not.toHaveBeenCalled();
    expect(ctx.sseService.publish).not.toHaveBeenCalled();
  });

  it('B3-002: runReconciliation() skips recently approved posts (< 10 min)', async () => {
    const recentPost = {
      id: 'post-1',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(), // just now
      createdAt: new Date(),
    };
    ctx.prisma.post.findMany.mockResolvedValue([recentPost]);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.deduplicated).toBe(0);
    expect(ctx.queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-003: runReconciliation() re-enqueues stuck posts (> 10 min)', async () => {
    const stuckPost = {
      id: 'post-stuck',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue(null); // no existing job

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(result.skipped).toBe(0);
    expect(ctx.queueService.enqueuePosting).toHaveBeenCalledWith('post-stuck', SocialNetwork.X);
  });

  it('B3-004: runReconciliation() deduplicates — skips posts with active BullMQ job', async () => {
    const stuckPost = {
      id: 'post-dup',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('active'),
    });

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(ctx.queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-005: runReconciliation() deduplicates — skips posts with waiting BullMQ job', async () => {
    const stuckPost = {
      id: 'post-waiting',
      network: SocialNetwork.THREADS,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 15 * 60 * 1000),
      createdAt: new Date(Date.now() - 15 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(ctx.queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-006: runReconciliation() deduplicates — skips posts with delayed BullMQ job', async () => {
    const stuckPost = {
      id: 'post-delayed',
      network: SocialNetwork.FACEBOOK,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(ctx.queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-007: runReconciliation() re-enqueues when existing job is completed/failed', async () => {
    const stuckPost = {
      id: 'post-completed',
      network: SocialNetwork.FACEBOOK,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
    });

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(ctx.queueService.enqueuePosting).toHaveBeenCalledWith('post-completed', SocialNetwork.FACEBOOK);
  });

  it('B3-008: runReconciliation() publishes SSE reconciliation_requeue event on re-enqueue', async () => {
    const stuckPost = {
      id: 'post-sse',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue(null);

    await ctx.service.runReconciliation();

    expect(ctx.sseService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation_requeue',
        postId: 'post-sse',
        network: SocialNetwork.X,
      }),
    );
  });

  it('B3-009: runReconciliation() continues on enqueue failure (does not throw)', async () => {
    const stuckPost = {
      id: 'post-fail',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue(null);
    ctx.queueService.enqueuePosting.mockRejectedValue(new Error('redis down'));

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0); // not counted because enqueue failed
    expect(ctx.sseService.publish).not.toHaveBeenCalled();
  });

  it('B3-010: runReconciliation() proceeds with enqueue when queue.getJob throws (best effort)', async () => {
    const stuckPost = {
      id: 'post-besteffort',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockRejectedValue(new Error('queue unavailable'));

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(ctx.queueService.enqueuePosting).toHaveBeenCalledWith('post-besteffort', SocialNetwork.X);
  });

  it('B3-011: runReconciliation() uses createdAt fallback when approvedAt is null', async () => {
    // Post approved long ago but approvedAt missing — should fall back to createdAt
    const oldCreated = new Date(Date.now() - 30 * 60 * 1000);
    const stuckPost = {
      id: 'post-noapproved',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: null,
      createdAt: oldCreated,
    };
    ctx.prisma.post.findMany.mockResolvedValue([stuckPost]);
    ctx.queue.getJob.mockResolvedValue(null);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(ctx.queueService.enqueuePosting).toHaveBeenCalledWith('post-noapproved', SocialNetwork.X);
  });

  // ── F21: Ban Detection (via runHealthCheck → checkSessionHealth) ────────────

  it('BAN-001: runHealthCheck() flags session as BANNED when consecutive failures >= threshold', async () => {
    const session = {
      id: 'sess-banned',
      accountId: 'acc-banned',
      status: SessionStatus.ACTIVE,
      lastHealthCheck: new Date('2026-07-15T10:00:00Z'),
      createdAt: new Date('2026-07-01T00:00:00Z'),
      account: { network: SocialNetwork.X },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    // 5 consecutive FAILED posts (>= default threshold 5)
    ctx.prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
    ]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    // Session status updated to BANNED in DB
    expect(ctx.prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-banned' },
      data: { status: 'BANNED' as SessionStatus },
    });

    // Session reported as BANNED
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0].status).toBe('BANNED');
    expect(report.sessions[0].consecutiveFailures).toBe(5);
    expect(report.sessions[0].accountId).toBe('acc-banned');
    expect(report.sessions[0].network).toBe(SocialNetwork.X);

    // Critical alert emitted
    const banAlert = report.alerts.find(
      (a) => a.severity === 'critical' && a.message.includes('BANNED'),
    );
    expect(banAlert).toBeDefined();
    expect(banAlert?.message).toContain('acc-banned');
    expect(banAlert?.message).toContain('5 consecutive failures');
  });

  it('BAN-002: runHealthCheck() does NOT flag session when consecutive failures < threshold', async () => {
    const session = {
      id: 'sess-ok',
      accountId: 'acc-ok',
      status: SessionStatus.ACTIVE,
      lastHealthCheck: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      account: { network: SocialNetwork.THREADS },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    // 4 consecutive FAILED then a POSTED (streak broken at 4 < 5)
    ctx.prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.POSTED, createdAt: new Date() },
    ]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
    expect(report.sessions[0].status).toBe('ACTIVE');
    expect(report.sessions[0].consecutiveFailures).toBe(4);
    expect(report.alerts.find((a) => a.message.includes('BANNED'))).toBeUndefined();
  });

  it('BAN-003: runHealthCheck() counts only the trailing FAILED streak (broken by POSTED)', async () => {
    const session = {
      id: 'sess-streak',
      accountId: 'acc-streak',
      status: SessionStatus.ACTIVE,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.X },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    // 2 FAILED, then POSTED, then 3 FAILED — trailing streak is 3 (< 5)
    ctx.prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.POSTED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
    ]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    expect(report.sessions[0].consecutiveFailures).toBe(3);
    expect(report.sessions[0].status).toBe('ACTIVE');
    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
  });

  it('BAN-004: runHealthCheck() respects custom ban threshold from config', async () => {
    ctx = buildContext({ HEALTH_MONITOR_BAN_THRESHOLD: 3 });

    const session = {
      id: 'sess-custom',
      accountId: 'acc-custom',
      status: SessionStatus.ACTIVE,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.X },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    ctx.prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
    ]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    // 3 failures >= threshold 3 → BANNED
    expect(report.sessions[0].status).toBe('BANNED');
    expect(ctx.prisma.session.update).toHaveBeenCalled();
  });

  it('BAN-005: runHealthCheck() does not update already-BANNED session status again', async () => {
    // If session is already BANNED (e.g. EXPIRED status but flagged), no double update.
    // The service only updates when status === ACTIVE.
    const session = {
      id: 'sess-expired',
      accountId: 'acc-expired',
      status: SessionStatus.EXPIRED,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.X },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    ctx.prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
      { status: PostStatus.FAILED, createdAt: new Date() },
    ]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    // Reported as BANNED but no DB update (status was EXPIRED, not ACTIVE)
    expect(report.sessions[0].status).toBe('BANNED');
    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
  });

  // ── F21: Health Check — Session EXPIRED ────────────────────────────────────

  it('HC-001: runHealthCheck() emits warning alert for EXPIRED session', async () => {
    const session = {
      id: 'sess-exp',
      accountId: 'acc-exp',
      status: SessionStatus.EXPIRED,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.THREADS },
    };
    ctx.prisma.session.findMany.mockResolvedValue([session]);
    ctx.prisma.post.findMany.mockResolvedValue([]); // no recent posts
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    const expiredAlert = report.alerts.find(
      (a) => a.severity === 'warning' && a.message.includes('EXPIRED'),
    );
    expect(expiredAlert).toBeDefined();
    expect(expiredAlert?.message).toContain(SocialNetwork.THREADS);
    expect(report.sessions[0].status).toBe('EXPIRED');
  });

  it('HC-002: runHealthCheck() emits warning alert when failed posts > 0 (<= 5)', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountByStatus(ctx.prisma, { [PostStatus.FAILED]: 3 });
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    const failedAlert = report.alerts.find(
      (a) => a.message.includes('FAILED status'),
    );
    expect(failedAlert).toBeDefined();
    expect(failedAlert?.severity).toBe('warning');
    expect(failedAlert?.message).toContain('3 posts in FAILED');
  });

  it('HC-003: runHealthCheck() emits critical alert when failed posts > 5', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountByStatus(ctx.prisma, { [PostStatus.FAILED]: 8 });
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    const failedAlert = report.alerts.find(
      (a) => a.message.includes('FAILED status'),
    );
    expect(failedAlert).toBeDefined();
    expect(failedAlert?.severity).toBe('critical');
  });

  it('HC-004: runHealthCheck() returns healthy report with empty alerts when all clear', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    expect(report.timestamp).toBeDefined();
    expect(report.alerts).toEqual([]);
    expect(report.sessions).toEqual([]);
    expect(report.posts.failedCount).toBe(0);
    expect(report.queues.dlqDepth).toBe(0);
  });

  it('HC-005: runHealthCheck() publishes SSE health_alert for each alert', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountByStatus(ctx.prisma, { [PostStatus.FAILED]: 3 });
    queueCountsByNetwork(ctx.queueService, {});

    await ctx.service.runHealthCheck();

    const healthAlertCalls = ctx.sseService.publish.mock.calls.filter(
      (c: unknown[]) => c[0]?.type === 'health_alert',
    );
    expect(healthAlertCalls.length).toBeGreaterThan(0);
    expect(healthAlertCalls[0][0]).toMatchObject({
      type: 'health_alert',
      severity: 'warning',
    });
  });

  it('HC-006: runHealthCheck() reports post health counts (draft, approved, posting, failed, stuckPosting)', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    // Provide counts for each status + stuckPosting (approvedAt query → 0 via helper)
    ctx.prisma.post.count.mockImplementation((args: { where: { status: PostStatus; approvedAt?: unknown } }) => {
      if (args.where.approvedAt) return Promise.resolve(2); // stuckPosting
      const map: Partial<Record<PostStatus, number>> = {
        [PostStatus.FAILED]: 1,
        [PostStatus.POSTING]: 3,
        [PostStatus.DRAFT]: 5,
        [PostStatus.APPROVED]: 7,
      };
      return Promise.resolve(map[args.where.status] ?? 0);
    });
    queueCountsByNetwork(ctx.queueService, {});

    const report = await ctx.service.runHealthCheck();

    expect(report.posts).toEqual({
      draftCount: 5,
      approvedCount: 7,
      postingCount: 3,
      failedCount: 1,
      stuckPosting: 2,
    });
  });

  // ── F21: DLQ Handling (checkQueueHealth) ───────────────────────────────────

  it('DLQ-001: runHealthCheck() reports dlqDepth from failed jobs across networks', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {
      [SocialNetwork.X]: { failed: 2, active: 0, waiting: 0 },
      [SocialNetwork.THREADS]: { failed: 3, active: 0, waiting: 0 },
      [SocialNetwork.FACEBOOK]: { failed: 0, active: 0, waiting: 0 },
    });

    const report = await ctx.service.runHealthCheck();

    expect(report.queues.dlqDepth).toBe(5);
  });

  it('DLQ-002: runHealthCheck() emits critical alert when DLQ has dead jobs', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {
      [SocialNetwork.X]: { failed: 4, active: 0, waiting: 0 },
    });

    const report = await ctx.service.runHealthCheck();

    const dlqAlert = report.alerts.find((a) => a.message.includes('DLQ'));
    expect(dlqAlert).toBeDefined();
    expect(dlqAlert?.severity).toBe('critical');
    expect(dlqAlert?.message).toContain('4 dead jobs');
  });

  it('DLQ-003: runHealthCheck() lists active queues with active/waiting jobs', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {
      [SocialNetwork.X]: { failed: 0, active: 1, waiting: 2 },
      [SocialNetwork.THREADS]: { failed: 0, active: 0, waiting: 0 },
      [SocialNetwork.FACEBOOK]: { failed: 0, active: 0, waiting: 5 },
    });

    const report = await ctx.service.runHealthCheck();

    expect(report.queues.dlqDepth).toBe(0);
    expect(report.queues.activeQueues).toHaveLength(2);
    expect(report.queues.activeQueues.some((q) => q.startsWith('X (1 active'))).toBe(true);
    expect(report.queues.activeQueues.some((q) => q.includes('FACEBOOK') && q.includes('5 waiting'))).toBe(true);
  });

  it('DLQ-004: runHealthCheck() skips networks where getJobCounts throws (queue unavailable)', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    ctx.queueService.getJobCounts.mockRejectedValue(new Error('redis down'));

    const report = await ctx.service.runHealthCheck();

    // No crash, dlqDepth stays 0
    expect(report.queues.dlqDepth).toBe(0);
    expect(report.queues.activeQueues).toEqual([]);
  });

  // ── F21: getDashboard ──────────────────────────────────────────────────────

  it('DASH-001: getDashboard() returns report with summary counts', async () => {
    const activeSession = {
      id: 'sess-a',
      accountId: 'acc-a',
      status: SessionStatus.ACTIVE,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.X },
    };
    const expiredSession = {
      id: 'sess-e',
      accountId: 'acc-e',
      status: SessionStatus.EXPIRED,
      lastHealthCheck: null,
      createdAt: new Date(),
      account: { network: SocialNetwork.THREADS },
    };
    ctx.prisma.session.findMany.mockResolvedValue([activeSession, expiredSession]);
    ctx.prisma.post.findMany.mockResolvedValue([]);
    postCountAllZero(ctx.prisma);
    queueCountsByNetwork(ctx.queueService, {});

    const dashboard = await ctx.service.getDashboard();

    expect(dashboard.summary).toEqual({
      totalAlerts: dashboard.alerts.length,
      criticalAlerts: 0,
      warningAlerts: expect.any(Number),
      healthySessions: 1,
      bannedSessions: 0,
      expiredSessions: 1,
    });
    expect(dashboard.sessions).toHaveLength(2);
    expect(dashboard.timestamp).toBeDefined();
  });

  // ── Sprint K: Ban Recovery ─────────────────────────────────────────────────

  it('BR-001: checkBanRecovery() returns false when no BANNED session exists', async () => {
    ctx.prisma.session.findFirst.mockResolvedValue(null);

    const result = await ctx.service.checkBanRecovery('acc-1');
    expect(result).toBe(false);
    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
  });

  it('BR-002: checkBanRecovery() returns false when ban is recent (< 24h)', async () => {
    ctx.prisma.session.findFirst.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acc-1',
      status: SessionStatus.BANNED,
      createdAt: new Date(), // just now
    });

    const result = await ctx.service.checkBanRecovery('acc-1');
    expect(result).toBe(false);
    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
  });

  it('BR-003: checkBanRecovery() returns false when ban > 24h but has recent failures', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    ctx.prisma.session.findFirst.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acc-1',
      status: SessionStatus.BANNED,
      createdAt: twoDaysAgo,
    });
    ctx.prisma.post.count.mockResolvedValue(3); // 3 recent failures

    const result = await ctx.service.checkBanRecovery('acc-1');
    expect(result).toBe(false);
    expect(ctx.prisma.session.update).not.toHaveBeenCalled();
  });

  it('BR-004: checkBanRecovery() recovers session when ban > 24h and no recent failures', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    ctx.prisma.session.findFirst.mockResolvedValue({
      id: 'sess-1',
      accountId: 'acc-1',
      status: SessionStatus.BANNED,
      createdAt: twoDaysAgo,
    });
    ctx.prisma.post.count.mockResolvedValue(0); // no recent failures

    const result = await ctx.service.checkBanRecovery('acc-1');

    expect(result).toBe(true);
    expect(ctx.prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { status: SessionStatus.ACTIVE },
    });
    expect(ctx.sseService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'health_alert',
        severity: 'info',
        error: expect.stringContaining('Ban lifted for account acc-1'),
      }),
    );
  });

  it('BR-005: recoverBannedSessions() checks all banned sessions and returns counts', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    ctx.prisma.session.findMany.mockResolvedValue([
      { id: 'sess-1', accountId: 'acc-1', status: SessionStatus.BANNED, createdAt: twoDaysAgo, account: { network: SocialNetwork.X } },
      { id: 'sess-2', accountId: 'acc-2', status: SessionStatus.BANNED, createdAt: new Date(), account: { network: SocialNetwork.THREADS } },
    ]);
    // First session: recoverable (no recent failures)
    // Second session: not recoverable (recent ban)
    ctx.prisma.session.findFirst
      .mockResolvedValueOnce({ id: 'sess-1', accountId: 'acc-1', status: SessionStatus.BANNED, createdAt: twoDaysAgo })
      .mockResolvedValueOnce({ id: 'sess-2', accountId: 'acc-2', status: SessionStatus.BANNED, createdAt: new Date() });
    ctx.prisma.post.count.mockResolvedValue(0);

    const result = await ctx.service.recoverBannedSessions();

    expect(result.checked).toBe(2);
    expect(result.recovered).toBe(1);
  });

  it('BR-006: recoverBannedSessions() returns {checked:0, recovered:0} when no banned sessions', async () => {
    ctx.prisma.session.findMany.mockResolvedValue([]);

    const result = await ctx.service.recoverBannedSessions();

    expect(result).toEqual({ checked: 0, recovered: 0 });
    expect(ctx.prisma.session.findFirst).not.toHaveBeenCalled();
  });

  // ── onModuleInit ────────────────────────────────────────────────────────────

  it('INIT-001: onModuleInit() registers two cron jobs with scheduler registry', () => {
    ctx.service.onModuleInit();

    expect(ctx.schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    expect(ctx.schedulerRegistry.addCronJob).toHaveBeenCalledWith('health-monitor', expect.anything());
    expect(ctx.schedulerRegistry.addCronJob).toHaveBeenCalledWith('reconciliation', expect.anything());
  });

  it('INIT-002: onModuleInit() does not throw when SchedulerRegistry is unavailable', () => {
    ctx.schedulerRegistry.addCronJob.mockImplementation(() => {
      throw new Error('already exists');
    });

    expect(() => ctx.service.onModuleInit()).not.toThrow();
  });
});
