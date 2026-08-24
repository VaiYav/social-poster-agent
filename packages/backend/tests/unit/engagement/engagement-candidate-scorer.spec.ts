import { describe, expect, it } from "vitest";
import { SocialNetwork } from "../../../src/generated/prisma/client.js";
import { EngagementCandidateScorer } from "../../../src/modules/engagement/engagement-candidate-scorer.js";
import { EngagementSafetyService } from "../../../src/modules/engagement/engagement-safety.service.js";

describe("ENGAGE-101 EngagementCandidateScorer", () => {
  const scorer = new EngagementCandidateScorer(new EngagementSafetyService());

  it("keeps SKIP terminal for generic or low-value text", () => {
    const result = scorer.score({
      network: SocialNetwork.X,
      postUrl: "https://x.com/post/1",
      postText: "Nice!",
      topicKeywords: ["astrology"],
      source: "home-feed",
    });

    expect(result.decision).toBe("SKIP");
  });

  it("creates a reply suggestion candidate only for a relevant conversation", () => {
    const result = scorer.score({
      network: SocialNetwork.THREADS,
      postUrl: "https://threads.net/@author/post/1",
      postText:
        "I keep noticing this workflow pattern in small teams, and it changes how people plan their week. Has anyone else seen it?",
      topicKeywords: ["workflow", "pattern"],
      authorHandle: "author",
      source: "notifications",
    });

    expect(result.decision).toBe("SUGGEST_REPLY");
    expect(result.policyEligible).toBe(true);
    expect(result.safetyRisk).toBe(0);
  });

  it("rejects duplicate candidates before any LLM action", () => {
    const result = scorer.score({
      network: SocialNetwork.X,
      postUrl: "https://x.com/post/1",
      postText: "A specific pattern worth discussing today.",
      topicKeywords: ["pattern"],
      source: "home-feed",
      previousTexts: [" a specific pattern worth discussing today. "],
    });

    expect(result.decision).toBe("SKIP");
    expect(result.duplicationRisk).toBe(1);
  });
});
