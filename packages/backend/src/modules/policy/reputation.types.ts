import type { SocialNetwork } from "../../generated/prisma/client.js";
import type { ReputationState } from "./policy.types.js";

export const REPUTATION_SIGNAL_FAMILIES = ["TECHNICAL", "PUBLIC_SEMANTIC", "BEHAVIORAL"] as const;
export type ReputationSignalFamily = (typeof REPUTATION_SIGNAL_FAMILIES)[number];
export const REPUTATION_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ReputationSeverity = (typeof REPUTATION_SEVERITIES)[number];
export const REPUTATION_TRUST_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type ReputationTrustLevel = (typeof REPUTATION_TRUST_LEVELS)[number];

export interface ReputationSignalInput {
  readonly accountId: string;
  readonly network: SocialNetwork;
  readonly signalType: string;
  readonly signalFamily: ReputationSignalFamily;
  readonly severity: ReputationSeverity;
  readonly trustLevel: ReputationTrustLevel;
  readonly sourceRef: Record<string, unknown>;
  readonly evidenceHash: string;
  readonly classification?: Record<string, unknown>;
  readonly occurredAt?: Date;
  readonly expiresAt?: Date;
}

export interface IReputationStatePort {
  getState(accountId: string, network: SocialNetwork): Promise<ReputationState>;
}

export const IReputationStatePort = Symbol("IReputationStatePort");

export function reputationStateRank(state: ReputationState): number {
  return { HEALTHY: 0, WATCH: 1, LIMITED: 2, PAUSED: 3, INCIDENT: 4 }[state];
}
