/**
 * ThreadProgressService tests — P0-H2 per-reply tracking for resumable threads.
 *
 * Tests:
 *   - initThread() creates PENDING entries for all replies
 *   - initThread() is idempotent (upsert, doesn't overwrite existing)
 *   - markReplyPosted() updates status to POSTED with URL
 *   - markReplyFailed() updates status to FAILED with error
 *   - getPendingReplies() returns only PENDING reply IDs
 *   - getThreadProgress() returns all entries ordered by position
 *   - isThreadComplete() returns true when all replies POSTED
 *   - getThreadStats() returns correct counts
 *   - Graceful handling of Prisma errors
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThreadProgressService } from "../../../src/modules/posting/thread-progress.service";
import { PrismaService } from "../../../src/infrastructure/prisma/prisma.service";

function createMockPrisma() {
  const mockThreadProgress = {
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  return {
    threadProgress: mockThreadProgress,
    _mock: mockThreadProgress,
  } as unknown as PrismaService;
}

describe("ThreadProgressService (P0-H2 — Resumable Thread Tracking)", () => {
  let service: ThreadProgressService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let mockTP: { upsert: any; update: any; findMany: any; count: any };

  beforeEach(() => {
    prisma = createMockPrisma();
    mockTP = (prisma as any).threadProgress;
    service = new ThreadProgressService(prisma);
  });

  // ── initThread ──

  it("UTC-TP-001: initThread creates PENDING entries for all replies", async () => {
    const replies = [
      { id: "reply-1", threadPosition: 1 },
      { id: "reply-2", threadPosition: 2 },
      { id: "reply-3", threadPosition: 3 },
    ];

    await service.initThread("root-1", replies);

    expect(mockTP.upsert).toHaveBeenCalledTimes(3);
    expect(mockTP.upsert).toHaveBeenCalledWith({
      where: {
        postId_replyPostId: { postId: "root-1", replyPostId: "reply-1" },
      },
      create: {
        postId: "root-1",
        replyPostId: "reply-1",
        position: 1,
        status: "PENDING",
      },
      update: {},
    });
  });

  it("UTC-TP-002: initThread is idempotent — upsert with empty update", async () => {
    const replies = [{ id: "reply-1", threadPosition: 1 }];

    await service.initThread("root-1", replies);

    // The update: {} means existing entries are not overwritten
    expect(mockTP.upsert).toHaveBeenCalledWith({
      where: {
        postId_replyPostId: { postId: "root-1", replyPostId: "reply-1" },
      },
      create: expect.any(Object),
      update: {},
    });
  });

  it("UTC-TP-003: initThread handles empty replies array", async () => {
    await service.initThread("root-1", []);
    expect(mockTP.upsert).not.toHaveBeenCalled();
  });

  it("UTC-TP-004: initThread continues on Prisma error for individual reply", async () => {
    mockTP.upsert.mockRejectedValueOnce(new Error("Unique constraint")).mockResolvedValueOnce({});

    const replies = [
      { id: "reply-1", threadPosition: 1 },
      { id: "reply-2", threadPosition: 2 },
    ];

    await service.initThread("root-1", replies);

    // Both calls made, even though first failed
    expect(mockTP.upsert).toHaveBeenCalledTimes(2);
  });

  // ── markReplyPosted ──

  it("UTC-TP-005: markReplyPosted updates status to POSTED with URL", async () => {
    await service.markReplyPosted("root-1", "reply-1", "https://x.com/status/123");

    expect(mockTP.update).toHaveBeenCalledWith({
      where: {
        postId_replyPostId: { postId: "root-1", replyPostId: "reply-1" },
      },
      data: {
        status: "POSTED",
        postUrl: "https://x.com/status/123",
        completedAt: expect.any(Date),
        error: null,
      },
    });
  });

  it("UTC-TP-006: markReplyPosted handles Prisma error gracefully", async () => {
    mockTP.update.mockRejectedValue(new Error("Record not found"));

    // Should not throw
    await expect(
      service.markReplyPosted("root-1", "reply-1", "https://x.com/status/123"),
    ).resolves.not.toThrow();
  });

  // ── markReplyFailed ──

  it("UTC-TP-007: markReplyFailed updates status to FAILED with error", async () => {
    await service.markReplyFailed("root-1", "reply-1", "Posting timeout");

    expect(mockTP.update).toHaveBeenCalledWith({
      where: {
        postId_replyPostId: { postId: "root-1", replyPostId: "reply-1" },
      },
      data: {
        status: "FAILED",
        error: "Posting timeout",
        completedAt: expect.any(Date),
      },
    });
  });

  it("UTC-TP-008: markReplyFailed handles Prisma error gracefully", async () => {
    mockTP.update.mockRejectedValue(new Error("Record not found"));

    await expect(service.markReplyFailed("root-1", "reply-1", "error")).resolves.not.toThrow();
  });

  // ── getPendingReplies ──

  it("UTC-TP-009: getPendingReplies returns only PENDING reply IDs", async () => {
    mockTP.findMany.mockResolvedValue([{ replyPostId: "reply-2" }, { replyPostId: "reply-3" }]);

    const pending = await service.getPendingReplies("root-1");

    expect(pending).toEqual(["reply-2", "reply-3"]);
    expect(mockTP.findMany).toHaveBeenCalledWith({
      where: { postId: "root-1", status: "PENDING" },
      select: { replyPostId: true },
    });
  });

  it("UTC-TP-010: getPendingReplies returns empty array when no pending", async () => {
    mockTP.findMany.mockResolvedValue([]);

    const pending = await service.getPendingReplies("root-1");
    expect(pending).toEqual([]);
  });

  // ── getThreadProgress ──

  it("UTC-TP-011: getThreadProgress returns all entries ordered by position", async () => {
    mockTP.findMany.mockResolvedValue([
      {
        replyPostId: "r1",
        position: 1,
        status: "POSTED",
        postUrl: "url1",
        error: null,
        attemptedAt: new Date(),
        completedAt: new Date(),
      },
      {
        replyPostId: "r2",
        position: 2,
        status: "PENDING",
        postUrl: null,
        error: null,
        attemptedAt: new Date(),
        completedAt: null,
      },
      {
        replyPostId: "r3",
        position: 3,
        status: "FAILED",
        postUrl: null,
        error: "timeout",
        attemptedAt: new Date(),
        completedAt: new Date(),
      },
    ]);

    const progress = await service.getThreadProgress("root-1");

    expect(progress).toHaveLength(3);
    expect(progress[0].position).toBe(1);
    expect(progress[1].position).toBe(2);
    expect(progress[2].position).toBe(3);
    expect(mockTP.findMany).toHaveBeenCalledWith({
      where: { postId: "root-1" },
      orderBy: { position: "asc" },
      select: expect.any(Object),
    });
  });

  // ── isThreadComplete ──

  it("UTC-TP-012: isThreadComplete returns true when no replies exist", async () => {
    mockTP.count.mockResolvedValue(0);

    const complete = await service.isThreadComplete("root-1");
    expect(complete).toBe(true);
  });

  it("UTC-TP-013: isThreadComplete returns true when all replies POSTED", async () => {
    mockTP.count
      .mockResolvedValueOnce(3) // total
      .mockResolvedValueOnce(3); // posted

    const complete = await service.isThreadComplete("root-1");
    expect(complete).toBe(true);
  });

  it("UTC-TP-014: isThreadComplete returns false when some replies PENDING", async () => {
    mockTP.count
      .mockResolvedValueOnce(3) // total
      .mockResolvedValueOnce(2); // posted (1 still pending)

    const complete = await service.isThreadComplete("root-1");
    expect(complete).toBe(false);
  });

  // ── getThreadStats ──

  it("UTC-TP-015: getThreadStats returns correct counts", async () => {
    mockTP.count
      .mockResolvedValueOnce(5) // total
      .mockResolvedValueOnce(3) // posted
      .mockResolvedValueOnce(1) // failed
      .mockResolvedValueOnce(1); // pending

    const stats = await service.getThreadStats("root-1");

    expect(stats).toEqual({
      total: 5,
      posted: 3,
      failed: 1,
      pending: 1,
    });
  });

  it("UTC-TP-016: getThreadStats returns zeros for empty thread", async () => {
    mockTP.count.mockResolvedValue(0);

    const stats = await service.getThreadStats("root-1");

    expect(stats).toEqual({
      total: 0,
      posted: 0,
      failed: 0,
      pending: 0,
    });
  });
});
