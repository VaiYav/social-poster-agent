import { describe, expect, it, vi } from "vitest";
import { FeedbackSyncService } from "../../../src/modules/evaluation/feedback-sync.service.js";

function buildContext(options: { enabled?: boolean; row?: Record<string, unknown> } = {}) {
  const prisma = {
    postReviewDecision: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "review-1",
          syncStatus: "PENDING",
          syncAttempts: 0,
          langfuseTraceId: "trace-1",
          langfuseObservationId: null,
          decision: "APPROVE_EDITED",
          reasonCodes: ["VOICE_AI_GENERIC"],
          rubric: {
            publishability: 2,
            factualSupport: 1,
            humanVoice: 0,
            hookStrength: 2,
            platformFit: 1,
          },
          comment: "Contact me at editor@example.com https://example.com",
          normalizedEditDistance: 0.2,
          ...options.row,
        },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
  const langfuse = {
    isEnabled: options.enabled ?? true,
    createScore: vi.fn().mockResolvedValue(true),
  };
  const config = {
    get: vi.fn((_key: string, fallback?: unknown) => fallback),
  };
  return {
    prisma,
    langfuse,
    service: new FeedbackSyncService(prisma as never, langfuse as never, config as never),
  };
}

describe("EVAL-502 FeedbackSyncService", () => {
  it("syncs decision, edit distance and rubric with stable idempotency ids", async () => {
    const ctx = buildContext();

    await expect(ctx.service.syncPending()).resolves.toEqual({
      examined: 1,
      synced: 1,
      failed: 0,
      skipped: 0,
    });

    expect(ctx.prisma.postReviewDecision.updateMany).toHaveBeenCalledWith({
      where: {
        id: "review-1",
        syncStatus: { in: ["PENDING", "FAILED"] },
        syncAttempts: { lt: 8 },
      },
      data: { syncStatus: "SYNCING", syncAttempts: { increment: 1 } },
    });
    expect(ctx.langfuse.createScore).toHaveBeenCalledTimes(7);
    const scoreInputs = ctx.langfuse.createScore.mock.calls.map(([input]) => input);
    expect(scoreInputs.map((input) => input.id)).toContain(
      "spa-review:review-1:human-review-decision",
    );
    expect(scoreInputs.map((input) => input.id)).toContain(
      "spa-review:review-1:human-edit-distance",
    );
    expect(scoreInputs[0].comment).toContain("[redacted-email]");
    expect(scoreInputs[0].comment).toContain("[redacted-url]");
    expect(scoreInputs[0].comment).not.toContain("editor@example.com");
    expect(ctx.prisma.postReviewDecision.update).toHaveBeenLastCalledWith({
      where: { id: "review-1" },
      data: {
        syncStatus: "SYNCED",
        lastSyncError: null,
        langfuseSyncedAt: expect.any(Date),
      },
    });
  });

  it("marks a provider failure for bounded retry reconciliation", async () => {
    const ctx = buildContext();
    ctx.langfuse.createScore.mockResolvedValue(false);

    await expect(ctx.service.syncPending()).resolves.toEqual({
      examined: 1,
      synced: 0,
      failed: 1,
      skipped: 0,
    });
    expect(ctx.prisma.postReviewDecision.update).toHaveBeenLastCalledWith({
      where: { id: "review-1" },
      data: { syncStatus: "FAILED", lastSyncError: expect.stringContaining("rejected") },
    });
  });

  it("leaves pending decisions untouched while Langfuse is disabled", async () => {
    const ctx = buildContext({ enabled: false });

    await expect(ctx.service.syncPending()).resolves.toEqual({
      examined: 0,
      synced: 0,
      failed: 0,
      skipped: 0,
    });
    expect(ctx.prisma.postReviewDecision.findMany).not.toHaveBeenCalled();
  });

  it("skips rows that cannot be linked to a trace or observation", async () => {
    const ctx = buildContext({ row: { langfuseTraceId: null, langfuseObservationId: null } });

    await expect(ctx.service.syncPending()).resolves.toEqual({
      examined: 1,
      synced: 0,
      failed: 0,
      skipped: 1,
    });
    expect(ctx.langfuse.createScore).not.toHaveBeenCalled();
    expect(ctx.prisma.postReviewDecision.update).toHaveBeenCalledWith({
      where: { id: "review-1" },
      data: { syncStatus: "SKIPPED", lastSyncError: "No Langfuse trace or observation id" },
    });
  });

  it("does not duplicate a row claimed by another sync worker", async () => {
    const ctx = buildContext();
    ctx.prisma.postReviewDecision.updateMany.mockResolvedValue({ count: 0 });

    await expect(ctx.service.syncPending()).resolves.toEqual({
      examined: 1,
      synced: 0,
      failed: 0,
      skipped: 1,
    });
    expect(ctx.langfuse.createScore).not.toHaveBeenCalled();
  });
});
