/**
 * MOD-05: Infrastructure Adapters Module — QueueFactory unit tests.
 *
 * Tests BullMQ queue creation, job enqueueing, worker registration,
 * job counts, failed jobs, and lifecycle (destroy).
 *
 * Source: packages/backend/src/infrastructure/queue/queue.factory.ts
 * Traces to: REQ-027..031, REQ-NF-003
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock BullMQ ──
// QueueFactory creates Queue and Worker instances from bullmq.
// We mock both so no real Redis connection is needed.
// vi.hoisted() ensures mock functions are available before the hoisted vi.mock factory runs.

const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn().mockResolvedValue({ id: 'job-1' }),
  queueGetFailed: vi.fn().mockResolvedValue([
    { id: 'failed-job-1', data: { postId: 'p1' }, attemptsMade: 3 },
  ]),
  queueGetJobCounts: vi.fn().mockResolvedValue({
    waiting: 2,
    active: 1,
    completed: 10,
    failed: 1,
    delayed: 0,
  }),
  queueGetJob: vi.fn().mockResolvedValue(null),
  queuePause: vi.fn().mockResolvedValue(undefined),
  queueResume: vi.fn().mockResolvedValue(undefined),
  queueIsPaused: vi.fn().mockResolvedValue(false),
  queueClose: vi.fn().mockResolvedValue(undefined),
  workerClose: vi.fn().mockResolvedValue(undefined),
  workerOn: vi.fn(),
  QueueMock: vi.fn(),
  WorkerMock: vi.fn(),
  // DiscordNotificationService mocks
  discordCritical: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bullmq', () => ({
  Queue: mocks.QueueMock.mockImplementation(() => ({
    add: mocks.queueAdd,
    getFailed: mocks.queueGetFailed,
    getJobCounts: mocks.queueGetJobCounts,
    getJob: mocks.queueGetJob,
    pause: mocks.queuePause,
    resume: mocks.queueResume,
    isPaused: mocks.queueIsPaused,
    close: mocks.queueClose,
  })),
  Worker: mocks.WorkerMock.mockImplementation(() => ({
    close: mocks.workerClose,
    on: mocks.workerOn,
  })),
}));

import { ConfigService } from '@nestjs/config';
import { QueueFactory } from '../../../src/infrastructure/queue/queue.factory';

// ── Helpers ──

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    REDIS_URL: 'redis://localhost:6381',
    BULLMQ_MAX_RETRIES: 3,
    BULLMQ_RETRY_DELAY_MS: 60000,
    BULLMQ_POSTING_MAX_RETRIES: 8,
    BULLMQ_POSTING_RETRY_DELAY_MS: 120000,
    BULLMQ_QUEUE_PREFIX: 'spa',
    BULLMQ_CONCURRENCY_PER_QUEUE: 1,
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => overrides[key] ?? defaults[key] ?? defaultValue),
  } as unknown as ConfigService;
}

// ── Tests ──

describe('QueueFactory (MOD-05 — Infrastructure Adapters)', () => {
  let factory: QueueFactory;
  let configService: ConfigService;
  let discord: { critical: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    configService = createMockConfigService();
    discord = {
      critical: mocks.discordCritical,
      warning: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
    };
    factory = new QueueFactory(configService, discord as never);
  });

  // ── getQueue ──

  it('getQueue() creates a queue with correct name for network X', () => {
    const queue = factory.getQueue('X');

    expect(queue).toBeDefined();
    // Queue constructor called with name "spa-posting-x"
    expect(mocks.QueueMock).toHaveBeenCalledWith(
      'spa-posting-x',
      expect.objectContaining({
        connection: expect.objectContaining({
          url: 'redis://localhost:6381',
        }),
      }),
    );
  });

  it('getQueue() lowercases network name in queue name', () => {
    factory.getQueue('THREADS');

    expect(mocks.QueueMock).toHaveBeenCalledWith(
      'spa-posting-threads',
      expect.anything(),
    );
  });

  it('getQueue() returns cached queue on subsequent calls (no duplicate creation)', () => {
    const q1 = factory.getQueue('X');
    const q2 = factory.getQueue('X');

    expect(q1).toBe(q2);
    expect(mocks.QueueMock).toHaveBeenCalledTimes(1);
  });

  it('getQueue() creates separate queues for different networks', () => {
    const qX = factory.getQueue('X');
    const qT = factory.getQueue('THREADS');

    expect(qX).not.toBe(qT);
    expect(mocks.QueueMock).toHaveBeenCalledTimes(2);
  });

  // ── enqueuePosting ──

  it('enqueuePosting() adds job with postId as jobId for idempotency', async () => {
    await factory.enqueuePosting('post-123', 'X');

    expect(mocks.queueAdd).toHaveBeenCalledOnce();
    const addArgs = mocks.queueAdd.mock.calls[0]!;
    expect(addArgs[0]).toBe('post'); // job name
    expect(addArgs[1]).toEqual({ postId: 'post-123', network: 'X' });
  });

  it('enqueuePosting() sets jobId equal to postId for deduplication', async () => {
    await factory.enqueuePosting('post-456', 'THREADS');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.jobId).toBe('post-456');
  });

  it('enqueuePosting() configures retry attempts and exponential backoff', async () => {
    await factory.enqueuePosting('post-789', 'FACEBOOK');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.attempts).toBe(8); // BULLMQ_POSTING_MAX_RETRIES (default)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 120000 }); // BULLMQ_POSTING_RETRY_DELAY_MS
  });

  it('enqueuePosting() sets removeOnComplete and removeOnFail counts', async () => {
    await factory.enqueuePosting('post-000', 'X');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.removeOnComplete).toEqual({ count: 100 });
    expect(opts.removeOnFail).toEqual({ count: 500 });
  });

  it('enqueuePosting() removes existing completed job before re-enqueuing', async () => {
    const jobRemove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({
      id: 'post-done',
      getState: vi.fn().mockResolvedValue('completed'),
      remove: jobRemove,
    });

    await factory.enqueuePosting('post-done', 'X');

    expect(jobRemove).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it('enqueuePosting() removes existing failed job before re-enqueuing', async () => {
    const jobRemove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({
      id: 'post-fail',
      getState: vi.fn().mockResolvedValue('failed'),
      remove: jobRemove,
    });

    await factory.enqueuePosting('post-fail', 'X');

    expect(jobRemove).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it('enqueuePosting() removes limbo job (unknown state) before re-enqueuing', async () => {
    // BullMQ limbo: job hash exists but not in any state sorted set.
    // getState() returns 'unknown'. Without removal, queue.add() silently
    // deduplicates and the post is stuck forever.
    const jobRemove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({
      id: 'post-limbo',
      getState: vi.fn().mockResolvedValue('unknown'),
      remove: jobRemove,
    });

    await factory.enqueuePosting('post-limbo', 'THREADS');

    expect(jobRemove).toHaveBeenCalledOnce();
    expect(mocks.queueAdd).toHaveBeenCalledOnce();
  });

  it('enqueuePosting() does NOT remove active job (would duplicate)', async () => {
    const jobRemove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({
      id: 'post-active',
      getState: vi.fn().mockResolvedValue('active'),
      remove: jobRemove,
    });

    await factory.enqueuePosting('post-active', 'X');

    expect(jobRemove).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('enqueuePosting() does NOT remove delayed job (preserves scheduled delay)', async () => {
    // The PostHandler intentionally adds a 3-15 min delay. The orchestrator cycle runs
    // every 60s. If we removed delayed jobs, the delay would reset every cycle and the
    // job would never execute.
    const jobRemove = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({
      id: 'post-delayed',
      getState: vi.fn().mockResolvedValue('delayed'),
      remove: jobRemove,
    });

    await factory.enqueuePosting('post-delayed', 'X');

    expect(jobRemove).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  // ── registerWorker ──

  it('registerWorker() creates a Worker with correct queue name and concurrency', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const worker = factory.registerWorker('X', handler);

    expect(worker).toBeDefined();
    expect(mocks.WorkerMock).toHaveBeenCalledWith(
      'spa-posting-x',
      handler,
      expect.objectContaining({
        concurrency: 1,
        connection: expect.objectContaining({
          url: 'redis://localhost:6381',
        }),
      }),
    );
  });

  it('registerWorker() registers event listeners for completed, failed, stalled', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    factory.registerWorker('THREADS', handler);

    // Worker.on should be called for 'completed', 'failed', 'stalled'
    const eventTypes = mocks.workerOn.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain('completed');
    expect(eventTypes).toContain('failed');
    expect(eventTypes).toContain('stalled');
  });

  it('registerWorker() returns existing worker if already registered (no duplicate)', () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const w1 = factory.registerWorker('X', handler);
    const w2 = factory.registerWorker('X', handler);

    expect(w1).toBe(w2);
    // Worker constructor called only once
    expect(mocks.WorkerMock).toHaveBeenCalledTimes(1);
  });

  // ── getFailedJobs ──

  it('getFailedJobs() returns failed jobs from the queue', async () => {
    const failed = await factory.getFailedJobs('X');

    expect(mocks.queueGetFailed).toHaveBeenCalledOnce();
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('failed-job-1');
  });

  // ── getJobCounts ──

  it('getJobCounts() returns counts for waiting, active, completed, failed, delayed', async () => {
    const counts = await factory.getJobCounts('X');

    expect(mocks.queueGetJobCounts).toHaveBeenCalledOnce();
    expect(mocks.queueGetJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    expect(counts).toEqual({
      waiting: 2,
      active: 1,
      completed: 10,
      failed: 1,
      delayed: 0,
    });
  });

  // ── onModuleInit ──

  it('onModuleInit() logs configuration without creating queues', () => {
    expect(() => factory.onModuleInit()).not.toThrow();
    expect(mocks.QueueMock).not.toHaveBeenCalled();
  });

  // ── onModuleDestroy ──

  it('onModuleDestroy() closes all registered workers and queues', async () => {
    // Register a worker and create a queue first
    factory.registerWorker('X', vi.fn().mockResolvedValue(undefined));
    factory.getQueue('X');

    await factory.onModuleDestroy();

    expect(mocks.workerClose).toHaveBeenCalledOnce();
    expect(mocks.queueClose).toHaveBeenCalledOnce();
  });

  it('onModuleDestroy() is safe when no workers or queues registered', async () => {
    await expect(factory.onModuleDestroy()).resolves.not.toThrow();
    expect(mocks.workerClose).not.toHaveBeenCalled();
    expect(mocks.queueClose).not.toHaveBeenCalled();
  });

  // ── Custom config ──

  it('uses env-configurable max retries and retry delay', async () => {
    const customConfig = createMockConfigService({
      BULLMQ_MAX_RETRIES: 5,
      BULLMQ_RETRY_DELAY_MS: 120000,
      BULLMQ_POSTING_MAX_RETRIES: 10,
      BULLMQ_POSTING_RETRY_DELAY_MS: 180000,
    });
    const customFactory = new QueueFactory(customConfig, discord as never);

    await customFactory.enqueuePosting('post-custom', 'X');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.attempts).toBe(10); // BULLMQ_POSTING_MAX_RETRIES
    expect(opts.backoff.delay).toBe(180000); // BULLMQ_POSTING_RETRY_DELAY_MS
  });

  // ── Sprint K: Priority & Delayed Jobs (UTC-460+) ──

  it('UTC-460: enqueuePosting with priority=1 → job.add with priority opts', async () => {
    await factory.enqueuePosting('post-prio', 'X', { priority: 1 });

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.priority).toBe(1);
  });

  it('UTC-461: enqueuePosting with delay=30000 → job.add with delay', async () => {
    await factory.enqueuePosting('post-delayed', 'X', { delay: 30000 });

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.delay).toBe(30000);
  });

  it('UTC-462: enqueuePosting default priority is 10 when not specified', async () => {
    await factory.enqueuePosting('post-default-prio', 'X');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.priority).toBe(10);
  });

  // ── enqueueEngagement ──

  it('UTC-463: enqueueEngagement with action=like → correct engagement queue', async () => {
    await factory.enqueueEngagement('int-1', 'X', 'like', { targetPostId: 't123' });

    // Assert — queue name includes 'engagement'
    expect(mocks.QueueMock).toHaveBeenCalledWith(
      'spa-engagement-x',
      expect.anything(),
    );
    const addArgs = mocks.queueAdd.mock.calls[0]!;
    expect(addArgs[0]).toBe('like'); // job name = action
    expect(addArgs[1]).toMatchObject({
      interactionId: 'int-1',
      network: 'X',
      action: 'like',
      targetPostId: 't123',
    });
  });

  it('UTC-464: enqueueEngagement with delay → job.add with delay option', async () => {
    await factory.enqueueEngagement('int-2', 'THREADS', 'comment', { text: 'hi' }, { delay: 60000 });

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.delay).toBe(60000);
  });

  // ── retryFailedJob ──

  it('UTC-465: retryFailedJob: move failed → waiting (job.retry called)', async () => {
    // Arrange — mock getJob to return a failed job
    const jobRetry = vi.fn().mockResolvedValue(undefined);
    mocks.queueGetJob.mockResolvedValueOnce({ id: 'job-fail', failedReason: 'some error', retry: jobRetry });

    // Act
    await factory.retryFailedJob('X', 'job-fail');

    // Assert
    expect(mocks.queueGetJob).toHaveBeenCalledWith('job-fail');
    expect(jobRetry).toHaveBeenCalledOnce();
  });

  it('UTC-466: retryFailedJob: job not found → throws', async () => {
    mocks.queueGetJob.mockResolvedValueOnce(null);

    await expect(factory.retryFailedJob('X', 'missing')).rejects.toThrow(/not found/);
  });

  it('UTC-467: retryFailedJob: job not in failed state → throws', async () => {
    mocks.queueGetJob.mockResolvedValueOnce({ id: 'job-ok', failedReason: null, retry: vi.fn() });

    await expect(factory.retryFailedJob('X', 'job-ok')).rejects.toThrow(/not in failed state/);
  });

  // ── schedulePosting ──

  it('UTC-468: schedulePosting for future time → job.add with delay', async () => {
    // Arrange — schedule 60 seconds in the future
    const future = new Date(Date.now() + 60_000);

    // Act
    await factory.schedulePosting('post-sched', 'X', future);

    // Assert
    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.delay).toBeGreaterThan(0);
    expect(opts.delay).toBeLessThanOrEqual(60_000);
    expect(opts.jobId).toBe('post-sched');
  });

  it('UTC-469: schedulePosting for past time → enqueues immediately (no delay)', async () => {
    // Arrange — schedule in the past
    const past = new Date(Date.now() - 60_000);

    // Act
    await factory.schedulePosting('post-past', 'X', past);

    // Assert — enqueuePosting called (which adds with default opts, no delay)
    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.delay).toBeUndefined();
  });

  // ── registerWorker: event handler behavior ──

  it('UTC-470: registerWorker: failed handler sends Discord DLQ alert when retries exhausted', async () => {
    // Arrange
    const handler = vi.fn().mockResolvedValue(undefined);
    factory.registerWorker('X', handler);

    // Find the 'failed' event handler registered via worker.on
    const failedCall = mocks.workerOn.mock.calls.find((c) => c[0] === 'failed');
    expect(failedCall).toBeDefined();
    const failedHandler = failedCall![1] as (job: { id: string; attemptsMade: number }, err: Error) => void;

    // Act — simulate a job that exhausted all retries. registerWorker() defaults to the
    // 'posting' action, so the effective budget is BULLMQ_POSTING_MAX_RETRIES (8), not the
    // general-queue BULLMQ_MAX_RETRIES (3) — see queue.factory.ts registerWorker().
    const job = { id: 'job-exhausted', attemptsMade: 8 };
    const err = new Error('persistent failure');
    failedHandler(job, err);

    // Assert — Discord critical alert sent (flush microtasks)
    await vi.waitFor(() => {
      expect(mocks.discordCritical).toHaveBeenCalledOnce();
    });
    const [title, message] = mocks.discordCritical.mock.calls[0]!;
    expect(title).toContain('DLQ');
    expect(message).toContain('job-exhausted');
  });

  it('UTC-471: registerWorker: failed handler does NOT send Discord alert when retries remain', async () => {
    // Arrange
    const handler = vi.fn().mockResolvedValue(undefined);
    factory.registerWorker('X', handler);
    const failedCall = mocks.workerOn.mock.calls.find((c) => c[0] === 'failed');
    const failedHandler = failedCall![1] as (job: { id: string; attemptsMade: number }, err: Error) => void;

    // Act — only 1 attempt made (retries remain)
    failedHandler({ id: 'job-retry', attemptsMade: 1 }, new Error('transient'));

    // Assert — no Discord alert yet
    expect(mocks.discordCritical).not.toHaveBeenCalled();
  });

  // ── getFailedJobs ──

  it('UTC-472: getFailedJobs: returns DLQ jobs for engagement action', async () => {
    const failed = await factory.getFailedJobs('X', 'engagement');

    expect(mocks.queueGetFailed).toHaveBeenCalledOnce();
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('failed-job-1');
  });

  // ── getJobCounts ──

  it('UTC-473: getJobCounts: returns counts for engagement queue', async () => {
    const counts = await factory.getJobCounts('THREADS', 'engagement');

    expect(mocks.queueGetJobCounts).toHaveBeenCalledWith(
      'waiting', 'active', 'completed', 'failed', 'delayed',
    );
    expect(counts.waiting).toBe(2);
    expect(counts.failed).toBe(1);
  });

  // ── pauseQueue / resumeQueue / isQueuePaused ──

  it('UTC-474: pauseQueue → calls queue.pause()', async () => {
    await factory.pauseQueue('X');

    expect(mocks.queuePause).toHaveBeenCalledOnce();
  });

  it('UTC-475: resumeQueue → calls queue.resume()', async () => {
    await factory.resumeQueue('X');

    expect(mocks.queueResume).toHaveBeenCalledOnce();
  });

  it('UTC-476: isQueuePaused → returns queue.isPaused() result', async () => {
    mocks.queueIsPaused.mockResolvedValueOnce(true);

    const paused = await factory.isQueuePaused('X');

    expect(mocks.queueIsPaused).toHaveBeenCalledOnce();
    expect(paused).toBe(true);
  });

  it('UTC-477: isQueuePaused → false when queue not paused', async () => {
    mocks.queueIsPaused.mockResolvedValueOnce(false);

    const paused = await factory.isQueuePaused('X');

    expect(paused).toBe(false);
  });
});
