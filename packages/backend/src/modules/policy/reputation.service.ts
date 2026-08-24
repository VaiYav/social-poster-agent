import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SocialNetwork } from "../../generated/prisma/client.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { FlowControlService } from "../flow-control/flow-control.service.js";
import {
  IReputationStatePort,
  type IReputationStatePort as ReputationStatePort,
  type ReputationSignalInput,
  reputationStateRank,
} from "./reputation.types.js";

const STATE_NAMES = ["HEALTHY", "WATCH", "LIMITED", "PAUSED", "INCIDENT"] as const;
type ReputationStateName = (typeof STATE_NAMES)[number];
const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class ReputationService implements ReputationStatePort {
  private readonly logger = new Logger(ReputationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flowControl: FlowControlService,
  ) {}

  async getState(accountId: string, network: SocialNetwork): Promise<ReputationStateName> {
    const state = await this.prisma.accountReputationState.findUnique({
      where: { accountId_network: { accountId, network } },
      select: { state: true },
    });
    return isState(state?.state) ? state.state : "HEALTHY";
  }

  async getStateRecord(accountId: string, network: SocialNetwork) {
    return this.prisma.accountReputationState.findUnique({
      where: { accountId_network: { accountId, network } },
      select: { id: true, accountId: true, network: true, state: true, version: true, reason: true, changedAt: true },
    });
  }

  async ingestSignal(input: ReputationSignalInput) {
    const signal = await this.prisma.reputationSignal.upsert({
      where: {
        accountId_network_signalType_evidenceHash: {
          accountId: input.accountId,
          network: input.network,
          signalType: input.signalType,
          evidenceHash: input.evidenceHash,
        },
      },
      create: {
        accountId: input.accountId,
        network: input.network,
        signalType: input.signalType,
        signalFamily: input.signalFamily,
        severity: input.severity,
        trustLevel: input.trustLevel,
        sourceRef: input.sourceRef as Prisma.InputJsonValue,
        evidenceHash: input.evidenceHash,
        classification: input.classification as Prisma.InputJsonValue | undefined,
        occurredAt: input.occurredAt ?? new Date(),
        expiresAt: input.expiresAt,
      },
      update: {},
    });
    await this.reconcile(input.accountId, input.network);
    return signal;
  }

  async reconcile(accountId: string, network: SocialNetwork) {
    const now = new Date();
    const signals = await this.prisma.reputationSignal.findMany({
      where: {
        accountId,
        network,
        occurredAt: { gte: new Date(now.getTime() - SIGNAL_WINDOW_MS) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { occurredAt: "desc" },
    });
    const current = await this.getState(accountId, network);
    const target = deriveState(signals);
    if (reputationStateRank(target) <= reputationStateRank(current)) {
      return { state: current, changed: false, signalCount: signals.length };
    }
    return this.applyAutomaticTransition(accountId, network, current, target, signals);
  }

  async listSignals(query: { accountId?: string; network?: SocialNetwork; limit?: number }) {
    return this.prisma.reputationSignal.findMany({
      where: { accountId: query.accountId, network: query.network },
      orderBy: { occurredAt: "desc" },
      take: query.limit ?? 100,
    });
  }

  async listIncidents(query: { accountId?: string; network?: SocialNetwork; status?: string }) {
    return this.prisma.reputationIncident.findMany({
      where: { accountId: query.accountId, network: query.network, status: query.status },
      orderBy: { createdAt: "desc" },
    });
  }

  async acknowledgeIncident(id: string, owner: string) {
    const result = await this.prisma.reputationIncident.updateMany({
      where: { id, acknowledgedAt: null },
      data: { owner, acknowledgedAt: new Date(), status: "ACKNOWLEDGED" },
    });
    if (result.count !== 1) throw new NotFoundException(`Open reputation incident ${id} not found`);
    return this.prisma.reputationIncident.findUnique({ where: { id } });
  }

  /**
   * Operator-controlled staged recovery. A state cannot jump directly from
   * INCIDENT/PAUSED to HEALTHY; the expected version prevents stale UI writes.
   */
  async recover(input: {
    accountId: string;
    network: SocialNetwork;
    expectedVersion: number;
    targetState: "HEALTHY" | "WATCH" | "LIMITED" | "PAUSED";
    reviewer: string;
    reason: string;
  }) {
    const current = await this.prisma.accountReputationState.findUnique({
      where: { accountId_network: { accountId: input.accountId, network: input.network } },
    });
    if (!current) throw new NotFoundException("Reputation state not found");
    if (!isState(current.state)) throw new ConflictException("Unknown reputation state");
    if (reputationStateRank(input.targetState) >= reputationStateRank(current.state)) {
      throw new ConflictException("Recovery target must be less restrictive than current state");
    }
    if (current.state === "INCIDENT" && input.targetState === "HEALTHY") {
      throw new ConflictException("INCIDENT requires staged recovery through PAUSED/LIMITED/WATCH");
    }
    const updated = await this.prisma.accountReputationState.updateMany({
      where: {
        accountId: input.accountId,
        network: input.network,
        version: input.expectedVersion,
      },
      data: {
        state: input.targetState,
        version: { increment: 1 },
        reason: `${input.reviewer}: ${input.reason}`,
        changedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new ConflictException("Reputation state changed concurrently");
    await this.applyFlowEffects(input.accountId, input.network, input.targetState);
    return this.prisma.accountReputationState.findUnique({
      where: { accountId_network: { accountId: input.accountId, network: input.network } },
    });
  }

  private async applyAutomaticTransition(
    accountId: string,
    network: SocialNetwork,
    current: ReputationStateName,
    target: ReputationStateName,
    signals: Array<{ id: string; signalFamily: string; severity: string; signalType: string }>,
  ) {
    const state = await this.prisma.accountReputationState.upsert({
      where: { accountId_network: { accountId, network } },
      create: { accountId, network, state: target, version: 1, reason: transitionReason(signals) },
      update: {
        state: target,
        version: { increment: 1 },
        reason: transitionReason(signals),
        changedAt: new Date(),
      },
    });
    await this.prisma.reputationIncident.create({
      data: {
        accountId,
        network,
        status: "OPEN",
        stateBefore: current,
        stateAfter: target,
        severity: target === "INCIDENT" ? "CRITICAL" : target,
        signalIds: signals.map((signal) => signal.id) as Prisma.InputJsonValue,
        decisionRules: {
          sentimentOnlyCannotPause: true,
          rule: target === "WATCH" ? "single_or_advisory_signal" : "critical_or_corroborated",
        } as Prisma.InputJsonValue,
        automaticActions: flowEffects(target) as Prisma.InputJsonValue,
      },
    });
    await this.applyFlowEffects(accountId, network, target);
    this.logger.warn(`Reputation ${accountId}/${network}: ${current} → ${target}`);
    return { state: state.state, changed: true, signalCount: signals.length };
  }

  private async applyFlowEffects(
    accountId: string,
    network: SocialNetwork,
    state: ReputationStateName,
  ): Promise<void> {
    if (state === "LIMITED") {
      await this.flowControl.pauseScoped(
        "engagement",
        accountId,
        `Reputation LIMITED on ${network}`,
      );
      return;
    }
    if (state === "PAUSED" || state === "INCIDENT") {
      await Promise.all([
        this.flowControl.pauseScoped("engagement", accountId, `Reputation ${state} on ${network}`),
        this.flowControl.pauseScoped("posting", accountId, `Reputation ${state} on ${network}`),
      ]);
      return;
    }
    await Promise.all([
      this.flowControl.resumeScoped("engagement", accountId),
      this.flowControl.resumeScoped("posting", accountId),
    ]);
  }
}

function deriveState(
  signals: Array<{
    signalFamily: string;
    severity: string;
    trustLevel: string;
    signalType: string;
  }>,
): ReputationStateName {
  const criticalTrusted = signals.some(
    (signal) => signal.severity === "CRITICAL" && signal.trustLevel === "HIGH",
  );
  if (criticalTrusted) {
    const incident = signals.some((signal) =>
      /policy|suspend|safety|duplicate_execution/i.test(signal.signalType),
    );
    return incident ? "INCIDENT" : "PAUSED";
  }
  const corroboratedFamilies = new Set(
    signals
      .filter(
        (signal) => ["HIGH", "CRITICAL"].includes(signal.severity) && signal.trustLevel !== "LOW",
      )
      .map((signal) => signal.signalFamily),
  );
  if (corroboratedFamilies.size >= 2) return "LIMITED";
  if (signals.length > 0) return "WATCH";
  return "HEALTHY";
}

function transitionReason(
  signals: Array<{ signalType: string; signalFamily: string; severity: string }>,
): string {
  return signals
    .slice(0, 5)
    .map((signal) => `${signal.signalFamily}:${signal.signalType}:${signal.severity}`)
    .join(", ");
}

function flowEffects(state: ReputationStateName): string[] {
  if (state === "LIMITED") return ["PAUSE_SCOPED_ENGAGEMENT"];
  if (state === "PAUSED" || state === "INCIDENT") {
    return ["PAUSE_SCOPED_ENGAGEMENT", "PAUSE_SCOPED_POSTING"];
  }
  return ["RESUME_SCOPED_ENGAGEMENT", "RESUME_SCOPED_POSTING"];
}

function isState(value: string | undefined): value is ReputationStateName {
  return Boolean(value && (STATE_NAMES as readonly string[]).includes(value));
}

export { IReputationStatePort };
