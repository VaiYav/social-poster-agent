import { describe, expect, it, vi } from "vitest";
import { ImageQuotaService } from "../../../src/modules/media/image-quota.service.js";

describe("MEDIA-101 ImageQuotaService", () => {
  it("uses atomic Redis reservation results and exposes the blocking reason", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([0, 2, 3, 999_000]) };
    const service = new ImageQuotaService(
      redis as never,
      { get: vi.fn().mockReturnValue("3") } as never,
    );

    const result = await service.reserve("account-1", 0.0336);

    expect(result).toMatchObject({ allowed: false, reason: "COST_BUDGET", count: 3 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      "spa:imagegen:account-1:daily",
      "spa:imagegen:account-1:budget",
      expect.any(Number),
      expect.any(Number),
      33_600,
      expect.any(Number),
    );
  });

  it("releases a reservation through the compensating atomic script", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([0, 0]) };
    const service = new ImageQuotaService(
      redis as never,
      { get: vi.fn().mockReturnValue("3") } as never,
    );

    await service.release("account-1", 0.0336);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      "spa:imagegen:account-1:daily",
      "spa:imagegen:account-1:budget",
      33_600,
    );
  });
});
