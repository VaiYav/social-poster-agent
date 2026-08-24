import type { SocialNetwork } from "../../generated/prisma/client.js";

export const POLICY_EXECUTION_MODES = [
  "DISABLED",
  "SUGGEST_ONLY",
  "HUMAN_APPROVAL_REQUIRED",
  "APPROVED_AUTOMATION",
] as const;
export type ExecutionMode = (typeof POLICY_EXECUTION_MODES)[number];

export const PLATFORM_ACTIONS = [
  "POST",
  "REPLY",
  "MENTION",
  "QUOTE",
  "REPOST",
  "LIKE",
  "FOLLOW",
  "DM",
  "READ",
] as const;
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];

export type PlatformTransport = "OFFICIAL_API" | "BROWSER" | "MANUAL_EXTERNAL";
export type TargetRelationship = "OWN_POST" | "MENTIONED_US" | "OPTED_IN" | "STRANGER" | "UNKNOWN";
export type RiskTier = "LOW" | "MEDIUM" | "HIGH";
export type ReputationState = "HEALTHY" | "WATCH" | "LIMITED" | "PAUSED" | "INCIDENT";

export interface AuthorizePlatformActionParams {
  readonly accountId: string;
  readonly network: SocialNetwork;
  readonly action: PlatformAction;
  readonly transport: PlatformTransport;
  readonly targetRelationship: TargetRelationship;
  readonly contentRiskTier: RiskTier;
  readonly requestedMode: ExecutionMode;
}

export interface PlatformAuthorizationDecision {
  readonly allowedMode: ExecutionMode;
  readonly policyVersionIds: readonly string[];
  readonly policyHash: string;
  readonly reputationState: ReputationState;
  readonly requirements: readonly string[];
  readonly blockReasons: readonly string[];
  readonly validUntil: string;
}

export interface IRuntimeActionAuthorizer {
  authorize(params: AuthorizePlatformActionParams): Promise<PlatformAuthorizationDecision>;
  reauthorize(
    params: AuthorizePlatformActionParams,
    expectedPolicyHash: string,
  ): Promise<PlatformAuthorizationDecision>;
}

export const IRuntimeActionAuthorizer = Symbol("IRuntimeActionAuthorizer");
export const IPlatformPolicyPort = Symbol("IPlatformPolicyPort");

export interface CreatePolicyEvidenceInput {
  readonly network: SocialNetwork;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly contentHash: string;
  readonly snapshotRef?: string;
  readonly expiresAt?: Date;
  readonly reviewNotes?: string;
}

export interface CreateActionPolicyInput {
  readonly policyKey: string;
  readonly network: SocialNetwork;
  readonly action: PlatformAction;
  readonly transport: PlatformTransport;
  readonly targetRelationship: TargetRelationship | "ANY";
  readonly executionMode: ExecutionMode;
  readonly requirements: string[];
  readonly limits?: Record<string, unknown>;
  readonly evidenceId: string;
  readonly effectiveAt?: Date;
  readonly expiresAt?: Date;
  readonly supersedesId?: string;
}

export function isExecutionMode(value: string): value is ExecutionMode {
  return (POLICY_EXECUTION_MODES as readonly string[]).includes(value);
}

export function executionModeRank(mode: ExecutionMode): number {
  return POLICY_EXECUTION_MODES.indexOf(mode);
}

export function mostRestrictiveMode(modes: readonly ExecutionMode[]): ExecutionMode {
  return modes.reduce<ExecutionMode>(
    (current, candidate) =>
      executionModeRank(candidate) < executionModeRank(current) ? candidate : current,
    "APPROVED_AUTOMATION",
  );
}
