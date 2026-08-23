import { describe, expect, it, vi } from "vitest";
import { PlatformPolicyController } from "../../../src/modules/policy/policy.controller.js";

function buildController() {
  const policy = {
    listEvidence: vi.fn().mockResolvedValue([]),
    createEvidence: vi.fn().mockResolvedValue({ id: "e1" }),
    verifyEvidence: vi.fn().mockResolvedValue({ id: "e1", status: "VERIFIED" }),
    listPolicies: vi.fn().mockResolvedValue([]),
    createPolicyVersion: vi.fn().mockResolvedValue({ id: "p1" }),
    approvePolicy: vi.fn().mockResolvedValue({ id: "p1", status: "APPROVED" }),
    revokePolicy: vi.fn().mockResolvedValue({ id: "p1", status: "REVOKED" }),
  };
  return { controller: new PlatformPolicyController(policy as never), policy };
}

const evidence = {
  network: "X",
  sourceUrl: "https://example.com/policy",
  sourceType: "official",
  contentHash: "12345678",
};

const policyVersion = {
  policyKey: "x-post",
  network: "X",
  action: "POST",
  transport: "BROWSER",
  targetRelationship: "OWN_POST",
  executionMode: "SUGGEST_ONLY",
  requirements: [],
  evidenceId: "e1",
};

describe("PlatformPolicyController", () => {
  it("validates and delegates evidence lifecycle", async () => {
    const { controller, policy } = buildController();

    await expect(controller.listEvidence()).resolves.toEqual([]);
    await expect(controller.createEvidence(evidence)).resolves.toEqual({ id: "e1" });
    await expect(controller.createEvidence({ ...evidence, sourceUrl: "bad" })).rejects.toThrow();
    await expect(controller.verifyEvidence("e1", {})).resolves.toEqual({
      id: "e1",
      status: "VERIFIED",
    });
    expect(policy.verifyEvidence).toHaveBeenCalledWith("e1", "operator");
  });

  it("validates and delegates policy version lifecycle", async () => {
    const { controller, policy } = buildController();

    await expect(controller.listPolicies("X")).resolves.toEqual([]);
    expect(() => controller.listPolicies("NOPE")).toThrow("Unsupported social network");
    await expect(controller.createPolicy(policyVersion)).resolves.toEqual({ id: "p1" });
    await expect(controller.createPolicy({ ...policyVersion, action: "NOPE" })).rejects.toThrow();
    await expect(controller.approve("p1", {})).resolves.toEqual({ id: "p1", status: "APPROVED" });
    await expect(controller.revoke("p1", { reason: "policy changed" })).resolves.toEqual({
      id: "p1",
      status: "REVOKED",
    });
    expect(policy.approvePolicy).toHaveBeenCalledWith("p1", "operator");
    expect(policy.revokePolicy).toHaveBeenCalledWith("p1", "operator", "policy changed");
  });
});
