import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { PlatformPolicyService } from "../../../src/modules/policy/platform-policy.service.js";
import type { AuthorizePlatformActionParams } from "../../../src/modules/policy/policy.types.js";

const params: AuthorizePlatformActionParams = {
  accountId: "account-1",
  network: SocialNetwork.X,
  action: "REPLY",
  transport: "BROWSER",
  targetRelationship: "UNKNOWN",
  contentRiskTier: "LOW",
  requestedMode: "APPROVED_AUTOMATION",
};

function policy(id: string, executionMode: string, expiresAt = new Date(Date.now() + 60_000)) {
  return {
    id,
    executionMode,
    transport: "BROWSER",
    targetRelationship: "UNKNOWN",
    effectiveAt: new Date(Date.now() - 60_000),
    expiresAt,
    evidence: {
      id: `evidence-${id}`,
      status: "VERIFIED",
      expiresAt,
    },
    requirements: ["reviewed-primary-source"],
  };
}

function createService(policies: unknown[]) {
  const prisma = {
    platformActionPolicy: {
      findMany: vi.fn().mockResolvedValue(policies),
      findFirst: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    compiledExecutionPolicy: {
      create: vi.fn().mockResolvedValue({ id: "compiled-1" }),
      upsert: vi.fn().mockResolvedValue({ id: "compiled-1" }),
    },
  };
  const flowControl = { isPaused: vi.fn().mockResolvedValue(false) };
  return {
    service: new PlatformPolicyService(prisma as never, flowControl as never),
    prisma,
    flowControl,
  };
}

describe("POLICY-101 PlatformPolicyService", () => {
  it("fails closed when no current verified policy matches", async () => {
    const { service, prisma } = createService([]);

    const decision = await service.authorize(params);

    expect(decision.allowedMode).toBe("DISABLED");
    expect(decision.blockReasons).toContain("No active policy backed by current verified evidence");
    expect(prisma.compiledExecutionPolicy.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ executionMode: "DISABLED" }) }),
    );
  });

  it("compiles the most restrictive mode across matching policies", async () => {
    const { service } = createService([
      policy("policy-suggest", "SUGGEST_ONLY"),
      policy("policy-human", "HUMAN_APPROVAL_REQUIRED"),
      policy("policy-other", "APPROVED_AUTOMATION"),
    ]);

    const decision = await service.authorize(params);

    expect(decision.allowedMode).toBe("SUGGEST_ONLY");
    expect(decision.policyVersionIds).toEqual(["policy-suggest", "policy-human", "policy-other"]);
  });

  it("excludes stale evidence and invalidates a changed policy before the side effect", async () => {
    const { service } = createService([
      policy("policy-stale", "APPROVED_AUTOMATION", new Date(Date.now() - 1_000)),
    ]);

    const initial = await service.authorize(params);
    const current = await service.reauthorize(params, "different-hash");

    expect(initial.allowedMode).toBe("DISABLED");
    expect(current.allowedMode).toBe("DISABLED");
    expect(current.blockReasons).toContain("Policy hash or expiry changed before side effect");
  });

  it("downgrades approved automation for high-risk content", async () => {
    const { service } = createService([policy("policy-approved", "APPROVED_AUTOMATION")]);

    const decision = await service.authorize({ ...params, contentRiskTier: "HIGH" });

    expect(decision.allowedMode).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(decision.blockReasons).toContain("High-risk content cannot use approved automation");
  });
});
