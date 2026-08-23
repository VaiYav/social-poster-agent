import { describe, expect, it, vi } from "vitest";
import { SocialPromoListener } from "../../../src/events/listeners/social-promo.listener.js";

function build(values: { enabled?: string; post?: unknown; error?: Error } = {}) {
  const config = {
    get: vi.fn((_key: string, fallback?: unknown) => values.enabled ?? fallback),
  };
  const prisma = {
    post: {
      findUnique: values.error
        ? vi.fn().mockRejectedValue(values.error)
        : vi.fn().mockResolvedValue(values.post ?? null),
    },
  };
  const generation = { generateSocialPromo: vi.fn().mockResolvedValue(undefined) };
  return {
    listener: new SocialPromoListener(config as never, prisma as never, generation as never),
    prisma,
    generation,
  };
}

const payload = {
  postId: "post-verified-1",
  network: "X",
  postUrl: "https://x.com/example/status/1",
};

describe("SocialPromoListener", () => {
  it("does nothing when social promo is disabled", async () => {
    const { listener, prisma, generation } = build({ enabled: "false" });

    await expect(listener.handlePostVerified(payload as never)).resolves.toBeUndefined();
    expect(prisma.post.findUnique).not.toHaveBeenCalled();
    expect(generation.generateSocialPromo).not.toHaveBeenCalled();
  });

  it("loads a verified post and dispatches generation", async () => {
    const post = { id: payload.postId, network: "X", content: "verified" };
    const { listener, prisma, generation } = build({ enabled: "true", post });

    await listener.handlePostVerified(payload as never);

    expect(prisma.post.findUnique).toHaveBeenCalledWith({ where: { id: payload.postId } });
    expect(generation.generateSocialPromo).toHaveBeenCalledWith(post);
  });

  it("skips safely when the verified post no longer exists", async () => {
    const { listener, generation } = build({ enabled: "true", post: null });

    await expect(listener.handlePostVerified(payload as never)).resolves.toBeUndefined();
    expect(generation.generateSocialPromo).not.toHaveBeenCalled();
  });

  it("swallows DB and generation failures so the event bus remains alive", async () => {
    const dbFailure = build({ enabled: "true", error: new Error("database down") });
    await expect(dbFailure.listener.handlePostVerified(payload as never)).resolves.toBeUndefined();

    const dispatchFailure = build({
      enabled: "true",
      post: { id: payload.postId, network: "X" },
    });
    dispatchFailure.generation.generateSocialPromo.mockRejectedValue(new Error("generation down"));
    await expect(
      dispatchFailure.listener.handlePostVerified(payload as never),
    ).resolves.toBeUndefined();
  });
});
