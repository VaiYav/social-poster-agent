/**
 * AN1: FacebookInsightsSource + parseFacebookPostCounts. Engagement counts from
 * the Graph post node; impressions intentionally null this increment (post-June-2026
 * fields are live-verify). Injected fetch — no real network I/O.
 *
 * Source: packages/backend/src/modules/analytics/metrics-sources/facebook-insights.source.ts
 */
import { describe, it, expect, vi } from "vitest";

import {
  FacebookInsightsSource,
  parseFacebookPostCounts,
} from "../../../../src/modules/analytics/metrics-sources/facebook-insights.source.js";

const POST = {
  id: "p1",
  postUrl: "https://www.facebook.com/exampleco/posts/1234567890",
  network: "FACEBOOK" as const,
  accountId: "a1",
};

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
const fail = () => ({ ok: false, status: 500, json: async () => ({}) });

describe("parseFacebookPostCounts (AN1)", () => {
  it("reads like / comment / share counts", () => {
    expect(
      parseFacebookPostCounts({
        likes: { summary: { total_count: 42 } },
        comments: { summary: { total_count: 7 } },
        shares: { count: 3 },
      }),
    ).toEqual({ likes: 42, comments: 7, shares: 3 });
  });

  it("defaults missing / malformed fields to 0", () => {
    expect(parseFacebookPostCounts({ likes: { summary: { total_count: 5 } } })).toEqual({
      likes: 5,
      comments: 0,
      shares: 0,
    });
    expect(parseFacebookPostCounts(null)).toEqual({ likes: 0, comments: 0, shares: 0 });
  });
});

describe("FacebookInsightsSource (AN1)", () => {
  it("resolves the post id, queries the node, and parses counts (impressions null)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      ok({
        likes: { summary: { total_count: 42 } },
        comments: { summary: { total_count: 7 } },
        shares: { count: 3 },
      }),
    );
    const source = new FacebookInsightsSource("tok-9", fetchFn as never);

    const metrics = await source.fetchMetrics(POST);

    expect(metrics).toEqual({ likes: 42, comments: 7, shares: 3, impressions: null });
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain("/1234567890?");
    expect(url).toContain("fields=likes.summary(true)");
    expect(url).toContain("access_token=tok-9");
  });

  it("returns null on a non-ok response", async () => {
    const source = new FacebookInsightsSource("t", vi.fn().mockResolvedValue(fail()) as never);
    expect(await source.fetchMetrics(POST)).toBeNull();
  });

  it("returns null and never calls fetch when no id resolves", async () => {
    const fetchFn = vi.fn();
    const source = new FacebookInsightsSource("t", fetchFn as never);

    expect(
      await source.fetchMetrics({ ...POST, postUrl: "https://www.facebook.com/exampleco" }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
