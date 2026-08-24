import { describe, expect, it, vi } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { ReviewResumeService } from "../../../src/modules/generation/review-resume.service.js";

describe("ReviewResumeService", () => {
  it("resumes the HITL command and persists the reviewed graph output", async () => {
    const accounts = {
      getNextAccountForNetwork: vi.fn().mockResolvedValue({ id: "account-x" }),
    };
    const sse = { publish: vi.fn().mockResolvedValue(undefined) };
    const persistence = {
      persistGeneratedPosts: vi.fn().mockResolvedValue([{ id: "post-1" }]),
    };
    const invokeGraph = vi.fn().mockResolvedValue({
      finalState: {
        posts: [
          {
            network: SocialNetwork.X,
            content: "reviewed content",
            hook: "hook",
            angle: "question — practical",
            model: "gpt-5-nano",
          },
        ],
      },
      promptLabels: { "draft-post": { label: "production" } },
    });
    const loadRecentHashes = vi.fn().mockResolvedValue([]);
    const service = new ReviewResumeService(accounts as never, sse as never, persistence as never);

    const result = await service.resume(
      "run-1",
      "Test topic",
      true,
      { [SocialNetwork.X]: "reviewed content" },
      invokeGraph,
      loadRecentHashes,
    );

    expect(result).toEqual({ runId: "run-1", topic: "Test topic", status: "completed" });
    expect(invokeGraph).toHaveBeenCalledWith(
      expect.objectContaining({ configurable: { thread_id: "run-1:Test topic" } }),
      expect.anything(),
      { runId: "run-1", topic: "Test topic", approved: true },
    );
    expect(persistence.persistGeneratedPosts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Map),
      "run-1",
      { type: "review", path: "", topic: "Test topic", keywords: [] },
      { recentHashes: [], promptLabels: { "draft-post": { label: "production" } } },
    );
    expect(sse.publish).toHaveBeenCalledWith({
      type: "generation_completed",
      runId: "run-1",
      postCount: 1,
    });
  });
});
