import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { GenerationPersistenceService } from "../../../src/modules/generation/generation-persistence.service.js";
import { PostFactory } from "../../../src/modules/generation/post.factory.js";
import type { GeneratedPost } from "../../../src/modules/generation/generation.graph.js";

const SOURCE_REF = {
  type: "brief",
  path: "briefs/test.json",
  topic: "Test topic",
  keywords: ["test"],
};

function generatedPost(network: SocialNetwork, content: string): GeneratedPost {
  return {
    network,
    content,
    hook: "A useful hook",
    angle: "question — practical",
    model: "openai/gpt-5-nano",
    qualityScore: 8,
  };
}

describe("GenerationPersistenceService", () => {
  let llm: { getPromptVersion: ReturnType<typeof vi.fn> };
  let posts: { create: ReturnType<typeof vi.fn> };
  let abVariants: { createVariants: ReturnType<typeof vi.fn> };
  let onlineEvaluator: { evaluate: ReturnType<typeof vi.fn> };
  let service: GenerationPersistenceService;

  beforeEach(() => {
    llm = { getPromptVersion: vi.fn().mockReturnValue("prompt-1") };
    posts = {
      create: vi.fn((input: Record<string, unknown>) =>
        Promise.resolve({
          id: `post-${posts.create.mock.calls.length}`,
          network: input.network,
          accountId: input.accountId,
          llmMetadata: input.llmMetadata,
        }),
      ),
    };
    abVariants = { createVariants: vi.fn().mockResolvedValue(undefined) };
    onlineEvaluator = { evaluate: vi.fn().mockResolvedValue(undefined) };
    service = new GenerationPersistenceService(
      posts as never,
      abVariants as never,
      onlineEvaluator as never,
      new PostFactory(llm as never),
    );
  });

  it("builds stable metadata behind the persistence interface", () => {
    const metadata = service.buildPostLlmMetadata(
      {
        ...generatedPost(SocialNetwork.X, "Content"),
        accountId: "account-x",
        personaRevisionId: "revision-1",
        voiceMode: "pattern_breakdown",
      },
      "hash-1",
      { "draft-post": { label: "production" } },
    );

    expect(metadata).toEqual(
      expect.objectContaining({
        model: "openai/gpt-5-nano",
        promptVersion: "prompt-1",
        simhash: "hash-1",
        promptLabels: { "draft-post": { label: "production" } },
        authorContext: expect.objectContaining({
          accountId: "account-x",
          personaRevisionId: "revision-1",
        }),
      }),
    );
  });

  it("deduplicates content and rotates accounts per network", async () => {
    const accountsByNetwork = new Map([
      [SocialNetwork.X, [{ id: "account-a" }, { id: "account-b" }]],
    ]);
    const recentHashes: string[] = [];

    const saved = await service.persistGeneratedPosts(
      [
        generatedPost(SocialNetwork.X, "First unique post"),
        generatedPost(SocialNetwork.X, "Second unique post"),
        generatedPost(SocialNetwork.X, "First unique post"),
      ],
      accountsByNetwork,
      "run-1",
      SOURCE_REF,
      { recentHashes },
    );

    expect(saved).toHaveLength(2);
    expect(posts.create.mock.calls.map(([input]) => input.accountId)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(abVariants.createVariants).toHaveBeenCalledTimes(2);
    expect(onlineEvaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(recentHashes).toHaveLength(2);
  });
});
