import { describe, expect, it, vi } from "vitest";
import { OrchestratorHistoryService } from "../../../src/modules/orchestrator/orchestrator-history.service.js";

function buildService(redisOverrides: Record<string, unknown> = {}) {
  const redis = {
    lpush: vi.fn().mockResolvedValue(1),
    ltrim: vi.fn().mockResolvedValue("OK"),
    lrange: vi.fn().mockResolvedValue([]),
    ...redisOverrides,
  };
  const config = { get: vi.fn().mockReturnValue(undefined) };
  return {
    service: new OrchestratorHistoryService(config as never, redis as never),
    redis,
  };
}

describe("OrchestratorHistoryService", () => {
  it("records bounded cycle history with the configured Redis list", async () => {
    const { service, redis } = buildService();

    await service.record(4, { success: true, type: "POST", duration: 12 }, 60_000);

    expect(redis.lpush).toHaveBeenCalledWith(
      "spa:orchestrator:history",
      expect.stringContaining('"cycle":4'),
    );
    expect(redis.ltrim).toHaveBeenCalledWith("spa:orchestrator:history", 0, 199);
    const entry = JSON.parse(redis.lpush.mock.calls[0][1]);
    expect(entry).toMatchObject({
      cycle: 4,
      type: "POST",
      success: true,
      duration: 12,
      sleepMs: 60_000,
    });
  });

  it("clamps requested history limits to the safe range", async () => {
    const { service, redis } = buildService({
      lrange: vi.fn().mockResolvedValue(['{"cycle":1}']),
    });

    await service.getHistory(0);
    expect(redis.lrange).toHaveBeenLastCalledWith("spa:orchestrator:history", 0, 0);

    await service.getHistory(500);
    expect(redis.lrange).toHaveBeenLastCalledWith("spa:orchestrator:history", 0, 199);
  });

  it("uses a configured history key", async () => {
    const redis = {
      lpush: vi.fn().mockResolvedValue(1),
      ltrim: vi.fn().mockResolvedValue("OK"),
      lrange: vi.fn().mockResolvedValue([]),
    };
    const config = { get: vi.fn().mockReturnValue("custom:history") };
    const service = new OrchestratorHistoryService(config as never, redis as never);

    await service.record(1, null, 120_000);
    expect(redis.lpush.mock.calls[0][0]).toBe("custom:history");
  });

  it("fails closed when Redis recording or JSON history is unavailable", async () => {
    const { service: recordService } = buildService({
      lpush: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    await expect(recordService.record(1, null, 1_000)).resolves.toBeUndefined();

    const { service: readService } = buildService({
      lrange: vi.fn().mockResolvedValue(["not-json"]),
    });
    await expect(readService.getHistory()).resolves.toEqual([]);
  });
});
