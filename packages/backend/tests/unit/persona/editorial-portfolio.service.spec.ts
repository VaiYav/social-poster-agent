import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPrismaService } from "../../mocks/index.js";
import { EditorialPortfolioPlanner } from "../../../src/modules/persona/editorial-portfolio-planner.js";
import { EditorialPortfolioService } from "../../../src/modules/persona/editorial-portfolio.service.js";

function opportunity() {
  return {
    opportunityId: "opportunity-1",
    canonicalTopic: "Workflow slowdown",
    thesis: "The hidden cost is context switching",
    thesisHash: "thesis-1",
    domain: "productivity",
    riskTier: "LOW" as const,
    funnelIntent: "AWARENESS",
    validUntil: new Date(Date.now() + 60_000),
  };
}

function candidate() {
  return {
    accountId: "account-1",
    personaRevisionId: "revision-1",
    network: "X",
    voiceMode: "pattern_breakdown",
    policyMode: "SUGGEST_ONLY" as const,
    healthy: true,
    allowedActions: ["OWN_POST"] as const,
    personaFit: 1,
    audienceDemand: 0.5,
    sourceFreshness: 1,
    novelty: 1,
    pillarDeficit: 0.5,
    funnelDeficit: 0.5,
    conversationOpportunity: 0,
    expectedCost: 0.5,
    reviewCapacity: 1,
  };
}

describe("PERSONA-103 EditorialPortfolioService", () => {
  const prisma = createMockPrismaService();
  const service = new EditorialPortfolioService(prisma as never, new EditorialPortfolioPlanner());

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.editorialOpportunity.findFirst.mockResolvedValue(null);
    prisma.editorialOpportunity.create.mockResolvedValue({
      id: "opportunity-1",
      ...opportunity(),
    });
    prisma.editorialAssignmentRecord.findFirst.mockResolvedValue(null);
    prisma.editorialAssignmentRecord.create.mockResolvedValue({ id: "assignment-1" });
  });

  it("reuses a live open opportunity instead of creating a duplicate", async () => {
    const existing = { id: "opportunity-existing", status: "OPEN" };
    prisma.editorialOpportunity.findFirst.mockResolvedValue(existing);

    await expect(
      service.ensureOpportunity({
        ...opportunity(),
        sourceType: "brief",
        sourceRef: { topic: "Workflow slowdown" },
      }),
    ).resolves.toBe(existing);
    expect(prisma.editorialOpportunity.create).not.toHaveBeenCalled();
  });

  it("plans and persists a deterministic assignment with explicit provenance", async () => {
    const assignment = await service.planAndPersist({
      opportunity: opportunity(),
      candidates: [candidate()],
    });

    expect(assignment).toMatchObject({
      opportunityId: "opportunity-1",
      accountId: "account-1",
      personaRevisionId: "revision-1",
      action: "OWN_POST",
    });
    expect(prisma.editorialAssignmentRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        opportunityId: "opportunity-1",
        accountId: "account-1",
        personaRevisionId: "revision-1",
        status: "PLANNED",
        thesisHash: "thesis-1",
      }),
    });
  });

  it("does not create a second live assignment for the same opportunity/account/action", async () => {
    const existing = { id: "assignment-existing", status: "PLANNED" };
    prisma.editorialAssignmentRecord.findFirst.mockResolvedValue(existing);

    await service.planAndPersist({
      opportunity: opportunity(),
      candidates: [candidate()],
    });

    expect(prisma.editorialAssignmentRecord.create).not.toHaveBeenCalled();
  });

  it("persists null persona provenance for a safe global-fallback candidate", async () => {
    await service.planAndPersist({
      opportunity: opportunity(),
      candidates: [{ ...candidate(), accountId: "fallback", personaRevisionId: "" }],
    });

    expect(prisma.editorialAssignmentRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ personaRevisionId: null }),
    });
  });
});
