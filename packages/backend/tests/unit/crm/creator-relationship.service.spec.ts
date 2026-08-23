import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { CreatorRelationshipService } from "../../../src/modules/crm/creator-relationship.service.js";

function makeDb() {
  return {
    creatorProfile: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    creatorIdentityLink: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    creatorRelationship: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    creatorInteractionEvidence: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    collaborationOpportunity: {
      create: vi.fn(),
    },
  };
}

describe("CRM-101 CreatorRelationshipService", () => {
  let db: ReturnType<typeof makeDb>;
  let service: CreatorRelationshipService;

  beforeEach(() => {
    db = makeDb();
    service = new CreatorRelationshipService(db as never);
  });

  it("canonicalizes handles and stores only an allowed public profile URL", async () => {
    db.creatorProfile.upsert.mockResolvedValue({ id: "creator-1" });

    await service.createOrUpdateProfile({
      network: SocialNetwork.X,
      handle: " @PublicWriter ",
      displayName: "Public Writer",
      profileUrl: "https://x.com/PublicWriter",
      publicTopics: ["writing"],
      sourceRefs: { review: "manual" },
    });

    expect(db.creatorProfile.upsert).toHaveBeenCalledWith({
      where: {
        network_handleCanonical: { network: SocialNetwork.X, handleCanonical: "publicwriter" },
      },
      create: expect.objectContaining({
        handleCanonical: "publicwriter",
        profileUrl: "https://x.com/PublicWriter",
        publicTopics: ["writing"],
        sourceRefs: { review: "manual" },
      }),
      update: expect.objectContaining({ profileUrl: "https://x.com/PublicWriter" }),
    });
  });

  it("rejects a URL outside the selected public network", async () => {
    await expect(
      service.createOrUpdateProfile({
        network: SocialNetwork.THREADS,
        handle: "writer",
        profileUrl: "https://x.com/writer",
        publicTopics: [],
        sourceRefs: {},
      }),
    ).rejects.toThrow("selected network");
    expect(db.creatorProfile.upsert).not.toHaveBeenCalled();
  });

  it("deduplicates repeated interaction evidence without inflating counters", async () => {
    const relationship = { id: "relationship-1" };
    const evidence = { id: "evidence-1", evidenceHash: "hash-1" };
    db.creatorRelationship.findUnique
      .mockResolvedValueOnce(relationship)
      .mockResolvedValueOnce(relationship);
    db.creatorInteractionEvidence.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(evidence);
    db.creatorInteractionEvidence.upsert.mockResolvedValue(evidence);

    await service.recordEvidence({
      relationshipId: "relationship-1",
      evidenceType: "PUBLIC_REPLY",
      evidenceHash: "hash-1",
      sourceRef: { url: "https://x.com/writer/status/1" },
      substantive: true,
      reciprocal: true,
    });
    await service.recordEvidence({
      relationshipId: "relationship-1",
      evidenceType: "PUBLIC_REPLY",
      evidenceHash: "hash-1",
      sourceRef: { url: "https://x.com/writer/status/1" },
      substantive: true,
      reciprocal: true,
    });

    expect(db.creatorInteractionEvidence.upsert).toHaveBeenCalledTimes(1);
    expect(db.creatorRelationship.update).toHaveBeenCalledTimes(1);
    expect(db.creatorRelationship.update).toHaveBeenCalledWith({
      where: { id: "relationship-1" },
      data: expect.objectContaining({
        interactionCount: { increment: 1 },
        substantiveReplyCount: { increment: 1 },
        reciprocalCount: { increment: 1 },
      }),
    });
  });

  it("records public interaction evidence only for an existing manually curated relationship", async () => {
    db.creatorProfile.findFirst.mockResolvedValue({ id: "creator-1" });
    db.creatorRelationship.findUnique.mockResolvedValue({ id: "relationship-1", status: "ACTIVE" });
    db.creatorInteractionEvidence.findUnique.mockResolvedValue(null);
    db.creatorInteractionEvidence.upsert.mockResolvedValue({ id: "evidence-1" });

    await service.recordPublicInteraction({
      accountId: "account-1",
      network: SocialNetwork.X,
      authorHandle: "@PublicWriter",
      interactionId: "interaction-1",
      postUrl: "https://x.com/publicwriter/status/1",
      kind: "comment",
    });

    expect(db.creatorProfile.findFirst).toHaveBeenCalledWith({
      where: { network: SocialNetwork.X, handleHash: expect.any(String), status: "ACTIVE" },
      select: { id: true },
    });
    expect(db.creatorInteractionEvidence.upsert).toHaveBeenCalledWith({
      where: {
        relationshipId_evidenceType_evidenceHash: {
          relationshipId: "relationship-1",
          evidenceType: "PUBLIC_COMMENT",
          evidenceHash: expect.any(String),
        },
      },
      create: expect.objectContaining({
        interactionId: "interaction-1",
        evidenceType: "PUBLIC_COMMENT",
        sourceRef: { postUrl: "https://x.com/publicwriter/status/1", visibility: "PUBLIC" },
        weight: 1,
      }),
      update: {},
    });
  });

  it("requires explicit human evidence for a cross-network identity link and supports unlinking", async () => {
    db.creatorProfile.findUnique
      .mockResolvedValueOnce({ id: "creator-x", network: SocialNetwork.X })
      .mockResolvedValueOnce({ id: "creator-threads", network: SocialNetwork.THREADS });
    db.creatorIdentityLink.upsert.mockResolvedValue({ id: "link-1", status: "REVIEWED" });

    await service.linkIdentity({
      sourceCreatorId: "creator-x",
      targetCreatorId: "creator-threads",
      evidence: {
        publicProfileRefs: ["https://x.com/publicwriter", "https://threads.net/@publicwriter"],
      },
      reviewer: "operator",
      reason: "Same public website links both profiles",
    });

    expect(db.creatorIdentityLink.upsert).toHaveBeenCalledWith({
      where: {
        sourceCreatorId_targetCreatorId: {
          sourceCreatorId: "creator-x",
          targetCreatorId: "creator-threads",
        },
      },
      create: expect.objectContaining({
        reviewedBy: "operator",
        reviewReason: "Same public website links both profiles",
      }),
      update: expect.objectContaining({ status: "REVIEWED" }),
    });

    db.creatorIdentityLink.findUnique.mockResolvedValue({ id: "link-1", status: "REVIEWED" });
    db.creatorIdentityLink.update.mockResolvedValue({ id: "link-1", status: "UNLINKED" });
    await service.unlinkIdentity({
      linkId: "link-1",
      reviewer: "operator",
      reason: "Evidence expired",
    });
    expect(db.creatorIdentityLink.update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: expect.objectContaining({ status: "UNLINKED", reviewReason: "Evidence expired" }),
    });
  });

  it("uses optimistic versioning and refuses a concurrent relationship transition", async () => {
    db.creatorRelationship.findUnique.mockResolvedValue({
      id: "relationship-1",
      status: "ACTIVE",
      stage: "OBSERVED",
      stageEvidence: [],
      version: 2,
    });
    db.creatorRelationship.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.transition({
        relationshipId: "relationship-1",
        targetStage: "ENGAGED",
        expectedVersion: 2,
        reviewer: "operator",
        reason: "Value-adding public interaction reviewed",
      }),
    ).rejects.toThrow("changed concurrently");
  });

  it("makes DO_NOT_ENGAGE durable and blocks downstream opportunity proposals", async () => {
    db.creatorProfile.update.mockResolvedValue({ id: "creator-1", status: "DO_NOT_ENGAGE" });
    db.creatorRelationship.updateMany.mockResolvedValue({ count: 1 });
    db.creatorRelationship.findUnique.mockResolvedValue({
      id: "relationship-1",
      status: "DO_NOT_ENGAGE",
    });

    await service.doNotEngage("creator-1", "operator", "Requested by account owner");
    expect(db.creatorRelationship.updateMany).toHaveBeenCalledWith({
      where: { creatorId: "creator-1" },
      data: { status: "DO_NOT_ENGAGE", ownerNote: "operator: Requested by account owner" },
    });

    await expect(
      service.proposeOpportunity({
        relationshipId: "relationship-1",
        opportunityType: "CO_AUTHORING",
        topic: "Public topic",
        rationale: { source: "review" },
        risks: { outreach: "manual only" },
        accountId: "account-1",
      }),
    ).rejects.toThrow("DO_NOT_ENGAGE");
    expect(db.collaborationOpportunity.create).not.toHaveBeenCalled();
  });

  it("returns cooldown as the next action and never schedules autonomous outreach", async () => {
    db.creatorRelationship.findUnique.mockResolvedValue({
      id: "relationship-1",
      status: "ACTIVE",
      stage: "OBSERVED",
      cooldownUntil: new Date(Date.now() + 60_000),
      creator: { status: "ACTIVE" },
    });

    await expect(service.nextAction("relationship-1")).resolves.toEqual({
      action: "WAIT_COOLDOWN",
      reasons: ["Creator cooldown is active"],
    });
  });

  it("requires an explicit future cooldown and records the human reason", async () => {
    db.creatorRelationship.findUnique.mockResolvedValue({
      id: "relationship-1",
      status: "ACTIVE",
    });
    db.creatorRelationship.update.mockResolvedValue({ id: "relationship-1" });
    const until = new Date(Date.now() + 60_000);

    await service.setCooldown({
      relationshipId: "relationship-1",
      until,
      reviewer: "operator",
      reason: "Avoid repeated targeting after a substantive exchange",
    });

    expect(db.creatorRelationship.update).toHaveBeenCalledWith({
      where: { id: "relationship-1" },
      data: {
        cooldownUntil: until,
        ownerNote: expect.stringContaining("Avoid repeated targeting"),
      },
    });
    await expect(
      service.setCooldown({
        relationshipId: "relationship-1",
        until: new Date(Date.now() - 1),
        reviewer: "operator",
        reason: "expired",
      }),
    ).rejects.toThrow("future");
  });
});
