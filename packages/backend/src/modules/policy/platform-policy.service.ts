import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { FlowControlService, type FlowName } from "../flow-control/flow-control.service.js";
import {
  type AuthorizePlatformActionParams,
  type CreateActionPolicyInput,
  type CreatePolicyEvidenceInput,
  executionModeRank,
  IPlatformPolicyPort,
  IRuntimeActionAuthorizer,
  isExecutionMode,
  mostRestrictiveMode,
  type PlatformAuthorizationDecision,
  type ExecutionMode,
  type ReputationState,
} from "./policy.types.js";
import {
  IReputationStatePort,
  type IReputationStatePort as ReputationStatePort,
} from "./reputation.types.js";

const ACTIVE = "ACTIVE";
const VERIFIED = "VERIFIED";
const DEFAULT_VALID_UNTIL_MS = 15 * 60 * 1000;

// Prisma 7's generated constructor type can lag behind the runtime client in
// extensionless CommonJS consumers. Keep this narrow structural view local to
// the policy adapter rather than weakening PrismaService globally.
type PolicyPrismaClient = PrismaService & {
  platformPolicyEvidence: Prisma.PlatformPolicyEvidenceDelegate;
  platformActionPolicy: Prisma.PlatformActionPolicyDelegate;
  compiledExecutionPolicy: Prisma.CompiledExecutionPolicyDelegate;
};

@Injectable()
export class PlatformPolicyService {
  private readonly logger = new Logger(PlatformPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowControl: FlowControlService,
    @Optional()
    @Inject(IReputationStatePort)
    private readonly reputationState?: ReputationStatePort,
  ) {}

  private get policyDb(): PolicyPrismaClient {
    return this.prisma as unknown as PolicyPrismaClient;
  }

  async createEvidence(input: CreatePolicyEvidenceInput) {
    validateEvidenceUrl(input.sourceUrl);
    return this.policyDb.platformPolicyEvidence.create({
      data: {
        network: input.network,
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType,
        contentHash: input.contentHash,
        snapshotRef: input.snapshotRef,
        expiresAt: input.expiresAt,
        reviewNotes: input.reviewNotes,
      },
    });
  }

  async verifyEvidence(id: string, reviewer: string) {
    return this.policyDb.platformPolicyEvidence.update({
      where: { id },
      data: { status: VERIFIED, reviewer, verifiedAt: new Date() },
    });
  }

  async listEvidence() {
    return this.policyDb.platformPolicyEvidence.findMany({
      orderBy: { createdAt: "desc" },
      include: { versions: { orderBy: { version: "desc" }, take: 5 } },
    });
  }

  async createPolicyVersion(input: CreateActionPolicyInput) {
    const evidence = await this.policyDb.platformPolicyEvidence.findUnique({
      where: { id: input.evidenceId },
      select: { id: true },
    });
    if (!evidence) throw new Error(`Policy evidence ${input.evidenceId} not found`);

    const latest = await this.policyDb.platformActionPolicy.findFirst({
      where: { policyKey: input.policyKey },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return this.policyDb.platformActionPolicy.create({
      data: {
        policyKey: input.policyKey,
        version: (latest?.version ?? 0) + 1,
        network: input.network,
        action: input.action,
        transport: input.transport,
        targetRelationship: input.targetRelationship,
        executionMode: input.executionMode,
        requirements: input.requirements as Prisma.InputJsonValue,
        limits: input.limits as Prisma.InputJsonValue | undefined,
        evidenceId: input.evidenceId,
        effectiveAt: input.effectiveAt,
        expiresAt: input.expiresAt,
        supersedesId: input.supersedesId,
      },
    });
  }

  async approvePolicy(id: string, reviewer: string) {
    const policy = await this.policyDb.platformActionPolicy.findUnique({
      where: { id },
      include: { evidence: true },
    });
    if (!policy) throw new Error(`Policy ${id} not found`);
    if (policy.evidence.status !== VERIFIED || isExpired(policy.evidence.expiresAt)) {
      throw new Error("Policy requires current VERIFIED evidence before approval");
    }
    return this.policyDb.platformActionPolicy.update({
      where: { id },
      data: { status: ACTIVE, approvedBy: reviewer, approvedAt: new Date() },
    });
  }

  async revokePolicy(id: string, reviewer: string, reason?: string) {
    return this.policyDb.platformActionPolicy.update({
      where: { id },
      data: {
        status: "REVOKED",
        approvedBy: reviewer,
        limits: { revokedReason: reason ?? "operator revoked" },
      },
    });
  }

  async listPolicies(network?: SocialNetwork) {
    return this.policyDb.platformActionPolicy.findMany({
      where: network ? { network } : undefined,
      orderBy: [{ network: "asc" }, { action: "asc" }, { version: "desc" }],
      include: { evidence: true },
    });
  }

  async authorize(params: AuthorizePlatformActionParams): Promise<PlatformAuthorizationDecision> {
    const now = new Date();
    const policies = await this.policyDb.platformActionPolicy.findMany({
      where: { network: params.network, action: params.action, status: ACTIVE },
      include: { evidence: true },
    });
    const matching = policies.filter(
      (policy) =>
        (policy.transport === params.transport || policy.transport === "ANY") &&
        (policy.targetRelationship === params.targetRelationship ||
          policy.targetRelationship === "ANY") &&
        isEffective(policy.effectiveAt, now) &&
        !isExpired(policy.expiresAt, now) &&
        policy.evidence.status === VERIFIED &&
        !isExpired(policy.evidence.expiresAt, now),
    );

    const reputationState: ReputationState = this.reputationState
      ? await this.reputationState.getState(params.accountId, params.network)
      : "HEALTHY";
    const flow = flowForAction(params.action);
    const flowPaused = flow ? await this.flowControl.isPaused(flow, params.accountId) : false;
    const policyModes = matching
      .map((policy) => policy.executionMode)
      .filter((mode): mode is ExecutionMode => isExecutionMode(mode));
    const requirements = matching.flatMap((policy) => jsonStringArray(policy.requirements));
    const blockReasons: string[] = [];
    let allowedMode: ExecutionMode = policyModes.length
      ? mostRestrictiveMode(policyModes)
      : "DISABLED";

    if (policyModes.length === 0) {
      blockReasons.push("No active policy backed by current verified evidence");
    }
    if (matching.length < policies.length && policies.length > 0) {
      blockReasons.push("One or more policy/evidence records are stale, revoked, or mismatched");
    }
    if (flowPaused) {
      allowedMode = "DISABLED";
      blockReasons.push(`Flow ${flow} is paused`);
    }
    if (isReputationBlocking(reputationState)) {
      allowedMode = "DISABLED";
      blockReasons.push(`Reputation state is ${reputationState}`);
    }
    if (params.contentRiskTier === "HIGH" && allowedMode === "APPROVED_AUTOMATION") {
      allowedMode = "HUMAN_APPROVAL_REQUIRED";
      blockReasons.push("High-risk content cannot use approved automation");
    }
    if (executionModeRank(allowedMode) > executionModeRank(params.requestedMode)) {
      allowedMode = params.requestedMode;
    }

    const validUntil = matching.reduce(
      (until, policy) => minDate(until, policy.expiresAt, policy.evidence.expiresAt),
      new Date(now.getTime() + DEFAULT_VALID_UNTIL_MS),
    );
    const policyHash = hashDecision({
      accountId: params.accountId,
      network: params.network,
      action: params.action,
      transport: params.transport,
      targetRelationship: params.targetRelationship,
      allowedMode,
      policyVersionIds: matching.map((policy) => policy.id).sort(),
      reputationState,
    });
    const decision: PlatformAuthorizationDecision = {
      allowedMode,
      policyVersionIds: matching.map((policy) => policy.id),
      policyHash,
      reputationState,
      requirements,
      blockReasons,
      validUntil: validUntil.toISOString(),
    };

    try {
      const compiledData = {
        accountId: params.accountId,
        network: params.network,
        action: params.action,
        contextClass: `${params.transport}:${params.targetRelationship}:${params.contentRiskTier}`,
        executionMode: allowedMode,
        sourcePolicyIds: decision.policyVersionIds as Prisma.InputJsonValue,
        reputationState,
        policyHash,
        validUntil,
      };
      await this.policyDb.compiledExecutionPolicy.upsert({
        where: {
          accountId_network_action_contextClass_policyHash: {
            accountId: params.accountId,
            network: params.network,
            action: params.action,
            contextClass: compiledData.contextClass,
            policyHash,
          },
        },
        create: compiledData,
        update: {
          validUntil,
          executionMode: allowedMode,
          sourcePolicyIds: compiledData.sourcePolicyIds,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to persist compiled policy: ${errorMessage(err)}`);
      return {
        ...decision,
        allowedMode: "DISABLED",
        blockReasons: [...decision.blockReasons, "Compiled policy could not be persisted"],
      };
    }
    return decision;
  }

  async reauthorize(
    params: AuthorizePlatformActionParams,
    expectedPolicyHash: string,
  ): Promise<PlatformAuthorizationDecision> {
    const current = await this.authorize(params);
    if (current.policyHash === expectedPolicyHash && new Date(current.validUntil) > new Date()) {
      return current;
    }
    return {
      ...current,
      allowedMode: "DISABLED",
      blockReasons: [...current.blockReasons, "Policy hash or expiry changed before side effect"],
    };
  }
}

function flowForAction(action: string): FlowName | undefined {
  if (action === "POST") return "posting";
  if (["REPLY", "MENTION", "QUOTE", "REPOST", "LIKE", "FOLLOW", "DM"].includes(action)) {
    return "engagement";
  }
  return undefined;
}

function isReputationBlocking(state: ReputationState): boolean {
  return state === "PAUSED" || state === "INCIDENT";
}

function isExpired(date: Date | null | undefined, now = new Date()): boolean {
  return Boolean(date && date <= now);
}

function isEffective(date: Date | null | undefined, now: Date): boolean {
  return !date || date <= now;
}

function minDate(current: Date, ...candidates: (Date | null | undefined)[]): Date {
  return candidates.reduce<Date>(
    (min, candidate) => (candidate && candidate < min ? candidate : min),
    current,
  );
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function hashDecision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validateEvidenceUrl(sourceUrl: string): void {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== "https:") throw new Error("Policy evidence URL must use HTTPS");
  const host = parsed.hostname.toLowerCase();
  const allowed = [
    "x.com",
    "twitter.com",
    "threads.net",
    "about.fb.com",
    "developers.facebook.com",
    "facebook.com",
  ];
  if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error(`Policy evidence host is not allowlisted: ${host}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { IPlatformPolicyPort, IRuntimeActionAuthorizer };
