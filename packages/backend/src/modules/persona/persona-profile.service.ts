import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { PersonaProfileSchema, type PersonaProfile } from "@spa/shared";
import type { Prisma, SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  IAuthorContextPort,
  type AuthorContextResult,
  type IAuthorContextPort as AuthorContextPort,
  type ResolveAuthorContextParams,
} from "../../domain/ports/author-context.port.js";
import { loadPersonaProfiles } from "./persona-profile-config.js";
import {
  IKnowledgeRetrievalPort,
  IPersonaMemoryPort,
  type IKnowledgeRetrievalPort as KnowledgeRetrievalPort,
  type IPersonaMemoryPort as PersonaMemoryPort,
} from "../../domain/ports/grounding.port.js";

export interface CreatePersonaRevisionInput {
  personaId: string;
  profile: PersonaProfile;
  createdBy?: string;
  safetyPolicyVersion?: string;
}

@Injectable()
export class PersonaProfileService implements OnModuleInit, AuthorContextPort {
  private readonly logger = new Logger(PersonaProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() @Inject(IPersonaMemoryPort) private readonly memoryPort?: PersonaMemoryPort,
    @Optional()
    @Inject(IKnowledgeRetrievalPort)
    private readonly evidencePort?: KnowledgeRetrievalPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get<string>("PERSONA_SEED_DRAFTS", "true") === "true";
    if (!enabled) return;
    try {
      await this.seedDraftPersonas();
    } catch (err) {
      this.logger.warn(`Persona draft seeding skipped: ${errorMessage(err)}`);
    }
  }

  async createPersona(input: {
    key: string;
    displayName: string;
    profile: PersonaProfile;
    createdBy?: string;
    safetyPolicyVersion?: string;
  }) {
    const profile = PersonaProfileSchema.parse(input.profile);
    const checksum = profileChecksum(profile);
    return this.prisma.$transaction(async (tx) => {
      const persona = await tx.editorialPersona.create({
        data: { key: input.key, displayName: input.displayName, status: "DRAFT" },
      });
      const revision = await tx.personaRevision.create({
        data: {
          personaId: persona.id,
          version: 1,
          profile: profile as Prisma.InputJsonValue,
          checksum,
          safetyPolicyVersion: input.safetyPolicyVersion ?? "persona-policy-v1",
          createdBy: input.createdBy,
        },
      });
      return { persona, revision };
    });
  }

  async listPersonas() {
    return this.prisma.editorialPersona.findMany({
      orderBy: { key: "asc" },
      include: {
        revisions: { orderBy: { version: "desc" }, take: 1 },
        assignments: { where: { active: true } },
      },
    });
  }

  async createRevision(input: CreatePersonaRevisionInput) {
    const profile = PersonaProfileSchema.parse(input.profile);
    const checksum = profileChecksum(profile);
    return this.prisma.$transaction(async (tx) => {
      const latest = await tx.personaRevision.findFirst({
        where: { personaId: input.personaId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      return tx.personaRevision.create({
        data: {
          personaId: input.personaId,
          version: (latest?.version ?? 0) + 1,
          profile: profile as Prisma.InputJsonValue,
          checksum,
          safetyPolicyVersion: input.safetyPolicyVersion ?? "persona-policy-v1",
          createdBy: input.createdBy,
        },
      });
    });
  }

  async assign(input: {
    accountId: string;
    personaId: string;
    personaRevisionId: string;
    defaultVoiceMode: string;
    startsAt?: Date;
  }) {
    const revision = await this.prisma.personaRevision.findUnique({
      where: { id: input.personaRevisionId },
      select: { personaId: true },
    });
    if (!revision || revision.personaId !== input.personaId) {
      throw new Error("Persona revision does not belong to persona");
    }
    return this.prisma.$transaction(async (tx) => {
      const now = input.startsAt ?? new Date();
      await tx.accountPersonaAssignment.updateMany({
        where: { accountId: input.accountId, active: true },
        data: { active: false, endsAt: now },
      });
      return tx.accountPersonaAssignment.create({
        data: {
          accountId: input.accountId,
          personaId: input.personaId,
          personaRevisionId: input.personaRevisionId,
          defaultVoiceMode: input.defaultVoiceMode,
          startsAt: now,
        },
      });
    });
  }

  async resolve(params: ResolveAuthorContextParams): Promise<AuthorContextResult> {
    const assignment = await this.prisma.accountPersonaAssignment.findFirst({
      where: {
        accountId: params.accountId,
        active: true,
        startsAt: { lte: new Date() },
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
        account: { network: params.network },
      },
      orderBy: { startsAt: "desc" },
      include: {
        persona: true,
        personaRevision: true,
      },
    });
    if (!assignment) {
      return {
        accountId: params.accountId,
        network: params.network,
        personaId: null,
        personaRevisionId: null,
        voiceMode: params.requestedVoiceMode ?? "default",
        experimentAssignmentId: params.experimentAssignmentId ?? null,
        profile: null,
        disclosure: null,
        safetyPolicyVersion: null,
        source: "GLOBAL_FALLBACK",
      };
    }
    const profile = PersonaProfileSchema.parse(assignment.personaRevision.profile);
    const mode = params.requestedVoiceMode ?? assignment.defaultVoiceMode;
    if (!profile.modes.some((candidate) => candidate.id === mode)) {
      throw new Error(
        `Voice mode ${mode} is not defined by persona revision ${assignment.personaRevisionId}`,
      );
    }
    const traces = await this.resolveGrounding(params, assignment.personaId);
    return {
      accountId: params.accountId,
      network: params.network,
      personaId: assignment.personaId,
      personaRevisionId: assignment.personaRevisionId,
      voiceMode: mode,
      experimentAssignmentId: params.experimentAssignmentId ?? null,
      profile,
      disclosure: profile.identity.disclosure,
      safetyPolicyVersion: assignment.personaRevision.safetyPolicyVersion,
      source: "PERSONA",
      ...traces,
    };
  }

  private async resolveGrounding(
    params: ResolveAuthorContextParams,
    personaId: string,
  ): Promise<Pick<AuthorContextResult, "memoryTrace" | "evidenceTrace" | "retrieverMode">> {
    if (!params.retrievalQuery) return { retrieverMode: "NONE" };
    if (!this.memoryPort && !this.evidencePort) return { retrieverMode: "UNAVAILABLE" };
    try {
      const [memoryTrace, evidenceTrace] = await Promise.all([
        this.memoryPort?.retrieveMemories({
          personaId,
          query: params.retrievalQuery,
          limit: 5,
        }) ?? Promise.resolve([]),
        this.evidencePort?.retrieveEvidence({
          query: params.retrievalQuery,
          domain: params.retrievalDomain,
          riskClass: params.retrievalRiskClass,
          limit: 5,
        }) ?? Promise.resolve([]),
      ]);
      return { memoryTrace, evidenceTrace, retrieverMode: "LEXICAL" };
    } catch (err) {
      this.logger.warn(`Author grounding lookup unavailable: ${errorMessage(err)}`);
      return { retrieverMode: "UNAVAILABLE", memoryTrace: [], evidenceTrace: [] };
    }
  }

  async seedDraftPersonas(): Promise<void> {
    const profiles = await loadPersonaProfiles(this.configService);
    if (Object.keys(profiles).length === 0) {
      this.logger.warn("No PERSONA_PROFILES_PATH configured — skipping persona draft seeding");
      return;
    }
    for (const [key, definition] of Object.entries(profiles)) {
      const existing = await this.prisma.editorialPersona.findUnique({ where: { key } });
      if (existing) continue;
      await this.createPersona({
        key,
        displayName: definition.displayName,
        profile: definition.profile,
      });
      this.logger.log(`Seeded draft persona ${key}`);
    }
  }
}

export function profileChecksum(profile: PersonaProfile): string {
  return createHash("sha256").update(stableJson(profile), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
