import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  IKnowledgeRetrievalPort,
  IPersonaMemoryPort,
  type RetrievedGroundingItem,
} from "../../domain/ports/grounding.port.js";
import { detectGroundingConflicts, type GroundingConflict } from "./grounding-conflict-detector.js";

type GroundingPrismaClient = PrismaService & {
  knowledgeEvidence: Prisma.KnowledgeEvidenceDelegate;
  personaMemory: Prisma.PersonaMemoryDelegate;
};

@Injectable()
export class GroundingService implements IKnowledgeRetrievalPort, IPersonaMemoryPort {
  constructor(private readonly prisma: PrismaService) {}

  private get groundingDb(): GroundingPrismaClient {
    return this.prisma as unknown as GroundingPrismaClient;
  }

  async createEvidence(input: {
    domain: string;
    riskClass: string;
    title: string;
    text: string;
    sourceUrl?: string;
    sourceType: string;
    validFrom?: Date;
    validTo?: Date;
  }) {
    return this.groundingDb.knowledgeEvidence.create({
      data: {
        ...input,
        contentHash: hashText(`${input.title}\n${input.text}`),
      },
    });
  }

  async reviewEvidence(
    id: string,
    reviewStatus: "VERIFIED" | "REJECTED" | "STALE",
    reviewer: string,
  ) {
    const evidence = await this.groundingDb.knowledgeEvidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException(`Knowledge evidence ${id} not found`);
    return this.groundingDb.knowledgeEvidence.update({
      where: { id },
      data: {
        reviewStatus,
        reviewedAt: new Date(),
        reviewedBy: reviewer,
      },
    });
  }

  async listEvidence(query: { reviewStatus?: string; domain?: string }) {
    return this.groundingDb.knowledgeEvidence.findMany({
      where: { reviewStatus: query.reviewStatus, domain: query.domain },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  }

  async retrieveEvidence(params: {
    query: string;
    domain?: string;
    riskClass?: string;
    limit?: number;
  }): Promise<RetrievedGroundingItem[]> {
    const now = new Date();
    const rows = await this.groundingDb.knowledgeEvidence.findMany({
      where: {
        reviewStatus: "VERIFIED",
        domain: params.domain,
        riskClass: params.riskClass,
        OR: [{ validFrom: null }, { validFrom: { lte: now } }],
        AND: [{ validTo: null }, { validTo: { gt: now } }],
      },
      take: Math.max(1, Math.min(params.limit ?? 8, 50)),
    });
    return rankRows(rows, params.query).map((row) => ({
      id: row.id,
      text: row.text,
      sourceType: row.sourceType,
      riskClass: row.riskClass ?? undefined,
      score: row.score,
    }));
  }

  async createMemory(input: {
    personaId: string;
    kind: string;
    text: string;
    sourceType: string;
    sourceRef?: Record<string, unknown>;
    status?: "CANDIDATE" | "VERIFIED";
    confidence?: number;
    importance?: number;
    expiresAt?: Date;
  }) {
    if (!input.text.trim()) throw new ConflictException("Memory text cannot be empty");
    return this.groundingDb.personaMemory.create({
      data: {
        personaId: input.personaId,
        kind: input.kind,
        text: input.text.trim(),
        sourceType: input.sourceType,
        sourceRef: input.sourceRef as Prisma.InputJsonValue | undefined,
        status: input.status ?? "CANDIDATE",
        confidence: input.confidence,
        importance: input.importance ?? 0.5,
        expiresAt: input.expiresAt,
        contentHash: hashText(input.text),
      },
    });
  }

  async approveMemory(id: string, reviewer: string) {
    const memory = await this.groundingDb.personaMemory.findUnique({ where: { id } });
    if (!memory) throw new NotFoundException(`Persona memory ${id} not found`);
    if (memory.status !== "CANDIDATE") return memory;
    return this.groundingDb.personaMemory.update({
      where: { id },
      data: { status: "VERIFIED", reviewedBy: reviewer },
    });
  }

  async listMemories(query: { personaId?: string; status?: string }) {
    return this.groundingDb.personaMemory.findMany({
      where: { personaId: query.personaId, status: query.status },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  }

  async rejectMemory(id: string) {
    return this.groundingDb.personaMemory.update({ where: { id }, data: { status: "REJECTED" } });
  }

  async supersedeMemory(id: string, successorId: string) {
    const successor = await this.groundingDb.personaMemory.findUnique({
      where: { id: successorId },
    });
    if (!successor) throw new NotFoundException(`Successor memory ${successorId} not found`);
    return this.groundingDb.personaMemory.update({
      where: { id },
      data: { status: "SUPERSEDED", supersededById: successorId },
    });
  }

  async retrieveMemories(params: {
    personaId: string;
    query: string;
    kinds?: readonly string[];
    limit?: number;
  }): Promise<RetrievedGroundingItem[]> {
    const now = new Date();
    const rows = await this.groundingDb.personaMemory.findMany({
      where: {
        personaId: params.personaId,
        status: "VERIFIED",
        kind: params.kinds?.length ? { in: [...params.kinds] } : undefined,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      take: Math.max(1, Math.min(params.limit ?? 5, 20)),
    });
    return rankRows(rows, params.query).map((row) => ({
      id: row.id,
      text: row.text,
      sourceType: row.sourceType,
      score: row.score,
    }));
  }

  async findPossibleConflicts(params: {
    personaId: string;
    query: string;
  }): Promise<GroundingConflict[]> {
    const [memories, evidence] = await Promise.all([
      this.retrieveMemories({ personaId: params.personaId, query: params.query, limit: 8 }),
      this.retrieveEvidence({ query: params.query, limit: 8 }),
    ]);
    return detectGroundingConflicts([
      ...memories.map((item) => ({
        id: item.id,
        text: item.text,
        sourceType: `MEMORY:${item.sourceType}`,
      })),
      ...evidence.map((item) => ({
        id: item.id,
        text: item.text,
        sourceType: `EVIDENCE:${item.sourceType}`,
      })),
    ]);
  }

  async purgePersonaMemories(personaId: string, kind?: string) {
    return this.groundingDb.personaMemory.deleteMany({ where: { personaId, kind } });
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

function rankRows(
  rows: Array<{ id: string; text: string; sourceType: string; riskClass?: string | null }>,
  query: string,
): Array<{
  id: string;
  text: string;
  sourceType: string;
  riskClass?: string | null;
  score: number;
}> {
  const tokens = tokenize(query);
  return rows
    .map((row) => {
      const haystack = tokenize(row.text);
      const hits = tokens.filter((token) => haystack.includes(token)).length;
      return { ...row, score: tokens.length ? hits / tokens.length : 0 };
    })
    .filter((row) => row.score > 0 || tokens.length === 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}
