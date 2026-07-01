/**
 * B3: Reconciliation feature — dedicated unit tests for runReconciliation().
 *
 * The reconciliation cron finds APPROVED posts that have been stuck (approved
 * > 10 minutes ago) without a posting job, and re-enqueues them into BullMQ.
 * Before re-enqueuing, it checks BullMQ for an existing active/waiting/delayed
 * job to avoid duplicate postings (P0-H5 dedup).
 *
 * Source: packages/backend/src/modules/health-monitor/health-monitor.service.ts
 * Traces to: REQ-B3, HAZ-005 (double-posting), P0-H5 (duplicate detection)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PostStatus, SocialNetwork } from '@prisma/client';

import { HealthMonitorService } from '../../../src/modules/health-monitor/health-monitor.service';

// ── Mocks ──

const mockPrisma = {
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

const mockSseService = {
  publish: vi.fn().mockResolvedValue(undefined),
  init: vi.fn().mockResolvedValue(undefined),
};

const mockDiscord = {
  sendAlert: vi.fn().mockResolvedValue(undefined),
  sendCritical: vi.fn().mockResolvedValue(undefined),
};

const mockQueueService = {
  enqueuePosting: vi.fn().mockResolvedValue(undefined),
};

const mockQueue = {
  getJob: vi.fn(),
};

const mockQueueFactory = {
  getQueue: vi.fn().mockReturnValue(mockQueue),
};

const mockSchedulerRegistry = {
  addCronJob: vi.fn(),
};

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

// ── Fixtures ──

/** A post approved `minutesAgo` minutes ago, with no existing BullMQ job. */
function makeStuckPost(
  id: string,
  network: SocialNetwork,
  minutesAgo = 20,
): {
  id: string;
  network: SocialNetwork;
  status: PostStatus;
  approvedAt: Date;
  createdAt: Date;
} {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000);
  return {
    id,
    network,
    status: PostStatus.APPROVED,
    approvedAt: ts,
    createdAt: ts,
  };
}

/** A post approved `minutesAgo` minutes ago with an existing BullMQ job in `state`. */
function makePostWithJob(
  id: string,
  network: SocialNetwork,
  state: 'active' | 'waiting' | 'delayed' | 'completed' | 'failed',
  minutesAgo = 20,
) {
  return {
    post: makeStuckPost(id, network, minutesAgo),
    job: { getState: vi.fn().mockResolvedValue(state) },
  };
}

// ── Test Context ──

interface TestContext {
  service: HealthMonitorService;
  configService: ConfigService;
}

function buildContext(overrides?: Record<string, unknown>): TestContext {
  const configService = createMockConfigService(overrides);
  const service = new HealthMonitorService(
    mockPrisma as never,
    mockSseService as never,
    mockDiscord as never,
    mockQueueService as never,
    mockQueueFactory as never,
    configService,
    mockSchedulerRegistry as never,
  );
  return { service, configService };
}

// ── Tests ──

describe('B3: Reconciliation — runReconciliation()', () => {
  let ctx: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default queue factory mock (clearAllMocks resets implementations)
    mockQueueFactory.getQueue.mockReturnValue(mockQueue);
    mockQueue.getJob.mockResolvedValue(null);
    mockQueueService.enqueuePosting.mockResolvedValue(undefined);
    mockSseService.publish.mockResolvedValue(undefined);
    ctx = buildContext();
  });

  // ── 1. Finds orphaned APPROVED posts ──

  it('B3-REC-001: queries APPROVED posts ordered by approvedAt desc', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await ctx.service.runReconciliation();

    expect(mockPrisma.post.findMany).toHaveBeenCalledWith({
      where: { status: PostStatus.APPROVED },
      orderBy: { approvedAt: 'desc' },
      take: 1000,
    });
  });

  it('B3-REC-002: re-enqueues an orphaned APPROVED post with no active BullMQ job', async () => {
    const orphan = makeStuckPost('post-orphan', SocialNetwork.X, 20);
    mockPrisma.post.findMany.mockResolvedValue([orphan]);
    mockQueue.getJob.mockResolvedValue(null); // no existing job

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-orphan', SocialNetwork.X);
  });

  // ── 2. Re-enqueues orphaned posts into the correct network queue ──

  it('B3-REC-003: re-enqueues into the correct queue per network (X, THREADS, FACEBOOK)', async () => {
    const posts = [
      makeStuckPost('post-x', SocialNetwork.X, 20),
      makeStuckPost('post-t', SocialNetwork.THREADS, 20),
      makeStuckPost('post-f', SocialNetwork.FACEBOOK, 20),
    ];
    mockPrisma.post.findMany.mockResolvedValue(posts);
    mockQueue.getJob.mockResolvedValue(null);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(3);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-x', SocialNetwork.X);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-t', SocialNetwork.THREADS);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-f', SocialNetwork.FACEBOOK);
    // getQueue called with the correct network + 'posting' action for each
    expect(mockQueueFactory.getQueue).toHaveBeenCalledWith(SocialNetwork.X, 'posting');
    expect(mockQueueFactory.getQueue).toHaveBeenCalledWith(SocialNetwork.THREADS, 'posting');
    expect(mockQueueFactory.getQueue).toHaveBeenCalledWith(SocialNetwork.FACEBOOK, 'posting');
  });

  // ── 3. Skips posts that already have an active BullMQ job (dedup) ──

  it('B3-REC-004: skips posts with an active BullMQ job (dedup)', async () => {
    const { post, job } = makePostWithJob('post-active', SocialNetwork.X, 'active');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-REC-005: skips posts with a waiting BullMQ job (dedup)', async () => {
    const { post, job } = makePostWithJob('post-waiting', SocialNetwork.THREADS, 'waiting');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-REC-006: skips posts with a delayed BullMQ job (dedup)', async () => {
    const { post, job } = makePostWithJob('post-delayed', SocialNetwork.FACEBOOK, 'delayed');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.deduplicated).toBe(1);
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it('B3-REC-007: re-enqueues when existing job is completed (not active/waiting/delayed)', async () => {
    const { post, job } = makePostWithJob('post-done', SocialNetwork.X, 'completed');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(result.deduplicated).toBe(0);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-done', SocialNetwork.X);
  });

  it('B3-REC-008: re-enqueues when existing job is failed (not active/waiting/delayed)', async () => {
    const { post, job } = makePostWithJob('post-failed-job', SocialNetwork.X, 'failed');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-failed-job', SocialNetwork.X);
  });

  // ── 4. Skips posts that are already POSTED ──

  it('B3-REC-009: only queries APPROVED posts — POSTED posts are never considered', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    await ctx.service.runReconciliation();

    // The Prisma query filters by status: APPROVED only.
    // POSTED posts are excluded at the DB level, so they are never reconciled.
    const callArg = mockPrisma.post.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBe(PostStatus.APPROVED);
  });

  it('B3-REC-010: skips recently approved posts (< 10 min) to allow worker pickup', async () => {
    const recentPost = makeStuckPost('post-recent', SocialNetwork.X, 2); // 2 min ago
    mockPrisma.post.findMany.mockResolvedValue([recentPost]);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
    // Queue dedup check not even performed for recently-approved posts
    expect(mockQueueFactory.getQueue).not.toHaveBeenCalled();
  });

  it('B3-REC-011: uses approvedAt when present, falls back to createdAt', async () => {
    // approvedAt null, createdAt 20 min ago → should be treated as stuck
    const post = {
      id: 'post-noapproved',
      network: SocialNetwork.X,
      status: PostStatus.APPROVED,
      approvedAt: null,
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    };
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(null);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(1);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-noapproved', SocialNetwork.X);
  });

  // ── 5. Handles empty orphan list ──

  it('B3-REC-012: returns zeroed result when no APPROVED posts exist', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);

    const result = await ctx.service.runReconciliation();

    expect(result).toEqual({ requeued: 0, skipped: 0, deduplicated: 0 });
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
    expect(mockSseService.publish).not.toHaveBeenCalled();
  });

  it('B3-REC-013: returns zeroed result when all approved posts are recent (< 10 min)', async () => {
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('p1', SocialNetwork.X, 1),
      makeStuckPost('p2', SocialNetwork.THREADS, 5),
    ]);

    const result = await ctx.service.runReconciliation();

    expect(result).toEqual({ requeued: 0, skipped: 2, deduplicated: 0 });
    expect(mockQueueService.enqueuePosting).not.toHaveBeenCalled();
  });

  // ── 6. Logs reconciliation results ──

  it('B3-REC-014: logs start and completion summary with counts', async () => {
    const loggerSpy = vi.spyOn(ctx.service['logger'], 'log');
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('p1', SocialNetwork.X, 20),
      makeStuckPost('p2', SocialNetwork.X, 3), // recent → skipped
    ]);
    mockQueue.getJob.mockResolvedValue(null);

    await ctx.service.runReconciliation();

    // Start log
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining('Running reconciliation'),
    );
    // Completion summary log includes counts
    const summaryCall = loggerSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('Reconciliation complete'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall[0]).toContain('1 requeued');
    expect(summaryCall[0]).toContain('1 skipped');
    expect(summaryCall[0]).toContain('0 deduplicated');
  });

  it('B3-REC-015: logs a warn for each re-enqueued stuck post', async () => {
    const warnSpy = vi.spyOn(ctx.service['logger'], 'warn');
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('post-warn', SocialNetwork.X, 20),
    ]);
    mockQueue.getJob.mockResolvedValue(null);

    await ctx.service.runReconciliation();

    const stuckWarn = warnSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('post-warn') && c[0].includes('stuck'),
    );
    expect(stuckWarn).toBeDefined();
  });

  it('B3-REC-016: logs a warn when a post is deduplicated (has active job)', async () => {
    const warnSpy = vi.spyOn(ctx.service['logger'], 'warn');
    const { post, job } = makePostWithJob('post-dup-warn', SocialNetwork.X, 'active');
    mockPrisma.post.findMany.mockResolvedValue([post]);
    mockQueue.getJob.mockResolvedValue(job);

    await ctx.service.runReconciliation();

    const dedupWarn = warnSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('dedup'),
    );
    expect(dedupWarn).toBeDefined();
    expect(dedupWarn[0]).toContain('post-dup-warn');
  });

  // ── 7. Handles queue errors gracefully ──

  it('B3-REC-017: continues enqueuing other posts when one enqueue throws', async () => {
    const posts = [
      makeStuckPost('post-ok-1', SocialNetwork.X, 20),
      makeStuckPost('post-fail', SocialNetwork.X, 20),
      makeStuckPost('post-ok-2', SocialNetwork.THREADS, 20),
    ];
    mockPrisma.post.findMany.mockResolvedValue(posts);
    mockQueue.getJob.mockResolvedValue(null);
    mockQueueService.enqueuePosting
      .mockResolvedValueOnce(undefined) // post-ok-1
      .mockRejectedValueOnce(new Error('redis down')) // post-fail
      .mockResolvedValueOnce(undefined); // post-ok-2

    const result = await ctx.service.runReconciliation();

    // 2 succeeded, 1 failed (not counted in requeued)
    expect(result.requeued).toBe(2);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledTimes(3);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-ok-1', SocialNetwork.X);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-fail', SocialNetwork.X);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-ok-2', SocialNetwork.THREADS);
  });

  it('B3-REC-018: logs an error when enqueue fails and does not publish SSE for that post', async () => {
    const errorSpy = vi.spyOn(ctx.service['logger'], 'error');
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('post-err', SocialNetwork.X, 20),
    ]);
    mockQueue.getJob.mockResolvedValue(null);
    mockQueueService.enqueuePosting.mockRejectedValue(new Error('queue add failed'));

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(0);
    const errCall = errorSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('post-err'),
    );
    expect(errCall).toBeDefined();
    expect(errCall[0]).toContain('failed to re-enqueue');
    // SSE not published because enqueue failed (publish is after enqueue)
    expect(mockSseService.publish).not.toHaveBeenCalled();
  });

  it('B3-REC-019: proceeds with enqueue when queue getJob throws (best-effort dedup)', async () => {
    const debugSpy = vi.spyOn(ctx.service['logger'], 'debug');
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('post-queueerr', SocialNetwork.X, 20),
    ]);
    mockQueue.getJob.mockRejectedValue(new Error('redis connection lost'));

    const result = await ctx.service.runReconciliation();

    // Dedup check failed, but reconciliation proceeds (best effort)
    expect(result.requeued).toBe(1);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledWith('post-queueerr', SocialNetwork.X);
    // Debug log for the queue state check failure
    const debugCall = debugSpy.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('could not check queue state'),
    );
    expect(debugCall).toBeDefined();
  });

  it('B3-REC-020: handles mixed scenario — skip, dedup, enqueue, and enqueue-failure in one run', async () => {
    const activeJob = { getState: vi.fn().mockResolvedValue('active') };
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('recent', SocialNetwork.X, 3), // skipped (recent)
      makeStuckPost('dup', SocialNetwork.X, 20), // dedup (active job)
      makeStuckPost('ok', SocialNetwork.THREADS, 20), // enqueued ok
      makeStuckPost('boom', SocialNetwork.FACEBOOK, 20), // enqueue fails
    ]);
    // getJob returns active job for 'dup', null for others
    mockQueue.getJob.mockImplementation(async (jobId: string) => {
      if (jobId === 'dup') return activeJob;
      return null;
    });
    // enqueuePosting succeeds for 'ok', fails for 'boom'
    mockQueueService.enqueuePosting.mockImplementation(async (postId: string) => {
      if (postId === 'boom') throw new Error('boom');
      return undefined;
    });

    const result = await ctx.service.runReconciliation();

    // 'recent' is skipped (too recent), 'boom' is skipped (enqueue failed → returns 'skipped')
    expect(result.skipped).toBe(2);
    expect(result.deduplicated).toBe(1);
    expect(result.requeued).toBe(1); // only 'ok' succeeded
  });

  // ── 8. Respects rate limits / batch behaviour ──

  it('B3-REC-021: processes all orphaned posts in a single run (no artificial batch limit)', async () => {
    // The current implementation has no batch limit — it processes every
    // stuck post returned by the DB query. This test documents that behaviour.
    const posts = Array.from({ length: 8 }, (_, i) =>
      makeStuckPost(`post-batch-${i}`, SocialNetwork.X, 20),
    );
    mockPrisma.post.findMany.mockResolvedValue(posts);
    mockQueue.getJob.mockResolvedValue(null);

    const result = await ctx.service.runReconciliation();

    expect(result.requeued).toBe(8);
    expect(mockQueueService.enqueuePosting).toHaveBeenCalledTimes(8);
  });

  it('B3-REC-022: publishes an SSE reconciliation_requeue event for each re-enqueued post', async () => {
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('p-a', SocialNetwork.X, 20),
      makeStuckPost('p-b', SocialNetwork.THREADS, 20),
    ]);
    mockQueue.getJob.mockResolvedValue(null);

    await ctx.service.runReconciliation();

    expect(mockSseService.publish).toHaveBeenCalledTimes(2);
    expect(mockSseService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation_requeue',
        postId: 'p-a',
        network: SocialNetwork.X,
      }),
    );
    expect(mockSseService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation_requeue',
        postId: 'p-b',
        network: SocialNetwork.THREADS,
      }),
    );
  });

  it('B3-REC-023: does not publish SSE for skipped or deduplicated posts', async () => {
    const activeJob = { getState: vi.fn().mockResolvedValue('active') };
    mockPrisma.post.findMany.mockResolvedValue([
      makeStuckPost('recent', SocialNetwork.X, 3), // skipped
      makeStuckPost('dup', SocialNetwork.X, 20), // dedup
    ]);
    mockQueue.getJob.mockResolvedValue(activeJob);

    await ctx.service.runReconciliation();

    expect(mockSseService.publish).not.toHaveBeenCalled();
  });

  it('B3-REC-024: returns the result object with requeued/skipped/deduplicated counts', async () => {
    mockPrisma.post.findMany.mockResolvedValue([]);
    mockQueue.getJob.mockResolvedValue(null);

    const result = await ctx.service.runReconciliation();

    expect(result).toHaveProperty('requeued');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('deduplicated');
    expect(typeof result.requeued).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(typeof result.deduplicated).toBe('number');
  });
});
