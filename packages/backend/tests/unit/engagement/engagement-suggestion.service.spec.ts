import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { EngagementSafetyService } from "../../../src/modules/engagement/engagement-safety.service.js";
import { EngagementSuggestionService } from "../../../src/modules/engagement/engagement-suggestion.service.js";

describe("ENGAGE-101 EngagementSuggestionService", () => {
  it("persists a proposed suggestion and approves it with optimistic concurrency", async () => {
    const created = { id: "suggestion-1", status: "PROPOSED", version: 1, content: "A reply" };
    const updated = { id: "suggestion-1", status: "APPROVED", version: 2, content: "A reply" };
    const prisma = {
      engagementSuggestion: {
        create: vi.fn().mockResolvedValue(created),
        findUnique: vi.fn().mockResolvedValueOnce(created).mockResolvedValueOnce(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new EngagementSuggestionService(prisma as never, new EngagementSafetyService());

    await expect(
      service.create({
        accountId: "account-1",
        personaRevisionId: "revision-1",
        network: SocialNetwork.THREADS,
        targetUrl: "https://threads.net/@author/post/1",
        sourceSnapshotHash: "snapshot-1",
        voiceMode: "gentle_reflection",
        intent: "ASK_SPECIFIC_QUESTION",
        content: "A reply",
        policyMode: "HUMAN_APPROVAL_REQUIRED",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toMatchObject({ id: "suggestion-1" });

    await expect(
      service.review("suggestion-1", {
        reviewerId: "operator-1",
        expectedVersion: 1,
        decision: "APPROVED",
      }),
    ).resolves.toMatchObject({ status: "APPROVED", version: 2 });
    expect(prisma.engagementSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "suggestion-1", status: "PROPOSED", version: 1 },
      }),
    );
  });

  it("does not persist disabled-policy suggestions", async () => {
    const prisma = { engagementSuggestion: { create: vi.fn() } };
    const service = new EngagementSuggestionService(prisma as never, new EngagementSafetyService());

    await expect(
      service.create({
        accountId: "account-1",
        personaRevisionId: "revision-1",
        network: SocialNetwork.X,
        targetUrl: "https://x.com/author/status/1",
        sourceSnapshotHash: "snapshot-1",
        voiceMode: "pattern_breakdown",
        intent: "ADD_NUANCE",
        content: "A reply",
        policyMode: "DISABLED",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("non-disabled");
    expect(prisma.engagementSuggestion.create).not.toHaveBeenCalled();
  });

  it("fails closed when a factual suggestion has no verified evidence trace", async () => {
    const prisma = { engagementSuggestion: { create: vi.fn() } };
    const service = new EngagementSuggestionService(prisma as never, new EngagementSafetyService());

    await expect(
      service.create({
        accountId: "account-1",
        personaRevisionId: "revision-1",
        network: SocialNetwork.THREADS,
        targetUrl: "https://threads.net/@author/post/1",
        sourceSnapshotHash: "snapshot-1",
        voiceMode: "gentle_reflection",
        intent: "ADD_NUANCE",
        content: "A factual reply",
        claimTrace: { claimType: "FACT", verifiedEvidenceIds: [] },
        policyMode: "HUMAN_APPROVAL_REQUIRED",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("verified evidence");
    expect(prisma.engagementSuggestion.create).not.toHaveBeenCalled();
  });

  it("fails closed when a first-person suggestion has no approved memory", async () => {
    const prisma = { engagementSuggestion: { create: vi.fn() } };
    const service = new EngagementSuggestionService(prisma as never, new EngagementSafetyService());

    await expect(
      service.create({
        accountId: "account-1",
        personaRevisionId: "revision-1",
        network: SocialNetwork.X,
        targetUrl: "https://x.com/author/status/1",
        sourceSnapshotHash: "snapshot-1",
        voiceMode: "pattern_breakdown",
        intent: "SHARE_EXPERIENCE",
        content: "I experienced this myself.",
        claimTrace: { claimType: "FIRST_PERSON" },
        policyMode: "SUGGEST_ONLY",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("approved persona memory");
    expect(prisma.engagementSuggestion.create).not.toHaveBeenCalled();
  });
});
