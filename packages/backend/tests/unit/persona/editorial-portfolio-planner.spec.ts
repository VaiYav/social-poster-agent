import { describe, expect, it } from "vitest";
import { EditorialPortfolioPlanner } from "../../../src/modules/persona/editorial-portfolio-planner.js";

const opportunity = (overrides: Record<string, unknown> = {}) => ({
  opportunityId: "opportunity-1",
  canonicalTopic: "Workflow slowdown",
  thesis: "The hidden cost is context switching",
  thesisHash: "thesis-1",
  domain: "productivity",
  riskTier: "LOW" as const,
  funnelIntent: "AWARENESS",
  validUntil: new Date(Date.now() + 60_000),
  ...overrides,
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  accountId: "account-1",
  personaRevisionId: "revision-1",
  network: "X",
  voiceMode: "pattern_breakdown",
  policyMode: "APPROVED_AUTOMATION" as const,
  healthy: true,
  allowedActions: ["OWN_POST", "REPLY"] as const,
  personaFit: 0.8,
  audienceDemand: 0.7,
  sourceFreshness: 0.9,
  novelty: 0.8,
  pillarDeficit: 0.5,
  funnelDeficit: 0.4,
  conversationOpportunity: 0.2,
  expectedCost: 0.2,
  reviewCapacity: 1,
  ...overrides,
});

describe("PERSONA-103 EditorialPortfolioPlanner", () => {
  const planner = new EditorialPortfolioPlanner();

  it("selects the highest deterministic score and records components", () => {
    const assignments = planner.plan(
      [opportunity()],
      [
        candidate({ accountId: "account-low", personaFit: 0.1 }),
        candidate({ accountId: "account-high", personaFit: 0.95 }),
      ],
    );

    expect(assignments[0]).toMatchObject({
      accountId: "account-high",
      action: "OWN_POST",
      thesisHash: "thesis-1",
    });
    expect(assignments[0]?.scoreComponents).toHaveProperty("personaFit");
    expect(assignments[0]?.hardConstraintResults.every((result) => result.passed)).toBe(true);
  });

  it("returns SKIP for a saturated thesis and DEFER when policy/capacity is unavailable", () => {
    const [duplicate] = planner.plan([opportunity()], [candidate()], new Set(["thesis-1"]));
    const [deferred] = planner.plan(
      [opportunity({ opportunityId: "opportunity-2", thesisHash: "thesis-2" })],
      [candidate({ policyMode: "DISABLED" })],
    );

    expect(duplicate?.action).toBe("SKIP");
    expect(deferred?.action).toBe("DEFER");
  });

  it("requires review capacity for high-risk opportunities", () => {
    const [assignment] = planner.plan(
      [opportunity({ riskTier: "HIGH" })],
      [candidate({ reviewCapacity: 0 })],
    );

    expect(assignment?.action).toBe("DEFER");
  });
});
