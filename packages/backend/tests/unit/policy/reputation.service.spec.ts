import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { ReputationService } from "../../../src/modules/policy/reputation.service.js";

function createService(signals: unknown[], state = "HEALTHY") {
  const prisma = {
    accountReputationState: {
      findUnique: vi.fn().mockResolvedValue({ state, version: 1 }),
      upsert: vi.fn().mockResolvedValue({ state: "WATCH", version: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    reputationSignal: {
      findMany: vi.fn().mockResolvedValue(signals),
      upsert: vi.fn().mockResolvedValue({ id: "signal-1" }),
    },
    reputationIncident: {
      create: vi.fn().mockResolvedValue({ id: "incident-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: "incident-1" }),
    },
  };
  const flowControl = {
    pauseScoped: vi.fn().mockResolvedValue(undefined),
    resumeScoped: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new ReputationService(prisma as never, flowControl as never),
    prisma,
    flowControl,
  };
}

const signal = (overrides: Record<string, unknown> = {}) => ({
  id: "signal-1",
  signalFamily: "PUBLIC_SEMANTIC",
  signalType: "negative_sentiment",
  severity: "MEDIUM",
  trustLevel: "LOW",
  ...overrides,
});

describe("POLICY-102 ReputationService", () => {
  it("keeps sentiment-only evidence at WATCH", async () => {
    const { service, prisma, flowControl } = createService([signal()]);

    const result = await service.reconcile("account-1", SocialNetwork.X);

    expect(result).toMatchObject({ state: "WATCH", changed: true });
    expect(prisma.reputationIncident.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stateAfter: "WATCH" }) }),
    );
    expect(flowControl.pauseScoped).not.toHaveBeenCalled();
  });

  it("requires independent corroboration before LIMITED", async () => {
    const { service, flowControl, prisma } = createService([
      signal({ signalFamily: "TECHNICAL", severity: "HIGH", trustLevel: "HIGH" }),
      signal({ id: "signal-2", signalFamily: "BEHAVIORAL", severity: "HIGH", trustLevel: "HIGH" }),
    ]);
    prisma.accountReputationState.upsert.mockResolvedValue({ state: "LIMITED", version: 2 });

    const result = await service.reconcile("account-1", SocialNetwork.X);

    expect(result.state).toBe("LIMITED");
    expect(flowControl.pauseScoped).toHaveBeenCalledWith(
      "engagement",
      "account-1",
      expect.stringContaining("LIMITED"),
    );
  });

  it("turns a trusted policy violation into INCIDENT and pauses both side-effect scopes", async () => {
    const { service, flowControl, prisma } = createService([
      signal({
        signalType: "policy_violation",
        signalFamily: "TECHNICAL",
        severity: "CRITICAL",
        trustLevel: "HIGH",
      }),
    ]);
    prisma.accountReputationState.upsert.mockResolvedValue({ state: "INCIDENT", version: 2 });

    const result = await service.reconcile("account-1", SocialNetwork.X);

    expect(result.state).toBe("INCIDENT");
    expect(flowControl.pauseScoped).toHaveBeenCalledTimes(2);
    expect(flowControl.pauseScoped).toHaveBeenCalledWith(
      "posting",
      "account-1",
      expect.any(String),
    );
  });

  it("rejects a direct INCIDENT to HEALTHY recovery jump", async () => {
    const { service } = createService([], "INCIDENT");

    await expect(
      service.recover({
        accountId: "account-1",
        network: SocialNetwork.X,
        expectedVersion: 1,
        targetState: "HEALTHY" as never,
        reviewer: "operator",
        reason: "incident contained",
      }),
    ).rejects.toThrow("INCIDENT requires staged recovery");
  });
});
