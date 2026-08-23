/**
 * M1.1 multi-account: StateCollectorService.collectFleet — per-account
 * runtime states + best-case network aggregate for WorldState.sessions.
 *
 * Source: packages/backend/src/modules/orchestrator/state-collector.service.ts
 */
import { describe, expect, it, vi } from "vitest";
import { SessionStatus, SocialNetwork } from "../../../src/generated/prisma/client.js";
import { StateCollectorService } from "../../../src/modules/orchestrator/state-collector.service.js";

function buildService(
  prismaOverrides: Record<string, unknown>,
  dependencyOverrides: Record<string, unknown> = {},
): StateCollectorService {
  const configService = {
    get: vi.fn().mockReturnValue("30"),
  } as unknown as import("@nestjs/config").ConfigService;

  const prisma = {
    socialAccount: { findMany: vi.fn().mockResolvedValue([]) },
    session: { findMany: vi.fn().mockResolvedValue([]) },
    post: { findMany: vi.fn().mockResolvedValue([]) },
    ...prismaOverrides,
  } as unknown as ConstructorParameters<typeof StateCollectorService>[0];

  return new StateCollectorService(
    prisma,
    configService,
    {} as never, // redis
    (dependencyOverrides.rateLimitService ?? {}) as never,
    (dependencyOverrides.flowControlService ?? {}) as never,
    (dependencyOverrides.queueFactory ?? {}) as never,
    {} as never, // accountsService
  );
}

const NOW = Date.now();

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-a",
    network: SocialNetwork.X,
    handle: "handle_a",
    displayName: null,
    priority: 0,
    active: true,
    warmupEnabled: false,
    warmupStartedAt: null,
    warmupDaysTotal: 7,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

describe("collectFleet — M1.1 multi-account WorldState", () => {
  it("aggregates best case across accounts: one healthy account keeps the network closed", async () => {
    const svc = buildService({
      socialAccount: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            account({ id: "acc-a", handle: "healthy" }),
            account({ id: "acc-b", handle: "failing", priority: -1 }),
          ]),
      },
      session: {
        findMany: vi.fn().mockResolvedValue([
          {
            accountId: "acc-a",
            status: SessionStatus.ACTIVE,
            lastHealthCheck: new Date(NOW - 1000),
            createdAt: new Date(NOW),
          },
        ]),
      },
      post: {
        // acc-b failure storm: ≥3 fails in the 30-min window → open breaker.
        findMany: vi.fn().mockResolvedValue([
          { accountId: "acc-b", status: "FAILED" },
          { accountId: "acc-b", status: "FAILED" },
          { accountId: "acc-b", status: "FAILED" },
        ]),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fleet = await (svc as any).collectFleet(["X"]);

    // Per-account detail
    expect(fleet.accounts.total).toBe(2);
    expect(fleet.accounts.byNetwork.X).toBe(2);
    expect(fleet.accounts.accounts["X:healthy"]).toMatchObject({
      sessionStatus: SessionStatus.ACTIVE,
      circuitBreaker: "closed",
    });
    expect(fleet.accounts.accounts["X:failing"]).toMatchObject({
      sessionStatus: "none",
      circuitBreaker: "open",
    });

    // Network aggregate: best case — healthy member wins on both dimensions.
    expect(fleet.sessions.X).toMatchObject({
      status: SessionStatus.ACTIVE,
      circuitBreaker: "closed",
      lastCheckMs: NOW - 1000,
    });
  });

  it("reports open only when EVERY member is failing; half_open when partial", async () => {
    const makeSvc = (posts: Array<{ accountId: string; status: string }>) =>
      buildService({
        socialAccount: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              account({ id: "acc-a", handle: "a" }),
              account({ id: "acc-b", handle: "b" }),
            ]),
        },
        session: { findMany: vi.fn().mockResolvedValue([]) },
        post: { findMany: vi.fn().mockResolvedValue(posts) },
      });

    const allOpen = await (
      makeSvc([
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-b", status: "FAILED" },
        { accountId: "acc-b", status: "FAILED" },
        { accountId: "acc-b", status: "FAILED" },
      ]) as any
    ).collectFleet(["X"]);
    expect(allOpen.sessions.X.circuitBreaker).toBe("open");
    expect(allOpen.sessions.X.status).toBe("unknown"); // no sessions anywhere

    const halfOpen = await (
      makeSvc([
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-b", status: "COMPLETED" },
      ]) as any
    ).collectFleet(["X"]);
    // acc-a: 1 fail / 1 total → closed by formula (total < 2); acc-b closed.
    expect(halfOpen.sessions.X.circuitBreaker).toBe("closed");

    const mixed = await (
      makeSvc([
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-a", status: "FAILED" },
        { accountId: "acc-b", status: "COMPLETED" },
      ]) as any
    ).collectFleet(["X"]);
    // acc-a half_open (1 fail / 2 total), acc-b closed → network stays closed.
    expect(mixed.sessions.X.circuitBreaker).toBe("closed");
    expect(mixed.accounts.accounts["X:a"].circuitBreaker).toBe("half_open");
  });

  it("returns an empty fleet when the network has no active accounts", async () => {
    const svc = buildService({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fleet = await (svc as any).collectFleet(["THREADS"]);
    expect(fleet.sessions).toEqual({});
    expect(fleet.accounts).toEqual({ total: 0, byNetwork: {}, accounts: {} });
  });

  it("never throws — degraded DB returns empty fleet", async () => {
    const svc = buildService({
      socialAccount: { findMany: vi.fn().mockRejectedValue(new Error("db down")) },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fleet = await (svc as any).collectFleet(["X"]);
    expect(fleet.sessions).toEqual({});
    expect(fleet.accounts.total).toBe(0);
  });

  it("exposes warm-up day for warming accounts", async () => {
    const threeDaysAgo = new Date(NOW - 3 * 86_400_000);
    const svc = buildService({
      socialAccount: {
        findMany: vi.fn().mockResolvedValue([
          account({
            id: "acc-w",
            handle: "warming",
            warmupEnabled: true,
            warmupStartedAt: threeDaysAgo,
          }),
        ]),
      },
      session: { findMany: vi.fn().mockResolvedValue([]) },
      post: { findMany: vi.fn().mockResolvedValue([]) },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fleet = await (svc as any).collectFleet(["X"]);
    expect(fleet.accounts.accounts["X:warming"].warmupEnabled).toBe(true);
    expect(fleet.accounts.accounts["X:warming"].warmupDay).toBeGreaterThanOrEqual(2);
  });
});

describe("collectQueueDepth and collectRateLimits — account isolation", () => {
  const twoAccounts = [
    account({ id: "acc-a", handle: "a" }),
    account({ id: "acc-b", handle: "b" }),
  ];

  it("keeps queue depth separate for two accounts on one network", async () => {
    const queueFactory = {
      getJobCounts: vi.fn((_network: string, _action: string, accountId?: string) =>
        Promise.resolve(
          accountId === undefined
            ? { waiting: 1, active: 1, delayed: 1 }
            : accountId === "acc-a"
              ? { waiting: 1, active: 1, delayed: 0 }
              : { waiting: 0, active: 0, delayed: 1 },
        ),
      ),
    };
    const svc = buildService(
      { socialAccount: { findMany: vi.fn().mockResolvedValue(twoAccounts) } },
      { queueFactory },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (svc as any).collectQueueDepth([SocialNetwork.X]);

    expect(snapshot.byNetwork).toEqual({ X: 3 });
    expect(snapshot.byAccount).toEqual({ "X:acc-a": 2, "X:acc-b": 1 });
    expect(queueFactory.getJobCounts).toHaveBeenCalledWith("X", "posting", "acc-a");
    expect(queueFactory.getJobCounts).toHaveBeenCalledWith("X", "posting", "acc-b");
  });

  it("keeps rate-limit snapshots separate and aggregates network capacity", async () => {
    const rateLimitService = {
      getStatus: vi.fn((_network: string, accountId?: string) =>
        Promise.resolve({
          dailyCount: accountId === "acc-a" ? 1 : 0,
          dailyLimit: 2,
          weeklyCount: accountId === "acc-a" ? 2 : 0,
          weeklyLimit: 5,
          minIntervalMs: 300_000,
          lastPostAt: accountId === "acc-a" ? NOW : null,
        }),
      ),
    };
    const svc = buildService(
      { socialAccount: { findMany: vi.fn().mockResolvedValue(twoAccounts) } },
      { rateLimitService },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await (svc as any).collectRateLimits([SocialNetwork.X]);

    expect(snapshot.byAccount["X:acc-a"]).toMatchObject({
      dailyRemaining: 1,
      weeklyRemaining: 3,
      lastPostMs: NOW,
    });
    expect(snapshot.byAccount["X:acc-b"]).toMatchObject({
      dailyRemaining: 2,
      weeklyRemaining: 5,
    });
    expect(snapshot.byNetwork.X).toMatchObject({
      dailyRemaining: 3,
      weeklyRemaining: 8,
      dailyLimit: 4,
      weeklyLimit: 10,
      lastPostMs: NOW,
    });
    expect(rateLimitService.getStatus).toHaveBeenCalledWith("X", "acc-a");
    expect(rateLimitService.getStatus).toHaveBeenCalledWith("X", "acc-b");
  });
});
