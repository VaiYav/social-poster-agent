/**
 * M1.5: ResilienceService skeleton — degradation levels, withFallback,
 * canary probes. Redis-free paths (memory store) are covered; the Redis
 * client is mocked as null so the in-memory fallback is exercised.
 *
 * Source: packages/backend/src/modules/resilience/resilience.service.ts
 */
import { describe, expect, it, vi } from "vitest";
import { ResilienceService } from "../../../src/modules/resilience/resilience.service.js";

function buildService(): ResilienceService {
  // redis: null → in-memory fallback path
  return new ResilienceService(null);
}

describe("ResilienceService", () => {
  it("unknown subsystems are implicitly HEALTHY and usable", async () => {
    const svc = buildService();
    await expect(svc.getHealth("llm").then((h) => h.level)).resolves.toBe("HEALTHY");
    await expect(svc.isUsable("llm")).resolves.toBe(true);
  });

  it("reportHealth records transitions with reason + since", async () => {
    const svc = buildService();
    await svc.reportHealth("llm", "DEGRADED", "provider chain exhausted");
    const snap = await svc.getHealth("llm");
    expect(snap.level).toBe("DEGRADED");
    expect(snap.reason).toBe("provider chain exhausted");
    expect(snap.since).toBeLessThanOrEqual(Date.now());
    expect(snap.consecutiveProbePasses).toBe(0);
  });

  it("withFallback returns the fallback value and reports DEGRADED on failure", async () => {
    const svc = buildService();
    const result = await svc.withFallback(
      "image-gen",
      { fallbackValue: () => "text-only" },
      async () => {
        throw new Error("gemini quota exceeded");
      },
    );
    expect(result).toBe("text-only");
    const snap = await svc.getHealth("image-gen");
    expect(snap.level).toBe("DEGRADED");
    expect(snap.reason).toBe("gemini quota exceeded");
  });

  it("withFallback rethrows when no fallback value is provided", async () => {
    const svc = buildService();
    await expect(
      svc.withFallback("posting", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("success after CRITICAL promotes through probe passes", async () => {
    const svc = buildService();
    const probe = vi.fn().mockResolvedValue(true);
    svc.scheduleProbe("queues", probe, 60_000);

    await svc.reportHealth("queues", "CRITICAL", "worker stall");

    // First pass → RECOVERING, second pass → HEALTHY (streak = 2).
    await svc.runDueProbes();
    expect((await svc.getHealth("queues")).level).toBe("RECOVERING");

    // Force due again by rewinding nextProbeAt via a fresh schedule.
    svc.scheduleProbe("queues", probe, 60_000);
    await svc.runDueProbes();
    expect((await svc.getHealth("queues")).level).toBe("HEALTHY");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("failing probe demotes HEALTHY to CRITICAL and resets streak", async () => {
    const svc = buildService();
    svc.scheduleProbe("redis", vi.fn().mockResolvedValue(false), 60_000);
    await svc.runDueProbes();
    const snap = await svc.getHealth("redis");
    expect(snap.level).toBe("CRITICAL");
    expect(snap.consecutiveProbePasses).toBe(0);
    await expect(svc.isUsable("redis")).resolves.toBe(false);
  });

  it("can defer the first probe while applying bounded jitter to later runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const probe = vi.fn().mockResolvedValue(true);
      const svc = buildService();
      svc.scheduleProbe("llm", probe, 1_000, { jitterMs: 100, runImmediately: false });

      await svc.runDueProbes();
      expect(probe).not.toHaveBeenCalled();

      vi.advanceTimersByTime(900);
      await svc.runDueProbes();
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("getAllHealth merges memory entries sorted by subsystem name", async () => {
    const svc = buildService();
    await svc.reportHealth("zzz-subsystem", "DOWN");
    await svc.reportHealth("aaa-subsystem", "DEGRADED");
    const all = await svc.getAllHealth();
    expect(all.map((h) => h.subsystem)).toEqual(["aaa-subsystem", "zzz-subsystem"]);
  });
});
