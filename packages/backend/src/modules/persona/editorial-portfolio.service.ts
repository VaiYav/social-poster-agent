import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  EditorialPortfolioPlanner,
  type EditorialAccountCandidate,
  type EditorialOpportunityInput,
} from "./editorial-portfolio-planner.js";

@Injectable()
export class EditorialPortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: EditorialPortfolioPlanner,
  ) {}

  async createOpportunity(
    input: Omit<EditorialOpportunityInput, "opportunityId"> & {
      sourceType: string;
      sourceRef: Record<string, unknown>;
    },
  ) {
    return this.prisma.editorialOpportunity.create({
      data: {
        id: crypto.randomUUID(),
        sourceType: input.sourceType,
        sourceRef: input.sourceRef as Prisma.InputJsonValue,
        domain: input.domain,
        canonicalTopic: input.canonicalTopic,
        thesisHash: input.thesisHash,
        riskTier: input.riskTier,
        funnelIntent: input.funnelIntent,
        validUntil: input.validUntil,
        status: input.status ?? "OPEN",
      },
    });
  }

  async ensureOpportunity(
    input: Omit<EditorialOpportunityInput, "opportunityId"> & {
      sourceType: string;
      sourceRef: Record<string, unknown>;
    },
  ) {
    const existing = await this.prisma.editorialOpportunity.findFirst({
      where: {
        thesisHash: input.thesisHash,
        status: "OPEN",
        validUntil: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    return existing ?? this.createOpportunity(input);
  }

  async listOpen() {
    return this.prisma.editorialOpportunity.findMany({
      where: { status: "OPEN", OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] },
      orderBy: { createdAt: "asc" },
    });
  }

  plan(
    opportunities: readonly EditorialOpportunityInput[],
    candidates: readonly EditorialAccountCandidate[],
    existingThesisHashes?: ReadonlySet<string>,
  ) {
    return this.planner.plan(opportunities, candidates, existingThesisHashes);
  }

  async persistAssignments(
    assignments: readonly ReturnType<EditorialPortfolioPlanner["plan"]>[number][],
  ) {
    return this.prisma.$transaction(async (tx) =>
      Promise.all(
        assignments.map(async (assignment) => {
          const status =
            assignment.action === "SKIP" || assignment.action === "DEFER"
              ? assignment.action
              : "PLANNED";
          const existing = await tx.editorialAssignmentRecord.findFirst({
            where: {
              opportunityId: assignment.opportunityId,
              accountId: assignment.accountId,
              action: assignment.action,
              status,
              validUntil: { gt: new Date() },
            },
          });
          if (existing) return existing;
          return tx.editorialAssignmentRecord.create({
            data: {
              opportunityId: assignment.opportunityId,
              accountId: assignment.accountId,
              personaRevisionId: assignment.personaRevisionId || null,
              action: assignment.action,
              thesis: assignment.thesis,
              thesisHash: assignment.thesisHash,
              angle: assignment.angle,
              voiceMode: assignment.voiceMode,
              funnelIntent: assignment.funnelIntent,
              scoreComponents: assignment.scoreComponents as Prisma.InputJsonValue,
              constraintResults: assignment.hardConstraintResults as Prisma.InputJsonValue,
              status,
              validUntil: new Date(assignment.validUntil),
            },
          });
        }),
      ),
    );
  }

  async planAndPersist(input: {
    opportunity: EditorialOpportunityInput;
    candidates: readonly EditorialAccountCandidate[];
    existingThesisHashes?: ReadonlySet<string>;
  }) {
    const [assignment] = this.plan(
      [input.opportunity],
      input.candidates,
      input.existingThesisHashes,
    );
    if (!assignment) return null;
    const [record] = await this.persistAssignments([assignment]);
    return { ...assignment, assignmentId: record?.id as string | undefined };
  }

  async findActiveAssignment(opportunityId: string) {
    return this.prisma.editorialAssignmentRecord.findFirst({
      where: {
        opportunityId,
        status: "PLANNED",
        validUntil: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}
