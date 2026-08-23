import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { PostStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";
import { QueueTriageService } from "../../../src/modules/queue/queue-triage.service.js";

type AnyMock = ReturnType<typeof vi.fn>;

function createJob(
  id: string,
  failedReason: string,
  options: { attemptsMade?: number; attempts?: number; postId?: string } = {},
): Job {
  return {
    id,
    data: { postId: options.postId ?? id },
    failedReason,
    attemptsMade: options.attemptsMade ?? 1,
    opts: { attempts: options.attempts ?? 3 },
  } as unknown as Job;
}

function createConfig(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string, fallback?: unknown) => (key in values ? values[key] : fallback)),
  };
}

function createMocks() {
  const failedJobs: Job[] = [];
  const posts = new Map<string, Record<string, unknown>>();
  const removedJobs = new Map<string, AnyMock>();
  const queue = {
    getJob: vi.fn(async (id: string) => {
      if (!failedJobs.some((job) => String(job.id) === id)) return undefined;
      const remove = removedJobs.get(id) ?? vi.fn().mockResolvedValue(undefined);
      removedJobs.set(id, remove);
      return { remove };
    }),
  };
  const mocks = {
    failedJobs,
    posts,
    removedJobs,
    queue,
    queueFactory: {
      getFailedJobs: vi.fn().mockResolvedValue(failedJobs),
      retryFailedJob: vi.fn().mockResolvedValue(undefined),
      enqueuePosting: vi.fn().mockResolvedValue(undefined),
      getQueue: vi.fn().mockReturnValue(queue),
    },
    prisma: {
      post: {
        findMany: vi.fn(async () => [...posts.values()]),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => posts.get(where.id)),
        update: vi.fn().mockResolvedValue(undefined),
      },
    },
    llm: {
      generateChat: vi.fn().mockResolvedValue({
        content: JSON.stringify({ decisions: [] }),
        model: "mock-utility",
      }),
    },
    promptPort: undefined as undefined | { getCompiledChat: AnyMock },
    sse: { publish: vi.fn().mockResolvedValue(undefined) },
    flowControl: { isPaused: vi.fn().mockResolvedValue(false) },
  };
  return mocks;
}

function buildService(
  mocks: ReturnType<typeof createMocks>,
  configValues: Record<string, unknown> = { LLM_QUEUE_TRIAGE_ENABLED: "true" },
) {
  return new QueueTriageService(
    mocks.queueFactory as never,
    mocks.prisma as never,
    createConfig(configValues) as never,
    mocks.llm as never,
    mocks.promptPort as never,
    mocks.sse as never,
    mocks.flowControl as never,
  );
}

describe("QueueTriageService behavior", () => {
  const originalEnabledNetworks = process.env.ENABLED_NETWORKS;

  beforeEach(() => {
    process.env.ENABLED_NETWORKS = "X,THREADS";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnabledNetworks === undefined) delete process.env.ENABLED_NETWORKS;
    else process.env.ENABLED_NETWORKS = originalEnabledNetworks;
  });

  it("applies deterministic filters and LLM decisions with safety counters", async () => {
    const mocks = createMocks();
    const records = [
      {
        id: "p-rate",
        status: PostStatus.APPROVED,
        approvedAt: new Date("2026-08-23T10:00:00.000Z"),
        content: "rate limited content",
        errorMessage: null,
        network: SocialNetwork.X,
        accountId: "acc-x",
      },
      {
        id: "p-terminal",
        status: PostStatus.FAILED,
        approvedAt: null,
        content: "terminal content",
        errorMessage: "old failure",
        network: SocialNetwork.X,
        accountId: "acc-x",
      },
      {
        id: "p-retry",
        status: PostStatus.APPROVED,
        approvedAt: new Date("2026-08-23T10:00:00.000Z"),
        content: "retry content",
        errorMessage: null,
        network: SocialNetwork.X,
        accountId: "acc-x",
      },
      {
        id: "p-banned",
        status: PostStatus.APPROVED,
        approvedAt: new Date("2026-08-23T10:00:00.000Z"),
        content: "banned account content",
        errorMessage: null,
        network: SocialNetwork.X,
        accountId: "acc-x",
      },
      {
        id: "p-llm",
        status: PostStatus.APPROVED,
        approvedAt: new Date("2026-08-23T10:00:00.000Z"),
        content: "needs operator review",
        errorMessage: null,
        network: SocialNetwork.X,
        accountId: "acc-x",
      },
    ];
    for (const record of records) mocks.posts.set(record.id, record);
    mocks.failedJobs.push(
      createJob("p-rate", "rate limited: daily limit", { attemptsMade: 2 }),
      createJob("p-terminal", "stale job", { attemptsMade: 3 }),
      createJob("p-retry", "temporary network timeout", { attemptsMade: 1 }),
      createJob("p-banned", "account banned by platform", { attemptsMade: 1 }),
      createJob("p-llm", "provider returned an unusual response", { attemptsMade: 3 }),
    );
    mocks.llm.generateChat.mockResolvedValue({
      content: JSON.stringify({
        decisions: [
          {
            postId: "p-llm",
            decision: "ESCALATE",
            reason: "Needs operator review",
          },
        ],
      }),
      model: "mock-utility",
    });

    const result = await buildService(mocks).triageNetwork(SocialNetwork.X);

    expect(result).toMatchObject({
      network: SocialNetwork.X,
      examined: 5,
      retried: 1,
      requeuedDelayed: 1,
      rejected: 2,
      escalated: 1,
      skipped: 0,
      errors: 0,
    });
    expect(result.decisions.map((decision) => decision.postId)).toEqual([
      "p-rate",
      "p-terminal",
      "p-retry",
      "p-banned",
      "p-llm",
    ]);
    expect(mocks.queueFactory.enqueuePosting).toHaveBeenCalledWith(
      "p-rate",
      SocialNetwork.X,
      { delay: 60 * 60 * 1000 },
      "acc-x",
    );
    expect(mocks.queueFactory.retryFailedJob).toHaveBeenCalledWith(SocialNetwork.X, "p-retry");
    expect(mocks.prisma.post.update).toHaveBeenCalledWith({
      where: { id: "p-banned" },
      data: {
        status: PostStatus.FAILED,
        errorMessage: "LLM triage REJECT: Hard-filter: permanent failure (banned/disabled/deleted)",
      },
    });
    expect(mocks.sse.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "health_alert", severity: "warning" }),
    );
    expect(mocks.llm.generateChat).toHaveBeenCalledWith(
      expect.stringContaining("queue triage"),
      expect.stringContaining("p-llm"),
      { temperature: 0.1, maxTokens: 800, role: "utility" },
    );
  });

  it("supports prompt management and dry-run without applying side effects", async () => {
    const mocks = createMocks();
    const promptPort = { getCompiledChat: vi.fn() };
    mocks.promptPort = promptPort;
    mocks.posts.set("p-dry", {
      id: "p-dry",
      status: PostStatus.APPROVED,
      approvedAt: new Date("2026-08-23T10:00:00.000Z"),
      content: "dry run",
      errorMessage: null,
      network: SocialNetwork.X,
      accountId: "acc-x",
    });
    mocks.failedJobs.push(createJob("p-dry", "provider response requires review"));
    promptPort.getCompiledChat.mockResolvedValue({
      systemPrompt: "compiled system",
      userPrompt: "compiled user",
    });
    mocks.llm.generateChat.mockResolvedValue({
      content: JSON.stringify({
        decisions: [
          {
            postId: "p-dry",
            decision: "REQUEUE_DELAY",
            delayMinutes: 5,
            reason: "retry after cooldown",
          },
        ],
      }),
      model: "mock-utility",
    });

    const result = await buildService(mocks).triageNetwork(SocialNetwork.X, { dryRun: true });

    expect(result).toMatchObject({ examined: 1, requeuedDelayed: 0, dryRun: true });
    expect(result.decisions).toEqual([
      {
        postId: "p-dry",
        decision: "REQUEUE_DELAY",
        delayMinutes: 5,
        reason: "retry after cooldown",
      },
    ]);
    expect(promptPort.getCompiledChat).toHaveBeenCalledWith(
      "queue-triage",
      expect.objectContaining({ batch: expect.stringContaining("p-dry") }),
      expect.any(Object),
    );
    expect(mocks.queueFactory.enqueuePosting).not.toHaveBeenCalled();
    expect(mocks.prisma.post.update).not.toHaveBeenCalled();
  });

  it("returns empty results for disabled, unavailable, and paused triage", async () => {
    const disabled = createMocks();
    expect(await buildService(disabled, { LLM_QUEUE_TRIAGE_ENABLED: "false" }).triageAll()).toEqual(
      [],
    );

    const withoutLlm = createMocks();
    const noLlmService = new QueueTriageService(
      withoutLlm.queueFactory as never,
      withoutLlm.prisma as never,
      createConfig({ LLM_QUEUE_TRIAGE_ENABLED: "true" }) as never,
      undefined,
      undefined,
      undefined,
      withoutLlm.flowControl as never,
    );
    expect(await noLlmService.triageAll()).toEqual([]);

    const paused = createMocks();
    paused.flowControl.isPaused.mockResolvedValue(true);
    const pausedResult = await buildService(paused).triageNetwork(SocialNetwork.X);
    expect(pausedResult).toMatchObject({ network: SocialNetwork.X, examined: 0, skipped: 0 });
    expect(paused.queueFactory.getFailedJobs).not.toHaveBeenCalled();
  });

  it("limits the examined batch and reports an apply error without aborting the cycle", async () => {
    const mocks = createMocks();
    mocks.posts.set("p-error", {
      id: "p-error",
      status: PostStatus.APPROVED,
      approvedAt: new Date("2026-08-23T10:00:00.000Z"),
      content: "error path",
      errorMessage: null,
      network: SocialNetwork.X,
      accountId: "acc-x",
    });
    mocks.failedJobs.push(
      createJob("p-error", "temporary network timeout"),
      createJob("p-extra", "temporary network timeout"),
    );
    mocks.queueFactory.retryFailedJob.mockRejectedValueOnce(new Error("queue unavailable"));

    const result = await buildService(mocks, {
      LLM_QUEUE_TRIAGE_ENABLED: "true",
      LLM_QUEUE_TRIAGE_MAX_JOBS: "1",
    }).triageNetwork(SocialNetwork.X);

    expect(result).toMatchObject({ examined: 1, errors: 1, retried: 0 });
    expect(mocks.prisma.post.update).not.toHaveBeenCalled();
  });

  it("skips missing, mismatched, and non-approved posts while allowing stale rejects", async () => {
    const mocks = createMocks();
    mocks.posts.set("p-other-network", {
      id: "p-other-network",
      status: PostStatus.APPROVED,
      network: SocialNetwork.THREADS,
      accountId: "acc-threads",
    });
    mocks.posts.set("p-draft", {
      id: "p-draft",
      status: PostStatus.DRAFT,
      network: SocialNetwork.X,
      accountId: "acc-x",
    });
    const service = buildService(mocks);
    const result = {
      network: SocialNetwork.X,
      examined: 0,
      retried: 0,
      requeuedDelayed: 0,
      rejected: 0,
      escalated: 0,
      skipped: 0,
      errors: 0,
      decisions: [],
    };
    const apply = (service as unknown as Record<string, (...args: unknown[]) => Promise<void>>)[
      "applyDecision"
    ]!.bind(service);

    await apply(
      SocialNetwork.X,
      {
        postId: "missing-reject",
        decision: "REJECT",
        reason: "stale",
      },
      result,
    );
    await apply(
      SocialNetwork.X,
      {
        postId: "missing-retry",
        decision: "RETRY",
        reason: "retry",
      },
      result,
    );
    await apply(
      SocialNetwork.X,
      {
        postId: "p-other-network",
        decision: "RETRY",
        reason: "retry",
      },
      result,
    );
    await apply(
      SocialNetwork.X,
      {
        postId: "p-draft",
        decision: "RETRY",
        reason: "retry",
      },
      result,
    );

    expect(result).toMatchObject({ rejected: 1, skipped: 3, errors: 0 });
    expect(mocks.queue.getJob).toHaveBeenCalledWith("missing-reject");
  });
});
