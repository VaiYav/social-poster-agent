/**
 * RP1: auto-replies are scheduled as delayed BullMQ jobs instead of blocking the
 * monitoring cron with an inline `await setTimeout(5-30min)`.
 *
 * Verifies:
 *   - the `auto_reply` decision enqueues a delayed engagement job (jobId=commentId,
 *     action='reply') and does NOT post inline (cron stays responsive);
 *   - the inline fallback only runs when no queue is wired;
 *   - postScheduledReply posts + marks REPLIED + emits SSE;
 *   - postScheduledReply re-checks the per-post cap at execution time;
 *   - postScheduledReply throws on failure so BullMQ retries;
 *   - the re-entrancy guard skips re-deciding a comment that already has a job in flight.
 *
 * Source: packages/backend/src/modules/replies/replies-monitor.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CommentStatus } from '@prisma/client';
import { RepliesMonitorService } from '../../../src/modules/replies/replies-monitor.service';

function mockConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: unknown) => (key in values ? values[key] : def)),
  } as unknown as ConfigService;
}

function mockPrisma() {
  return {
    incomingComment: {
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

function mockSse() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function mockDiscord() {
  return {
    warning: vi.fn().mockResolvedValue(undefined),
    critical: vi.fn().mockResolvedValue(undefined),
  };
}

function mockEngagement() {
  return { reply: vi.fn().mockResolvedValue({ success: true }) };
}

function mockQueue() {
  return {
    enqueueEngagement: vi.fn().mockResolvedValue(undefined),
    getEngagementJob: vi.fn().mockResolvedValue(undefined),
  };
}

interface Deps {
  prisma: ReturnType<typeof mockPrisma>;
  sse: ReturnType<typeof mockSse>;
  engagement: ReturnType<typeof mockEngagement>;
  queue: ReturnType<typeof mockQueue> | undefined;
}

function makeService(overrides: Partial<Deps> = {}): { svc: any; deps: Deps } {
  const deps: Deps = {
    prisma: overrides.prisma ?? mockPrisma(),
    sse: overrides.sse ?? mockSse(),
    engagement: overrides.engagement ?? mockEngagement(),
    queue: 'queue' in overrides ? overrides.queue : mockQueue(),
  };
  const service = new RepliesMonitorService(
    deps.prisma as any,
    mockConfig({ REPLIES_ENABLED: 'true', REPLIES_MAX_PER_POST: '3' }),
    {} as any, // accountsService
    {} as any, // sessionsService
    { addCronJob: vi.fn() } as any, // schedulerRegistry
    mockDiscord() as any,
    deps.sse as any,
    undefined, // llmService
    undefined, // browser
    deps.engagement as any,
    deps.queue as any,
  );
  return { svc: service, deps };
}

const POST = { id: 'p1', network: 'X', postUrl: 'https://x.com/u/status/1', content: 'About Mars' };
const COMMENT = { id: 'c-db', commentId: 'cid-1', author: '@stranger', text: 'How does this work?' };
const DECISION = { action: 'auto_reply' as const, reason: 'question', replyText: 'Great question ✨' };

function freshStats() {
  return { postsChecked: 0, commentsScraped: 0, repliesPosted: 0, repliesScheduled: 0, humanReview: 0 };
}

describe('RP1 — delayed auto-reply jobs', () => {
  let env: ReturnType<typeof makeService>;

  beforeEach(() => {
    env = makeService();
  });

  it('RP1-001: auto_reply enqueues a delayed engagement job (jobId=commentId) and does not post inline', async () => {
    const stats = freshStats();
    await env.svc.executeDecision(POST, COMMENT, DECISION, stats);

    expect(env.deps.queue!.enqueueEngagement).toHaveBeenCalledTimes(1);
    const [interactionId, network, action, payload, opts] = env.deps.queue!.enqueueEngagement.mock.calls[0];
    expect(interactionId).toBe('cid-1'); // jobId=commentId → idempotent
    expect(network).toBe('X');
    expect(action).toBe('reply');
    expect(payload).toMatchObject({
      commentDbId: 'c-db',
      postId: 'p1',
      postUrl: 'https://x.com/u/status/1',
      replyText: 'Great question ✨',
    });
    expect(opts.delay).toBeGreaterThan(0);

    // The cron must NOT block / post inline when a queue is wired.
    expect(env.deps.engagement.reply).not.toHaveBeenCalled();
    expect(stats.repliesPosted).toBe(0); // posted later by the worker
    expect(stats.repliesScheduled).toBe(1); // B9: scheduled count is tracked
    // Decided reply text is persisted so the UI can show it while the job waits.
    expect(env.deps.prisma.incomingComment.update).toHaveBeenCalled();
  });

  it('RP1-002: delay is bounded by the configured min/max window', async () => {
    const svc2 = makeService();
    // force the random factor extremes by stubbing Math.random
    const r = vi.spyOn(Math, 'random').mockReturnValue(0);
    await svc2.svc.executeDecision(POST, COMMENT, DECISION, freshStats());
    const minDelay = svc2.deps.queue!.enqueueEngagement.mock.calls[0][4].delay;
    expect(minDelay).toBe(300000); // default REPLIES_AUTO_DELAY_MIN_MS
    r.mockRestore();
  });

  it('RP1-003: without a queue wired, falls back to posting inline (no 5-30min block)', async () => {
    const noQueue = makeService({ queue: undefined });
    const stats = freshStats();
    await noQueue.svc.executeDecision(POST, COMMENT, DECISION, stats);

    expect(noQueue.deps.engagement.reply).toHaveBeenCalledWith('X', 'https://x.com/u/status/1', 'Great question ✨');
    expect(stats.repliesPosted).toBe(1);
  });

  it('RP1-004: postScheduledReply posts, marks REPLIED and emits SSE', async () => {
    await env.svc.postScheduledReply({
      commentDbId: 'c-db',
      commentId: 'cid-1',
      postId: 'p1',
      network: 'X',
      postUrl: 'https://x.com/u/status/1',
      replyText: 'Hi ✨',
    });

    expect(env.deps.engagement.reply).toHaveBeenCalledWith('X', 'https://x.com/u/status/1', 'Hi ✨');
    expect(env.deps.prisma.incomingComment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-db' },
        data: expect.objectContaining({ status: CommentStatus.REPLIED }),
      }),
    );
    expect(env.deps.sse.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'reply_posted', commentId: 'cid-1' }));
  });

  it('RP1-005: postScheduledReply re-checks the per-post cap and drops (SKIPPED) when reached', async () => {
    const prisma = mockPrisma();
    prisma.incomingComment.count.mockResolvedValue(3); // already at the cap of 3
    const capped = makeService({ prisma });

    await capped.svc.postScheduledReply({
      commentDbId: 'c-db',
      commentId: 'cid-1',
      postId: 'p1',
      network: 'X',
      postUrl: 'https://x.com/u/status/1',
      replyText: 'Hi ✨',
    });

    expect(capped.deps.engagement.reply).not.toHaveBeenCalled();
    expect(prisma.incomingComment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: CommentStatus.SKIPPED }) }),
    );
  });

  it('RP1-006: postScheduledReply throws when the reply fails (so BullMQ retries)', async () => {
    const engagement = { reply: vi.fn().mockResolvedValue({ success: false, error: 'nav timeout' }) };
    const failing = makeService({ engagement });

    await expect(
      failing.svc.postScheduledReply({
        commentDbId: 'c-db',
        commentId: 'cid-1',
        postId: 'p1',
        network: 'X',
        postUrl: 'https://x.com/u/status/1',
        replyText: 'Hi ✨',
      }),
    ).rejects.toThrow(/nav timeout/);

    // Must NOT mark REPLIED on failure — the comment stays NEW for a retry.
    const updates = engagement.reply.mock.calls.length;
    expect(updates).toBe(1);
    expect(failing.deps.prisma.incomingComment.update).not.toHaveBeenCalled();
  });

  it('RP1-007: re-entrancy guard skips re-deciding a comment that already has a job in flight', async () => {
    const env2 = makeService();
    env2.deps.queue!.getEngagementJob.mockResolvedValue({ id: 'cid-1' }); // existing delayed job

    // Stub the scrape pipeline so the cycle reaches the per-comment loop.
    env2.svc.getMonitorablePosts = vi.fn().mockResolvedValue([POST]);
    env2.svc.scrapeComments = vi.fn().mockResolvedValue([{ commentId: 'cid-1', author: '@s', text: 'hi' }]);
    env2.svc.saveNewComments = vi.fn().mockResolvedValue([{ id: 'c-db', commentId: 'cid-1', author: '@s', text: 'hi' }]);
    const decideSpy = vi.spyOn(env2.svc, 'decideReply');

    await env2.svc.runMonitoringCycle();

    expect(env2.deps.queue!.getEngagementJob).toHaveBeenCalledWith('cid-1', 'X');
    expect(decideSpy).not.toHaveBeenCalled(); // guarded — no costly re-decision
  });
});
