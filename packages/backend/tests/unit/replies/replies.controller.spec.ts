/**
 * F4: RepliesController unit tests.
 *
 * Covers REST endpoints for reply monitoring and human review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { RepliesController } from "../../../src/modules/replies/replies.controller.js";
import { RepliesMonitorService } from "../../../src/modules/replies/replies-monitor.service.js";
import { PrismaService } from "../../../src/infrastructure/prisma/prisma.service.js";
import { CommentStatus } from "../../../src/generated/prisma/client.js";

describe("F4: RepliesController", () => {
  let controller: RepliesController;
  let repliesMonitor: {
    isEnabled: ReturnType<typeof vi.fn>;
    getPendingHumanReview: ReturnType<typeof vi.fn>;
    manualReply: ReturnType<typeof vi.fn>;
    dismissReview: ReturnType<typeof vi.fn>;
    runMonitoringCycle: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    incomingComment: { count: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    repliesMonitor = {
      isEnabled: vi.fn().mockReturnValue(true),
      getPendingHumanReview: vi.fn().mockResolvedValue([]),
      manualReply: vi.fn().mockResolvedValue({ success: true }),
      dismissReview: vi.fn().mockResolvedValue(undefined),
      runMonitoringCycle: vi.fn().mockResolvedValue({
        postsChecked: 1,
        commentsScraped: 2,
        repliesPosted: 0,
        repliesScheduled: 0,
        humanReview: 1,
      }),
    };
    prisma = { incomingComment: { count: vi.fn().mockResolvedValue(0) } };
    controller = new RepliesController(
      repliesMonitor as unknown as RepliesMonitorService,
      prisma as unknown as PrismaService,
    );
  });

  it("getPending() returns pending human-review comments", async () => {
    const pending = [{ id: "c1", text: "hello" }];
    repliesMonitor.getPendingHumanReview.mockResolvedValue(pending);

    const result = await controller.getPending();

    expect(result).toBe(pending);
    expect(repliesMonitor.getPendingHumanReview).toHaveBeenCalled();
  });

  it("getStats() returns counts and enabled flag", async () => {
    prisma.incomingComment.count
      .mockResolvedValueOnce(5) // NEW
      .mockResolvedValueOnce(3) // REPLIED
      .mockResolvedValueOnce(1) // SKIPPED
      .mockResolvedValueOnce(2) // HUMAN_REVIEW
      .mockResolvedValueOnce(1); // REPLIED_MANUAL

    const result = await controller.getStats();

    expect(result).toEqual({
      enabled: true,
      counts: { new: 5, replied: 3, skipped: 1, humanReview: 2, repliedManual: 1 },
      pendingReview: 2,
    });
    expect(prisma.incomingComment.count).toHaveBeenCalledWith({
      where: { status: CommentStatus.NEW },
    });
  });

  it("manualReply() delegates to service with parsed replyText", async () => {
    const result = await controller.manualReply("c1", { replyText: "Hi there!" });

    expect(result).toEqual({ success: true });
    expect(repliesMonitor.manualReply).toHaveBeenCalledWith("c1", "Hi there!");
  });

  it("manualReply() returns validation error for invalid body", async () => {
    const result = await controller.manualReply("c1", { replyText: "" } as unknown);

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("replyText: Too small"),
    });
    expect(repliesMonitor.manualReply).not.toHaveBeenCalled();
  });

  it("manualReply() throws when replies module is disabled", async () => {
    repliesMonitor.isEnabled.mockReturnValue(false);

    await expect(controller.manualReply("c1", { replyText: "hello" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("dismiss() delegates to service and returns success", async () => {
    const result = await controller.dismiss("c1");

    expect(result).toEqual({ success: true });
    expect(repliesMonitor.dismissReview).toHaveBeenCalledWith("c1");
  });

  it("dismiss() throws when replies module is disabled", async () => {
    repliesMonitor.isEnabled.mockReturnValue(false);

    await expect(controller.dismiss("c1")).rejects.toThrow(BadRequestException);
  });

  it("runCycle() triggers monitoring and returns stats", async () => {
    const result = await controller.runCycle();

    expect(result).toEqual({
      postsChecked: 1,
      commentsScraped: 2,
      repliesPosted: 0,
      repliesScheduled: 0,
      humanReview: 1,
    });
    expect(repliesMonitor.runMonitoringCycle).toHaveBeenCalled();
  });

  it("runCycle() throws when replies module is disabled", async () => {
    repliesMonitor.isEnabled.mockReturnValue(false);

    await expect(controller.runCycle()).rejects.toThrow(BadRequestException);
  });
});
