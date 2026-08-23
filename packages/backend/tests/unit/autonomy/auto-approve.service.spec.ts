/**
 * A1/BUG-12: AutoApproveService is the single decision-gate.
 *
 * It is the ONLY place that maps an LLM quality score to a decision. The key
 * regression here is BUG-12: with AUTO_APPROVE_MIN_SCORE=7 and
 * AUTO_APPROVE_REVIEW_SCORE=4, scores 4/5/6 must land in HUMAN_REVIEW (stay
 * DRAFT), not REJECT — previously an AutoCheck score floor of 6 pre-rejected
 * 4/5 before this matrix ever ran.
 *
 * Source: packages/backend/src/modules/autonomy/auto-approve.service.ts
 */
import { describe, it, expect, vi } from "vitest";
import { PostStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";

import { AutoApproveService } from "../../../src/modules/autonomy/auto-approve.service.js";

import type { JudgeScores } from "@spa/shared";

function build(
  opts: {
    enabled?: boolean;
    checkPassed?: boolean;
    status?: PostStatus;
    failOpenMissingScore?: boolean;
    useJudgeScores?: boolean;
  } = {},
) {
  const {
    enabled = true,
    checkPassed = true,
    status = PostStatus.DRAFT,
    failOpenMissingScore = false,
    useJudgeScores = true,
  } = opts;

  const cfg: Record<string, unknown> = {
    AUTO_APPROVE_ENABLED: enabled ? "true" : "false",
    AUTO_APPROVE_MIN_SCORE: 7,
    AUTO_APPROVE_REVIEW_SCORE: 4,
    AUTO_APPROVE_REJECT_STREAK_ALERT: 3,
    AUTO_APPROVE_MISSING_SCORE_FAIL_OPEN: failOpenMissingScore ? "true" : "false",
    AUTO_APPROVE_USE_JUDGE_SCORES: useJudgeScores ? "true" : "false",
    AUTO_APPROVE_MIN_JUDGE_ANTI_AI: 0.6,
    AUTO_APPROVE_MIN_JUDGE_FACTUAL: 0.5,
    AUTO_APPROVE_MIN_JUDGE_HOOK: 0.0,
    AUTO_APPROVE_MIN_JUDGE_CHARACTER: 0.0,
  };
  const configService = { get: vi.fn((k: string, d?: unknown) => cfg[k] ?? d) };

  const prisma = {
    post: {
      findUnique: vi.fn().mockResolvedValue({ status, llmMetadata: {} }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]), // reject-streak lookup → no alert
    },
  };
  const sseService = { publish: vi.fn().mockResolvedValue(undefined) };
  const autoCheck = {
    check: vi
      .fn()
      .mockResolvedValue(
        checkPassed
          ? { passed: true, checks: [] }
          : { passed: false, checks: [], rejectionReason: "forbidden_phrases: brand violation" },
      ),
  };

  const service = new AutoApproveService(
    configService as never,
    prisma as never,
    sseService as never,
    autoCheck as never,
  );
  return { service, prisma, sseService, autoCheck, configService };
}

const passingJudgeScores = (): JudgeScores => ({
  anti_ai_tone: 0.8,
  anti_ai_tone_reason: "sounds human",
  hook_strength: 0.7,
  hook_strength_reason: "strong hook",
  factual_accuracy: 0.9,
  factual_accuracy_reason: "facts correct",
  character_limit: 1.0,
  character_limit_reason: "fits",
});

const evalArgs = (score?: number, judgeScores?: JudgeScores) =>
  [
    "p1",
    "some clean content",
    SocialNetwork.X,
    score,
    judgeScores ?? passingJudgeScores(),
  ] as const;
const writtenStatus = (prisma: { post: { updateMany: { mock: { calls: unknown[][] } } } }) =>
  (prisma.post.updateMany.mock.calls[0]![0] as { data: { status: PostStatus } }).data.status;

describe("AutoApproveService.evaluate (A1/BUG-12 — single decision-gate)", () => {
  it("score ≥ AUTO_APPROVE_MIN_SCORE (7) → AUTO_APPROVE (status APPROVED)", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate(...evalArgs(7));

    expect(res.decision).toBe("AUTO_APPROVE");
    expect(writtenStatus(prisma)).toBe(PostStatus.APPROVED);
  });

  // BUG-12: the [review, approve) band must be reachable.
  it.each([4, 5, 6])(
    "score %d → HUMAN_REVIEW (stays DRAFT), NOT reject (BUG-12)",
    async (score) => {
      const { service, prisma } = build();
      const res = await service.evaluate(...evalArgs(score));

      expect(res.decision).toBe("HUMAN_REVIEW");
      expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
    },
  );

  it("score < AUTO_APPROVE_REVIEW_SCORE (4) → REJECT (status REJECTED)", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate(...evalArgs(3));

    expect(res.decision).toBe("REJECT");
    expect(writtenStatus(prisma)).toBe(PostStatus.REJECTED);
  });

  it("missing score + enabled → HUMAN_REVIEW (fail-closed) by default", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate(...evalArgs(undefined));

    expect(res.decision).toBe("HUMAN_REVIEW");
    expect(res.reason).toMatch(/Missing quality score.*human review/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
  });

  it("missing score + enabled + fail-open → AUTO_APPROVE (AutoCheck passed, safe to publish)", async () => {
    const { service, prisma } = build({ failOpenMissingScore: true });
    const res = await service.evaluate(...evalArgs(undefined));

    expect(res.decision).toBe("AUTO_APPROVE");
    expect(res.reason).toMatch(/Missing quality score.*AutoCheck passed/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.APPROVED);
  });

  it("AutoCheck content failure → REJECT regardless of a high score", async () => {
    const { service } = build({ checkPassed: false });
    const res = await service.evaluate(...evalArgs(9));

    expect(res.decision).toBe("REJECT");
    expect(res.reason).toMatch(/AutoCheck failed/i);
  });

  it("auto-approve disabled → HUMAN_REVIEW even for a top score (stays DRAFT)", async () => {
    const { service, prisma } = build({ enabled: false });
    const res = await service.evaluate(...evalArgs(9));

    expect(res.decision).toBe("HUMAN_REVIEW");
    expect(res.reason).toMatch(/disabled/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
  });

  it("P1: high quality score but judge anti_ai below threshold → HUMAN_REVIEW", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate(
      ...evalArgs(9, { ...passingJudgeScores(), anti_ai_tone: 0.5 }),
    );

    expect(res.decision).toBe("HUMAN_REVIEW");
    expect(res.reason).toMatch(/judge.*anti-ai tone/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
  });

  it("P1: high quality score but judge factual below threshold → HUMAN_REVIEW", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate(
      ...evalArgs(9, { ...passingJudgeScores(), factual_accuracy: 0.4 }),
    );

    expect(res.decision).toBe("HUMAN_REVIEW");
    expect(res.reason).toMatch(/judge.*factual accuracy/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
  });

  it("P1: high quality score + missing judge scores → HUMAN_REVIEW (fail-closed)", async () => {
    const { service, prisma } = build();
    const res = await service.evaluate("p1", "some clean content", SocialNetwork.X, 9, undefined);

    expect(res.decision).toBe("HUMAN_REVIEW");
    expect(res.reason).toMatch(/judge scores missing/i);
    expect(writtenStatus(prisma)).toBe(PostStatus.DRAFT);
  });

  it("P1: high quality score with judge disabled falls back to score-only auto-approve", async () => {
    const { service, prisma } = build({ useJudgeScores: false });
    const res = await service.evaluate("p1", "some clean content", SocialNetwork.X, 9, undefined);

    expect(res.decision).toBe("AUTO_APPROVE");
    expect(writtenStatus(prisma)).toBe(PostStatus.APPROVED);
  });

  it("AU3 idempotency: post no longer DRAFT → SKIP, no write", async () => {
    const { service, prisma } = build({ status: PostStatus.APPROVED });
    const res = await service.evaluate(...evalArgs(9));

    expect(res.decision).toBe("SKIP");
    expect(prisma.post.updateMany).not.toHaveBeenCalled();
  });

  it("P2-2.2.3: consecutive reject streak within 1 hour triggers health alert", async () => {
    const { service, prisma, sseService } = build();
    const now = new Date();
    prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.REJECTED, createdAt: now },
      { status: PostStatus.REJECTED, createdAt: now },
      { status: PostStatus.REJECTED, createdAt: now },
    ]);

    await service.evaluate(...evalArgs(3));

    const alert = sseService.publish.mock.calls.find(
      (c: unknown[]) => (c[0] as { type: string }).type === "health_alert",
    );
    expect(alert).toBeDefined();
  });

  it("P2-2.2.3: non-consecutive rejects do NOT trigger health alert", async () => {
    const { service, prisma, sseService } = build();
    const now = new Date();
    prisma.post.findMany.mockResolvedValue([
      { status: PostStatus.REJECTED, createdAt: now },
      { status: PostStatus.APPROVED, createdAt: now },
      { status: PostStatus.REJECTED, createdAt: now },
    ]);

    await service.evaluate(...evalArgs(3));

    const alert = sseService.publish.mock.calls.find(
      (c: unknown[]) => (c[0] as { type: string }).type === "health_alert",
    );
    expect(alert).toBeUndefined();
  });
});
