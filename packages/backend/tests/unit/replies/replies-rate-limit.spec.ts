/**
 * F4.B: Daily per-network reply rate limit.
 */
import { describe, it, expect, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { CommentStatus } from "../../../src/generated/prisma/client.js";
import { RepliesMonitorService } from "../../../src/modules/replies/replies-monitor.service.js";

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

function mockEngagement() {
  return {
    reply: vi.fn().mockResolvedValue({ success: true, postUrl: "https://x.com/u/status/2" }),
  };
}

function mockSse() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function mockDiscord() {
  return { warning: vi.fn(), critical: vi.fn() };
}

function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    eval: vi.fn(async (_script: string, _numKeys: number, ...rest: unknown[]) => {
      const key = rest[0] as string;
      const current = Number(store.get(key)) || 0;
      // RESERVE_REPLY_SLOT_SCRIPT: key, limit, ttl
      if (rest.length === 3) {
        const limit = Number(rest[1]);
        if (limit > 0 && current >= limit) {
          return [0, current];
        }
        const next = current + 1;
        store.set(key, String(next));
        return [1, next];
      }
      // RELEASE_REPLY_SLOT_SCRIPT: key
      if (current > 0) {
        const next = current - 1;
        store.set(key, String(next));
      }
      return current;
    }),
    store,
  };
}

function makeService(overrides: { redis?: any; maxPerDay?: number } = {}) {
  const prisma = mockPrisma();
  const engagement = mockEngagement();
  const sse = mockSse();
  const redis = overrides.redis ?? makeRedis();
  const config = mockConfig({
    REPLIES_ENABLED: "true",
    REPLIES_MAX_PER_POST: "3",
    REPLIES_MAX_PER_DAY: String(overrides.maxPerDay ?? 2),
  });

  const svc = new RepliesMonitorService(
    prisma as any,
    config,
    {} as any,
    {} as any,
    { addCronJob: vi.fn() } as any,
    mockDiscord() as any,
    sse as any,
    { processComment: vi.fn().mockResolvedValue({ action: "skip" }) } as any,
    undefined,
    undefined,
    engagement as any,
    undefined,
    undefined,
    undefined,
    undefined,
    redis,
  );
  return { svc, prisma, engagement, redis };
}

const POST = {
  id: "p1",
  network: "X",
  postUrl: "https://x.com/u/status/1",
  content: "About Workflow",
};

describe("F4.B — daily reply rate limit", () => {
  it("F4-B1: allows posting while under the daily budget", async () => {
    const { svc, engagement } = makeService({ maxPerDay: 2 });

    await svc.postScheduledReply({
      commentDbId: "c1",
      commentId: "cid-1",
      postId: "p1",
      network: "X",
      postUrl: "https://x.com/u/status/1",
      replyText: "Hi",
    });

    expect(engagement.reply).toHaveBeenCalledTimes(1);
  });

  it("F4-B2: drops additional replies once the daily budget is exhausted", async () => {
    const { svc, engagement, prisma } = makeService({ maxPerDay: 1 });

    await svc.postScheduledReply({
      commentDbId: "c1",
      commentId: "cid-1",
      postId: "p1",
      network: "X",
      postUrl: "https://x.com/u/status/1",
      replyText: "First",
    });

    await svc.postScheduledReply({
      commentDbId: "c2",
      commentId: "cid-2",
      postId: "p1",
      network: "X",
      postUrl: "https://x.com/u/status/1",
      replyText: "Second",
    });

    expect(engagement.reply).toHaveBeenCalledTimes(1);
    expect(prisma.incomingComment.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "c2" },
        data: expect.objectContaining({ status: CommentStatus.SKIPPED }),
      }),
    );
  });

  it("F4-B3: releases the budget slot when posting fails", async () => {
    const { svc, engagement, redis } = makeService({ maxPerDay: 1 });
    engagement.reply.mockResolvedValueOnce({ success: false, error: "timeout" });

    await expect(
      svc.postScheduledReply({
        commentDbId: "c1",
        commentId: "cid-1",
        postId: "p1",
        network: "X",
        postUrl: "https://x.com/u/status/1",
        replyText: "Hi",
      }),
    ).rejects.toThrow(/timeout/);

    // The slot should have been released so the next reply can still be attempted.
    await svc.postScheduledReply({
      commentDbId: "c2",
      commentId: "cid-2",
      postId: "p1",
      network: "X",
      postUrl: "https://x.com/u/status/1",
      replyText: "Retry",
    });

    expect(engagement.reply).toHaveBeenCalledTimes(2);
    const key = [...redis.store.keys()].find((k) => k.startsWith("spa:replies:daily:X:"))!;
    expect(Number(redis.store.get(key))).toBe(1);
  });

  it("F4-B4: manualReply increments and respects the daily budget", async () => {
    const { svc } = makeService({ maxPerDay: 2 });

    const comment = {
      post: { postUrl: "https://x.com/u/status/1", network: "X" },
      commentUrl: null,
    };
    (svc as any).prisma = {
      incomingComment: {
        findUnique: vi.fn().mockResolvedValue(comment),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const first = await svc.manualReply("c1", "Thanks!");
    expect(first.success).toBe(true);

    const second = await svc.manualReply("c2", "Appreciate it!");
    expect(second.success).toBe(true);

    const third = await svc.manualReply("c3", "Sorry, budget reached");
    expect(third.success).toBe(false);
    expect(third.error).toMatch(/budget/i);
  });
});
