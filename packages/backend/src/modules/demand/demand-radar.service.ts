import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma, SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

export interface DemandSignalInput {
  readonly sourceType: string;
  readonly sourceRef: Record<string, unknown>;
  readonly network: SocialNetwork;
  readonly accountId?: string;
  readonly personaRevisionId?: string;
  readonly signalType: string;
  readonly domain: string;
  readonly text: string;
  readonly language?: string;
  readonly riskTier: "LOW" | "MEDIUM" | "HIGH";
  readonly sourceAuthorRef?: string;
  readonly sourceSnapshotHash: string;
  readonly occurredAt?: Date;
  readonly expiresAt?: Date;
}

@Injectable()
export class DemandRadarService {
  private readonly db: PrismaService & {
    audienceSignal: Prisma.AudienceSignalDelegate;
    audienceQuestionCluster: Prisma.AudienceQuestionClusterDelegate;
    audienceClusterMembership: Prisma.AudienceClusterMembershipDelegate;
    productInsightProposal: Prisma.ProductInsightProposalDelegate;
  };

  constructor(prisma: PrismaService) {
    this.db = prisma as unknown as typeof this.db;
  }

  async ingestSignal(input: DemandSignalInput) {
    const privacy = minimizePublicText(input.text, input.language);
    if (!privacy.eligible) {
      return { stored: false, privacyStatus: "BLOCKED", reason: privacy.reason };
    }
    const normalizedQuestion = normalizeQuestion(privacy.text);
    if (!normalizedQuestion)
      return { stored: false, privacyStatus: "BLOCKED", reason: "Empty after minimization" };
    const sourceAuthorHash = input.sourceAuthorRef ? hash(input.sourceAuthorRef) : undefined;
    const signal = await this.db.audienceSignal.upsert({
      where: {
        network_sourceSnapshotHash_signalType: {
          network: input.network,
          sourceSnapshotHash: input.sourceSnapshotHash,
          signalType: input.signalType,
        },
      },
      create: {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef as Prisma.InputJsonValue,
        network: input.network,
        accountId: input.accountId,
        personaRevisionId: input.personaRevisionId,
        signalType: input.signalType,
        domain: input.domain,
        normalizedQuestion,
        languagePattern: privacy.text.slice(0, 240),
        riskTier: input.riskTier,
        privacyStatus: "ELIGIBLE",
        sourceAuthorHash,
        sourceSnapshotHash: input.sourceSnapshotHash,
        occurredAt: input.occurredAt ?? new Date(),
        expiresAt: input.expiresAt,
      },
      update: {},
    });

    const clusterKey = hash(`${input.domain}:${input.signalType}:${normalizedQuestion}`);
    const now = input.occurredAt ?? new Date();
    const cluster = await this.db.audienceQuestionCluster.upsert({
      where: { clusterKey },
      create: {
        clusterKey,
        label: normalizedQuestion,
        canonicalQuestion: normalizedQuestion,
        domain: input.domain,
        signalTypes: [input.signalType] as Prisma.InputJsonValue,
        riskTier: input.riskTier,
        firstSeenAt: now,
        lastSeenAt: now,
        scoreComponents: { frequency: 1, recency: 1, sourceDiversity: sourceAuthorHash ? 1 : 0 },
        sourceCount: 0,
        distinctAuthorCount: 0,
      },
      update: { lastSeenAt: now },
    });
    const membership = await this.db.audienceClusterMembership.upsert({
      where: { clusterId_signalId: { clusterId: cluster.id, signalId: signal.id } },
      create: { clusterId: cluster.id, signalId: signal.id, method: "EXACT", similarity: 1 },
      update: {},
    });
    await this.db.audienceQuestionCluster.update({
      where: { id: cluster.id },
      data: {
        sourceCount: { increment: 1 },
        demandScore: Math.min(1, (cluster.sourceCount + 1) / 5),
      },
    });
    return { stored: true, signal, cluster, membership };
  }

  async listSignals(query: { domain?: string; signalType?: string; riskTier?: string }) {
    return this.db.audienceSignal.findMany({
      where: {
        domain: query.domain,
        signalType: query.signalType,
        riskTier: query.riskTier,
        privacyStatus: "ELIGIBLE",
      },
      orderBy: { occurredAt: "desc" },
      take: 100,
    });
  }

  async listClusters(query: { status?: string; domain?: string; minScore?: number }) {
    return this.db.audienceQuestionCluster.findMany({
      where: {
        status: query.status,
        domain: query.domain,
        demandScore: query.minScore === undefined ? undefined : { gte: query.minScore },
      },
      orderBy: [{ demandScore: "desc" }, { lastSeenAt: "desc" }],
      take: 100,
    });
  }

  async reviewCluster(id: string, reviewer: string, status: "REVIEWED" | "VALIDATED" | "ARCHIVED") {
    const cluster = await this.db.audienceQuestionCluster.findUnique({ where: { id } });
    if (!cluster) throw new NotFoundException(`Demand cluster ${id} not found`);
    if (status === "VALIDATED" && cluster.riskTier === "HIGH") {
      throw new ConflictException("High-risk demand clusters require separate safety review");
    }
    return this.db.audienceQuestionCluster.update({
      where: { id },
      data: { status, reviewedBy: reviewer, reviewedAt: new Date() },
    });
  }

  async proposeProductInsight(input: {
    clusterId: string;
    insightType: string;
    summary: string;
    reviewer: string;
  }) {
    const cluster = await this.db.audienceQuestionCluster.findUnique({
      where: { id: input.clusterId },
    });
    if (!cluster) throw new NotFoundException(`Demand cluster ${input.clusterId} not found`);
    if (cluster.status !== "VALIDATED")
      throw new ConflictException("Cluster must be VALIDATED before insight proposal");
    return this.db.productInsightProposal.create({
      data: {
        clusterId: cluster.id,
        insightType: input.insightType,
        summary: input.summary,
        evidence: {
          clusterId: cluster.id,
          sourceCount: cluster.sourceCount,
          reviewer: input.reviewer,
        },
        privacyReview: "AGGREGATE_ONLY",
      },
    });
  }

  async purgeAuthor(network: SocialNetwork, authorRef: string) {
    return this.db.audienceSignal.deleteMany({
      where: { network, sourceAuthorHash: hash(authorRef) },
    });
  }
}

function minimizePublicText(
  text: string,
  language?: string,
): { eligible: boolean; text: string; reason?: string } {
  if (language && language.toLowerCase() !== "en")
    return { eligible: false, text: "", reason: "English-only pilot" };
  if (
    /\b(?:dm|private message|birth data|cycle log|diagnos(?:is|ed)|pregnan(?:t|cy))\b/i.test(text)
  ) {
    return { eligible: false, text: "", reason: "Sensitive/private content blocked" };
  }
  const redacted = text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .trim()
    .slice(0, 500);
  return {
    eligible: redacted.length > 0,
    text: redacted,
    reason: redacted ? undefined : "Empty source",
  };
}

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ?]/g, "")
    .trim();
}

function hash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}
