// Resilience port — unified degradation model (ROADMAP_V2 M1.5 / docs/roadmap/06).
// Implementation: ResilienceService (modules/resilience). Full subsystem
// integration lands at M3 GA; this phase ships the health-level core,
// withFallback() and the probe registry.

/**
 * Explicit degradation ladder — a subsystem is always in exactly one level.
 * HEALTHY → DEGRADED → RECOVERING → CRITICAL → DOWN
 */
export type DegradationLevel =
  | "HEALTHY" // normal operation
  | "DEGRADED" // fallback active, service continues (e.g. inline prompt fallback)
  | "RECOVERING" // probing after failure (canary operations)
  | "CRITICAL" // feature paused, will retry automatically
  | "DOWN"; // needs human intervention

/** Persisted health record for one subsystem. */
export interface HealthSnapshot {
  subsystem: string;
  level: DegradationLevel;
  /** When the CURRENT level was entered (epoch ms). */
  since: number;
  /** Human-readable reason for the last transition. */
  reason?: string;
  lastProbeMs?: number;
  consecutiveProbePasses: number;
  nextProbeAt?: number;
}

export interface FallbackOptions<T = unknown> {
  /**
   * Value returned when fn() fails and the subsystem is degraded past the
   * given threshold. When omitted, the error propagates after reporting.
   */
  fallbackValue?: () => T;
  /** Level to report on fn() failure (default: DEGRADED). */
  failureLevel?: DegradationLevel;
}

export const IResiliencePort = Symbol("IResiliencePort");

export interface IResiliencePort {
  /** Record a health transition (no-op when the level is unchanged). */
  reportHealth(subsystem: string, level: DegradationLevel, reason?: string): Promise<void>;

  /** Current snapshot; implicit HEALTHY for unknown subsystems. */
  getHealth(subsystem: string): Promise<HealthSnapshot>;

  /** All known snapshots — dashboard / orchestrator OBSERVE feed. */
  getAllHealth(): Promise<HealthSnapshot[]>;

  /** True when the subsystem can serve traffic (HEALTHY / DEGRADED / RECOVERING). */
  isUsable(subsystem: string): Promise<boolean>;

  /**
   * Run fn() and auto-report failures at options.failureLevel; on failure
   * return options.fallbackValue() when provided, else rethrow.
   */
  withFallback<T>(subsystem: string, options: FallbackOptions<T>, fn: () => Promise<T>): Promise<T>;

  /** Register a canary probe; it runs when due via runDueProbes(). */
  scheduleProbe(subsystem: string, probe: () => Promise<boolean>, intervalMs: number): void;

  /** Execute all due probes; passing streak promotes out of CRITICAL/DOWN. */
  runDueProbes(): Promise<void>;
}
