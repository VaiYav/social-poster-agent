/**
 * AN1: ThreadsInsightsSource — HTTP wiring around the pure parser, with an
 * injected fetch so no real network I/O happens. (Live token verification of the
 * exact endpoint / media-id resolution is a separate manual step.)
 *
 * Source: packages/backend/src/modules/analytics/metrics-sources/threads-insights.source.ts
 */
import { describe, it, expect, vi } from "vitest";

import { ThreadsInsightsSource } from "../../../../src/modules/analytics/metrics-sources/threads-insights.source.js";

const POST = {
  id: "p1",
  postUrl: "https://www.threads.com/@me/post/CuX1y_2-3",
  network: "THREADS" as const,
  accountId: "a1",
};

const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json });
const fail = () => ({ ok: false, status: 500, json: async () => ({}) });

describe("ThreadsInsightsSource (AN1)", () => {
  it("resolves the media id, hits the insights endpoint, and parses metrics", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      ok({
        data: [
          { name: "views", values: [{ value: 1500 }] },
          { name: "likes", values: [{ value: 42 }] },
          { name: "replies", values: [{ value: 7 }] },
          { name: "reposts", values: [{ value: 3 }] },
        ],
      }),
    );
    const source = new ThreadsInsightsSource("tok-123", fetchFn as never);

    const metrics = await source.fetchMetrics(POST);

    expect(metrics).toEqual({ likes: 42, comments: 7, shares: 3, impressions: 1500 });
    const url = fetchFn.mock.calls[0]![0] as string;
    expect(url).toContain("/CuX1y_2-3/insights");
    expect(url).toContain("access_token=tok-123");
    expect(url).toMatch(/metric=[^&]*likes/);
  });

  it("returns null on a non-ok response", async () => {
    const source = new ThreadsInsightsSource("tok", vi.fn().mockResolvedValue(fail()) as never);
    expect(await source.fetchMetrics(POST)).toBeNull();
  });

  it("returns null and never calls fetch when no media id can be resolved", async () => {
    const fetchFn = vi.fn();
    const source = new ThreadsInsightsSource("tok", fetchFn as never);

    expect(
      await source.fetchMetrics({ ...POST, postUrl: "https://www.threads.com/@me" }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
