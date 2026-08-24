import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { CtaAttributionService } from "../../../src/modules/posting/cta-attribution.service.js";

describe("CtaAttributionService", () => {
  const post = {
    id: "post-1",
    network: SocialNetwork.X,
    content: "Useful post",
    ctaUrl: null,
  };

  it("prepares an inline CTA without changing the base content for reply networks", async () => {
    const assignForPost = vi.fn().mockResolvedValue({
      ctaUrl: "https://quiz.example/r/abc",
      mode: "inline",
      source: "provider",
    });
    const service = new CtaAttributionService({} as never, { assignForPost } as never);

    const result = await service.prepare(
      { ...post, network: SocialNetwork.FACEBOOK } as never,
      false,
    );

    expect(result).toEqual({ content: "Useful post\n\nhttps://quiz.example/r/abc" });
    expect(assignForPost).toHaveBeenCalledWith(expect.objectContaining({ id: "post-1" }));
  });

  it("delivers a reply CTA only after the policy re-authorization succeeds", async () => {
    const postThreadReply = vi.fn().mockResolvedValue({ url: "https://x.com/user/status/1" });
    const registry = { getReplyCapablePoster: vi.fn().mockReturnValue({ postThreadReply }) };
    const authorizer = {
      authorize: vi.fn().mockResolvedValue({
        allowedMode: "APPROVED_AUTOMATION",
        blockReasons: [],
        policyHash: "hash-1",
      }),
      reauthorize: vi.fn().mockResolvedValue({
        allowedMode: "APPROVED_AUTOMATION",
        blockReasons: [],
        policyHash: "hash-1",
      }),
    };
    const service = new CtaAttributionService(registry as never, undefined, authorizer as never);

    await service.deliverFirstReply(
      post as never,
      {
        accountId: "account-1",
        network: SocialNetwork.X,
        action: "POST",
        transport: "BROWSER",
        targetRelationship: "OWN_POST",
        contentRiskTier: "LOW",
        requestedMode: "APPROVED_AUTOMATION",
      },
      {} as never,
      "https://x.com/user/status/1",
      "https://quiz.example/r/abc",
    );

    expect(authorizer.reauthorize).toHaveBeenCalledWith(
      expect.objectContaining({ action: "REPLY" }),
      "hash-1",
    );
    expect(postThreadReply).toHaveBeenCalledWith(
      {},
      "https://x.com/user/status/1",
      "https://quiz.example/r/abc",
    );
  });
});
