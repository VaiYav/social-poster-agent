import { describe, expect, it, vi } from "vitest";
import { GroundingService } from "../../../src/modules/persona/grounding.service.js";

describe("GROUND-101 GroundingService", () => {
  it("retrieves only reviewed evidence and ranks lexical matches deterministically", async () => {
    const prisma = {
      knowledgeEvidence: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "evidence-2",
            text: "A distant unrelated note",
            sourceType: "PAPER",
            riskClass: "LOW",
          },
          {
            id: "evidence-1",
            text: "A verified pattern about cycle education",
            sourceType: "PAPER",
            riskClass: "SENSITIVE",
          },
        ]),
      },
    };
    const service = new GroundingService(prisma as never);

    const result = await service.retrieveEvidence({ query: "cycle education" });

    expect(result).toMatchObject([{ id: "evidence-1", score: 1 }]);
    expect(prisma.knowledgeEvidence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reviewStatus: "VERIFIED" }) }),
    );
  });

  it("keeps new memories as candidates and supports explicit approval/supersession/purge", async () => {
    const prisma = {
      personaMemory: {
        create: vi.fn().mockResolvedValue({ id: "memory-1", status: "CANDIDATE" }),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "memory-1", status: "CANDIDATE", sourceType: "OPERATOR" })
          .mockResolvedValueOnce({ id: "memory-2", status: "VERIFIED" }),
        update: vi.fn().mockResolvedValue({ id: "memory-1", status: "VERIFIED" }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new GroundingService(prisma as never);

    await expect(
      service.createMemory({
        personaId: "persona-1",
        kind: "EPISODE",
        text: "An approved candidate episode",
        sourceType: "OPERATOR",
      }),
    ).resolves.toMatchObject({ status: "CANDIDATE" });
    await expect(service.approveMemory("memory-1", "operator")).resolves.toMatchObject({
      status: "VERIFIED",
    });
    await expect(service.supersedeMemory("memory-1", "memory-2")).resolves.toBeDefined();
    await expect(service.purgePersonaMemories("persona-1")).resolves.toEqual({ count: 1 });
  });
});
