import { describe, it, expect } from "vitest";
import {
  extractTopic,
  computeVariantStats,
  pickWinner,
} from "../../../src/modules/content-enhancements/ab-test.utils.js";

describe("ab-test.utils", () => {
  describe("extractTopic", () => {
    it("uses sourceRef.topic when present", () => {
      const row = {
        post: { sourceRef: { topic: "Workflow Trends", extra: "ignore" } },
        content: "fallback text",
      };
      expect(extractTopic(row)).toBe("Workflow Trends");
    });

    it("falls back to sourceRef.originalTopic", () => {
      const row = {
        post: { sourceRef: { originalTopic: "Recycled topic" } },
        content: "fallback text",
      };
      expect(extractTopic(row)).toBe("Recycled topic");
    });

    it("falls back to sourceRef.title", () => {
      const row = {
        post: { sourceRef: { title: "Product Launch in Q4" } },
        content: "fallback text",
      };
      expect(extractTopic(row)).toBe("Product Launch in Q4");
    });

    it("falls back to content slice when sourceRef has no topic key", () => {
      const row = {
        post: { sourceRef: { unrelated: "value" } },
        content: "The quick brown fox jumps over the lazy dog",
      };
      expect(extractTopic(row)).toBe("The quick brown fox jumps over the lazy dog".slice(0, 50));
    });

    it("falls back to content slice when sourceRef is missing", () => {
      const row = {
        post: { sourceRef: undefined },
        content: "Short content",
      };
      expect(extractTopic(row)).toBe("Short content");
    });
  });

  describe("computeVariantStats", () => {
    it("computes averages and engagement correctly", () => {
      const rows = [
        {
          likes: 10,
          comments: 2,
          shares: 1,
          impressions: 100,
          judgeScores: { anti_ai_tone: 0.8, hook_strength: 0.7 },
          content: "",
          label: "a",
          post: { sourceRef: {} },
        },
        {
          likes: 20,
          comments: 4,
          shares: 2,
          impressions: 200,
          judgeScores: { anti_ai_tone: 0.6, hook_strength: 0.9 },
          content: "",
          label: "a",
          post: { sourceRef: {} },
        },
      ];

      const stats = computeVariantStats("a", rows);

      expect(stats.label).toBe("a");
      expect(stats.sampleSize).toBe(2);
      expect(stats.avgLikes).toBe(15);
      expect(stats.avgComments).toBe(3);
      expect(stats.avgShares).toBe(1.5);
      expect(stats.avgEngagement).toBe(19.5);
      expect(stats.avgImpressions).toBe(150);
      expect(stats.avgAntiAiTone).toBe(0.7);
      expect(stats.avgHookStrength).toBe(0.8);
    });

    it("returns null for optional averages when all values are missing", () => {
      const rows = [
        {
          likes: 0,
          comments: 0,
          shares: 0,
          impressions: null,
          judgeScores: null,
          content: "",
          label: "b",
          post: { sourceRef: {} },
        },
      ];

      const stats = computeVariantStats("b", rows);

      expect(stats.avgImpressions).toBeNull();
      expect(stats.avgAntiAiTone).toBeNull();
      expect(stats.avgHookStrength).toBeNull();
      expect(stats.avgEngagement).toBe(0);
    });
  });

  describe("pickWinner", () => {
    it("returns the variant with the highest engagement", () => {
      const variants = [
        {
          label: "a",
          sampleSize: 5,
          avgEngagement: 12,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
        {
          label: "b",
          sampleSize: 5,
          avgEngagement: 20,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
      ];

      expect(pickWinner(variants, 3)).toBe("b");
    });

    it("returns null when no variants meet the minimum sample size", () => {
      const variants = [
        {
          label: "a",
          sampleSize: 2,
          avgEngagement: 100,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
        {
          label: "b",
          sampleSize: 2,
          avgEngagement: 1,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
      ];

      expect(pickWinner(variants, 3)).toBeNull();
    });

    it("returns null when there is a tie", () => {
      const variants = [
        {
          label: "a",
          sampleSize: 5,
          avgEngagement: 10,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
        {
          label: "b",
          sampleSize: 5,
          avgEngagement: 10,
          avgLikes: 0,
          avgComments: 0,
          avgShares: 0,
          avgImpressions: null,
          avgAntiAiTone: null,
          avgHookStrength: null,
        },
      ];

      expect(pickWinner(variants, 3)).toBeNull();
    });
  });
});
