import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Analytics from "../../src/views/Analytics.vue";

const api = {
  get: vi.fn(),
  post: vi.fn(),
};

vi.mock("../../src/composables/useApi", () => ({
  useApi: () => api,
}));

vi.mock("../../src/composables/useToast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock("../../src/stores/analytics", () => ({
  useAnalyticsStore: () => ({
    autonomousStats: null,
    fetchAutonomousStats: vi.fn(),
  }),
}));

describe("Analytics conversion funnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url: string) => {
      if (url.startsWith("/link-attribution/summary")) {
        return Promise.resolve({
          data: {
            windowDays: 30,
            totals: { posts: 2, clicks: 12, conversions: 3, conversionRate: 0.25 },
            degradedLinks: 1,
            posts: [
              {
                postId: "post-1",
                network: "THREADS",
                status: "POSTED",
                postedAt: "2026-08-23T09:00:00.000Z",
                topic: "Daily rhythm",
                deliveryMode: "inline",
                source: "utm-fallback",
                clicks: 12,
                conversions: 3,
              },
            ],
          },
        });
      }
      if (url === "/analytics/summary") {
        return Promise.resolve({
          data: {
            totalPosts: 2,
            posted: 2,
            failed: 0,
            pending: 0,
            successRate: 100,
            byNetwork: { THREADS: { total: 2, posted: 2, failed: 0 } },
            last7Days: [],
          },
        });
      }
      if (url === "/analytics/top-posts?limit=10") return Promise.resolve({ data: [] });
      if (url === "/analytics/hook-performance") {
        return Promise.resolve({ data: { networks: {}, lastUpdated: null } });
      }
      if (url === "/analytics/review-calibration?days=30") {
        return Promise.resolve({
          data: {
            windowDays: 30,
            totalDecisions: 0,
            byDecision: {},
            syncStatus: {},
            averageEditDistance: null,
            evidenceCoverage: { reasonCodes: 0, rubric: 0, trace: 0, contentHashes: 0 },
            calibration: {
              pairedSamples: 0,
              agreementRate: null,
              kappa: null,
              precision: null,
              recall: null,
              tpr: null,
              tnr: null,
              status: "INSUFFICIENT_SAMPLE",
            },
          },
        });
      }
      if (url === "/analytics/online-evaluation") {
        return Promise.resolve({
          data: { slo: null, alerts: [], timestamp: "2026-08-23T00:00:00Z" },
        });
      }
      if (url === "/analytics/cost") {
        return Promise.resolve({
          data: {
            totalCostUsd: 0.0123,
            totalTokensIn: 100,
            totalTokensOut: 50,
            cacheHits: 2,
            events: 4,
          },
        });
      }
      if (url.startsWith("/analytics/ab-tests")) return Promise.resolve({ data: [] });
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it("renders conversion totals, source quality, and explicit revenue gap", async () => {
    const wrapper = mount(Analytics, {
      global: {
        stubs: { BarChart: true, DoughnutChart: true },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Conversion Funnel");
    expect(wrapper.text()).toContain("12");
    expect(wrapper.text()).toContain("3");
    expect(wrapper.text()).toContain("UTM fallback");
    expect(wrapper.text()).toContain("Revenue");
    expect(wrapper.text()).toContain("Provider field pending");
    expect(wrapper.text()).toContain("LLM Cost (7d)");
    expect(wrapper.text()).toContain("$0.0123");
  });
});
