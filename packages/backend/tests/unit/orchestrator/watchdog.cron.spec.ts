import { beforeEach, describe, expect, it, vi } from "vitest";
import { WatchdogCron } from "../../../src/modules/orchestrator/watchdog.cron.js";

function makeConfig(enabled = "true") {
  return {
    get: vi.fn((key: string, fallback?: unknown) => {
      if (key === "ORCHESTRATOR_ENABLED") return enabled;
      return fallback;
    }),
  } as never;
}

function makeRedis() {
  return {
    get: vi.fn().mockResolvedValue(String(Date.now() - 10_000_000)),
    set: vi.fn().mockResolvedValue("OK"),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe("WatchdogCron", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("takes a distributed lease before restarting stale orchestrator", async () => {
    const redis = makeRedis();
    const orchestrator = {
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const watchdog = new WatchdogCron(
      makeConfig(),
      redis as never,
      undefined,
      orchestrator as never,
    );

    await watchdog.checkHeartbeat();

    expect(redis.set).toHaveBeenCalledWith(
      "spa:orchestrator:watchdog-lock",
      expect.any(String),
      "PX",
      60_000,
      "NX",
    );
    expect(orchestrator.stop).toHaveBeenCalledOnce();
    expect(orchestrator.start).toHaveBeenCalledOnce();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      expect.any(String),
      expect.any(String),
    );
  });

  it("skips restart when another watchdog owns the lease", async () => {
    const redis = makeRedis();
    redis.set.mockResolvedValue(null);
    const orchestrator = { stop: vi.fn(), start: vi.fn() };
    const watchdog = new WatchdogCron(
      makeConfig(),
      redis as never,
      undefined,
      orchestrator as never,
    );

    await watchdog.checkHeartbeat();

    expect(orchestrator.stop).not.toHaveBeenCalled();
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
