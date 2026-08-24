import { describe, expect, it, vi } from "vitest";
import { ImageGenerationService } from "../../../src/modules/media/image-generation.service.js";

const concept = {
  style: "aesthetic_photo" as const,
  imagePrompt: "An abstract blue morning light composition",
  bgGradient: ["#112233", "#445566"] as [string, string],
  network: "X" as const,
  reasoning: "test",
};

describe("MEDIA-101 ImageGenerationService", () => {
  it("fails safely to text-only when the provider adapter is not configured", async () => {
    const service = new ImageGenerationService(
      { post: { update: vi.fn() } } as never,
      {
        get: vi.fn((key: string, fallback?: string) =>
          key === "IMAGE_GENERATION_ENABLED" ? "true" : fallback,
        ),
      } as never,
      { reserve: vi.fn(), release: vi.fn() } as never,
    );

    await expect(service.generateForPost("post-1", "account-1", concept)).resolves.toEqual({
      generated: false,
      skippedReason: "provider_unavailable",
    });
  });

  it("skips without spending quota when the feature is disabled", async () => {
    const quota = { reserve: vi.fn(), release: vi.fn() };
    const service = new ImageGenerationService(
      { post: { update: vi.fn() } } as never,
      { get: vi.fn((_key: string, fallback?: string) => fallback) } as never,
      quota as never,
    );

    await expect(service.generateForPost("post-1", "account-1", concept)).resolves.toEqual({
      generated: false,
      skippedReason: "disabled",
    });
    expect(quota.reserve).not.toHaveBeenCalled();
  });
});
