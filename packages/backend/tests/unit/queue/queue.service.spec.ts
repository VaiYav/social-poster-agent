/**
 * MOD-06: QueueService unit tests.
 *
 * Tests the queue service's DTO mapping for failed jobs and verifies
 * that raw BullMQ Job fields are not exposed through the REST API.
 *
 * Source: packages/backend/src/modules/queue/queue.service.ts
 * Traces to: REQ-032, REQ-033
 */
import { describe, it, expect, vi } from 'vitest';
import { QueueService } from '../../../src/modules/queue/queue.service';
import { QueueFactory } from '../../../src/infrastructure/queue/queue.factory';

describe('QueueService', () => {
  it('P2-2.1.3: getFailedJobs maps raw BullMQ jobs to sanitized QueueJobDto', async () => {
    const mockJob = {
      id: 'job-1',
      name: 'post',
      data: { postId: 'post-1' },
      failedReason: 'network error',
      attemptsMade: 3,
      opts: { attempts: 8 },
      timestamp: 123456789,
      processedOn: 123456790,
      finishedOn: 123456791,
      returnvalue: undefined,
      // Raw BullMQ Job fields that should NOT appear in the API response
      queue: { name: 'spa-posting-x' },
      moveToFailed: vi.fn(),
      storageState: 'sensitive',
      credentials: 'secret',
    };

    const queueFactory = {
      getFailedJobs: vi.fn().mockResolvedValue([mockJob]),
    } as unknown as QueueFactory;

    const service = new QueueService(queueFactory);
    const result = await service.getFailedJobs('X');

    expect(queueFactory.getFailedJobs).toHaveBeenCalledWith('X');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: 'job-1',
        name: 'post',
        data: { postId: 'post-1' },
        failedReason: 'network error',
        attemptsMade: 3,
        totalAttempts: 8,
        status: 'failed',
        timestamp: 123456789,
        processedOn: 123456790,
        finishedOn: 123456791,
        returnValue: undefined,
      }),
    );

    expect(result[0]).not.toHaveProperty('queue');
    expect(result[0]).not.toHaveProperty('moveToFailed');
    expect(result[0]).not.toHaveProperty('storageState');
    expect(result[0]).not.toHaveProperty('credentials');
    expect(result[0]).not.toHaveProperty('opts');
  });
});
