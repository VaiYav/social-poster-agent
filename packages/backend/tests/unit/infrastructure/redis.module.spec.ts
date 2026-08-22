/**
 * RedisModule unit tests — connection lifecycle and error handling.
 *
 * Source: packages/backend/src/infrastructure/redis/redis.module.ts
 */
import { describe, it, expect, vi } from "vitest";
import { RedisLifecycleService } from "../../../src/infrastructure/redis/redis.module";

describe("RedisLifecycleService — P0 1.4 lifecycle", () => {
  it("onModuleDestroy quits all three Redis connections", async () => {
    const redis = { on: vi.fn(), quit: vi.fn().mockResolvedValue("OK") };
    const subscriber = { on: vi.fn(), quit: vi.fn().mockResolvedValue("OK") };
    const publisher = { on: vi.fn(), quit: vi.fn().mockResolvedValue("OK") };

    const lifecycle = new RedisLifecycleService(
      redis as never,
      subscriber as never,
      publisher as never,
    );
    await lifecycle.onModuleDestroy();

    expect(redis.quit).toHaveBeenCalledOnce();
    expect(subscriber.quit).toHaveBeenCalledOnce();
    expect(publisher.quit).toHaveBeenCalledOnce();
  });
});
