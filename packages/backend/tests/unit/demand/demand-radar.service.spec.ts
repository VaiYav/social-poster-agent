import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { DemandRadarService } from "../../../src/modules/demand/demand-radar.service.js";

function createService() {
  const prisma = {
    audienceSignal: {
      upsert: vi.fn().mockResolvedValue({ id: "signal-1" }),
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    audienceQuestionCluster: {
      upsert: vi.fn().mockResolvedValue({ id: "cluster-1", sourceCount: 0 }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    audienceClusterMembership: {
      upsert: vi.fn().mockResolvedValue({ clusterId: "cluster-1", signalId: "signal-1" }),
    },
    productInsightProposal: { create: vi.fn().mockResolvedValue({ id: "insight-1" }) },
  };
  return { service: new DemandRadarService(prisma as never), prisma };
}

describe("INTEL-101 DemandRadarService", () => {
  it("minimizes eligible public text and creates an exact normalized cluster", async () => {
    const { service, prisma } = createService();

    const result = await service.ingestSignal({
      sourceType: "PUBLIC_REPLY",
      sourceRef: { id: "public-1" },
      network: SocialNetwork.X,
      signalType: "QUESTION",
      domain: "ASTROLOGY",
      text: "Why does this pattern repeat? https://example.com",
      language: "en",
      riskTier: "LOW",
      sourceAuthorRef: "public-author-1",
      sourceSnapshotHash: "snapshot-1",
    });

    expect(result).toMatchObject({ stored: true, cluster: { id: "cluster-1" } });
    expect(prisma.audienceSignal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ languagePattern: expect.stringContaining("[link]") }),
      }),
    );
    expect(prisma.audienceClusterMembership.upsert).toHaveBeenCalled();
  });

  it("blocks private or sensitive content before persistence", async () => {
    const { service, prisma } = createService();

    const result = await service.ingestSignal({
      sourceType: "PUBLIC_REPLY",
      sourceRef: { id: "public-2" },
      network: SocialNetwork.THREADS,
      signalType: "SAFETY_CONCERN",
      domain: "CYCLES",
      text: "Please DM me your birth data and cycle log",
      language: "en",
      riskTier: "HIGH",
      sourceSnapshotHash: "snapshot-2",
    });

    expect(result).toMatchObject({ stored: false, privacyStatus: "BLOCKED" });
    expect(prisma.audienceSignal.upsert).not.toHaveBeenCalled();
  });

  it("does not export a product insight until a cluster is validated", async () => {
    const { service, prisma } = createService();
    prisma.audienceQuestionCluster.findUnique.mockResolvedValue({
      id: "cluster-1",
      status: "REVIEWED",
      riskTier: "LOW",
    });

    await expect(
      service.proposeProductInsight({
        clusterId: "cluster-1",
        insightType: "FAQ",
        summary: "An aggregate question",
        reviewer: "operator",
      }),
    ).rejects.toThrow("VALIDATED");
    expect(prisma.productInsightProposal.create).not.toHaveBeenCalled();
  });
});
