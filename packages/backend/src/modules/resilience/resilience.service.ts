// ResilienceService — M1.5 skeleton of the unified self-healing layer
// (ROADMAP_V2 / docs/roadmap/06). Health is stored in Redis
// (`spa:health:{subsystem}`) with an in-memory fallback so the service stays
// usable when Redis itself is the sick subsystem.
//
// M3 GA will wire reportHealth/withFallback into LLM, browser, sessions,
// posting, queues and Langfuse; this phase ships the levels + fallback +
// canary-probe core and keeps every seam injectable.

import { Inject, Injectable, Logger, Optional } from "@nestjs/common";

import {
  IResiliencePort,
  type DegradationLevel,
  type FallbackOptions,
  type HealthSnapshot,
} from "../../domain/ports/resilience.port.js";
import { SHARED_REDIS } from "../../infrastructure/redis/redis.module.js";

const HEALTH_KEY_PREFIX = "spa:health:";
/** Probe streak required to promote CRITICAL/DOWN → RECOVERING → HEALTHY. */
const PROBE_STREAK_TO_RECOVER = 2;

interface ProbeRegistration {
  probe: () => Promise<boolean>;
  intervalMs: number;
  nextProbeAt: number;
}

@Injectable()
export class ResilienceService implements IResiliencePort {
  private readonly logger = new Logger(ResilienceService.name);
  /** In-memory mirror — also the store when Redis is unavailable. */
  private readonly memory = new Map<string, HealthSnapshot>();
  private readonly probes = new Map<string, ProbeRegistration>();

  constructor(
    @Optional()
    @Inject(SHARED_REDIS)
    private readonly redis?: InstanceType<typeof import("ioredis").default> | null,
  ) {}

  async reportHealth(subsystem: string, level: DegradationLevel, reason?: string): Promise<void> {
    const current = await this.getHealth(subsystem);
    if (current.level === level && current.reason === reason) return;

    const snapshot: HealthSnapshot = {
      subsystem,
      level,
      since: Date.now(),
      ...(reason !== undefined ? { reason } : {}),
      ...(current.lastProbeMs !== undefined ? { lastProbeMs: current.lastProbeMs } : {}),
      // Entering a failure state resets the recovery streak.
      consecutiveProbePasses:
        level === "CRITICAL" || level === "DOWN" ? 0 : current.consecutiveProbePasses,
      ...(current.nextProbeAt !== undefined ? { nextProbeAt: current.nextProbeAt } : {}),
    };

    this.memory.set(subsystem, snapshot);
    try {
      await this.redis?.set(
        `${HEALTH_KEY_PREFIX}${subsystem}`,
        JSON.stringify(snapshot),
        "EX",
        86_400,
      );
    } catch (err) {
      this.logger.warn(
        `reportHealth(${subsystem}): Redis write failed — memory only (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.logger.log(
      `Health ${subsystem}: ${current.level} → ${level}${reason ? ` (${reason})` : ""}`,
    );
  }

  async getHealth(subsystem: string): Promise<HealthSnapshot> {
    try {
      const raw = await this.redis?.get(`${HEALTH_KEY_PREFIX}${subsystem}`);
      if (raw) return JSON.parse(raw) as HealthSnapshot;
    } catch {
      // fall through to memory
    }
    return (
      this.memory.get(subsystem) ?? {
        subsystem,
        level: "HEALTHY",
        since: Date.now(),
        consecutiveProbePasses: 0,
      }
    );
  }

  async getAllHealth(): Promise<HealthSnapshot[]> {
    const merged = new Map(this.memory);
    try {
      const keys = await this.redis?.keys(`${HEALTH_KEY_PREFIX}*`);
      for (const key of keys ?? []) {
        const raw = await this.redis?.get(key);
        if (!raw) continue;
        try {
          const snap = JSON.parse(raw) as HealthSnapshot;
          merged.set(snap.subsystem, snap);
        } catch {
          // corrupt record — skip
        }
      }
    } catch {
      // Redis unavailable — memory view is enough
    }
    return [...merged.values()].sort((a, b) => a.subsystem.localeCompare(b.subsystem));
  }

  async isUsable(subsystem: string): Promise<boolean> {
    const { level } = await this.getHealth(subsystem);
    return level === "HEALTHY" || level === "DEGRADED" || level === "RECOVERING";
  }

  async withFallback<T>(
    subsystem: string,
    options: FallbackOptions<T>,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn();
      const health = await this.getHealth(subsystem);
      if (health.level === "CRITICAL" || health.level === "DOWN") {
        // Success while marked down — start promoting via probe semantics.
        await this.recordProbePass(subsystem, true);
      }
      return result;
    } catch (err) {
      await this.reportHealth(
        subsystem,
        options.failureLevel ?? "DEGRADED",
        err instanceof Error ? err.message : String(err),
      );
      if (options.fallbackValue) return options.fallbackValue();
      throw err;
    }
  }

  scheduleProbe(subsystem: string, probe: () => Promise<boolean>, intervalMs: number): void {
    this.probes.set(subsystem, { probe, intervalMs, nextProbeAt: Date.now() });
  }

  /**
   * Run all due probes. A passing streak promotes CRITICAL/DOWN → RECOVERING
   * → HEALTHY; a failing probe re-marks RECOVERING→CRITICAL and resets streak.
   */
  async runDueProbes(): Promise<void> {
    const now = Date.now();
    for (const [subsystem, reg] of this.probes) {
      if ((reg.nextProbeAt ?? 0) > now) continue;
      reg.nextProbeAt = now + reg.intervalMs;
      let pass = false;
      try {
        pass = await reg.probe();
      } catch {
        pass = false;
      }
      await this.recordProbePass(subsystem, pass);
    }
  }

  private async recordProbePass(subsystem: string, pass: boolean): Promise<void> {
    const current = await this.getHealth(subsystem);
    const lastProbeMs = Date.now();
    const nextProbeAt = this.probes.get(subsystem)?.nextProbeAt ?? lastProbeMs + 60_000;

    if (!pass) {
      const level: DegradationLevel =
        current.level === "HEALTHY" || current.level === "DEGRADED" ? "CRITICAL" : current.level;
      await this.reportHealth(subsystem, level, "recovery probe failed");
      const snap = await this.getHealth(subsystem);
      await this.persist({ ...snap, consecutiveProbePasses: 0, lastProbeMs, nextProbeAt });
      return;
    }

    const passes = current.consecutiveProbePasses + 1;
    let level = current.level;
    if (current.level !== "HEALTHY") {
      if (passes >= PROBE_STREAK_TO_RECOVER) {
        // canary proven over the full streak — promote fully
        level = "HEALTHY";
      } else if (current.level === "CRITICAL" || current.level === "DOWN") {
        level = "RECOVERING";
      }
      // DEGRADED stays DEGRADED until the streak completes.
    }
    await this.reportHealth(subsystem, level, `probe pass ${passes}/${PROBE_STREAK_TO_RECOVER}`);
    const snap = await this.getHealth(subsystem);
    await this.persist({ ...snap, consecutiveProbePasses: passes, lastProbeMs, nextProbeAt });
  }

  /** Direct persistence bypassing transition logging (for probe bookkeeping). */
  private async persist(snapshot: HealthSnapshot): Promise<void> {
    this.memory.set(snapshot.subsystem, snapshot);
    try {
      await this.redis?.set(
        `${HEALTH_KEY_PREFIX}${snapshot.subsystem}`,
        JSON.stringify(snapshot),
        "EX",
        86_400,
      );
    } catch {
      // memory only
    }
  }
}
