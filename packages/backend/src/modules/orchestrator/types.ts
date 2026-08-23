/**
 * Orchestrator types — shared type definitions for the LangGraph orchestrator.
 *
 * These types define the contract between the four graph nodes
 * (OBSERVE → DECIDE → EXECUTE → EVALUATE) and the services they call.
 */

import type { SocialNetwork, SessionStatus } from "../../generated/prisma/client.js";

// ── World State (collected by OBSERVE node) ────────────────────────────────

export interface TopicPoolState {
  count: number;
  threshold: number;
  oldestAgeMs: number;
}

export interface DraftCounts {
  pending: number;
  approved: number;
  rejected: number;
  approvedByNetwork: Record<string, number>;
}

export interface SessionState {
  status: SessionStatus | "unknown";
  lastCheckMs: number;
  circuitBreaker: "closed" | "open" | "half_open" | "unknown";
}

/**
 * M1.1 multi-account: runtime state of a single SocialAccount as observed
 * during the OBSERVE cycle. Keyed in WorldState.accounts.accounts by
 * `${network}:${handle}`.
 */
export interface AccountRuntimeState {
  accountId: string;
  network: string;
  handle: string;
  displayName?: string;
  /** Latest ACTIVE session status for this account; "none" when it has none. */
  sessionStatus: SessionStatus | "none";
  lastHealthCheckMs: number;
  circuitBreaker: "closed" | "open" | "half_open";
  warmupEnabled: boolean;
  /** F20 warm-up ramp day when warmupEnabled (0-based days since start). */
  warmupDay?: number;
}

/**
 * M1.1 multi-account: per-account view of the fleet.
 * Network-level `WorldState.sessions` stays an AGGREGATE (best case across
 * accounts) so HardRules/Guardrails/LLM consumers keep their per-network
 * contract; the per-account detail lives here for account-aware decisions.
 */
export interface AccountsState {
  total: number;
  byNetwork: Record<string, number>;
  accounts: Record<string, AccountRuntimeState>;
}

export interface RateLimitState {
  dailyRemaining: number;
  weeklyRemaining: number;
  dailyLimit: number;
  weeklyLimit: number;
  minIntervalMs: number;
  lastPostMs: number;
}

export interface PostingWindow {
  bestHours: number[];
  inWindow: boolean;
  confidence: "high" | "medium" | "low";
}

export interface PostMetricsSummary {
  lastPostMetrics?: {
    impressions: number;
    likes: number;
    comments: number;
    shares: number;
  };
  recentAvgEngagement: number;
  bestHours: number[];
}

export interface EngagementState {
  lastBrowseMs: Record<string, number>;
  uncheckedReplies: number;
  warmupPhase: Record<string, string>;
  lastSessionStatus: Record<string, string>;
  lastSessionInteractions: Record<string, number>;
  /** Number of outstanding engagement sessions that should have run but didn't (per target cadence). */
  engagementDebt: number;
  /** P0: daily engagement budget vs actual for the current calendar day. */
  commentsTargetToday: number;
  commentsActualToday: number;
  likesTargetToday: number;
  likesActualToday: number;
  /** Outstanding comments/likes still needed to hit today's target. */
  debt: number;
}

export interface HealthState {
  bans: number;
  dlqDepth: number;
  stuckPosting: number;
  stuckBrowsingSessions: number;
  orphanedPosts: number;
  killSwitch: boolean;
}

export interface FlowControlState {
  pauseAll: boolean;
  pauseGeneration: boolean;
  pausePosting: boolean;
  pauseEngagement: boolean;
  pauseReplies: boolean;
  /** P1: kill-switches for LLM-in-the-loop triage and auto-approve. */
  pauseLlmTriage: boolean;
  pauseAutoApprove: boolean;
}

export interface TrendState {
  lastRefreshMs: number;
  count: number;
}

export interface WorldState {
  timestamp: number;

  // Content pipeline
  topicPool: TopicPoolState;
  drafts: DraftCounts;
  queueDepth: Record<string, number>;
  /** Account-scoped queue depth keyed by `${network}:${accountId}`. */
  queueDepthByAccount?: Record<string, number>;

  // Sessions + rate limits
  sessions: Record<string, SessionState>;
  rateLimits: Record<string, RateLimitState>;
  /** Account-scoped rate-limit snapshots keyed by `${network}:${accountId}`. */
  rateLimitsByAccount?: Record<string, RateLimitState>;
  /** M1.1: per-account runtime detail (key `${network}:${handle}`). */
  accounts: AccountsState;

  // Timing
  now: number;
  utcHour: number;
  utcDayOfWeek: number;
  postingWindows: Record<string, PostingWindow | null>;
  inPostingWindow: Record<string, boolean>;

  // Performance
  performance: Record<string, PostMetricsSummary>;

  // Engagement
  engagement: EngagementState;

  // Health
  health: HealthState;

  // Trends
  trends: TrendState;

  // Flow control
  flowControl: FlowControlState;

  // Metadata
  _degraded: string[];
  _collectedAt: number;
}

// ── Actions (produced by DECIDE node) ──────────────────────────────────────

export type ActionType =
  | "GENERATE_TOPICS"
  | "GENERATE_POSTS"
  | "POST"
  | "BROWSE"
  | "RECOVER_SESSION"
  | "CHECK_REPLIES"
  | "REFRESH_TRENDS"
  | "HEALTH_CHECK"
  | "RECONCILE"
  | "TRIAGE_QUEUE"
  | "SCRAPE_METRICS"
  | "RECYCLE_CONTENT"
  | "AGGREGATE_HOOKS"
  | "WAIT";

/** Actions that require a network target */
export type NetworkActionType = "POST" | "BROWSE" | "RECOVER_SESSION";

/** Actions that don't require a network */
export type GenericActionType = Exclude<ActionType, NetworkActionType>;

interface BaseAction {
  reason: string;
  source: "hard_rule" | "llm" | "guardrail_override" | "rules_fallback";
  params?: Record<string, unknown>;
}

export interface NetworkAction extends BaseAction {
  type: NetworkActionType;
  network: SocialNetwork;
}

export interface GenericAction extends BaseAction {
  type: GenericActionType;
  network?: SocialNetwork;
}

export type Action = NetworkAction | GenericAction;

// ── Action Results (produced by EXECUTE node) ──────────────────────────────

export interface ActionResult {
  success: boolean;
  type: ActionType;
  duration: number;
  error?: string;
  sideEffects?: Record<string, unknown>;
}

// ── Orchestrator State (LangGraph Annotation) ──────────────────────────────

export interface OrchestratorState {
  world: WorldState;
  action: Action;
  result: ActionResult;
  cycle: number;
  sleepMs: number;
  heartbeat: number;
  errors: Error[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

export const WAIT_ACTION = (
  reason: string,
  sleepMs = 120_000,
  source: Action["source"] = "hard_rule",
): GenericAction => ({
  type: "WAIT",
  reason,
  source,
  params: { sleepMs },
});

export const RECOVER_ACTION = (network: SocialNetwork, reason: string): NetworkAction => ({
  type: "RECOVER_SESSION",
  network,
  reason,
  source: "hard_rule",
});
