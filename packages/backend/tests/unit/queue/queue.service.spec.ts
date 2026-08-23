/**
 * MOD-06: QueueService unit tests.
 *
 * Tests the queue service's DTO mapping for failed jobs and verifies
 * that raw BullMQ Job fields are not exposed through the REST API.
 *
 * Source: packages/backend/src/modules/queue/queue.service.ts
 * Traces to: REQ-032, REQ-033
 */
import { describe, it, expect, vi } from "vitest";
import { QueueService } from "../../../src/modules/queue/queue.service.js";
import { QueueFactory } from "../../../src/infrastructure/queue/queue.factory.js";

describe("QueueService", () => {
  it("P2-2.1.3: getFailedJobs maps raw BullMQ jobs to sanitized QueueJobDto", async () => {
    const mockJob = {
      id: "job-1",
      name: "post",
      data: { postId: "post-1" },
      failedReason: "network error",
      attemptsMade: 3,
      opts: { attempts: 8 },
      timestamp: 123456789,
      processedOn: 123456790,
      finishedOn: 123456791,
      returnvalue: undefined,
      // Raw BullMQ Job fields that should NOT appear in the API response
      queue: { name: "spa-posting-x" },
      moveToFailed: vi.fn(),
      storageState: "sensitive",
      credentials: "secret",
    };

    const queueFactory = {
      getFailedJobs: vi.fn().mockResolvedValue([mockJob]),
    } as unknown as QueueFactory;

    const service = new QueueService(queueFactory);
    const result = await service.getFailedJobs("X");

    expect(queueFactory.getFailedJobs).toHaveBeenCalledWith("X");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        id: "job-1",
        name: "post",
        data: { postId: "post-1" },
        failedReason: "network error",
        attemptsMade: 3,
        totalAttempts: 8,
        status: "failed",
        timestamp: 123456789,
        processedOn: 123456790,
        finishedOn: 123456791,
        returnValue: undefined,
      }),
    );

    expect(result[0]).not.toHaveProperty("queue");
    expect(result[0]).not.toHaveProperty("moveToFailed");
    expect(result[0]).not.toHaveProperty("storageState");
    expect(result[0]).not.toHaveProperty("credentials");
    expect(result[0]).not.toHaveProperty("opts");
  });

  it("delegates enqueue, counts, pause/resume, pause status, and completed cleanup", async () => {
    const queueFactory = {
      enqueuePosting: vi.fn().mockResolvedValue(undefined),
      getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1 }),
      pauseQueue: vi.fn().mockResolvedValue(undefined),
      resumeQueue: vi.fn().mockResolvedValue(undefined),
      isQueuePaused: vi.fn().mockResolvedValue(true),
      clearCompletedJobs: vi.fn().mockResolvedValue(4),
    } as unknown as QueueFactory;
    const service = new QueueService(queueFactory);

    await service.enqueuePosting("post-1", "X", { delay: 500 }, "account-1");
    await expect(service.getJobCounts("X")).resolves.toEqual({ waiting: 2, active: 1 });
    await service.pauseQueue("X");
    await service.resumeQueue("X");
    await expect(service.isQueuePaused("X")).resolves.toBe(true);
    await expect(service.clearCompleted("X")).resolves.toBe(4);

    expect(queueFactory.enqueuePosting).toHaveBeenCalledWith(
      "post-1",
      "X",
      { delay: 500 },
      "account-1",
    );
    expect(queueFactory.getJobCounts).toHaveBeenCalledWith("X");
    expect(queueFactory.pauseQueue).toHaveBeenCalledWith("X");
    expect(queueFactory.resumeQueue).toHaveBeenCalledWith("X");
    expect(queueFactory.isQueuePaused).toHaveBeenCalledWith("X");
    expect(queueFactory.clearCompletedJobs).toHaveBeenCalledWith("X");
  });

  it("retries only eligible failed jobs and continues after individual failures", async () => {
    const jobs = [
      { id: "retry-1", failedReason: "temporary browser timeout" },
      { id: "rate-1", failedReason: "rate limit reached" },
      { id: undefined, failedReason: "temporary network error" },
      { id: "retry-2", failedReason: "provider unavailable" },
    ];
    const queueFactory = {
      getFailedJobs: vi.fn().mockResolvedValue(jobs),
      retryFailedJob: vi.fn().mockImplementation(async (_network: string, id: string) => {
        if (id === "retry-2") throw new Error("queue unavailable");
      }),
    } as unknown as QueueFactory;
    const service = new QueueService(queueFactory);

    await expect(service.retryAllFailed("X")).resolves.toBe(1);
    expect(queueFactory.retryFailedJob).toHaveBeenCalledTimes(2);
    expect(queueFactory.retryFailedJob).toHaveBeenNthCalledWith(1, "X", "retry-1");
    expect(queueFactory.retryFailedJob).toHaveBeenNthCalledWith(2, "X", "retry-2");
  });

  it("maps optional BullMQ fields to safe defaults", async () => {
    const queueFactory = {
      getFailedJobs: vi.fn().mockResolvedValue([
        {
          name: "post",
          data: { postId: "post-2" },
          timestamp: 0,
        },
      ]),
    } as unknown as QueueFactory;
    const service = new QueueService(queueFactory);

    await expect(service.getFailedJobs("THREADS")).resolves.toEqual([
      expect.objectContaining({
        name: "post",
        attemptsMade: 0,
        totalAttempts: 1,
        status: "failed",
        timestamp: 0,
      }),
    ]);
  });
});
