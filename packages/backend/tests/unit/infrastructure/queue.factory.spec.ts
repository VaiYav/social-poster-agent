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
  queueClose: vi.fn().mockResolvedValue(undefined),
  workerClose: vi.fn().mockResolvedValue(undefined),
  workerOn: vi.fn(),
  QueueMock: vi.fn(),
  WorkerMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: mocks.QueueMock.mockImplementation(() => ({
    add: mocks.queueAdd,
    getFailed: mocks.queueGetFailed,
    getJobCounts: mocks.queueGetJobCounts,
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

  beforeEach(() => {
    vi.clearAllMocks();
    configService = createMockConfigService();
    factory = new QueueFactory(configService);
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
    expect(opts.attempts).toBe(3); // BULLMQ_MAX_RETRIES
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 60000 });
  });

  it('enqueuePosting() sets removeOnComplete and removeOnFail counts', async () => {
    await factory.enqueuePosting('post-000', 'X');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.removeOnComplete).toEqual({ count: 100 });
    expect(opts.removeOnFail).toEqual({ count: 500 });
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
    });
    const customFactory = new QueueFactory(customConfig);

    await customFactory.enqueuePosting('post-custom', 'X');

    const addArgs = mocks.queueAdd.mock.calls[0]!;
    const opts = addArgs[2];
    expect(opts.attempts).toBe(5);
    expect(opts.backoff.delay).toBe(120000);
  });
});
