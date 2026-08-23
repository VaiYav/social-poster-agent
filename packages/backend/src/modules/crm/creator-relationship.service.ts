import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma, SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

const STAGES = [
  "DISCOVERED",
  "OBSERVED",
  "ENGAGED",
  "RECIPROCAL",
  "COLLABORATION_CANDIDATE",
  "ACTIVE_COLLABORATOR",
  "DORMANT",
  "DO_NOT_ENGAGE",
] as const;
type Stage = (typeof STAGES)[number];

@Injectable()
export class CreatorRelationshipService {
  private readonly db: PrismaService & {
    creatorProfile: Prisma.CreatorProfileDelegate;
    creatorIdentityLink: Prisma.CreatorIdentityLinkDelegate;
    creatorRelationship: Prisma.CreatorRelationshipDelegate;
    creatorInteractionEvidence: Prisma.CreatorInteractionEvidenceDelegate;
    collaborationOpportunity: Prisma.CollaborationOpportunityDelegate;
  };

  constructor(prisma: PrismaService) {
    this.db = prisma as unknown as typeof this.db;
  }

  async createOrUpdateProfile(input: {
    network: SocialNetwork;
    handle: string;
    displayName?: string;
    profileUrl: string;
    publicTopics: string[];
    sourceRefs: Record<string, unknown>;
  }) {
    const handleCanonical = canonicalHandle(input.handle);
    if (!handleCanonical) throw new ConflictException("Creator handle is required");
    assertPublicUrl(input.profileUrl, input.network);
    return this.db.creatorProfile.upsert({
      where: { network_handleCanonical: { network: input.network, handleCanonical } },
      create: {
        network: input.network,
        handleCanonical,
        handleHash: hash(handleCanonical),
        displayName: input.displayName,
        profileUrl: input.profileUrl,
        publicTopics: input.publicTopics as Prisma.InputJsonValue,
        sourceRefs: input.sourceRefs as Prisma.InputJsonValue,
        lastVerifiedAt: new Date(),
      },
      update: {
        displayName: input.displayName,
        profileUrl: input.profileUrl,
        publicTopics: input.publicTopics as Prisma.InputJsonValue,
        sourceRefs: input.sourceRefs as Prisma.InputJsonValue,
        lastVerifiedAt: new Date(),
      },
    });
  }

  async listProfiles(query: { network?: SocialNetwork; status?: string }) {
    return this.db.creatorProfile.findMany({
      where: { network: query.network, status: query.status },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  }

  async linkIdentity(input: {
    sourceCreatorId: string;
    targetCreatorId: string;
    evidence: Record<string, unknown>;
    reviewer: string;
    reason: string;
  }) {
    if (input.sourceCreatorId === input.targetCreatorId)
      throw new ConflictException("A creator cannot be linked to itself");
    const [source, target] = await Promise.all([
      this.db.creatorProfile.findUnique({ where: { id: input.sourceCreatorId } }),
      this.db.creatorProfile.findUnique({ where: { id: input.targetCreatorId } }),
    ]);
    if (!source || !target) throw new NotFoundException("Both creator profiles are required");
    if (source.network === target.network)
      throw new ConflictException("Identity links must connect different networks");
    assertPublicIdentityEvidence(input.evidence);
    return this.db.creatorIdentityLink.upsert({
      where: {
        sourceCreatorId_targetCreatorId: {
          sourceCreatorId: input.sourceCreatorId,
          targetCreatorId: input.targetCreatorId,
        },
      },
      create: {
        sourceCreatorId: input.sourceCreatorId,
        targetCreatorId: input.targetCreatorId,
        evidence: input.evidence as Prisma.InputJsonValue,
        reviewedBy: input.reviewer,
        reviewReason: input.reason,
      },
      update: {
        evidence: input.evidence as Prisma.InputJsonValue,
        status: "REVIEWED",
        reviewedBy: input.reviewer,
        reviewedAt: new Date(),
        reviewReason: input.reason,
      },
    });
  }

  async listIdentityLinks(creatorId: string) {
    return this.db.creatorIdentityLink.findMany({
      where: {
        OR: [{ sourceCreatorId: creatorId }, { targetCreatorId: creatorId }],
        status: "REVIEWED",
      },
      include: { source: true, target: true },
      orderBy: { reviewedAt: "desc" },
    });
  }

  async unlinkIdentity(input: { linkId: string; reviewer: string; reason: string }) {
    const existing = await this.db.creatorIdentityLink.findUnique({ where: { id: input.linkId } });
    if (!existing) throw new NotFoundException(`Identity link ${input.linkId} not found`);
    return this.db.creatorIdentityLink.update({
      where: { id: input.linkId },
      data: {
        status: "UNLINKED",
        reviewedBy: input.reviewer,
        reviewedAt: new Date(),
        reviewReason: input.reason,
      },
    });
  }

  async recordPublicInteraction(input: {
    accountId: string;
    network: SocialNetwork;
    authorHandle: string;
    interactionId: string;
    postUrl: string;
    kind: "like" | "comment" | "repost" | "quote";
  }) {
    const handleCanonical = canonicalHandle(input.authorHandle);
    if (!handleCanonical) return null;
    const profile = await this.db.creatorProfile.findFirst({
      where: { network: input.network, handleHash: hash(handleCanonical), status: "ACTIVE" },
      select: { id: true },
    });
    if (!profile) return null;
    const relationship = await this.db.creatorRelationship.findUnique({
      where: { creatorId_accountId: { creatorId: profile.id, accountId: input.accountId } },
    });
    if (!relationship || relationship.status === "DO_NOT_ENGAGE") return null;
    return this.recordEvidence({
      relationshipId: relationship.id,
      interactionId: input.interactionId,
      evidenceType: `PUBLIC_${input.kind.toUpperCase()}`,
      evidenceHash: hash(
        `${input.network}:${handleCanonical}:${input.kind}:${input.interactionId}`,
      ),
      sourceRef: { postUrl: input.postUrl, visibility: "PUBLIC" },
      substantive: input.kind === "comment" || input.kind === "quote",
    });
  }

  async createRelationship(input: {
    creatorId: string;
    accountId: string;
    personaRevisionId?: string;
    sharedDomains?: string[];
    ownerNote?: string;
  }) {
    return this.db.creatorRelationship.upsert({
      where: { creatorId_accountId: { creatorId: input.creatorId, accountId: input.accountId } },
      create: {
        creatorId: input.creatorId,
        accountId: input.accountId,
        personaRevisionId: input.personaRevisionId,
        sharedDomains: (input.sharedDomains ?? []) as Prisma.InputJsonValue,
        stageEvidence: [],
        ownerNote: input.ownerNote,
      },
      update: {
        personaRevisionId: input.personaRevisionId,
        sharedDomains: (input.sharedDomains ?? []) as Prisma.InputJsonValue,
        ownerNote: input.ownerNote,
      },
    });
  }

  async listRelationships(query: { accountId?: string; stage?: string }) {
    return this.db.creatorRelationship.findMany({
      where: { accountId: query.accountId, stage: query.stage },
      include: { creator: true, evidence: { orderBy: { occurredAt: "desc" }, take: 10 } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  }

  async recordEvidence(input: {
    relationshipId: string;
    interactionId?: string;
    evidenceType: string;
    sourceRef: Record<string, unknown>;
    evidenceHash: string;
    substantive?: boolean;
    reciprocal?: boolean;
    occurredAt?: Date;
  }) {
    const relationship = await this.db.creatorRelationship.findUnique({
      where: { id: input.relationshipId },
    });
    if (!relationship)
      throw new NotFoundException(`Creator relationship ${input.relationshipId} not found`);
    const existing = await this.db.creatorInteractionEvidence.findUnique({
      where: {
        relationshipId_evidenceType_evidenceHash: {
          relationshipId: input.relationshipId,
          evidenceType: input.evidenceType,
          evidenceHash: input.evidenceHash,
        },
      },
    });
    if (existing) return existing;
    const evidence = await this.db.creatorInteractionEvidence.upsert({
      where: {
        relationshipId_evidenceType_evidenceHash: {
          relationshipId: input.relationshipId,
          evidenceType: input.evidenceType,
          evidenceHash: input.evidenceHash,
        },
      },
      create: {
        relationshipId: input.relationshipId,
        interactionId: input.interactionId,
        evidenceType: input.evidenceType,
        sourceRef: input.sourceRef as Prisma.InputJsonValue,
        evidenceHash: input.evidenceHash,
        weight: input.substantive ? 1 : 0.5,
        occurredAt: input.occurredAt ?? new Date(),
      },
      update: {},
    });
    await this.db.creatorRelationship.update({
      where: { id: input.relationshipId },
      data: {
        interactionCount: { increment: 1 },
        substantiveReplyCount: input.substantive ? { increment: 1 } : undefined,
        reciprocalCount: input.reciprocal ? { increment: 1 } : undefined,
        lastInteractionAt: input.occurredAt ?? new Date(),
      },
    });
    return evidence;
  }

  async transition(input: {
    relationshipId: string;
    targetStage: Stage;
    expectedVersion: number;
    reviewer: string;
    reason: string;
  }) {
    const current = await this.db.creatorRelationship.findUnique({
      where: { id: input.relationshipId },
    });
    if (!current)
      throw new NotFoundException(`Creator relationship ${input.relationshipId} not found`);
    if (current.status === "DO_NOT_ENGAGE" || input.targetStage === "DO_NOT_ENGAGE") {
      throw new ConflictException("Use the explicit DO_NOT_ENGAGE endpoint");
    }
    if (!STAGES.includes(input.targetStage))
      throw new ConflictException("Unknown relationship stage");
    const evidence = Array.isArray(current.stageEvidence) ? current.stageEvidence : [];
    const updated = await this.db.creatorRelationship.updateMany({
      where: { id: input.relationshipId, version: input.expectedVersion, status: "ACTIVE" },
      data: {
        stage: input.targetStage,
        version: { increment: 1 },
        stageEvidence: [
          ...evidence,
          {
            from: current.stage,
            to: input.targetStage,
            reviewer: input.reviewer,
            reason: input.reason,
            at: new Date().toISOString(),
          },
        ] as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) throw new ConflictException("Relationship changed concurrently");
    return this.db.creatorRelationship.findUnique({ where: { id: input.relationshipId } });
  }

  async doNotEngage(creatorId: string, reviewer: string, reason: string) {
    const profile = await this.db.creatorProfile.update({
      where: { id: creatorId },
      data: { status: "DO_NOT_ENGAGE" },
    });
    await this.db.creatorRelationship.updateMany({
      where: { creatorId },
      data: { status: "DO_NOT_ENGAGE", ownerNote: `${reviewer}: ${reason}` },
    });
    return profile;
  }

  async setCooldown(input: {
    relationshipId: string;
    until: Date;
    reviewer: string;
    reason: string;
  }) {
    if (input.until <= new Date()) throw new ConflictException("Cooldown must be in the future");
    const relationship = await this.db.creatorRelationship.findUnique({
      where: { id: input.relationshipId },
    });
    if (!relationship)
      throw new NotFoundException(`Creator relationship ${input.relationshipId} not found`);
    if (relationship.status === "DO_NOT_ENGAGE")
      throw new ConflictException("DO_NOT_ENGAGE relationship cannot be scheduled");
    return this.db.creatorRelationship.update({
      where: { id: input.relationshipId },
      data: {
        cooldownUntil: input.until,
        ownerNote: `${input.reviewer}: cooldown until ${input.until.toISOString()}; ${input.reason}`,
      },
    });
  }

  async nextAction(relationshipId: string) {
    const relationship = await this.db.creatorRelationship.findUnique({
      where: { id: relationshipId },
      include: { creator: true },
    });
    if (!relationship)
      throw new NotFoundException(`Creator relationship ${relationshipId} not found`);
    if (relationship.status === "DO_NOT_ENGAGE" || relationship.creator.status === "DO_NOT_ENGAGE")
      return { action: "DO_NOT_ENGAGE", reasons: ["Durable operator do-not-engage gate"] };
    if (relationship.cooldownUntil && relationship.cooldownUntil > new Date())
      return { action: "WAIT_COOLDOWN", reasons: ["Creator cooldown is active"] };
    if (relationship.stage === "DISCOVERED")
      return {
        action: "READ_RECENT_WORK",
        reasons: ["Public relationship has not been observed yet"],
      };
    if (relationship.stage === "OBSERVED")
      return {
        action: "REPLY_IF_VALUE",
        reasons: ["Only a value-adding public reply may advance the relationship"],
      };
    if (relationship.stage === "RECIPROCAL" || relationship.stage === "COLLABORATION_CANDIDATE")
      return {
        action: "PROPOSE_COLLABORATION",
        reasons: ["Reciprocal evidence exists; proposal still requires human review"],
      };
    return { action: "WAIT_COOLDOWN", reasons: ["No automatic outreach action is allowed"] };
  }

  async proposeOpportunity(input: {
    relationshipId: string;
    opportunityType: string;
    topic: string;
    rationale: Record<string, unknown>;
    risks: Record<string, unknown>;
    accountId: string;
    personaId?: string;
    validUntil?: Date;
  }) {
    const relationship = await this.db.creatorRelationship.findUnique({
      where: { id: input.relationshipId },
    });
    if (!relationship)
      throw new NotFoundException(`Creator relationship ${input.relationshipId} not found`);
    if (relationship.status === "DO_NOT_ENGAGE")
      throw new ConflictException("DO_NOT_ENGAGE blocks collaboration proposals");
    return this.db.collaborationOpportunity.create({
      data: {
        relationshipId: input.relationshipId,
        opportunityType: input.opportunityType,
        topic: input.topic,
        rationale: input.rationale as Prisma.InputJsonValue,
        risks: input.risks as Prisma.InputJsonValue,
        proposedAccountId: input.accountId,
        proposedPersonaId: input.personaId,
        validUntil: input.validUntil,
      },
    });
  }

  async purgeCreator(creatorId: string) {
    return this.db.creatorProfile.delete({ where: { id: creatorId } });
  }
}

function canonicalHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertPublicIdentityEvidence(evidence: Record<string, unknown>): void {
  const refs = evidence.publicProfileRefs;
  if (
    !Array.isArray(refs) ||
    refs.length < 2 ||
    refs.some((ref) => typeof ref !== "string" || !ref.startsWith("https://"))
  ) {
    throw new ConflictException("Identity links require at least two HTTPS public profile refs");
  }
}

function assertPublicUrl(url: string, network: SocialNetwork): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ConflictException("Creator URL must use HTTPS");
  const allowed =
    network === "X"
      ? ["x.com", "twitter.com"]
      : network === "THREADS"
        ? ["threads.net"]
        : ["facebook.com"];
  if (!allowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)))
    throw new ConflictException("Creator URL is not on the selected network");
}
