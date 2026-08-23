import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { EngagementSafetyService } from "./engagement-safety.service.js";

export interface CreateEngagementSuggestionInput {
  readonly accountId: string;
  readonly personaRevisionId: string;
  readonly network: SocialNetwork;
  readonly targetUrl: string;
  readonly targetAuthorHandleHash?: string;
  readonly sourceSnapshotHash: string;
  readonly threadContextRef?: Record<string, unknown>;
  readonly voiceMode: string;
  readonly intent: string;
  readonly content: string;
  readonly claimTrace?: Record<string, unknown>;
  readonly memoryTrace?: Record<string, unknown>;
  readonly judgeScores?: Record<string, unknown>;
  readonly policyMode: string;
  readonly expiresAt: Date;
}

@Injectable()
export class EngagementSuggestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly safety: EngagementSafetyService,
  ) {}

  async create(input: CreateEngagementSuggestionInput) {
    if (
      !["SUGGEST_ONLY", "HUMAN_APPROVAL_REQUIRED", "APPROVED_AUTOMATION"].includes(input.policyMode)
    ) {
      throw new ConflictException("Suggestions require a non-disabled execution policy mode");
    }
    const contentCheck = this.safety.checkContentSafety(input.content);
    if (!contentCheck.safe) throw new ConflictException(contentCheck.reason);
    assertGroundedClaimTrace(input.claimTrace);
    return this.prisma.engagementSuggestion.create({
      data: {
        accountId: input.accountId,
        personaRevisionId: input.personaRevisionId,
        network: input.network,
        targetUrl: input.targetUrl,
        targetAuthorHandleHash: input.targetAuthorHandleHash,
        sourceSnapshotHash: input.sourceSnapshotHash,
        threadContextRef: input.threadContextRef as Prisma.InputJsonValue | undefined,
        voiceMode: input.voiceMode,
        intent: input.intent,
        content: input.content.trim(),
        claimTrace: input.claimTrace as Prisma.InputJsonValue | undefined,
        memoryTrace: input.memoryTrace as Prisma.InputJsonValue | undefined,
        judgeScores: input.judgeScores as Prisma.InputJsonValue | undefined,
        policyMode: input.policyMode,
        expiresAt: input.expiresAt,
      },
    });
  }

  async list(query: { accountId?: string; network?: SocialNetwork; status?: string }) {
    return this.prisma.engagementSuggestion.findMany({
      where: {
        accountId: query.accountId,
        network: query.network,
        status: query.status,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: string) {
    const suggestion = await this.prisma.engagementSuggestion.findUnique({ where: { id } });
    if (!suggestion) throw new NotFoundException(`Engagement suggestion ${id} not found`);
    return suggestion;
  }

  async review(
    id: string,
    input: {
      reviewerId: string;
      expectedVersion: number;
      decision: "APPROVED" | "EDITED" | "REJECTED";
      content?: string;
    },
  ) {
    const existing = await this.findById(id);
    if (existing.status === input.decision && existing.version >= input.expectedVersion)
      return existing;
    if (existing.status !== "PROPOSED" || existing.version !== input.expectedVersion) {
      throw new ConflictException("Suggestion is stale or already reviewed");
    }
    if (input.decision === "EDITED") {
      if (!input.content?.trim()) throw new ConflictException("Edited approval requires content");
      const contentCheck = this.safety.checkContentSafety(input.content);
      if (!contentCheck.safe) throw new ConflictException(contentCheck.reason);
    }
    const updated = await this.prisma.engagementSuggestion.updateMany({
      where: { id, status: "PROPOSED", version: input.expectedVersion },
      data: {
        status: input.decision,
        content: input.content?.trim() ?? existing.content,
        reviewedBy: input.reviewerId,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new ConflictException("Suggestion review lost a concurrent update");
    return this.findById(id);
  }

  async expire(id: string) {
    const updated = await this.prisma.engagementSuggestion.updateMany({
      where: { id, status: "PROPOSED" },
      data: { status: "EXPIRED", version: { increment: 1 } },
    });
    if (updated.count !== 1) throw new ConflictException("Suggestion is not pending");
    return this.findById(id);
  }
}

function assertGroundedClaimTrace(claimTrace?: Record<string, unknown>): void {
  if (!claimTrace) return;
  const claimType = typeof claimTrace.claimType === "string" ? claimTrace.claimType : "";
  const evidenceIds = claimTrace.verifiedEvidenceIds;
  const memoryId = claimTrace.approvedMemoryId;
  if (
    ["FACT", "MEDICAL", "HIGH_RISK"].includes(claimType) &&
    (!Array.isArray(evidenceIds) || evidenceIds.length === 0)
  ) {
    throw new ConflictException("Factual or high-risk suggestions require verified evidence");
  }
  if (
    (claimType === "FIRST_PERSON" || claimTrace.firstPersonExperience === true) &&
    typeof memoryId !== "string"
  ) {
    throw new ConflictException("First-person suggestions require an approved persona memory");
  }
}
