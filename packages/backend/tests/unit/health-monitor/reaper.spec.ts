/**
 * M1: HealthMonitorService.reapStuckPosting() unit tests.
 *
 * Verifies the orphaned-POSTING reaper (audit `03 §1`):
 *   - detects POSTING posts with no in-flight BullMQ job → marks FAILED
 *   - NEVER auto-re-enqueues (would risk a duplicate publish)
 *   - skips genuinely in-flight posts (active/waiting/delayed job)
 *   - is conservative when the queue state can't be read (skip, don't reap)
 *
 * Source: packages/backend/src/modules/health-monitor/health-monitor.service.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PostStatus, SocialNetwork } from '@prisma/client';

import { HealthMonitorService } from '../../../src/modules/health-monitor/health-monitor.service';

function buildService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    post: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      count: vi.fn(),
    },
    session: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  };
  const sseService = { publish: vi.fn().mockResolvedValue(undefined) };
  const discord = {
    critical: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
  };
  const queueService = { enqueuePosting: vi.fn().mockResolvedValue(undefined), getJobCounts: vi.fn() };
  const queue = { getJob: vi.fn().mockResolvedValue(undefined) };
  const queueFactory = { getQueue: vi.fn().mockReturnValue(queue) };
  const configService = {
    get: vi.fn((key: string, def?: unknown) => overrides[key] ?? def),
  } as unknown as ConfigService;

  const service = new HealthMonitorService(
    prisma as never,
    sseService as never,
    discord as never,
    queueService as never,
    queueFactory as never,
    configService,
    { addCronJob: vi.fn() } as never,
  );

  return { service, prisma, sseService, discord, queueService, queue, queueFactory };
}

const orphanPost = {
  id: 'p1',
  network: SocialNetwork.X,
  status: PostStatus.POSTING,
  approvedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago — well past grace
  createdAt: new Date(),
};

describe('HealthMonitorService.reapStuckPosting (M1 — orphaned POSTING reaper)', () => {
  it('returns {reaped:0,skipped:0} when there are no stuck POSTING posts', async () => {
    const { service, prisma } = buildService();
    prisma.post.findMany.mockResolvedValue([]);

    expect(await service.reapStuckPosting()).toEqual({ reaped: 0, skipped: 0 });
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('queries only POSTING posts older than the grace window', async () => {
    const { service, prisma } = buildService({ STUCK_POSTING_GRACE_MIN: 5 });
    prisma.post.findMany.mockResolvedValue([]);

    await service.reapStuckPosting();

    const arg = prisma.post.findMany.mock.calls[0]![0] as {
      where: { status: PostStatus; approvedAt: { lt: Date } };
    };
    expect(arg.where.status).toBe(PostStatus.POSTING);
    expect(arg.where.approvedAt.lt).toBeInstanceOf(Date);
    const elapsedMs = Date.now() - arg.where.approvedAt.lt.getTime();
    expect(elapsedMs).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
  });

  it('reaps an orphaned POSTING post (no BullMQ job) → FAILED + SSE + Discord, and NEVER re-enqueues', async () => {
    const { service, prisma, sseService, discord, queueService, queue } = buildService();
    prisma.post.findMany.mockResolvedValue([orphanPost]);
    queue.getJob.mockResolvedValue(undefined); // no job → orphaned

    const res = await service.reapStuckPosting();

    expect(res).toEqual({ reaped: 1, skipped: 0 });
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ status: PostStatus.FAILED }),
      }),
    );
    expect(sseService.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'post_status', postId: 'p1', status: 'FAILED' }),
    );
    expect(discord.warning).toHaveBeenCalled();
    // The reaper must NOT auto-requeue — that would risk a duplicate publish.
    expect(queueService.enqueuePosting).not.toHaveBeenCalled();
  });

  it.each(['active', 'waiting', 'delayed'])(
    'skips a genuinely in-flight post (job state=%s) — does not mark FAILED',
    async (state) => {
      const { service, prisma, queue } = buildService();
      prisma.post.findMany.mockResolvedValue([orphanPost]);
      queue.getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue(state) });

      const res = await service.reapStuckPosting();

      expect(res).toEqual({ reaped: 0, skipped: 1 });
      expect(prisma.post.update).not.toHaveBeenCalled();
    },
  );

  it('reaps when a job exists but already completed/failed (not in-flight)', async () => {
    const { service, prisma, queue } = buildService();
    prisma.post.findMany.mockResolvedValue([orphanPost]);
    queue.getJob.mockResolvedValue({ getState: vi.fn().mockResolvedValue('completed') });

    const res = await service.reapStuckPosting();

    expect(res).toEqual({ reaped: 1, skipped: 0 });
    expect(prisma.post.update).toHaveBeenCalled();
  });

  it('is conservative: skips (never reaps) when the queue state cannot be determined', async () => {
    const { service, prisma, queue } = buildService();
    prisma.post.findMany.mockResolvedValue([orphanPost]);
    queue.getJob.mockRejectedValue(new Error('redis down'));

    const res = await service.reapStuckPosting();

    expect(res).toEqual({ reaped: 0, skipped: 1 });
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});
