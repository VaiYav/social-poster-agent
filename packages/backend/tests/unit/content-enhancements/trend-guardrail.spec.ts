/**
 * Trend guardrail unit tests.
 *  - B11: word-boundary blocklist (no more "war" matching "forward")
 *  - B9: layer-2 LLM failure must fail CLOSED (reject the topic), not open
 *
 * Source: packages/backend/src/modules/content-enhancements/trend-guardrail.ts
 */
import { describe, it, expect, vi } from "vitest";

import {
  isBlocklisted,
  checkTrendSafety,
  isTrendingSource,
} from "../../../src/modules/content-enhancements/trend-guardrail.js";

describe("isBlocklisted (B11 — word-boundary blocklist)", () => {
  it("still blocks genuine brand-unsafe whole-word topics", () => {
    for (const topic of [
      "War in the region escalates",
      "US election results 2026",
      "New pandemic breakthrough",
      "Nazi rally downtown",
      "Celebrity divorce shocker",
      "Mental illness awareness week", // multi-word phrase
    ]) {
      expect(isBlocklisted(topic), topic).toBe(true);
    }
  });

  it("still blocks stem keywords (casualt → casualties)", () => {
    expect(isBlocklisted("Heavy casualties reported")).toBe(true);
    expect(isBlocklisted("Homophobic remarks spark outrage")).toBe(true);
  });

  it("no longer false-positives on brand-relevant words containing a keyword substring", () => {
    for (const topic of [
      "Forward momentum this Workflow Trends",
      "Warm Q2 energy this week",
      "Rewarding career moves for q4",
      "Beat the deadline with Q3 focus",
      "A couples retreat under the product launch",
      "Awards season and your rising brand",
      "Current affairs digest", // "affair" no longer matches "affairs"
    ]) {
      expect(isBlocklisted(topic), topic).toBe(false);
    }
  });

  it('still blocks "pandemic" the disease in medical context', () => {
    for (const topic of [
      "New pandemic breakthrough",
      "Pandemic treatment options",
      "Pandemic survivor story",
    ]) {
      expect(isBlocklisted(topic), topic).toBe(true);
    }
  });
});

describe("checkTrendSafety (B9 — fail closed on LLM error)", () => {
  const trendingPath = "trending/google_trends";

  it("skips the guardrail for non-trending sources (already brand-safe)", async () => {
    const llm = { generateChat: vi.fn() };
    const res = await checkTrendSafety("anything at all", "brief", "briefs/abc", llm as never);
    expect(res.safe).toBe(true);
    expect(res.decidedBy).toBe("not_trending");
    expect(llm.generateChat).not.toHaveBeenCalled();
  });

  it("rejects blocklisted trending topics without calling the LLM", async () => {
    const llm = { generateChat: vi.fn() };
    const res = await checkTrendSafety(
      "Election scandal erupts",
      "topic",
      trendingPath,
      llm as never,
    );
    expect(res.safe).toBe(false);
    expect(res.decidedBy).toBe("blocklist");
    expect(llm.generateChat).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the LLM layer throws (B9) — topic rejected, not allowed", async () => {
    const llm = { generateChat: vi.fn().mockRejectedValue(new Error("provider down")) };
    const res = await checkTrendSafety(
      "Workflow Trends survival tips",
      "topic",
      trendingPath,
      llm as never,
    );
    expect(res.safe).toBe(false);
    expect(res.opportunityScore).toBe(0);
    expect(res.decidedBy).toBe("llm");
  });

  it("accepts a brand-fit trending topic when the LLM scores it above threshold", async () => {
    const llm = {
      generateChat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          safe: true,
          opportunityScore: 8,
          suggestedAngle: "Workflow Trends and mindful communication",
          reason: "Strong wellness angle",
        }),
      }),
    };
    const res = await checkTrendSafety("Workflow Trends", "topic", trendingPath, llm as never);
    expect(res.safe).toBe(true);
    expect(res.opportunityScore).toBeGreaterThanOrEqual(4);
    expect(res.decidedBy).toBe("llm");
  });
});

describe("isTrendingSource (B16 — path-segment match)", () => {
  it("matches real trending paths", () => {
    expect(isTrendingSource("topic", "trending/google_trends+x_trends")).toBe(true);
    expect(isTrendingSource("topic", "trending/x")).toBe(true);
  });

  it("does not match non-trending paths or empty input", () => {
    expect(isTrendingSource("brief", "briefs/abc")).toBe(false);
    expect(isTrendingSource("topic", "")).toBe(false);
  });

  it('only matches "trending/" as a path segment, not inside a slug', () => {
    expect(isTrendingSource("topic", "category/hottrending/x")).toBe(false);
  });
});
